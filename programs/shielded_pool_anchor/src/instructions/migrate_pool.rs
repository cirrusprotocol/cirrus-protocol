use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::ShieldedPoolError;
use crate::migration::{CURRENT_CONFIG_LEN, CURRENT_POOL_LEN, LEGACY_CONFIG_LEN, LEGACY_POOL_LEN};
use crate::state::{PoolState, VerifierConfig};

#[derive(Accounts)]
pub struct MigratePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: PDA ownership is verified via seeds constraint.
    /// Data may be in legacy 17-byte layout; deserialization is performed manually.
    #[account(
        mut,
        seeds = [b"pool_state"],
        bump,
    )]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: PDA ownership is verified via seeds constraint.
    /// Admin authority is read from bytes [8..40], valid for both legacy and current layouts.
    #[account(
        seeds = [b"verifier_config"],
        bump,
    )]
    pub config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MigratePool>, authority: Pubkey) -> Result<()> {
    // ── Verify admin authorization via config ─────────────────────────────────
    {
        let config_data = ctx.accounts.config.data.borrow();
        let config_len = config_data.len();

        require!(
            config_len == LEGACY_CONFIG_LEN || config_len == CURRENT_CONFIG_LEN,
            ShieldedPoolError::UnexpectedAccountSize
        );
        require!(
            &config_data[0..8] == VerifierConfig::DISCRIMINATOR,
            ShieldedPoolError::InvalidAccountData
        );
        // admin_authority is at [8..40] in both legacy (311-byte) and current (667-byte) layouts.
        let admin_authority =
            Pubkey::from(<[u8; 32]>::try_from(&config_data[8..40]).unwrap());
        require_keys_eq!(
            ctx.accounts.admin.key(),
            admin_authority,
            ShieldedPoolError::UnauthorizedAdmin
        );
    } // config borrow dropped here

    let pool_state = &ctx.accounts.pool_state;

    // Copy bytes before any mutation; RefCell borrow is released at end of let.
    let old_data: Vec<u8> = pool_state.data.borrow().to_vec();
    let old_len = old_data.len();

    if old_len == CURRENT_POOL_LEN {
        return err!(ShieldedPoolError::AlreadyMigrated);
    }
    if old_len != LEGACY_POOL_LEN {
        return err!(ShieldedPoolError::UnexpectedAccountSize);
    }

    let migrated = crate::migration::migrate_pool_bytes(
        &old_data,
        authority,
        ctx.bumps.pool_state,
    )?;

    // Rent top-up: admin covers any additional lamports required by the larger account.
    let rent = Rent::get()?;
    let required = rent.minimum_balance(PoolState::LEN);
    let current = pool_state.lamports();
    let top_up = required.saturating_sub(current);

    if top_up > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program::ID,
                system_program::Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: pool_state.to_account_info(),
                },
            ),
            top_up,
        )?;
    }

    pool_state.resize(PoolState::LEN)?;

    pool_state.data.borrow_mut().copy_from_slice(&migrated);

    msg!(
        "migrate_pool: {} → {} bytes, authority={}",
        old_len,
        PoolState::LEN,
        authority,
    );

    Ok(())
}
