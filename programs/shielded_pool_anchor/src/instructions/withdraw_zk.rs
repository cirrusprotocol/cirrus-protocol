use anchor_lang::prelude::*;

use crate::constants::{is_canonical_fr, ALLOWED_BUCKET_AMOUNTS, SUPPORTED_CIRCUIT_VERSION};
use crate::errors::ShieldedPoolError;
use crate::state::{
    NullifierConsumed, NullifierMarker, PoolState, VerifierConfig, ZkWithdrawExecuted,
};

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
)]
pub struct WithdrawZk<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state"],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        seeds = [b"verifier_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, VerifierConfig>,

    // Seeds shared with the non-ZK `withdraw` path (nullifier bytes differ by construction).
    // The ZK nullifier is Poseidon(TAG_NULLIFIER=1, secret) — cross-path collision
    // with arbitrary `withdraw` nullifiers is computationally infeasible.
    #[account(
        init_if_needed,
        payer = relayer,
        space = NullifierMarker::LEN,
        seeds = [b"nullifier", nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier_marker: Account<'info, NullifierMarker>,

    /// CHECK: Writable lamport target. In real verifier mode this account's pubkey
    /// is bound through on-chain tx_hash recomputation and Groth16 public input
    /// verification. In mock verifier mode it is bound through the local-test-only
    /// proof fixture: recipient bytes appear in proof_c[0..32] and enter tx_hash
    /// via pubkeys_hash (proof_b[0..32]).
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// Validate the local-test-only mock proof fixture.
//
// This is NOT Groth16 verification and provides no cryptographic proof security.
// It exists only to make mock-verifier integration tests exercise the same
// public-input boundary that the real Groth16 verifier will later enforce.
//
// Fixture format (all values are 32-byte big-endian):
//   proof_a[0..32]   = root
//   proof_a[32..64]  = nullifier_hash
//   proof_b[0..32]   = tx_hash
//   proof_b[32..64]  = program_id
//   proof_b[64..96]  = pool_state PDA
//   proof_b[96..128] = config PDA
//   proof_c[0..32]   = recipient pubkey
//   proof_c[32..64]  = relayer pubkey
//
// Returns InvalidProof on any mismatch.
#[cfg(feature = "mock-verifier")]
fn verify_mock_withdraw_zk_proof(
    proof_a: &[u8; 64],
    proof_b: &[u8; 128],
    proof_c: &[u8; 64],
    root: &[u8; 32],
    nullifier_hash: &[u8; 32],
    tx_hash: &[u8; 32],
    program_id: &Pubkey,
    pool_state_pda: &Pubkey,
    config_pda: &Pubkey,
    recipient: &Pubkey,
    relayer: &Pubkey,
) -> Result<()> {
    let ok = &proof_a[..32] == root.as_ref()
        && &proof_a[32..] == nullifier_hash.as_ref()
        && &proof_b[..32] == tx_hash.as_ref()
        && &proof_b[32..64] == program_id.as_ref()
        && &proof_b[64..96] == pool_state_pda.as_ref()
        && &proof_b[96..] == config_pda.as_ref()
        && &proof_c[..32] == recipient.as_ref()
        && &proof_c[32..] == relayer.as_ref();

    if !ok {
        return Err(error!(ShieldedPoolError::InvalidProof));
    }
    Ok(())
}

pub fn handler(
    ctx: Context<WithdrawZk>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
    denomination: u64,
    fee: u64,
    expiry_slot: u64,
    circuit_version: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let pool_state = &mut ctx.accounts.pool_state;
    let nullifier_marker = &mut ctx.accounts.nullifier_marker;
    let rent = Rent::get()?;
    let clock = Clock::get()?;

    // ── 1. Semantic checks (all before state mutation) ───────────────────────────

    require!(!config.paused, ShieldedPoolError::Paused);

    require!(
        circuit_version == SUPPORTED_CIRCUIT_VERSION,
        ShieldedPoolError::InvalidCircuitVersion
    );

    require!(
        ALLOWED_BUCKET_AMOUNTS.contains(&denomination),
        ShieldedPoolError::InvalidDenomination
    );

    require!(fee <= denomination, ShieldedPoolError::InvalidFee);

    let rent_cost = rent.minimum_balance(NullifierMarker::LEN);
    require!(fee >= rent_cost, ShieldedPoolError::FeeTooLow);

    require!(clock.slot <= expiry_slot, ShieldedPoolError::SettlementExpired);

    require!(is_canonical_fr(&root), ShieldedPoolError::NonCanonicalRoot);
    require!(
        is_canonical_fr(&nullifier_hash),
        ShieldedPoolError::NonCanonicalNullifierHash
    );

    require!(
        !config.allowed_roots.is_empty(),
        ShieldedPoolError::NoAllowedRootsConfigured
    );

    require!(
        config.allowed_roots.iter().any(|r| r == &root),
        ShieldedPoolError::UnknownMerkleRoot
    );

    let pool_info = pool_state.to_account_info();
    let pool_rent_min = rent.minimum_balance(PoolState::LEN);
    let pool_spendable = pool_info.lamports().saturating_sub(pool_rent_min);
    require!(
        pool_spendable >= denomination,
        ShieldedPoolError::InsufficientPoolBalance
    );

    require!(!nullifier_marker.used, ShieldedPoolError::NullifierAlreadyUsed);

    // ── 2. tx_hash recomputation and mock proof fixture validation ───────────────
    //
    // tx_hash is computed using the locked formula (spec §1):
    //   tx_hash = Poseidon(TAG_TX=4, pubkeys_hash, denomination, fee,
    //                       config.chain_id, expiry_slot, circuit_version)
    //   pubkeys_hash = Poseidon(TAG_TX_INNER=5, program_id, pool_pda, config_pda,
    //                            recipient, relayer — each split as LE lo/hi u128)
    //
    // In mock-verifier mode, the computed tx_hash is validated against the
    // deterministic local-test-only proof fixture (see verify_mock_withdraw_zk_proof).
    // This is not Groth16 verification. It only exercises the public-input boundary
    // that the real verifier will later enforce.
    //
    // Production flow: Groth16Verify(proof, [root, nullifier_hash, tx_hash])

    #[cfg(feature = "mock-verifier")]
    {
        use solana_program::log::sol_log_compute_units;

        sol_log_compute_units(); // CU checkpoint before Poseidon

        // Copy keys before any mutable borrow of pool_state is taken below.
        let pool_state_key = pool_state.key();
        let config_key = config.key();
        let recipient_key = ctx.accounts.recipient.key();
        let relayer_key = ctx.accounts.relayer.key();

        let tx_hash = crate::zk_hash::compute_tx_hash(
            ctx.program_id,
            &pool_state_key,
            &config_key,
            &recipient_key,
            &relayer_key,
            denomination,
            fee,
            config.chain_id,
            expiry_slot,
            circuit_version,
        )?;

        sol_log_compute_units(); // CU checkpoint after Poseidon

        verify_mock_withdraw_zk_proof(
            &proof_a,
            &proof_b,
            &proof_c,
            &root,
            &nullifier_hash,
            &tx_hash,
            ctx.program_id,
            &pool_state_key,
            &config_key,
            &recipient_key,
            &relayer_key,
        )?;

        msg!(
            "withdraw_zk: MOCK VERIFIER ENABLED — mock proof fixture matched public inputs; Groth16 proof check skipped (non-production)"
        );
    }

    #[cfg(not(feature = "mock-verifier"))]
    {
        let pool_state_key = pool_state.key();
        let config_key = config.key();
        let recipient_key = ctx.accounts.recipient.key();
        let relayer_key = ctx.accounts.relayer.key();

        let tx_hash = crate::zk_hash::compute_tx_hash(
            ctx.program_id,
            &pool_state_key,
            &config_key,
            &recipient_key,
            &relayer_key,
            denomination,
            fee,
            config.chain_id,
            expiry_slot,
            circuit_version,
        )?;

        let public_inputs: [[u8; 32]; crate::zk_verifier::WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT] = [
            root,
            nullifier_hash,
            tx_hash,
        ];

        crate::zk_verifier::verify_withdraw_sol_v1_proof(
            &proof_a,
            &proof_b,
            &proof_c,
            &public_inputs,
        )?;
    }

    // ── 3. Mutate state ──────────────────────────────────────────────────────────

    nullifier_marker.used = true;

    pool_state.total_withdrawals = pool_state
        .total_withdrawals
        .checked_add(denomination)
        .ok_or(ShieldedPoolError::ArithmeticOverflow)?;

    // ── 4. Settle lamports ───────────────────────────────────────────────────────

    let net_amount = denomination
        .checked_sub(fee)
        .ok_or(ShieldedPoolError::ArithmeticOverflow)?;

    let recipient_info = ctx.accounts.recipient.to_account_info();
    let relayer_info = ctx.accounts.relayer.to_account_info();

    let new_pool_lamports = pool_info
        .lamports()
        .checked_sub(denomination)
        .ok_or(ShieldedPoolError::InsufficientPoolBalance)?;

    let new_recipient_lamports = recipient_info
        .lamports()
        .checked_add(net_amount)
        .ok_or(ShieldedPoolError::ArithmeticOverflow)?;

    let new_relayer_lamports = relayer_info
        .lamports()
        .checked_add(fee)
        .ok_or(ShieldedPoolError::ArithmeticOverflow)?;

    **pool_info.try_borrow_mut_lamports()? = new_pool_lamports;
    **recipient_info.try_borrow_mut_lamports()? = new_recipient_lamports;
    **relayer_info.try_borrow_mut_lamports()? = new_relayer_lamports;

    // ── 5. Emit events ───────────────────────────────────────────────────────────

    msg!("withdraw_zk: nullifier consumed, slot={}", clock.slot);

    emit!(NullifierConsumed {
        nullifier: nullifier_hash,
        slot: clock.slot,
    });

    emit!(ZkWithdrawExecuted {
        nullifier_hash,
        recipient: ctx.accounts.recipient.key(),
        relayer: ctx.accounts.relayer.key(),
        denomination,
        fee,
        circuit_version,
        slot: clock.slot,
    });

    msg!(
        "withdraw_zk: settlement complete, denomination={}, fee={}, slot={}",
        denomination,
        fee,
        clock.slot
    );

    Ok(())
}
