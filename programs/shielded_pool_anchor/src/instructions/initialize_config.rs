use anchor_lang::prelude::*;

use crate::errors::ShieldedPoolError;
use crate::state::{VerifierConfig, VerifierConfigUpdated, MAX_ROOTS, MAX_VERIFIERS};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = VerifierConfig::LEN,
        seeds = [b"verifier_config"],
        bump
    )]
    pub config: Account<'info, VerifierConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeConfig>,
    attester_pubkey: Pubkey,
    verifier_pubkeys: Vec<Pubkey>,
    threshold: u8,
    chain_id: u64,
) -> Result<()> {
    // ── Validate verifier set ────────────────────────────────────
    require!(
        !verifier_pubkeys.is_empty(),
        ShieldedPoolError::EmptyVerifierSet
    );
    require!(
        verifier_pubkeys.len() <= MAX_VERIFIERS,
        ShieldedPoolError::TooManyVerifiers
    );
    require!(
        threshold > 0 && (threshold as usize) <= verifier_pubkeys.len(),
        ShieldedPoolError::InvalidThreshold
    );

    // Reject default (all-zero) pubkeys
    let default_key = Pubkey::default();
    for key in &verifier_pubkeys {
        require!(
            *key != default_key,
            ShieldedPoolError::DefaultVerifierKey
        );
    }

    // Reject duplicates
    for i in 0..verifier_pubkeys.len() {
        for j in (i + 1)..verifier_pubkeys.len() {
            require!(
                verifier_pubkeys[i] != verifier_pubkeys[j],
                ShieldedPoolError::DuplicateVerifier
            );
        }
    }

    // ── Write config ─────────────────────────────────────────────
    let config = &mut ctx.accounts.config;
    config.admin_authority = ctx.accounts.admin.key();
    config.attester_pubkey = attester_pubkey;
    config.root_submitter_authority = ctx.accounts.admin.key();
    config.chain_id = chain_id;
    config.paused = false;
    config.threshold = threshold;
    config.verifier_pubkeys = verifier_pubkeys;
    config.allowed_roots = Vec::with_capacity(MAX_ROOTS);
    config.bump = ctx.bumps.config;

    msg!(
        "config: initialized, threshold={}, verifiers={}, chain_id={}",
        config.threshold,
        config.verifier_pubkeys.len(),
        config.chain_id
    );

    emit!(VerifierConfigUpdated {
        admin: ctx.accounts.admin.key(),
        threshold: config.threshold,
        verifier_count: config.verifier_pubkeys.len() as u8,
        paused: config.paused,
    });

    Ok(())
}