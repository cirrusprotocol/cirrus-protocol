use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::state::VerifierConfig;

#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: PDA ownership is verified via seeds constraint.
    /// Data may be in legacy 311-byte layout; deserialization is performed manually.
    #[account(
        mut,
        seeds = [b"verifier_config"],
        bump,
    )]
    pub config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MigrateConfig>, attester_pubkey: Pubkey) -> Result<()> {
    let config = &ctx.accounts.config;

    // Copy bytes before any mutation; RefCell borrow is released at end of let.
    let old_data: Vec<u8> = config.data.borrow().to_vec();
    let old_len = old_data.len();

    // migrate_config_bytes handles four cases:
    //   CURRENT_CONFIG_LEN (699) + canonical → AlreadyMigrated
    //   PREV_CONFIG_LEN    (667) + canonical → shift fields, insert root_submitter=admin
    //   PREV_CONFIG_LEN    (667) + malformed → repair layout, set root_submitter=admin
    //   LEGACY_CONFIG_LEN  (311)             → full migration, root_submitter=admin
    //   any other size                       → UnexpectedAccountSize
    let migrated = crate::migration::migrate_config_bytes(
        &old_data,
        attester_pubkey,
        ctx.bumps.config,
        ctx.accounts.admin.key(),
    )?;

    if old_len != VerifierConfig::LEN {
        // Upgrading from legacy 311-byte layout: top up rent and resize.
        let rent = Rent::get()?;
        let required = rent.minimum_balance(VerifierConfig::LEN);
        let current = config.lamports();
        let top_up = required.saturating_sub(current);

        if top_up > 0 {
            system_program::transfer(
                CpiContext::new(
                    system_program::ID,
                    system_program::Transfer {
                        from: ctx.accounts.admin.to_account_info(),
                        to: config.to_account_info(),
                    },
                ),
                top_up,
            )?;
        }

        config.resize(VerifierConfig::LEN)?;
    }

    config.data.borrow_mut().copy_from_slice(&migrated);

    msg!(
        "migrate_config: {} → {} bytes, admin={}, attester={}",
        old_len,
        VerifierConfig::LEN,
        ctx.accounts.admin.key(),
        attester_pubkey,
    );

    Ok(())
}
