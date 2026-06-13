use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod migration;
pub mod state;
pub mod zk_hash;
pub mod zk_verifier;
pub mod zk_vk_withdraw_sol_v1;

use instructions::initialize_pool::*;
use instructions::initialize_config::*;
use instructions::update_verifier_config::*;
use instructions::withdraw::*;
use instructions::add_allowed_root::*;
use instructions::remove_allowed_root::*;
use instructions::set_root_submitter_authority::*;
use instructions::migrate_pool::*;
use instructions::migrate_config::*;
use instructions::deposit::*;
use instructions::deposit_note::*;
use instructions::init_note_tree::*;
use instructions::withdraw_zk::*;

use state::WithdrawIntent;

declare_id!("E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq");

#[program]
pub mod shielded_pool_anchor {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>) -> Result<()> {
        instructions::initialize_pool::handler(ctx)
    }

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        attester_pubkey: Pubkey,
        verifier_pubkeys: Vec<Pubkey>,
        threshold: u8,
        chain_id: u64,
    ) -> Result<()> {
        instructions::initialize_config::handler(
            ctx,
            attester_pubkey,
            verifier_pubkeys,
            threshold,
            chain_id,
        )
    }

    pub fn update_verifier_config(
        ctx: Context<UpdateVerifierConfig>,
        new_threshold: u8,
        new_verifiers: Vec<Pubkey>,
        paused: bool,
    ) -> Result<()> {
        instructions::update_verifier_config::handler(
            ctx,
            new_threshold,
            new_verifiers,
            paused,
        )
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
        intent: WithdrawIntent,
        expiry_slot: u64,
    ) -> Result<()> {
        instructions::withdraw::handler(ctx, intent, expiry_slot)
    }

    pub fn add_allowed_root(ctx: Context<AddAllowedRoot>, root: [u8; 32]) -> Result<()> {
        instructions::add_allowed_root::handler(ctx, root)
    }

    pub fn remove_allowed_root(ctx: Context<RemoveAllowedRoot>, root: [u8; 32]) -> Result<()> {
        instructions::remove_allowed_root::handler(ctx, root)
    }

    pub fn set_root_submitter_authority(
        ctx: Context<SetRootSubmitterAuthority>,
        new_root_submitter: Pubkey,
    ) -> Result<()> {
        instructions::set_root_submitter_authority::handler(ctx, new_root_submitter)
    }

    pub fn migrate_pool(ctx: Context<MigratePool>, authority: Pubkey) -> Result<()> {
        instructions::migrate_pool::handler(ctx, authority)
    }

    pub fn migrate_config(ctx: Context<MigrateConfig>, attester_pubkey: Pubkey) -> Result<()> {
        instructions::migrate_config::handler(ctx, attester_pubkey)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    pub fn init_note_tree(ctx: Context<InitNoteTree>) -> Result<()> {
        instructions::init_note_tree::handler(ctx)
    }

    pub fn deposit_note(
        ctx: Context<DepositNote>,
        commitment: [u8; 32],
        denomination: u64,
    ) -> Result<()> {
        instructions::deposit_note::handler(ctx, commitment, denomination)
    }

    pub fn withdraw_zk(
        ctx: Context<WithdrawZk>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
        denomination: u64,
        fee: u64,
        expiry_slot: u64,
        circuit_version: u64,
    ) -> Result<()> {
        instructions::withdraw_zk::handler(
            ctx,
            proof_a,
            proof_b,
            proof_c,
            root,
            nullifier_hash,
            denomination,
            fee,
            expiry_slot,
            circuit_version,
        )
    }
}