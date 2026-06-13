use anchor_lang::prelude::*;
use shielded_pool_interface::WithdrawalIntentV1;

use crate::errors::ShieldedPoolError;
use crate::instructions::attestation::verify_contiguous_threshold_attestation;
use crate::state::WithdrawIntent;
use crate::state::{
    NullifierConsumed, NullifierMarker, PoolState, VerifierConfig, WithdrawExecuted,
};
use shielded_pool_interface::instruction::{
    compute_handshake_hash_v1, compute_intent_hash_v1,
};

#[derive(Accounts)]
#[instruction(intent: WithdrawIntent, expiry_slot: u64)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        constraint = relayer.key() == intent.relayer @ ShieldedPoolError::Unauthorized
    )]
    pub relayer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state"],
        bump = pool_state.bump
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        seeds = [b"verifier_config"],
        bump = config.bump
    )]
    pub config: Account<'info, VerifierConfig>,

    #[account(
        init_if_needed,
        payer = relayer,
        space = NullifierMarker::LEN,
        seeds = [b"nullifier", intent.nullifier.as_ref()],
        bump
    )]
    pub nullifier_marker: Account<'info, NullifierMarker>,

    /// CHECK: Recipient address is strictly bound to intent.recipient via address constraint
    #[account(
        mut,
        address = intent.recipient @ ShieldedPoolError::BindingMismatch
    )]
    pub recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: instructions sysvar is only used for instruction introspection during attestation verification.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<Withdraw>,
    intent: WithdrawIntent,
    expiry_slot: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let pool_state = &mut ctx.accounts.pool_state;
    let nullifier_marker = &mut ctx.accounts.nullifier_marker;
    let clock = Clock::get()?;

    // ── 1. Verify config ─────────────────────────────────────────

    require!(!config.paused, ShieldedPoolError::Paused);
    require!(
        intent.chain_id == config.chain_id,
        ShieldedPoolError::InvalidChainId
    );
    msg!("withdraw: chain_id verified");

    if !config.allowed_roots.is_empty() {
        require!(
            config.allowed_roots.iter().any(|r| r == &intent.merkle_root),
            ShieldedPoolError::UnknownMerkleRoot
        );
        msg!("withdraw: merkle_root verified against allowed_roots");
    }

    require!(
        clock.slot <= expiry_slot,
        ShieldedPoolError::SettlementExpired
    );

    require!(
        ctx.accounts.relayer.key() == intent.relayer,
        ShieldedPoolError::Unauthorized
    );
    require!(
        ctx.accounts.recipient.key() == intent.recipient,
        ShieldedPoolError::BindingMismatch
    );

    require!(intent.amount > 0, ShieldedPoolError::InvalidAmount);
    require!(intent.fee <= intent.amount, ShieldedPoolError::InvalidFee);

    let rent = Rent::get()?;
    let rent_cost = rent.minimum_balance(NullifierMarker::LEN);
    require!(intent.fee >= rent_cost, ShieldedPoolError::FeeTooLow);

    // The pool PDA must retain its own rent-exempt reserve (PoolState::LEN bytes).
    // Only lamports above that floor are spendable; draining to zero would make
    // the account non-rent-exempt and eligible for garbage collection.
    let pool_info = pool_state.to_account_info();
    let pool_rent_min = rent.minimum_balance(PoolState::LEN);
    let pool_spendable = pool_info.lamports().saturating_sub(pool_rent_min);
    require!(
        pool_spendable >= intent.amount,
        ShieldedPoolError::InsufficientPoolBalance
    );

    // ── 2. Verify attestation ────────────────────────────────────

    let interface_intent = WithdrawalIntentV1 {
        commitment: intent.commitment,
        nullifier: intent.nullifier,
        recipient: intent.recipient,
        amount: intent.amount,
        fee: intent.fee,
        relayer: intent.relayer,
        chain_id: intent.chain_id,
        nonce: intent.nonce,
        audit_hash: intent.audit_hash,
        policy_id: intent.policy_id,
        merkle_root: intent.merkle_root,
    };

    let intent_hash = compute_intent_hash_v1(&interface_intent);

    let handshake_hash = compute_handshake_hash_v1(
        ctx.program_id,
        &pool_state.key(),
        &config.key(),
        expiry_slot,
        &intent_hash,
        &intent.audit_hash,
        intent.policy_id,
    );

    let signer_count = verify_contiguous_threshold_attestation(
        &ctx.accounts.instructions_sysvar,
        handshake_hash.as_ref(),
        config,
    )?;

    msg!(
        "withdraw: attestation verified, signers={}, threshold={}",
        signer_count,
        config.threshold
    );

    // ── 3. Verify replay protection ──────────────────────────────

    require!(
        !nullifier_marker.used,
        ShieldedPoolError::NullifierAlreadyUsed
    );

    // ── 4. Mutate state ──────────────────────────────────────────

    nullifier_marker.used = true;

    let new_total_withdrawals = pool_state
        .total_withdrawals
        .checked_add(intent.amount)
        .ok_or(ShieldedPoolError::ArithmeticOverflow)?;
    pool_state.total_withdrawals = new_total_withdrawals;

    // ── 5. Settle lamports ───────────────────────────────────────

    let net_amount = intent
        .amount
        .checked_sub(intent.fee)
        .ok_or(ShieldedPoolError::ArithmeticOverflow)?;

    let recipient_info = ctx.accounts.recipient.to_account_info();
    let relayer_info = ctx.accounts.relayer.to_account_info();

    let new_pool_lamports = pool_info
        .lamports()
        .checked_sub(intent.amount)
        .ok_or(ShieldedPoolError::InsufficientPoolBalance)?;

    let new_recipient_lamports = recipient_info
        .lamports()
        .checked_add(net_amount)
        .ok_or(ShieldedPoolError::ArithmeticOverflow)?;

    let new_relayer_lamports = relayer_info
        .lamports()
        .checked_add(intent.fee)
        .ok_or(ShieldedPoolError::ArithmeticOverflow)?;

    **pool_info.try_borrow_mut_lamports()? = new_pool_lamports;
    **recipient_info.try_borrow_mut_lamports()? = new_recipient_lamports;
    **relayer_info.try_borrow_mut_lamports()? = new_relayer_lamports;

    // ── 6. Emit events (after settlement succeeds) ───────────────

    msg!(
        "withdraw: nullifier consumed, slot={}",
        clock.slot
    );

    emit!(NullifierConsumed {
        nullifier: intent.nullifier,
        slot: clock.slot,
    });

    let mut ih = [0u8; 32];
    ih.copy_from_slice(intent_hash.as_ref());
    let mut hh = [0u8; 32];
    hh.copy_from_slice(handshake_hash.as_ref());

    emit!(WithdrawExecuted {
        intent_hash: ih,
        handshake_hash: hh,
        nullifier: intent.nullifier,
        recipient: intent.recipient,
        relayer: intent.relayer,
        amount: intent.amount,
        fee: intent.fee,
        signer_count,
        threshold: config.threshold,
        slot: clock.slot,
    });

    msg!(
        "withdraw: settlement complete, amount={}, fee={}, slot={}",
        intent.amount,
        intent.fee,
        clock.slot
    );

    Ok(())
}