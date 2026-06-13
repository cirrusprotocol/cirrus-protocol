use anchor_lang::prelude::*;

use crate::errors::ShieldedPoolError;
use crate::state::VerifierConfig;

#[derive(Accounts)]
pub struct RemoveAllowedRoot<'info> {
    pub root_submitter: Signer<'info>,

    #[account(
        mut,
        seeds = [b"verifier_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, VerifierConfig>,
}

pub fn handler(ctx: Context<RemoveAllowedRoot>, root: [u8; 32]) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        ctx.accounts.root_submitter.key() == config.root_submitter_authority,
        ShieldedPoolError::UnauthorizedRootSubmitter
    );

    let pos = config
        .allowed_roots
        .iter()
        .position(|r| r == &root)
        .ok_or(ShieldedPoolError::MerkleRootNotFound)?;

    config.allowed_roots.remove(pos);

    msg!(
        "config: allowed_roots -= 1, count={}",
        config.allowed_roots.len()
    );

    Ok(())
}
