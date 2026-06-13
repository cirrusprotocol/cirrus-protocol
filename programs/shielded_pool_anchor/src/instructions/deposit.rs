use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::ShieldedPoolError;
use crate::state::{DepositReceived, PoolState};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state"],
        bump = pool_state.bump
    )]
    pub pool_state: Account<'info, PoolState>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, ShieldedPoolError::InvalidDepositAmount);

    system_program::transfer(
        CpiContext::new(
            system_program::ID,
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.pool_state.to_account_info(),
            },
        ),
        amount,
    )?;

    let pool_state = &mut ctx.accounts.pool_state;
    pool_state.total_deposits = pool_state
        .total_deposits
        .checked_add(amount)
        .ok_or(ShieldedPoolError::ArithmeticOverflow)?;

    let clock = Clock::get()?;

    emit!(DepositReceived {
        depositor: ctx.accounts.depositor.key(),
        amount,
        slot: clock.slot,
    });

    msg!(
        "deposit: {} lamports, depositor={}, slot={}",
        amount,
        ctx.accounts.depositor.key(),
        clock.slot
    );

    Ok(())
}
