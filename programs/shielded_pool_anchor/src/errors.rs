use anchor_lang::prelude::*;

#[error_code]
pub enum ShieldedPoolError {
    #[msg("Contract is paused")]
    Paused,

    #[msg("Invalid chain ID")]
    InvalidChainId,

    #[msg("Settlement expired")]
    SettlementExpired,

    #[msg("Invalid withdrawal amount")]
    InvalidAmount,

    #[msg("Invalid fee")]
    InvalidFee,

    #[msg("Fee too low")]
    FeeTooLow,

    #[msg("Insufficient pool balance")]
    InsufficientPoolBalance,

    #[msg("Nullifier already used")]
    NullifierAlreadyUsed,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("Unauthorized")]
    Unauthorized,

    #[msg("Binding mismatch")]
    BindingMismatch,

    #[msg("Invalid account data")]
    InvalidAccountData,

    #[msg("Attestation failed")]
    AttestationFailed,

    // ── Phase 1 hardening ────────────────────────────────────────

    #[msg("Unauthorized admin: signer is not config.admin_authority")]
    UnauthorizedAdmin,

    #[msg("Invalid threshold: must be > 0 and <= verifier count")]
    InvalidThreshold,

    #[msg("Duplicate verifier pubkey in set")]
    DuplicateVerifier,

    #[msg("Verifier count exceeds MAX_VERIFIERS")]
    TooManyVerifiers,

    #[msg("Verifier set must not be empty")]
    EmptyVerifierSet,

    #[msg("Default pubkey (all zeros) not allowed as verifier")]
    DefaultVerifierKey,

    // ── Merkle root registry ─────────────────────────────────────

    #[msg("Merkle root not in allowed_roots registry")]
    UnknownMerkleRoot,

    #[msg("Default (all-zeros) value not allowed as Merkle root")]
    DefaultMerkleRoot,

    #[msg("Merkle root already present in allowed_roots")]
    DuplicateMerkleRoot,

    #[msg("Merkle root not found in allowed_roots")]
    MerkleRootNotFound,

    #[msg("Merkle root registry is at capacity (MAX_ROOTS)")]
    MerkleRootSetFull,

    // ── Migration ─────────────────────────────────────────────────────────────

    #[msg("Account is already at the current layout size; migration not needed")]
    AlreadyMigrated,

    #[msg("Account size does not match the expected legacy or current layout")]
    UnexpectedAccountSize,

    // ── Deposit ───────────────────────────────────────────────────────────────

    #[msg("Deposit amount must be greater than zero")]
    InvalidDepositAmount,

    // ── ZK deposit ────────────────────────────────────────────────────────────

    #[msg("Commitment must be a non-zero BN254 Fr element")]
    InvalidCommitment,

    #[msg("Commitment is not a canonical BN254 Fr element (>= field modulus)")]
    NonCanonicalCommitment,

    #[msg("Denomination is not in the allowed bucket set")]
    InvalidDenomination,

    #[msg("Merkle tree is full (leaf_count >= capacity)")]
    TreeFull,

    #[msg("Note tree has unexpected tree_depth; was it initialized by a compatible version?")]
    InvalidTreeDepth,

    // ── Root submitter authority ──────────────────────────────────────────────

    #[msg("Unauthorized root submitter: signer is not config.root_submitter_authority")]
    UnauthorizedRootSubmitter,

    #[msg("Invalid root submitter authority: default pubkey (all zeros) is not allowed")]
    InvalidRootSubmitterAuthority,

    // ── ZK withdrawal ─────────────────────────────────────────────────────────────

    #[msg("Merkle root allowlist is empty; no ZK withdrawals possible until a root is submitted")]
    NoAllowedRootsConfigured,

    #[msg("Groth16 proof verification failed")]
    InvalidProof,

    #[msg("circuit_version does not match the supported verifier version")]
    InvalidCircuitVersion,

    #[msg("Poseidon hash computation failed")]
    HashComputationFailed,

    #[msg("root is not a canonical BN254 Fr element")]
    NonCanonicalRoot,

    #[msg("nullifier_hash is not a canonical BN254 Fr element")]
    NonCanonicalNullifierHash,
}