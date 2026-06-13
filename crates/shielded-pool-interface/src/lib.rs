//! Shared interface crate for shielded pool program.
//! This crate provides types and constants shared between on-chain program and off-chain tooling.
//! It does NOT include the program entrypoint or declare_id!.

pub mod instruction;
pub mod state;
pub mod commitment;
pub mod pda;

// Re-export commonly used types
pub use instruction::{ShieldedPoolInstruction, WithdrawalIntent, WithdrawalIntentV1};
pub use state::{PoolState, VerifierConfig, NullifierSet, Nullifier, StateError};
// NOTE: this re-exports commitment::compute_intent_hash_v1 (SHA-256, legacy domain tag).
// The canonical V1 intent hash used by the current Anchor alpha is
// instruction::compute_intent_hash_v1 (Keccak256, SHIELDED_POOL_INTENT_V1 tag).
// These are different functions with different outputs.
pub use commitment::{Commitment, compute_withdraw_commitment_v1, compute_intent_hash_v1};
pub use pda::{pool_state_pda, nullifier_set_pda, verifier_config_pda};

// PDA seeds (constants)
pub const POOL_STATE_SEED: &[u8] = b"pool_state";
pub const NULLIFIER_SET_SEED: &[u8] = b"nullifier_set";
pub const VERIFIER_CONFIG_SEED: &[u8] = b"verifier_config";

// Parity test infrastructure: tests/parity_canonical.ts (21 tests).
// Run with: anchor run test_parity
