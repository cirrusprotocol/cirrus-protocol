use anchor_lang::prelude::*;

pub const DISCRIMINATOR_SIZE: usize = 8;
pub const MAX_VERIFIERS: usize = 8;
pub const MAX_ROOTS: usize = 10;
pub const MAX_NULLIFIERS: usize = 1024;
pub const NOTE_TREE_DEPTH: u8 = 20;

#[account]
pub struct PoolState {
    pub authority: Pubkey,
    pub total_deposits: u64,
    pub total_withdrawals: u64,
    pub bump: u8,
}

impl PoolState {
    pub const LEN: usize = DISCRIMINATOR_SIZE + 32 + 8 + 8 + 1;
}

#[account]
pub struct NullifierMarker {
    pub used: bool,
}

impl NullifierMarker {
    pub const LEN: usize = DISCRIMINATOR_SIZE + 1;
}

#[account]
pub struct NoteTreeState {
    pub leaf_count: u64,
    pub tree_depth: u8,
    pub bump: u8,
    pub padding: [u8; 6],
}

impl NoteTreeState {
    pub const LEN: usize = DISCRIMINATOR_SIZE + 8 + 1 + 1 + 6;
}

#[account]
pub struct VerifierConfig {
    pub admin_authority: Pubkey,
    pub attester_pubkey: Pubkey,
    pub root_submitter_authority: Pubkey,
    pub chain_id: u64,
    pub paused: bool,
    pub threshold: u8,
    pub verifier_pubkeys: Vec<Pubkey>,
    pub allowed_roots: Vec<[u8; 32]>,
    pub bump: u8,
}

impl VerifierConfig {
    pub const LEN: usize = DISCRIMINATOR_SIZE
        + 32  // admin_authority
        + 32  // attester_pubkey
        + 32  // root_submitter_authority
        + 8   // chain_id
        + 1   // paused
        + 1   // threshold
        + 4 + (32 * MAX_VERIFIERS)
        + 4 + (32 * MAX_ROOTS)
        + 1;  // bump
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct WithdrawIntent {
    pub commitment: [u8; 32],
    pub nullifier: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub relayer: Pubkey,
    pub chain_id: u64,
    pub nonce: u64,
    pub audit_hash: [u8; 32],
    pub policy_id: u8,
    pub merkle_root: [u8; 32],
}

// ── Events (Phase 1 hardening) ──────────────────────────────────

#[event]
pub struct WithdrawExecuted {
    pub intent_hash: [u8; 32],
    pub handshake_hash: [u8; 32],
    pub nullifier: [u8; 32],
    pub recipient: Pubkey,
    pub relayer: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub signer_count: u8,
    pub threshold: u8,
    pub slot: u64,
}

#[event]
pub struct VerifierConfigUpdated {
    pub admin: Pubkey,
    pub threshold: u8,
    pub verifier_count: u8,
    pub paused: bool,
}

#[event]
pub struct ProtocolPaused {
    pub admin: Pubkey,
}

#[event]
pub struct ProtocolUnpaused {
    pub admin: Pubkey,
}

#[event]
pub struct NullifierConsumed {
    pub nullifier: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct DepositReceived {
    pub depositor: Pubkey,
    pub amount: u64,
    pub slot: u64,
}

#[event]
pub struct NoteDeposited {
    pub commitment: [u8; 32],
    pub denomination: u64,
    pub leaf_index: u64,
    pub depositor: Pubkey,
    pub slot: u64,
}

#[event]
pub struct ZkWithdrawExecuted {
    pub nullifier_hash: [u8; 32],
    pub recipient: Pubkey,
    pub relayer: Pubkey,
    pub denomination: u64,
    pub fee: u64,
    pub circuit_version: u64,
    pub slot: u64,
}