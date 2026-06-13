use anchor_lang::prelude::*;

use crate::errors::ShieldedPoolError;
use crate::state::{
    ProtocolPaused, ProtocolUnpaused, VerifierConfig, VerifierConfigUpdated,
    MAX_VERIFIERS,
};

#[derive(Accounts)]
pub struct UpdateVerifierConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"verifier_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, VerifierConfig>,
}

pub fn handler(
    ctx: Context<UpdateVerifierConfig>,
    new_threshold: u8,
    new_verifiers: Vec<Pubkey>,
    paused: bool,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let admin_key = ctx.accounts.admin.key();

    // ── Admin authorization ──────────────────────────────────────
    require!(
        admin_key == config.admin_authority,
        ShieldedPoolError::UnauthorizedAdmin
    );

    // ── Validate verifier set ────────────────────────────────────
    require!(
        !new_verifiers.is_empty(),
        ShieldedPoolError::EmptyVerifierSet
    );
    require!(
        new_verifiers.len() <= MAX_VERIFIERS,
        ShieldedPoolError::TooManyVerifiers
    );
    require!(
        new_threshold > 0 && (new_threshold as usize) <= new_verifiers.len(),
        ShieldedPoolError::InvalidThreshold
    );

    // Reject default (all-zero) pubkeys
    let default_key = Pubkey::default();
    for key in &new_verifiers {
        require!(
            *key != default_key,
            ShieldedPoolError::DefaultVerifierKey
        );
    }

    // Reject duplicates (O(n²) is fine for n ≤ 8)
    for i in 0..new_verifiers.len() {
        for j in (i + 1)..new_verifiers.len() {
            require!(
                new_verifiers[i] != new_verifiers[j],
                ShieldedPoolError::DuplicateVerifier
            );
        }
    }

    // ── Track pause state change for events ──────────────────────
    let was_paused = config.paused;

    // ── Atomic update ────────────────────────────────────────────
    config.threshold = new_threshold;
    config.verifier_pubkeys = new_verifiers;
    config.paused = paused;

    msg!(
        "config: verifier set updated, threshold={}, count={}, paused={}",
        config.threshold,
        config.verifier_pubkeys.len(),
        config.paused
    );

    emit!(VerifierConfigUpdated {
        admin: admin_key,
        threshold: config.threshold,
        verifier_count: config.verifier_pubkeys.len() as u8,
        paused: config.paused,
    });

    // ── Pause/unpause events ─────────────────────────────────────
    if !was_paused && paused {
        emit!(ProtocolPaused { admin: admin_key });
        msg!("config: protocol paused by admin");
    } else if was_paused && !paused {
        emit!(ProtocolUnpaused { admin: admin_key });
        msg!("config: protocol unpaused by admin");
    }

    Ok(())
}
