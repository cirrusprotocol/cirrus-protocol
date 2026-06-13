
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::AccountInfo,
    ed25519_program,
    keccak,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};

use crate::commitment::Commitment;
use crate::state::Nullifier;

// -----------------------------------------------------------------------------
// Canonical V1 hashing constants
// -----------------------------------------------------------------------------
pub const INTENT_PREIMAGE_SIZE: usize = 248;
pub const HANDSHAKE_PREIMAGE_SIZE: usize = 196;

pub const INTENT_DOMAIN_TAG: &[u8; 23] = b"SHIELDED_POOL_INTENT_V1";
pub const HANDSHAKE_DOMAIN_TAG: &[u8; 26] = b"SHIELDED_POOL_HANDSHAKE_V1";
pub const PROTOCOL_VERSION_BYTE: u8 = 0x10;

// Legacy aliases retained for compatibility with older call sites.
pub const TAG_INTENT: &[u8; 23] = INTENT_DOMAIN_TAG;
pub const TAG_HANDSHAKE: &[u8; 26] = HANDSHAKE_DOMAIN_TAG;

pub const INTENT_TOTAL_SIZE: usize = INTENT_PREIMAGE_SIZE;
pub const HS_TOTAL_SIZE: usize = HANDSHAKE_PREIMAGE_SIZE;

// -----------------------------------------------------------------------------
// Legacy Ed25519 attestation parser (single-signer, not used by current Anchor program)
//
// The current Anchor program uses a multi-threshold attestation parser in
// programs/shielded_pool_anchor/src/instructions/attestation.rs.
// This function is retained for off-chain tooling reference only.
// -----------------------------------------------------------------------------
const ED25519_IX_DATA_LEN: usize = 272;
const MSG_SIZE: usize = 160;

const OFFSET_NUM_SIGS: usize = 0;
const OFFSET_SIG_OFFSET: usize = 2; // u16
const OFFSET_SIG_IX: usize = 4; // u16
const OFFSET_PUBKEY_OFFSET: usize = 6; // u16
const OFFSET_PUBKEY_IX: usize = 8; // u16
const OFFSET_MSG_OFFSET: usize = 10; // u16
const OFFSET_MSG_SIZE: usize = 12; // u16
const OFFSET_MSG_IX: usize = 14; // u16

const EXPECTED_PUBKEY_OFFSET: u16 = 16;
const EXPECTED_SIG_OFFSET: u16 = 48;
const EXPECTED_MSG_OFFSET: u16 = 112;
const EXPECTED_MSG_SIZE: u16 = 160;
const CURRENT_IX_FLAG: u16 = u16::MAX;

/// Legacy single-signer Ed25519 attestation parser (not called by current Anchor program).
///
/// Parses and verifies a single predecessor Ed25519 instruction. Requires exactly
/// one signature from a specific attester key.
///
/// The current Anchor alpha uses multi-threshold attestation
/// (`attestation.rs`) which accepts up to MAX_VERIFIERS signatures and enforces
/// a configurable threshold. This function is retained for off-chain tooling reference.
pub fn get_attestation_message_from_prev_ed25519_ix(
    instruction_sysvar_account: &AccountInfo,
    expected_attester: &Pubkey,
) -> Result<[u8; MSG_SIZE], ProgramError> {
    let current_index = load_current_index_checked(instruction_sysvar_account)?;
    if current_index == 0 {
        msg!("Error: No predecessor instruction found.");
        return Err(ProgramError::InvalidInstructionData);
    }

    let prev_ix = load_instruction_at_checked(
        (current_index - 1) as usize,
        instruction_sysvar_account,
    )?;

    if prev_ix.program_id != ed25519_program::id() {
        msg!("Error: Predecessor is not Ed25519 program.");
        return Err(ProgramError::IncorrectProgramId);
    }

    if prev_ix.data.len() != ED25519_IX_DATA_LEN {
        msg!(
            "Error: Ed25519 instruction data length mismatch. Expected 272, got {}",
            prev_ix.data.len()
        );
        return Err(ProgramError::InvalidInstructionData);
    }

    let data = &prev_ix.data;

    if data[OFFSET_NUM_SIGS] != 1 {
        msg!("Error: Ed25519 num_sigs must be 1.");
        return Err(ProgramError::InvalidInstructionData);
    }

    let read_u16 = |start: usize| -> Result<u16, ProgramError> {
        if start + 2 > data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }
        let mut bytes = [0u8; 2];
        bytes.copy_from_slice(&data[start..start + 2]);
        Ok(u16::from_le_bytes(bytes))
    };

    if read_u16(OFFSET_PUBKEY_OFFSET)? != EXPECTED_PUBKEY_OFFSET {
        return Err(ProgramError::InvalidInstructionData);
    }
    if read_u16(OFFSET_SIG_OFFSET)? != EXPECTED_SIG_OFFSET {
        return Err(ProgramError::InvalidInstructionData);
    }
    if read_u16(OFFSET_MSG_OFFSET)? != EXPECTED_MSG_OFFSET {
        return Err(ProgramError::InvalidInstructionData);
    }
    if read_u16(OFFSET_MSG_SIZE)? != EXPECTED_MSG_SIZE {
        return Err(ProgramError::InvalidInstructionData);
    }

    if read_u16(OFFSET_PUBKEY_IX)? != CURRENT_IX_FLAG {
        return Err(ProgramError::InvalidInstructionData);
    }
    if read_u16(OFFSET_SIG_IX)? != CURRENT_IX_FLAG {
        return Err(ProgramError::InvalidInstructionData);
    }
    if read_u16(OFFSET_MSG_IX)? != CURRENT_IX_FLAG {
        return Err(ProgramError::InvalidInstructionData);
    }

    let pubkey_start = EXPECTED_PUBKEY_OFFSET as usize;
    if pubkey_start + 32 > data.len() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut pubkey_bytes = [0u8; 32];
    pubkey_bytes.copy_from_slice(&data[pubkey_start..pubkey_start + 32]);
    let signer_pubkey = Pubkey::new_from_array(pubkey_bytes);

    if signer_pubkey != *expected_attester {
        msg!(
            "Error: Invalid Attester. Expected {}, got {}",
            expected_attester,
            signer_pubkey
        );
        return Err(ProgramError::InvalidArgument);
    }

    let msg_start = EXPECTED_MSG_OFFSET as usize;
    if msg_start + MSG_SIZE > data.len() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let mut message = [0u8; MSG_SIZE];
    message.copy_from_slice(&data[msg_start..msg_start + MSG_SIZE]);

    Ok(message)
}

// -----------------------------------------------------------------------------
// Legacy withdrawal intent (kept for backwards compatibility)
// -----------------------------------------------------------------------------
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct WithdrawalIntent {
    /// Commitment hash (must match recomputed commitment from other fields)
    pub commitment: Commitment,

    /// Nullifier that prevents double-spending
    pub nullifier: Nullifier,

    /// Recipient public key
    pub recipient: Pubkey,

    /// Withdrawal amount (in lamports)
    pub amount: u64,

    /// Fee paid to relayer (in lamports)
    pub fee: u64,
}

// -----------------------------------------------------------------------------
// Canonical WithdrawalIntentV1
// -----------------------------------------------------------------------------
#[derive(
    BorshSerialize,
    BorshDeserialize,
    Debug,
    Clone,
    PartialEq,
    Eq,
)]
pub struct WithdrawalIntentV1 {
    /// Commitment hash
    pub commitment: [u8; 32],

    /// Nullifier that prevents double-spending
    pub nullifier: [u8; 32],

    /// Recipient public key
    pub recipient: Pubkey,

    /// Withdrawal amount (in lamports)
    pub amount: u64,

    /// Fee paid to relayer (in lamports)
    pub fee: u64,

    /// Relayer public key
    pub relayer: Pubkey,

    /// Chain ID (protocol version identifier)
    pub chain_id: u64,

    /// Nonce for uniqueness
    pub nonce: u64,

    /// Cryptographic binding to off-chain EQE audit
    pub audit_hash: [u8; 32],

    /// Selected execution policy ID
    pub policy_id: u8,

    /// Merkle root binding used by the canonical V1 intent hash
    pub merkle_root: [u8; 32],
}

// -----------------------------------------------------------------------------
// Canonical V1 preimage builders + hashes
// -----------------------------------------------------------------------------
pub const INTENT_OFFSET_TAG: usize = 0;
pub const INTENT_OFFSET_RECIPIENT: usize = 23;
pub const INTENT_OFFSET_RELAYER: usize = 55;
pub const INTENT_OFFSET_AMOUNT: usize = 87;
pub const INTENT_OFFSET_FEE: usize = 95;
pub const INTENT_OFFSET_NONCE: usize = 103;
pub const INTENT_OFFSET_CHAINID: usize = 111;
pub const INTENT_OFFSET_NULLIFIER: usize = 119;
pub const INTENT_OFFSET_COMMITMENT: usize = 151;
pub const INTENT_OFFSET_MERKLEROOT: usize = 183;
pub const INTENT_OFFSET_AUDITHASH: usize = 215;
pub const INTENT_OFFSET_POLICYID: usize = 247;

pub fn build_intent_preimage_v1(
    recipient: &Pubkey,
    relayer: &Pubkey,
    amount: u64,
    fee: u64,
    nonce: u64,
    chain_id: u64,
    nullifier: &[u8; 32],
    commitment: &[u8; 32],
    merkle_root: &[u8; 32],
    audit_hash: &[u8; 32],
    policy_id: u8,
) -> [u8; INTENT_TOTAL_SIZE] {
    let mut buf = [0u8; INTENT_TOTAL_SIZE];

    buf[INTENT_OFFSET_TAG..INTENT_OFFSET_RECIPIENT].copy_from_slice(INTENT_DOMAIN_TAG);
    buf[INTENT_OFFSET_RECIPIENT..INTENT_OFFSET_RELAYER].copy_from_slice(recipient.as_ref());
    buf[INTENT_OFFSET_RELAYER..INTENT_OFFSET_AMOUNT].copy_from_slice(relayer.as_ref());
    buf[INTENT_OFFSET_AMOUNT..INTENT_OFFSET_FEE].copy_from_slice(&amount.to_le_bytes());
    buf[INTENT_OFFSET_FEE..INTENT_OFFSET_NONCE].copy_from_slice(&fee.to_le_bytes());
    buf[INTENT_OFFSET_NONCE..INTENT_OFFSET_CHAINID].copy_from_slice(&nonce.to_le_bytes());
    buf[INTENT_OFFSET_CHAINID..INTENT_OFFSET_NULLIFIER].copy_from_slice(&chain_id.to_le_bytes());
    buf[INTENT_OFFSET_NULLIFIER..INTENT_OFFSET_COMMITMENT].copy_from_slice(nullifier);
    buf[INTENT_OFFSET_COMMITMENT..INTENT_OFFSET_MERKLEROOT].copy_from_slice(commitment);
    buf[INTENT_OFFSET_MERKLEROOT..INTENT_OFFSET_AUDITHASH].copy_from_slice(merkle_root);
    buf[INTENT_OFFSET_AUDITHASH..INTENT_OFFSET_POLICYID].copy_from_slice(audit_hash);
    buf[INTENT_OFFSET_POLICYID] = policy_id;

    buf
}

/// Canonical V1 intent hash used by the new schema.
///
/// Layout:
/// TAG | recipient | relayer | amount | fee | nonce | chain_id | nullifier |
/// commitment | merkle_root | audit_hash | policy_id
pub fn compute_intent_hash_v1(intent: &WithdrawalIntentV1) -> [u8; 32] {
    let preimage = build_intent_preimage_v1(
        &intent.recipient,
        &intent.relayer,
        intent.amount,
        intent.fee,
        intent.nonce,
        intent.chain_id,
        &intent.nullifier,
        &intent.commitment,
        &intent.merkle_root,
        &intent.audit_hash,
        intent.policy_id,
    );

    let mut hash_arr = [0u8; 32];
    hash_arr.copy_from_slice(keccak::hashv(&[&preimage]).as_ref());
    hash_arr
}

/// Backwards-compatible wrapper for callers that still pass a merkle root separately.
pub fn compute_intent_hash_v1_legacy(
    intent: &WithdrawalIntentV1,
    merkle_root: &[u8; 32],
) -> [u8; 32] {
    let preimage = build_intent_preimage_v1(
        &intent.recipient,
        &intent.relayer,
        intent.amount,
        intent.fee,
        intent.nonce,
        intent.chain_id,
        &intent.nullifier,
        &intent.commitment,
        merkle_root,
        &intent.audit_hash,
        intent.policy_id,
    );

    let mut hash_arr = [0u8; 32];
    hash_arr.copy_from_slice(keccak::hashv(&[&preimage]).as_ref());
    hash_arr
}

pub const HS_OFFSET_TAG: usize = 0;
pub const HS_OFFSET_VERSION: usize = 26;
pub const HS_OFFSET_PROGRAMID: usize = 27;
pub const HS_OFFSET_POOLPDA: usize = 59;
pub const HS_OFFSET_CONFIGPDA: usize = 91;
pub const HS_OFFSET_EXPIRY: usize = 123;
pub const HS_OFFSET_AUDITHASH: usize = 131;
pub const HS_OFFSET_INTENTHASH: usize = 163;
pub const HS_OFFSET_POLICYID: usize = 195;

pub fn build_handshake_preimage_v1(
    program_id: &Pubkey,
    pool_pda: &Pubkey,
    config_pda: &Pubkey,
    expiry_slot: u64,
    audit_hash: &[u8; 32],
    intent_hash: &[u8; 32],
    policy_id: u8,
) -> [u8; HS_TOTAL_SIZE] {
    let mut buf = [0u8; HS_TOTAL_SIZE];

    buf[HS_OFFSET_TAG..HS_OFFSET_VERSION].copy_from_slice(HANDSHAKE_DOMAIN_TAG);
    buf[HS_OFFSET_VERSION] = PROTOCOL_VERSION_BYTE;
    buf[HS_OFFSET_PROGRAMID..HS_OFFSET_POOLPDA].copy_from_slice(program_id.as_ref());
    buf[HS_OFFSET_POOLPDA..HS_OFFSET_CONFIGPDA].copy_from_slice(pool_pda.as_ref());
    buf[HS_OFFSET_CONFIGPDA..HS_OFFSET_EXPIRY].copy_from_slice(config_pda.as_ref());
    buf[HS_OFFSET_EXPIRY..HS_OFFSET_AUDITHASH].copy_from_slice(&expiry_slot.to_le_bytes());
    buf[HS_OFFSET_AUDITHASH..HS_OFFSET_INTENTHASH].copy_from_slice(audit_hash);
    buf[HS_OFFSET_INTENTHASH..HS_OFFSET_POLICYID].copy_from_slice(intent_hash);
    buf[HS_OFFSET_POLICYID] = policy_id;

    buf
}

/// Canonical V1 handshake hash used by the new schema.
///
/// Layout:
/// TAG | version | program_id | pool_pda | config_pda | expiry_slot | audit_hash |
/// intent_hash | policy_id
pub fn compute_handshake_hash_v1(
    program_id: &Pubkey,
    pool_pda: &Pubkey,
    config_pda: &Pubkey,
    expiry_slot: u64,
    intent_hash: &[u8; 32],
    audit_hash: &[u8; 32],
    policy_id: u8,
) -> [u8; 32] {
    let preimage = build_handshake_preimage_v1(
        program_id,
        pool_pda,
        config_pda,
        expiry_slot,
        audit_hash,
        intent_hash,
        policy_id,
    );

    let mut hash_arr = [0u8; 32];
    hash_arr.copy_from_slice(keccak::hashv(&[&preimage]).as_ref());
    hash_arr
}

/// Backwards-compatible alias with older parameter order expectations.
pub fn compute_handshake_hash_v1_legacy(
    program_id: &Pubkey,
    pool_pda: &Pubkey,
    config_pda: &Pubkey,
    expiry_slot: u64,
    intent_hash: &[u8; 32],
    audit_hash: &[u8; 32],
    policy_id: u8,
) -> [u8; 32] {
    compute_handshake_hash_v1(
        program_id,
        pool_pda,
        config_pda,
        expiry_slot,
        intent_hash,
        audit_hash,
        policy_id,
    )
}

// -----------------------------------------------------------------------------
// Legacy instruction enum (non-Anchor; not dispatched by current Anchor program)
//
// This enum was used by an earlier non-Anchor version of the program.
// The current Anchor program uses Anchor-generated instruction discriminants and
// does not reference this enum. It is retained here as a type reference for
// off-chain tooling and historical compatibility only.
// -----------------------------------------------------------------------------

/// Legacy shielded pool program instruction set (non-Anchor, not active).
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum ShieldedPoolInstruction {
    /// Initialize pool state + nullifier set PDAs.
    ///
    /// Accounts:
    /// 0. [signer] Pool authority / payer
    /// 1. [writable] Pool state PDA
    /// 2. [writable] Nullifier set PDA
    /// 3. [] System program
    InitializePool,

    /// Process a withdrawal with off-chain verified proof.
    ///
    /// This instruction consumes a WithdrawalIntent and performs on-chain validation:
    /// 1. Commitment matches recomputed hash from intent fields
    /// 2. Nullifier has not been used before
    /// 3. Amount <= pool balance (fee retained in pool)
    /// 4. State transitions are applied atomically
    ///
    /// Accounts:
    /// 0. [signer] User (authority) or relayer
    /// 1. [writable] Pool state PDA
    /// 2. [writable] Nullifier set PDA
    /// 3. [writable] Recipient account
    ///
    /// LEGACY NOTE: This is the single-attester non-Anchor withdraw variant.
    /// The current Anchor program uses multi-threshold Ed25519 attestation via
    /// the `withdraw` instruction, not this enum variant.
    Withdraw {
        intent: WithdrawalIntent,
    },

    /// Initialize verifier configuration (admin-only, Model B: Committee + Threshold).
    ///
    /// Accounts:
    /// 0. [signer] Admin authority
    /// 1. [writable] Verifier config PDA
    /// 2. [] System program
    InitializeConfig {
        admin_authority: Pubkey,
        /// The dedicated Gatekeeper (Attester) public key
        attester_pubkey: Pubkey,
        verifier_pubkeys: Vec<Pubkey>,
        threshold: u8,
        chain_id: u64,
    },

    /// Add verifier to committee (admin-only).
    ///
    /// Accounts:
    /// 0. [signer] Admin authority
    /// 1. [writable] Verifier config PDA
    AddVerifier {
        verifier_pubkey: Pubkey,
    },

    /// Remove verifier from committee (admin-only).
    ///
    /// Accounts:
    /// 0. [signer] Admin authority
    /// 1. [writable] Verifier config PDA
    RemoveVerifier {
        verifier_pubkey: Pubkey,
    },

    /// Set threshold k (admin-only).
    ///
    /// Accounts:
    /// 0. [signer] Admin authority
    /// 1. [writable] Verifier config PDA
    SetThreshold {
        new_threshold: u8,
    },

    /// Add an allowed merkle root (admin-only).
    ///
    /// Accounts:
    /// 0. [signer] Admin authority
    /// 1. [writable] Verifier config PDA
    AddAllowedRoot {
        root: [u8; 32],
    },

    /// Remove an allowed merkle root (admin-only).
    ///
    /// Accounts:
    /// 0. [signer] Admin authority
    /// 1. [writable] Verifier config PDA
    RemoveAllowedRoot {
        root: [u8; 32],
    },

    /// Legacy attested withdrawal variant (non-Anchor, not active).
    ///
    /// Retained for layout reference only. Neither this variant nor `WithdrawZkV1`
    /// is dispatched by the current Anchor program. The current alpha uses
    /// multi-threshold Ed25519 attestation via the Anchor `withdraw` instruction.
    WithdrawAttestedV1 {
        intent: WithdrawalIntentV1,
        merkle_root: [u8; 32],
    },

    /// Legacy ZK withdrawal variant (non-Anchor, prototype only — not active).
    ///
    /// On-chain Groth16 verification is not wired in the current Anchor alpha.
    /// The `proof` field is layout-reserved; no pairing check is performed.
    /// Retained for type reference only.
    WithdrawZkV1 {
        intent: WithdrawalIntentV1,
        merkle_root: [u8; 32],
        /// Slot deadline for this execution binding
        expiry_slot: u64,
        /// Fixed-size proof (Groth16 BN254 = 128 bytes)
        proof: [u8; 128],
    },

    /// Allows recovery of locked liquidity in case of emergency (fail-closed disabled)
    EmergencyWithdrawV1 {
        intent: WithdrawalIntentV1,
        merkle_root: [u8; 32],
        proof: [u8; 128],
    },
}