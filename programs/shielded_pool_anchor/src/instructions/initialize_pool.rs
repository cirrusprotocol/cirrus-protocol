use anchor_lang::prelude::*;

use crate::state::PoolState;

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = PoolState::LEN,
        seeds = [b"pool_state"],
        bump
    )]
    pub pool_state: Account<'info, PoolState>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializePool>) -> Result<()> {
    let pool = &mut ctx.accounts.pool_state;

    pool.authority = ctx.accounts.authority.key();
    pool.total_deposits = 0;
    pool.total_withdrawals = 0;
    pool.bump = ctx.bumps.pool_state;

    Ok(())
}