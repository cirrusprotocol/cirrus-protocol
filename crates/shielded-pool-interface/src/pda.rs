//! Program Derived Address (PDA) helpers for the shielded pool program.
//! These functions provide a single source of truth for PDA derivation.

use solana_program::pubkey::Pubkey;

use crate::{POOL_STATE_SEED, NULLIFIER_SET_SEED, VERIFIER_CONFIG_SEED};

/// Derive the Pool State PDA for a given program ID.
/// Returns (pubkey, bump_seed).
pub fn pool_state_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POOL_STATE_SEED], program_id)
}

/// Derive the Nullifier Set PDA for a given program ID.
/// Returns (pubkey, bump_seed).
pub fn nullifier_set_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[NULLIFIER_SET_SEED], program_id)
}

/// Derive the Verifier Config PDA for a given program ID.
/// Returns (pubkey, bump_seed).
pub fn verifier_config_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VERIFIER_CONFIG_SEED], program_id)
}
