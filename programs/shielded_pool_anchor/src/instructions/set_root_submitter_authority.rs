use anchor_lang::prelude::*;

use crate::errors::ShieldedPoolError;
use crate::state::VerifierConfig;

#[derive(Accounts)]
pub struct SetRootSubmitterAuthority<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"verifier_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, VerifierConfig>,
}

pub fn handler(
    ctx: Context<SetRootSubmitterAuthority>,
    new_root_submitter: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        ctx.accounts.admin.key() == config.admin_authority,
        ShieldedPoolError::UnauthorizedAdmin
    );
    require!(
        new_root_submitter != Pubkey::default(),
        ShieldedPoolError::InvalidRootSubmitterAuthority
    );

    let old = config.root_submitter_authority;
    config.root_submitter_authority = new_root_submitter;

    msg!(
        "config: root_submitter_authority updated, old={}, new={}",
        old,
        new_root_submitter,
    );

    Ok(())
}
