use anchor_lang::prelude::*;

use crate::errors::ShieldedPoolError;
use crate::state::{NoteTreeState, VerifierConfig, NOTE_TREE_DEPTH};

#[derive(Accounts)]
pub struct InitNoteTree<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"verifier_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, VerifierConfig>,

    #[account(
        init,
        payer = admin,
        space = NoteTreeState::LEN,
        seeds = [b"note_tree"],
        bump
    )]
    pub note_tree_state: Account<'info, NoteTreeState>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitNoteTree>) -> Result<()> {
    require!(
        ctx.accounts.admin.key() == ctx.accounts.config.admin_authority,
        ShieldedPoolError::UnauthorizedAdmin
    );

    let tree = &mut ctx.accounts.note_tree_state;
    tree.leaf_count = 0;
    tree.tree_depth = NOTE_TREE_DEPTH;
    tree.bump = ctx.bumps.note_tree_state;
    tree.padding = [0u8; 6];

    msg!(
        "init_note_tree: depth={}, pda={}",
        NOTE_TREE_DEPTH,
        ctx.accounts.note_tree_state.key()
    );

    Ok(())
}
