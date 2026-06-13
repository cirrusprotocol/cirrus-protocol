//! State structures for the shielded pool program.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

/// Error type for state operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateError {
    /// Invalid account data or serialization error
    InvalidAccountData,
}

impl From<borsh::io::Error> for StateError {
    fn from(_: borsh::io::Error) -> Self {
        StateError::InvalidAccountData
    }
}

/// Nullifier type: a 32-byte identifier that prevents double-spending.
pub type Nullifier = [u8; 32];

/// Pool state tracking deposits and withdrawals.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct PoolState {
    pub authority: Pubkey,
    pub total_deposits: u64,
    pub total_withdrawals: u64,
}

impl PoolState {
    pub const fn size() -> usize {
        32 + 8 + 8
    }
}

/// Verifier configuration (Gatekeeper + Committee / future update layer).
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct VerifierConfig {
    /// Admin authority that can update verifiers and roots
    pub admin_authority: Pubkey,
    /// Dedicated Gatekeeper (Attester) public key
    pub attester_pubkey: Pubkey,
    /// Chain ID (protocol version identifier)
    pub chain_id: u64,
    /// Emergency stop flag
    pub paused: bool,
    /// Allowed merkle roots (sorted + deduped)
    pub allowed_roots: Vec<[u8; 32]>,
    /// Verifier committee (sorted + deduped)
    pub verifier_pubkeys: Vec<Pubkey>,
    /// k-of-n threshold
    pub threshold: u8,
}

impl VerifierConfig {
    pub const MAX_ROOTS: usize = 100;
    pub const MAX_VERIFIERS: usize = 8;

    pub fn new(
        admin_authority: Pubkey,
        attester_pubkey: Pubkey,
        verifier_pubkeys: Vec<Pubkey>,
        threshold: u8,
        chain_id: u64,
    ) -> Result<Self, StateError> {
        let mut cfg = Self {
            admin_authority,
            attester_pubkey,
            chain_id,
            paused: false,
            allowed_roots: Vec::new(),
            verifier_pubkeys,
            threshold,
        };

        cfg.validate_and_normalize()?;
        Ok(cfg)
    }

    pub fn validate_and_normalize(&mut self) -> Result<(), StateError> {
        self.allowed_roots.sort();
        self.allowed_roots.dedup();

        self.verifier_pubkeys.sort();
        self.verifier_pubkeys.dedup();

        if self.threshold == 0 {
            return Err(StateError::InvalidAccountData);
        }
        if self.admin_authority == Pubkey::default() {
            return Err(StateError::InvalidAccountData);
        }
        if self.attester_pubkey == Pubkey::default() {
            return Err(StateError::InvalidAccountData);
        }
        if self.verifier_pubkeys.len() > Self::MAX_VERIFIERS {
            return Err(StateError::InvalidAccountData);
        }
        if self.allowed_roots.len() > Self::MAX_ROOTS {
            return Err(StateError::InvalidAccountData);
        }
        if (self.threshold as usize) > self.verifier_pubkeys.len() {
            return Err(StateError::InvalidAccountData);
        }

        Ok(())
    }

    pub fn is_root_allowed(&self, root: &[u8; 32]) -> bool {
        self.allowed_roots.binary_search(root).is_ok()
    }

    pub fn is_verifier(&self, pubkey: &Pubkey) -> bool {
        self.verifier_pubkeys.binary_search(pubkey).is_ok()
    }

    pub fn add_allowed_root(&mut self, root: [u8; 32]) -> Result<(), StateError> {
        if self.is_root_allowed(&root) {
            return Ok(());
        }
        if self.allowed_roots.len() >= Self::MAX_ROOTS {
            return Err(StateError::InvalidAccountData);
        }

        match self.allowed_roots.binary_search(&root) {
            Ok(_) => Ok(()),
            Err(pos) => {
                self.allowed_roots.insert(pos, root);
                Ok(())
            }
        }
    }

    pub fn add_verifier(&mut self, verifier: Pubkey) -> Result<(), StateError> {
        if self.is_verifier(&verifier) {
            return Ok(());
        }
        if self.verifier_pubkeys.len() >= Self::MAX_VERIFIERS {
            return Err(StateError::InvalidAccountData);
        }

        match self.verifier_pubkeys.binary_search(&verifier) {
            Ok(_) => Ok(()),
            Err(pos) => {
                self.verifier_pubkeys.insert(pos, verifier);
                // Invariant check: threshold cannot be higher than committee size
                if (self.threshold as usize) > self.verifier_pubkeys.len() {
                    return Err(StateError::InvalidAccountData);
                }
                Ok(())
            }
        }
    }

    pub fn remove_verifier(&mut self, verifier: &Pubkey) -> Result<bool, StateError> {
        let pos = match self.verifier_pubkeys.binary_search(verifier) {
            Ok(p) => p,
            Err(_) => return Ok(false),
        };

        // FAIL CLOSED: threshold invariant check
        let new_len = self.verifier_pubkeys.len() - 1;
        if (self.threshold as usize) > new_len {
            return Err(StateError::InvalidAccountData);
        }

        self.verifier_pubkeys.remove(pos);
        Ok(true)
    }

    pub fn remove_allowed_root(&mut self, root: &[u8; 32]) -> bool {
        match self.allowed_roots.binary_search(root) {
            Ok(pos) => {
                self.allowed_roots.remove(pos);
                true
            }
            Err(_) => false,
        }
    }

    /// Conservative upper bound for account allocation (includes outer 4-byte prefix)
    pub const fn estimated_size() -> usize {
        4 + // outer payload length prefix
        32 + 32 + 8 + 1 + 1 + // scalars/pubkeys
        4 + (32 * Self::MAX_ROOTS) + // allowed_roots vec
        4 + (32 * Self::MAX_VERIFIERS) // verifier_pubkeys vec
    }

    pub fn store_into_account(&self, data: &mut [u8]) -> Result<(), StateError> {
        let mut buf = Vec::new();
        self.serialize(&mut buf)?;
        let len = buf.len();

        if len + 4 > data.len() {
            return Err(StateError::InvalidAccountData);
        }

        data[..4].copy_from_slice(&(len as u32).to_le_bytes());
        data[4..4 + len].copy_from_slice(&buf);
        data[4 + len..].fill(0); // Clear trailing bytes for determinism

        Ok(())
    }

    pub fn load_from_account(data: &[u8]) -> Result<Self, StateError> {
        if data.len() < 4 {
            return Err(StateError::InvalidAccountData);
        }

        let mut len_bytes = [0u8; 4];
        len_bytes.copy_from_slice(&data[..4]);
        let len = u32::from_le_bytes(len_bytes) as usize;

        if 4 + len > data.len() {
            return Err(StateError::InvalidAccountData);
        }

        let slice = &data[4..4 + len];
        let mut config = Self::try_from_slice(slice)?;
        config.validate_and_normalize()?;
        Ok(config)
    }
}

/// Persistent on-chain set tracking used nullifiers.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct NullifierSet {
    pub used_nullifiers: Vec<Nullifier>,
}

impl NullifierSet {
    pub fn new() -> Self {
        Self { used_nullifiers: Vec::new() }
    }

    pub fn contains(&self, nullifier: &Nullifier) -> bool {
        self.used_nullifiers.binary_search(nullifier).is_ok()
    }

    pub fn insert(&mut self, nullifier: Nullifier) {
        match self.used_nullifiers.binary_search(&nullifier) {
            Ok(_) => {}
            Err(pos) => {
                self.used_nullifiers.insert(pos, nullifier);
            }
        }
    }

    pub fn store_into_account(&self, data: &mut [u8]) -> Result<(), StateError> {
        let mut buf = Vec::new();
        self.serialize(&mut buf)?;
        let len = buf.len();

        if len + 4 > data.len() {
            return Err(StateError::InvalidAccountData);
        }

        data[..4].copy_from_slice(&(len as u32).to_le_bytes());
        data[4..4 + len].copy_from_slice(&buf);
        data[4 + len..].fill(0); // Clear trailing bytes
        Ok(())
    }

    pub fn load_from_account(data: &[u8]) -> Result<Self, StateError> {
        if data.len() < 4 {
            return Err(StateError::InvalidAccountData);
        }

        let mut len_bytes = [0u8; 4];
        len_bytes.copy_from_slice(&data[..4]);
        let len = u32::from_le_bytes(len_bytes) as usize;

        if 4 + len > data.len() {
            return Err(StateError::InvalidAccountData);
        }

        let slice = &data[4..4 + len];
        let mut set = Self::try_from_slice(slice)?;
        set.used_nullifiers.sort();
        Ok(set)
    }
}

// ============================================================
// ATTESTATION MESSAGE DEFINITION
// ============================================================

pub const ATTEST_MSG_LEN: usize = 160;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestationMessageV1 {
    pub domain_sep: [u8; 8],
    pub program_id: [u8; 32],
    pub context_id: [u8; 8],
    pub intent_hash: [u8; 32],
    pub commitment: [u8; 32],
    pub nullifier: [u8; 32],
    pub expiry_slot: u64,
    pub nonce: u64,
}

impl AttestationMessageV1 {
    pub fn to_bytes(&self) -> [u8; ATTEST_MSG_LEN] {
        let mut out = [0u8; ATTEST_MSG_LEN];
        let mut i = 0;

        out[i..i+8].copy_from_slice(&self.domain_sep); i += 8;
        out[i..i+32].copy_from_slice(&self.program_id); i += 32;
        out[i..i+8].copy_from_slice(&self.context_id); i += 8;
        out[i..i+32].copy_from_slice(&self.intent_hash); i += 32;
        out[i..i+32].copy_from_slice(&self.commitment); i += 32;
        out[i..i+32].copy_from_slice(&self.nullifier); i += 32;
        out[i..i+8].copy_from_slice(&self.expiry_slot.to_le_bytes()); i += 8;
        out[i..i+8].copy_from_slice(&self.nonce.to_le_bytes()); i += 8;

        debug_assert_eq!(i, ATTEST_MSG_LEN);
        out
    }

    pub fn from_bytes(bytes: &[u8; ATTEST_MSG_LEN]) -> Self {
        let mut i = 0;
        let mut take = |n: usize| { let s = &bytes[i..i+n]; i += n; s };

        Self {
            domain_sep: take(8).try_into().unwrap(),
            program_id: take(32).try_into().unwrap(),
            context_id: take(8).try_into().unwrap(),
            intent_hash: take(32).try_into().unwrap(),
            commitment: take(32).try_into().unwrap(),
            nullifier: take(32).try_into().unwrap(),
            expiry_slot: u64::from_le_bytes(take(8).try_into().unwrap()),
            nonce: u64::from_le_bytes(take(8).try_into().unwrap()),
        }
    }
}
