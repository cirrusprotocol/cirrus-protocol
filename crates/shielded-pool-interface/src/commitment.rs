//! Commitment hashing helpers for the legacy attested intent model.
//!
//! These functions use Solana's SHA-256 `hashv` with their own domain tags and
//! are distinct from the canonical V1 hashing in `instruction.rs` (Keccak256,
//! `SHIELDED_POOL_INTENT_V1` tag). The canonical V1 functions are what the
//! current Anchor alpha and `lib/crypto.ts` use.
//!
//! `compute_intent_hash_v1` exported from this module is NOT the same function
//! as `instruction::compute_intent_hash_v1`; they differ in hash algorithm,
//! domain tag, and preimage layout.

use solana_program::{
    hash::{hashv, Hash},
    pubkey::Pubkey,
};

/// Commitment type: a 32-byte hash commitment.
pub type Commitment = [u8; 32];

/// Domain separation tags for attested intent model
pub const WITHDRAW_COMMIT_V1_TAG: &[u8] = b"SHIELDED_POOL::WITHDRAW_COMMIT_V1";
pub const INTENT_HASH_V1_TAG: &[u8] = b"SHIELDED_POOL::INTENT_HASH_V1";
pub const ATTEST_HASH_V1_TAG: &[u8] = b"SHIELDED_POOL::ATTEST_HASH_V1";

// --- ZK BINDING STUBS (legacy prototype — not active in current Anchor alpha) ---
// Placeholders for a BN254/arkworks ZK circuit integration that was not implemented.
// The current alpha uses Ed25519 threshold attestation, not ZK proof verification.

// --- SOLANA ON-CHAIN HASHING FUNCTIONS ---

/// Compute withdraw commitment with domain separation (V1).
///
/// Format: H("SHIELDED_POOL::WITHDRAW_COMMIT_V1" || recipient || amount || fee || relayer || chain_id || nonce)
pub fn compute_withdraw_commitment_v1(
    recipient: &Pubkey,
    amount: u64,
    fee: u64,
    relayer: &Pubkey,
    chain_id: u64,
    nonce: u64,
) -> Commitment {
    let hash_result: Hash = hashv(&[
        WITHDRAW_COMMIT_V1_TAG,
        recipient.as_ref(),
        &amount.to_le_bytes(),
        &fee.to_le_bytes(),
        relayer.as_ref(),
        &chain_id.to_le_bytes(),
        &nonce.to_le_bytes(),
    ]);

    let mut commitment = [0u8; 32];
    commitment.copy_from_slice(hash_result.as_ref());
    commitment
}

/// Compute intent hash with domain separation (V1).
///
/// Format: H("SHIELDED_POOL::INTENT_HASH_V1" || commitment || nullifier || recipient || amount || fee || relayer || chain_id || nonce)
pub fn compute_intent_hash_v1(
    commitment: &[u8; 32],
    nullifier: &[u8; 32],
    recipient: &Pubkey,
    amount: u64,
    fee: u64,
    relayer: &Pubkey,
    chain_id: u64,
    nonce: u64,
) -> [u8; 32] {
    let hash_result: Hash = hashv(&[
        INTENT_HASH_V1_TAG,
        commitment,
        nullifier,
        recipient.as_ref(),
        &amount.to_le_bytes(),
        &fee.to_le_bytes(),
        relayer.as_ref(),
        &chain_id.to_le_bytes(),
        &nonce.to_le_bytes(),
    ]);

    let mut intent_hash = [0u8; 32];
    intent_hash.copy_from_slice(hash_result.as_ref());
    intent_hash
}
