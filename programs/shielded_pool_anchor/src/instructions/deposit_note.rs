use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::{is_canonical_fr, ALLOWED_BUCKET_AMOUNTS};
use crate::errors::ShieldedPoolError;
use crate::state::{NoteDeposited, NoteTreeState, PoolState, VerifierConfig, NOTE_TREE_DEPTH};

#[derive(Accounts)]
pub struct DepositNote<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state"],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(seeds = [b"verifier_config"], bump = config.bump)]
    pub config: Account<'info, VerifierConfig>,

    #[account(
        mut,
        seeds = [b"note_tree"],
        bump = note_tree_state.bump,
        constraint = note_tree_state.tree_depth == NOTE_TREE_DEPTH
            @ ShieldedPoolError::InvalidTreeDepth
    )]
    pub note_tree_state: Account<'info, NoteTreeState>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<DepositNote>,
    commitment: [u8; 32],
    denomination: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, ShieldedPoolError::Paused);
    require!(commitment != [0u8; 32], ShieldedPoolError::InvalidCommitment);
    require!(
        is_canonical_fr(&commitment),
        ShieldedPoolError::NonCanonicalCommitment
    );
    require!(
        ALLOWED_BUCKET_AMOUNTS.contains(&denomination),
        ShieldedPoolError::InvalidDenomination
    );

    let capacity: u64 = 1u64 << ctx.accounts.note_tree_state.tree_depth;
    require!(
        ctx.accounts.note_tree_state.leaf_count < capacity,
        ShieldedPoolError::TreeFull
    );

    let leaf_index = ctx.accounts.note_tree_state.leaf_count;

    system_program::transfer(
        CpiContext::new(
            system_program::ID,
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.pool_state.to_account_info(),
            },
        ),
        denomination,
    )?;

    let pool_state = &mut ctx.accounts.pool_state;
    pool_state.total_deposits = pool_state
        .total_deposits
        .checked_add(denomination)
        .ok_or(ShieldedPoolError::ArithmeticOverflow)?;

    let note_tree_state = &mut ctx.accounts.note_tree_state;
    note_tree_state.leaf_count = note_tree_state
        .leaf_count
        .checked_add(1)
        .ok_or(ShieldedPoolError::TreeFull)?;

    let clock = Clock::get()?;
    emit!(NoteDeposited {
        commitment,
        denomination,
        leaf_index,
        depositor: ctx.accounts.depositor.key(),
        slot: clock.slot,
    });

    msg!(
        "deposit_note: leaf_index={}, denomination={}, slot={}",
        leaf_index,
        denomination,
        clock.slot
    );

    Ok(())
}
