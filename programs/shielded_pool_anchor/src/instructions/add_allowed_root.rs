use anchor_lang::prelude::*;

use crate::errors::ShieldedPoolError;
use crate::state::{VerifierConfig, MAX_ROOTS};

#[derive(Accounts)]
pub struct AddAllowedRoot<'info> {
    pub root_submitter: Signer<'info>,

    #[account(
        mut,
        seeds = [b"verifier_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, VerifierConfig>,
}

pub fn handler(ctx: Context<AddAllowedRoot>, root: [u8; 32]) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        ctx.accounts.root_submitter.key() == config.root_submitter_authority,
        ShieldedPoolError::UnauthorizedRootSubmitter
    );
    require!(root != [0u8; 32], ShieldedPoolError::DefaultMerkleRoot);
    require!(
        !config.allowed_roots.iter().any(|r| r == &root),
        ShieldedPoolError::DuplicateMerkleRoot
    );
    require!(
        config.allowed_roots.len() < MAX_ROOTS,
        ShieldedPoolError::MerkleRootSetFull
    );

    config.allowed_roots.push(root);

    msg!(
        "config: allowed_roots += 1, count={}",
        config.allowed_roots.len()
    );

    Ok(())
}
