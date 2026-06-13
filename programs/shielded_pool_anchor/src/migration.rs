//! Pure byte-level migration helpers for the v1.6.3 → current account layout upgrade.
//!
//! These functions transform legacy on-chain account bytes into the current layout
//! entirely in memory, with no network calls and no account borrows.
//! The on-chain migration instructions (PR 2) will call these helpers after
//! `AccountInfo::realloc` expands the account to the target size.
//!
//! Layout reference:
//!   PoolState      legacy = 17 bytes  →  current = [`CURRENT_POOL_LEN`] bytes
//!   VerifierConfig legacy = 311 bytes →  current = [`CURRENT_CONFIG_LEN`] bytes
//!   VerifierConfig prev   = 667 bytes →  current = [`CURRENT_CONFIG_LEN`] bytes

use anchor_lang::prelude::*;

use crate::errors::ShieldedPoolError;
use crate::state::{PoolState, VerifierConfig, MAX_ROOTS, MAX_VERIFIERS};

// ── Size constants ────────────────────────────────────────────────────────────

/// Byte size of a v1.6.3 `PoolState` account as deployed on devnet.
pub const LEGACY_POOL_LEN: usize = 17;

/// Byte size of the current `PoolState` account layout.
pub const CURRENT_POOL_LEN: usize = PoolState::LEN;

/// Byte size of a v1.6.3 `VerifierConfig` account as deployed on devnet.
pub const LEGACY_CONFIG_LEN: usize = 311;

/// Byte size of the previous `VerifierConfig` layout (pre-root_submitter_authority).
/// Accounts at this size must be migrated to [`CURRENT_CONFIG_LEN`].
pub const PREV_CONFIG_LEN: usize = 667;

/// Byte size of the current `VerifierConfig` account layout.
pub const CURRENT_CONFIG_LEN: usize = VerifierConfig::LEN;

// Compile-time invariants.
const _: () = assert!(CURRENT_POOL_LEN > LEGACY_POOL_LEN);
const _: () = assert!(CURRENT_CONFIG_LEN > PREV_CONFIG_LEN);
const _: () = assert!(CURRENT_CONFIG_LEN > LEGACY_CONFIG_LEN);

// ── Pool migration ────────────────────────────────────────────────────────────

/// Transform a 17-byte v1.6.3 `PoolState` byte slice into a 57-byte current-layout
/// byte vector.
///
/// ## Legacy layout (17 bytes)
/// ```text
/// [0..8]   discriminator
/// [8..16]  total_withdrawn_lamports : u64 LE
/// [16]     bump                     : u8
/// ```
///
/// ## Current layout (57 bytes)
/// ```text
/// [0..8]   discriminator    (unchanged)
/// [8..40]  authority        : Pubkey   (new — supplied as parameter)
/// [40..48] total_deposits   : u64 LE  (new — set to 0; not recoverable)
/// [48..56] total_withdrawals: u64 LE  (renamed from total_withdrawn_lamports)
/// [56]     bump             : u8      (expected_bump from canonical seed derivation)
/// ```
///
/// ## Errors
/// - [`ShieldedPoolError::AlreadyMigrated`] — `legacy.len() == CURRENT_POOL_LEN`
/// - [`ShieldedPoolError::UnexpectedAccountSize`] — `legacy.len() != LEGACY_POOL_LEN`
/// - [`ShieldedPoolError::InvalidAccountData`] — discriminator mismatch
pub(crate) fn migrate_pool_bytes(
    legacy: &[u8],
    authority: Pubkey,
    expected_bump: u8,
) -> Result<Vec<u8>> {
    // Guard: idempotent if account is already at the current size.
    if legacy.len() == CURRENT_POOL_LEN {
        return err!(ShieldedPoolError::AlreadyMigrated);
    }
    require_eq!(
        legacy.len(),
        LEGACY_POOL_LEN,
        ShieldedPoolError::UnexpectedAccountSize
    );

    require!(
        &legacy[0..8] == PoolState::DISCRIMINATOR,
        ShieldedPoolError::InvalidAccountData
    );

    // Read legacy fields into stack locals before any allocation.
    let total_withdrawn = u64::from_le_bytes(legacy[8..16].try_into().unwrap());
    // legacy[16] is the stored bump; expected_bump (from seed derivation) is authoritative.

    // Build new layout. Every byte is written explicitly — nothing relies on zero-init.
    let mut out = vec![0u8; CURRENT_POOL_LEN];

    // [0..8] discriminator — unchanged
    out[0..8].copy_from_slice(PoolState::DISCRIMINATOR);

    // [8..40] authority — new field, caller-supplied
    out[8..40].copy_from_slice(authority.as_ref());

    // [40..48] total_deposits = 0 — new field; not recoverable from legacy state
    out[40..48].copy_from_slice(&0u64.to_le_bytes());

    // [48..56] total_withdrawals — renamed from total_withdrawn_lamports
    out[48..56].copy_from_slice(&total_withdrawn.to_le_bytes());

    // [56] bump
    out[56] = expected_bump;

    Ok(out)
}

// ── Config migration ──────────────────────────────────────────────────────────

/// Transform a legacy, previous, or malformed `VerifierConfig` byte slice into a
/// canonical [`CURRENT_CONFIG_LEN`]-byte byte vector.
///
/// ## Legacy layout (311 bytes — Borsh-dynamic Vec with trailing padding)
/// ```text
/// [0..8]         discriminator
/// [8..40]        admin_authority      : Pubkey
/// [40..48]       chain_id             : u64 LE
/// [48]           paused               : bool
/// [49]           threshold            : u8
/// [50..54]       verifier_pubkeys len : u32 LE  (Borsh length prefix)
/// [54..54+n*32]  verifier_pubkeys     : n × 32 bytes  (actual entries only)
/// [54+n*32]      bump                 : u8
/// [55+n*32..311] zero padding         (account pre-allocated for MAX_VERIFIERS = 8 entries)
/// ```
/// For n=3 the bump is at byte 150 and bytes 151–310 are zero padding.
///
/// ## Previous current layout (667 bytes — pre-root_submitter_authority)
/// ```text
/// Canonical (Borsh Vec, variable verifier count):
/// [0..8]    discriminator
/// [8..40]   admin_authority
/// [40..72]  attester_pubkey
/// [72..80]  chain_id
/// [80]      paused
/// [81]      threshold
/// [82..86]  verifier_pubkeys len : u32 LE
/// [86..X]   verifier_pubkeys     : n × 32 bytes
/// [X..X+4]  allowed_roots len    : u32 LE
/// [X+4+m*32] bump                : u8
/// where X = 86 + n × 32, m = current allowed_roots count
///
/// Malformed (fixed-capacity migration bug — verifier data written as 8-slot capacity):
/// [0..8]    discriminator
/// [8..40]   admin_authority
/// [40..72]  attester_pubkey
/// [72..80]  chain_id
/// [80]      paused
/// [81]      threshold
/// [82..86]  verifier_pubkeys len : u32 LE
/// [86..342] verifier_pubkeys data: 8 × 32 bytes (fixed capacity, not Borsh Vec)
/// [342..346] allowed_roots len   : u32 LE (at wrong fixed offset)
/// [666]     bump                 : u8 (at wrong fixed offset)
/// ```
///
/// ## Canonical current layout (699 bytes)
/// ```text
/// [0..8]     discriminator
/// [8..40]    admin_authority
/// [40..72]   attester_pubkey
/// [72..104]  root_submitter_authority : Pubkey  (new field)
/// [104..112] chain_id
/// [112]      paused
/// [113]      threshold
/// [114..118] verifier_pubkeys len : u32 LE
/// [118..Y]   verifier_pubkeys     : n × 32 bytes
/// [Y..Y+4]   allowed_roots len    : u32 LE
/// [Y+4+m*32] bump                 : u8
/// [Y+5+m*32..699] zero padding
/// where Y = 118 + n × 32, m = current allowed_roots count
/// ```
///
/// ## Migration behaviour
/// - **699 bytes, canonical** → `AlreadyMigrated`
/// - **667 bytes, canonical** → shift fields, insert `root_submitter_authority = admin_authority`,
///   preserve `allowed_roots` in place; output is 699 bytes
/// - **667 bytes, malformed** → repair field layout, set `root_submitter_authority = admin_authority`;
///   output is 699 bytes with `allowed_roots_len = 0`
/// - **311 bytes (legacy)** → full migration; `root_submitter_authority = admin_authority`;
///   output is 699 bytes with `allowed_roots_len = 0`
///
/// ## Errors
/// - [`ShieldedPoolError::AlreadyMigrated`]
/// - [`ShieldedPoolError::UnexpectedAccountSize`]
/// - [`ShieldedPoolError::InvalidAccountData`]
/// - [`ShieldedPoolError::UnauthorizedAdmin`]
/// - [`ShieldedPoolError::DefaultVerifierKey`] — `attester_pubkey == Pubkey::default()` (legacy path)
pub(crate) fn migrate_config_bytes(
    data: &[u8],
    attester_pubkey: Pubkey,
    expected_bump: u8,
    admin_signer: Pubkey,
) -> Result<Vec<u8>> {
    // ── New current layout (699 bytes) ──────────────────────────────────────────
    if data.len() == CURRENT_CONFIG_LEN {
        require!(
            &data[0..8] == VerifierConfig::DISCRIMINATOR,
            ShieldedPoolError::InvalidAccountData
        );
        let admin_authority = Pubkey::from(<[u8; 32]>::try_from(&data[8..40]).unwrap());
        require_keys_eq!(
            admin_signer,
            admin_authority,
            ShieldedPoolError::UnauthorizedAdmin
        );
        if is_canonical_config(data, expected_bump) {
            return err!(ShieldedPoolError::AlreadyMigrated);
        }
        // No known path creates a malformed 699-byte account with this codebase.
        return err!(ShieldedPoolError::UnexpectedAccountSize);
    }

    // ── Previous current layout (667 bytes, pre-root_submitter_authority) ───────
    if data.len() == PREV_CONFIG_LEN {
        require!(
            &data[0..8] == VerifierConfig::DISCRIMINATOR,
            ShieldedPoolError::InvalidAccountData
        );
        let admin_authority = Pubkey::from(<[u8; 32]>::try_from(&data[8..40]).unwrap());
        require_keys_eq!(
            admin_signer,
            admin_authority,
            ShieldedPoolError::UnauthorizedAdmin
        );

        if is_canonical_prev_config(data, expected_bump) {
            // Canonical 667: insert root_submitter_authority = admin_authority at [72..104]
            // and shift everything that was at [72..667] to [104..699].  The relative
            // positions of chain_id, paused, threshold, verifiers, allowed_roots, and bump
            // are identical in both layouts — they just shift by 32 bytes.
            let mut out = vec![0u8; CURRENT_CONFIG_LEN];
            out[0..72].copy_from_slice(&data[0..72]);           // disc + admin + attester
            out[72..104].copy_from_slice(admin_authority.as_ref()); // root_submitter = admin
            out[104..CURRENT_CONFIG_LEN].copy_from_slice(&data[72..PREV_CONFIG_LEN]);
            return Ok(out);
        }

        // Malformed 667: read from fixed positions, build canonical 699 with zeros for roots.
        let attester = Pubkey::from(<[u8; 32]>::try_from(&data[40..72]).unwrap());
        let chain_id = u64::from_le_bytes(data[72..80].try_into().unwrap());
        let paused = data[80] != 0;
        let threshold = data[81];
        let n_verifiers = u32::from_le_bytes(data[82..86].try_into().unwrap()) as usize;
        require!(
            n_verifiers <= MAX_VERIFIERS,
            ShieldedPoolError::UnexpectedAccountSize
        );
        require!(
            86 + n_verifiers * 32 <= data.len(),
            ShieldedPoolError::UnexpectedAccountSize
        );
        // Bump was written at fixed offset 666 by the prior buggy migration.
        let bump = data[666];
        return Ok(build_canonical_config_bytes(
            &data[8..40],
            attester.as_ref(),
            admin_authority.as_ref(),
            chain_id,
            paused,
            threshold,
            n_verifiers,
            &data[86..86 + n_verifiers * 32],
            bump,
        ));
    }

    // ── Legacy layout (311 bytes) ──────────────────────────────────────────────
    require_eq!(
        data.len(),
        LEGACY_CONFIG_LEN,
        ShieldedPoolError::UnexpectedAccountSize
    );

    require!(
        &data[0..8] == VerifierConfig::DISCRIMINATOR,
        ShieldedPoolError::InvalidAccountData
    );

    let admin_authority = Pubkey::from(<[u8; 32]>::try_from(&data[8..40]).unwrap());
    require_keys_eq!(
        admin_signer,
        admin_authority,
        ShieldedPoolError::UnauthorizedAdmin
    );

    require!(
        attester_pubkey != Pubkey::default(),
        ShieldedPoolError::DefaultVerifierKey
    );

    let chain_id = u64::from_le_bytes(data[40..48].try_into().unwrap());
    let paused = data[48] != 0;
    let threshold = data[49];
    let n_verifiers = u32::from_le_bytes(data[50..54].try_into().unwrap()) as usize;
    require!(
        n_verifiers <= MAX_VERIFIERS,
        ShieldedPoolError::UnexpectedAccountSize
    );
    // Verify verifier entries and bump byte fit within the legacy buffer.
    // For n=MAX_VERIFIERS=8: 54+256=310 < 311 ✓
    require!(
        data.len() > 54 + n_verifiers * 32,
        ShieldedPoolError::UnexpectedAccountSize
    );
    // Preserve the stored legacy bump (Borsh-dynamic layout: bump lives at 54+n*32).
    let bump = data[54 + n_verifiers * 32];

    Ok(build_canonical_config_bytes(
        &data[8..40],
        attester_pubkey.as_ref(),
        admin_authority.as_ref(),
        chain_id,
        paused,
        threshold,
        n_verifiers,
        &data[54..54 + n_verifiers * 32],
        bump,
    ))
}

/// Returns `true` if `data` (must be `CURRENT_CONFIG_LEN` = 699 bytes) has valid
/// Borsh-encoded variable-length field structure AND the bump byte at the
/// dynamic Borsh position equals `expected_bump`.
///
/// Canonical current layout offsets:
///   verifier_pubkeys_len at [114..118], roots_off = 118 + n*32
fn is_canonical_config(data: &[u8], expected_bump: u8) -> bool {
    debug_assert_eq!(data.len(), CURRENT_CONFIG_LEN);
    if data.len() < 118 {
        return false;
    }
    let n_verifiers = match <[u8; 4]>::try_from(&data[114..118]) {
        Ok(b) => u32::from_le_bytes(b) as usize,
        Err(_) => return false,
    };
    if n_verifiers > MAX_VERIFIERS {
        return false;
    }
    let roots_off = 118 + n_verifiers * 32;
    if data.len() < roots_off + 4 {
        return false;
    }
    let roots_len = match <[u8; 4]>::try_from(&data[roots_off..roots_off + 4]) {
        Ok(b) => u32::from_le_bytes(b) as usize,
        Err(_) => return false,
    };
    if roots_len > MAX_ROOTS {
        return false;
    }
    let bump_off = roots_off + 4 + roots_len * 32;
    if bump_off >= data.len() {
        return false;
    }
    data[bump_off] == expected_bump
}

/// Returns `true` if `data` (must be `PREV_CONFIG_LEN` = 667 bytes) has valid
/// Borsh-encoded variable-length field structure AND the bump byte at the
/// dynamic Borsh position equals `expected_bump`.
///
/// Previous layout offsets:
///   verifier_pubkeys_len at [82..86], roots_off = 86 + n*32
///
/// Trailing bytes after the bump are intentionally not checked — they may
/// contain stale root data from prior add/remove-root operations.
fn is_canonical_prev_config(data: &[u8], expected_bump: u8) -> bool {
    debug_assert_eq!(data.len(), PREV_CONFIG_LEN);
    if data.len() < 86 {
        return false;
    }
    let n_verifiers = match <[u8; 4]>::try_from(&data[82..86]) {
        Ok(b) => u32::from_le_bytes(b) as usize,
        Err(_) => return false,
    };
    if n_verifiers > MAX_VERIFIERS {
        return false;
    }
    let roots_off = 86 + n_verifiers * 32;
    if data.len() < roots_off + 4 {
        return false;
    }
    let roots_len = match <[u8; 4]>::try_from(&data[roots_off..roots_off + 4]) {
        Ok(b) => u32::from_le_bytes(b) as usize,
        Err(_) => return false,
    };
    if roots_len > MAX_ROOTS {
        return false;
    }
    let bump_off = roots_off + 4 + roots_len * 32;
    if bump_off >= data.len() {
        return false;
    }
    data[bump_off] == expected_bump
}

/// Build a canonical [`CURRENT_CONFIG_LEN`]-byte `VerifierConfig` Borsh layout
/// from extracted fields.
///
/// Writes exactly `n_verifiers` entries (no fixed-capacity padding), places
/// `allowed_roots_len = 0` at the dynamic Borsh offset, and zeros all trailing bytes.
/// `root_submitter` is written at `[72..104]`.
fn build_canonical_config_bytes(
    admin: &[u8],
    attester: &[u8],
    root_submitter: &[u8],
    chain_id: u64,
    paused: bool,
    threshold: u8,
    n_verifiers: usize,
    verifier_entries: &[u8], // exactly n_verifiers * 32 bytes
    bump: u8,
) -> Vec<u8> {
    let roots_off = 118 + n_verifiers * 32;
    let bump_off = roots_off + 4;
    let mut out = vec![0u8; CURRENT_CONFIG_LEN];
    out[0..8].copy_from_slice(VerifierConfig::DISCRIMINATOR);
    out[8..40].copy_from_slice(admin);
    out[40..72].copy_from_slice(attester);
    out[72..104].copy_from_slice(root_submitter);
    out[104..112].copy_from_slice(&chain_id.to_le_bytes());
    out[112] = u8::from(paused);
    out[113] = threshold;
    out[114..118].copy_from_slice(&(n_verifiers as u32).to_le_bytes());
    if !verifier_entries.is_empty() {
        out[118..118 + verifier_entries.len()].copy_from_slice(verifier_entries);
    }
    // allowed_roots len = 0 at dynamic Borsh offset (explicit write over zero-init).
    out[roots_off..roots_off + 4].copy_from_slice(&0u32.to_le_bytes());
    // bump at dynamic Borsh offset
    out[bump_off] = bump;
    // bytes after bump already zeroed by vec![0u8; CURRENT_CONFIG_LEN]
    out
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Fixture helpers ───────────────────────────────────────────────────────

    /// Construct a `Pubkey` from a single repeated byte.
    fn pk(byte: u8) -> Pubkey {
        Pubkey::from([byte; 32])
    }

    /// Build a valid legacy 17-byte PoolState byte array.
    fn make_legacy_pool(total_withdrawn: u64, bump: u8) -> Vec<u8> {
        let mut data = vec![0u8; LEGACY_POOL_LEN];
        data[0..8].copy_from_slice(PoolState::DISCRIMINATOR);
        data[8..16].copy_from_slice(&total_withdrawn.to_le_bytes());
        data[16] = bump;
        data
    }

    /// Build a valid legacy 311-byte VerifierConfig byte array.
    fn make_legacy_config(
        admin: &Pubkey,
        chain_id: u64,
        paused: bool,
        threshold: u8,
        verifiers: &[Pubkey],
        bump: u8,
    ) -> Vec<u8> {
        assert!(
            verifiers.len() <= MAX_VERIFIERS,
            "test fixture: too many verifiers"
        );
        let mut data = vec![0u8; LEGACY_CONFIG_LEN];
        data[0..8].copy_from_slice(VerifierConfig::DISCRIMINATOR);
        data[8..40].copy_from_slice(admin.as_ref());
        data[40..48].copy_from_slice(&chain_id.to_le_bytes());
        data[48] = u8::from(paused);
        data[49] = threshold;
        data[50..54].copy_from_slice(&(verifiers.len() as u32).to_le_bytes());
        for (i, v) in verifiers.iter().enumerate() {
            let start = 54 + i * 32;
            data[start..start + 32].copy_from_slice(v.as_ref());
        }
        // Bump lives immediately after the actual entries (Borsh-dynamic layout).
        data[54 + verifiers.len() * 32] = bump;
        data
    }

    /// Build a canonical 667-byte (PREV_CONFIG_LEN) VerifierConfig byte array with
    /// optional pre-existing allowed_roots.
    fn make_prev_canonical_config(
        admin: &Pubkey,
        attester: &Pubkey,
        chain_id: u64,
        paused: bool,
        threshold: u8,
        verifiers: &[Pubkey],
        allowed_roots: &[[u8; 32]],
        bump: u8,
    ) -> Vec<u8> {
        assert!(verifiers.len() <= MAX_VERIFIERS, "too many verifiers");
        assert!(allowed_roots.len() <= MAX_ROOTS, "too many roots");
        let roots_off = 86 + verifiers.len() * 32;
        let bump_off = roots_off + 4 + allowed_roots.len() * 32;
        assert!(bump_off < PREV_CONFIG_LEN, "fixture overflows 667 bytes");
        let mut data = vec![0u8; PREV_CONFIG_LEN];
        data[0..8].copy_from_slice(VerifierConfig::DISCRIMINATOR);
        data[8..40].copy_from_slice(admin.as_ref());
        data[40..72].copy_from_slice(attester.as_ref());
        data[72..80].copy_from_slice(&chain_id.to_le_bytes());
        data[80] = u8::from(paused);
        data[81] = threshold;
        data[82..86].copy_from_slice(&(verifiers.len() as u32).to_le_bytes());
        for (i, v) in verifiers.iter().enumerate() {
            let start = 86 + i * 32;
            data[start..start + 32].copy_from_slice(v.as_ref());
        }
        data[roots_off..roots_off + 4]
            .copy_from_slice(&(allowed_roots.len() as u32).to_le_bytes());
        for (i, r) in allowed_roots.iter().enumerate() {
            let start = roots_off + 4 + i * 32;
            data[start..start + 32].copy_from_slice(r);
        }
        data[bump_off] = bump;
        data
    }

    /// Build the malformed 667-byte layout produced by the buggy fixed-capacity migration.
    fn make_malformed_667_config(
        admin: &Pubkey,
        attester: &Pubkey,
        chain_id: u64,
        paused: bool,
        threshold: u8,
        verifiers: &[Pubkey],
        bump: u8,
    ) -> Vec<u8> {
        assert!(
            verifiers.len() <= MAX_VERIFIERS,
            "test fixture: too many verifiers"
        );
        let mut data = vec![0u8; PREV_CONFIG_LEN];
        data[0..8].copy_from_slice(VerifierConfig::DISCRIMINATOR);
        data[8..40].copy_from_slice(admin.as_ref());
        data[40..72].copy_from_slice(attester.as_ref());
        data[72..80].copy_from_slice(&chain_id.to_le_bytes());
        data[80] = u8::from(paused);
        data[81] = threshold;
        data[82..86].copy_from_slice(&(verifiers.len() as u32).to_le_bytes());
        // Fixed capacity: writes actual entries; unused slots remain zero.
        for (i, v) in verifiers.iter().enumerate() {
            let start = 86 + i * 32;
            data[start..start + 32].copy_from_slice(v.as_ref());
        }
        // allowed_roots_len at wrong fixed offset 342
        data[342..346].copy_from_slice(&0u32.to_le_bytes());
        // bump at wrong fixed offset 666
        data[666] = bump;
        data
    }

    /// Assert that `result` is an `AnchorError` with the given error code.
    fn assert_err(result: Result<Vec<u8>>, expected: ShieldedPoolError) {
        let err = result.expect_err("expected Err but got Ok");
        match err {
            anchor_lang::error::Error::AnchorError(ae) => {
                assert_eq!(
                    ae.error_code_number,
                    expected as u32 + 6000,
                    "wrong error code; expected {:?} (code {})",
                    expected,
                    expected as u32 + 6000,
                );
            }
            other => panic!("expected AnchorError variant, got: {other}"),
        }
    }

    // ── migrate_pool ──────────────────────────────────────────────────────────

    #[test]
    fn pool_migrates_17_to_57_bytes() {
        let legacy = make_legacy_pool(5_000_000, 254);
        let out = migrate_pool_bytes(&legacy, pk(1), 254).unwrap();
        assert_eq!(out.len(), CURRENT_POOL_LEN);
    }

    #[test]
    fn pool_discriminator_preserved() {
        let legacy = make_legacy_pool(0, 254);
        let out = migrate_pool_bytes(&legacy, pk(1), 254).unwrap();
        assert_eq!(&out[0..8], PoolState::DISCRIMINATOR);
    }

    #[test]
    fn pool_total_withdrawals_preserved() {
        let legacy = make_legacy_pool(7_777_777, 254);
        let out = migrate_pool_bytes(&legacy, pk(1), 254).unwrap();
        let total = u64::from_le_bytes(out[48..56].try_into().unwrap());
        assert_eq!(total, 7_777_777);
    }

    #[test]
    fn pool_authority_written() {
        let authority = pk(42);
        let legacy = make_legacy_pool(0, 254);
        let out = migrate_pool_bytes(&legacy, authority, 254).unwrap();
        let written = Pubkey::from(<[u8; 32]>::try_from(&out[8..40]).unwrap());
        assert_eq!(written, authority);
    }

    #[test]
    fn pool_total_deposits_is_zero() {
        let legacy = make_legacy_pool(999_999, 254);
        let out = migrate_pool_bytes(&legacy, pk(1), 254).unwrap();
        let deposits = u64::from_le_bytes(out[40..48].try_into().unwrap());
        assert_eq!(deposits, 0);
    }

    #[test]
    fn pool_bump_written() {
        let legacy = make_legacy_pool(0, 200);
        let out = migrate_pool_bytes(&legacy, pk(1), 200).unwrap();
        assert_eq!(out[56], 200);
    }

    #[test]
    fn pool_already_migrated_returns_error() {
        let data = vec![0u8; CURRENT_POOL_LEN];
        let result = migrate_pool_bytes(&data, pk(1), 0);
        assert_err(result, ShieldedPoolError::AlreadyMigrated);
    }

    #[test]
    fn pool_wrong_length_returns_error() {
        let data = vec![0u8; 20]; // neither LEGACY_POOL_LEN nor CURRENT_POOL_LEN
        let result = migrate_pool_bytes(&data, pk(1), 0);
        assert_err(result, ShieldedPoolError::UnexpectedAccountSize);
    }

    #[test]
    fn pool_bad_discriminator_returns_error() {
        let mut legacy = make_legacy_pool(0, 254);
        legacy[0] ^= 0xff; // corrupt first discriminator byte
        let result = migrate_pool_bytes(&legacy, pk(1), 0);
        assert_err(result, ShieldedPoolError::InvalidAccountData);
    }

    // ── migrate_config — legacy 311 → current 699 ─────────────────────────────

    #[test]
    fn config_migrates_311_to_699_bytes() {
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        assert_eq!(out.len(), CURRENT_CONFIG_LEN);
    }

    #[test]
    fn config_discriminator_preserved() {
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        assert_eq!(&out[0..8], VerifierConfig::DISCRIMINATOR);
    }

    #[test]
    fn config_admin_authority_preserved() {
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        let written = Pubkey::from(<[u8; 32]>::try_from(&out[8..40]).unwrap());
        assert_eq!(written, admin);
    }

    #[test]
    fn config_attester_pubkey_written() {
        let admin = pk(10);
        let attester = pk(30);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let out = migrate_config_bytes(&legacy, attester, 253, admin).unwrap();
        let written = Pubkey::from(<[u8; 32]>::try_from(&out[40..72]).unwrap());
        assert_eq!(written, attester);
    }

    #[test]
    fn config_root_submitter_set_to_admin_on_legacy_migration() {
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        let written = Pubkey::from(<[u8; 32]>::try_from(&out[72..104]).unwrap());
        assert_eq!(written, admin, "root_submitter_authority must equal admin on migration");
    }

    #[test]
    fn config_chain_id_preserved() {
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 99, false, 1, &[pk(20)], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        let chain_id = u64::from_le_bytes(out[104..112].try_into().unwrap());
        assert_eq!(chain_id, 99);
    }

    #[test]
    fn config_paused_false_preserved() {
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        assert_eq!(out[112], 0, "paused=false must write 0");
    }

    #[test]
    fn config_paused_true_preserved() {
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, true, 1, &[pk(20)], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        assert_ne!(out[112], 0, "paused=true must write non-zero");
    }

    #[test]
    fn config_threshold_preserved() {
        let admin = pk(10);
        let legacy =
            make_legacy_config(&admin, 1, false, 2, &[pk(21), pk(22), pk(23)], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        assert_eq!(out[113], 2);
    }

    #[test]
    fn config_verifier_pubkeys_len_preserved() {
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(21), pk(22)], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        let n = u32::from_le_bytes(out[114..118].try_into().unwrap());
        assert_eq!(n, 2);
    }

    #[test]
    fn config_verifier_pubkeys_data_preserved() {
        let admin = pk(10);
        let v1 = pk(21);
        let v2 = pk(22);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[v1, v2], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        let written_v1 = Pubkey::from(<[u8; 32]>::try_from(&out[118..150]).unwrap());
        let written_v2 = Pubkey::from(<[u8; 32]>::try_from(&out[150..182]).unwrap());
        assert_eq!(written_v1, v1);
        assert_eq!(written_v2, v2);
    }

    #[test]
    fn config_allowed_roots_len_is_zero() {
        // 1 verifier: roots_off = 118 + 1*32 = 150
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        let roots_len = u32::from_le_bytes(out[150..154].try_into().unwrap());
        assert_eq!(roots_len, 0);
    }

    #[test]
    fn config_allowed_roots_body_zeroed() {
        // Check the 320-byte MAX_ROOTS capacity region at max-verifiers offset.
        // For 8 verifiers: roots_data_start = 118 + 8*32 + 4 = 378.
        // End exclusive: 698 (last byte is bump at 698 for max fill).
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        assert!(
            out[378..698].iter().all(|&b| b == 0),
            "allowed_roots body (320 bytes at [378..698]) must be all zeros"
        );
    }

    #[test]
    fn config_bump_written() {
        // 1 verifier: bump_off = 118 + 1*32 + 4 = 154
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 200);
        let out = migrate_config_bytes(&legacy, pk(30), 200, admin).unwrap();
        assert_eq!(out[154], 200);
    }

    #[test]
    fn config_unauthorized_admin_returns_error() {
        let admin = pk(10);
        let wrong_admin = pk(11);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let result = migrate_config_bytes(&legacy, pk(30), 253, wrong_admin);
        assert_err(result, ShieldedPoolError::UnauthorizedAdmin);
    }

    #[test]
    fn config_default_attester_returns_error() {
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let result = migrate_config_bytes(&legacy, Pubkey::default(), 253, admin);
        assert_err(result, ShieldedPoolError::DefaultVerifierKey);
    }

    #[test]
    fn config_verifier_vec_too_large_returns_error() {
        let admin = pk(10);
        let mut legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        // Overwrite vec length field with 9 (> MAX_VERIFIERS = 8)
        legacy[50..54].copy_from_slice(&9u32.to_le_bytes());
        let result = migrate_config_bytes(&legacy, pk(30), 253, admin);
        assert_err(result, ShieldedPoolError::UnexpectedAccountSize);
    }

    #[test]
    fn config_already_migrated_returns_error() {
        // Migrate a legacy config to get a canonical 699-byte account, then verify
        // that migrating it again returns AlreadyMigrated.
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let canonical = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        let result = migrate_config_bytes(&canonical, pk(30), 253, admin);
        assert_err(result, ShieldedPoolError::AlreadyMigrated);
    }

    #[test]
    fn config_wrong_length_returns_error() {
        let data = vec![0u8; 100]; // neither LEGACY_CONFIG_LEN nor CURRENT_CONFIG_LEN
        let result = migrate_config_bytes(&data, pk(30), 0, pk(10));
        assert_err(result, ShieldedPoolError::UnexpectedAccountSize);
    }

    #[test]
    fn config_bad_discriminator_returns_error() {
        let admin = pk(10);
        let mut legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        legacy[0] ^= 0xff; // corrupt first discriminator byte
        let result = migrate_config_bytes(&legacy, pk(30), 253, admin);
        assert_err(result, ShieldedPoolError::InvalidAccountData);
    }

    // ── New tests: Borsh-correct offsets and malformed-current repair ─────────

    #[test]
    fn config_legacy_3_verifiers_borsh_offsets() {
        // For 3 verifiers: roots_off = 118+96 = 214, bump_off = 218.
        let admin = pk(10);
        let legacy =
            make_legacy_config(&admin, 1, false, 1, &[pk(21), pk(22), pk(23)], 253);
        let out = migrate_config_bytes(&legacy, pk(30), 0, admin).unwrap();
        assert_eq!(out.len(), CURRENT_CONFIG_LEN);
        let roots_len = u32::from_le_bytes(out[214..218].try_into().unwrap());
        assert_eq!(roots_len, 0, "allowed_roots_len must be 0 at Borsh offset 214");
        assert_eq!(out[218], 253, "bump must be at Borsh offset 218");
        assert!(
            out[219..].iter().all(|&b| b == 0),
            "all bytes after bump must be zero"
        );
    }

    #[test]
    fn config_malformed_667_repaired() {
        // Malformed 667-byte account → canonical 699-byte output.
        let admin = pk(10);
        let attester = pk(30);
        let v1 = pk(21);
        let v2 = pk(22);
        let v3 = pk(23);
        let malformed =
            make_malformed_667_config(&admin, &attester, 1, false, 1, &[v1, v2, v3], 253);
        // expected_bump=253 matches data[666] in the malformed fixture; the dynamic
        // prev-canonical bump position (186) contains 0 ≠ 253, so is_canonical_prev_config
        // returns false and we take the repair path.
        let out = migrate_config_bytes(&malformed, pk(99), 253, admin).unwrap();
        // roots_len and bump at correct Borsh offsets for 3 verifiers in new 699 layout
        // roots_off = 118+96=214, bump_off=218
        let roots_len = u32::from_le_bytes(out[214..218].try_into().unwrap());
        assert_eq!(roots_len, 0, "allowed_roots_len must be 0 at Borsh offset 214");
        assert_eq!(out[218], 253, "bump must be at Borsh offset 218");
        assert!(
            out[219..].iter().all(|&b| b == 0),
            "all bytes after bump must be zero"
        );
        // Fields preserved from malformed account bytes; verifiers now at new offsets
        let written_attester = Pubkey::from(<[u8; 32]>::try_from(&out[40..72]).unwrap());
        assert_eq!(written_attester, attester, "attester must be preserved from [40..72]");
        let written_v1 = Pubkey::from(<[u8; 32]>::try_from(&out[118..150]).unwrap());
        let written_v2 = Pubkey::from(<[u8; 32]>::try_from(&out[150..182]).unwrap());
        let written_v3 = Pubkey::from(<[u8; 32]>::try_from(&out[182..214]).unwrap());
        assert_eq!(written_v1, v1);
        assert_eq!(written_v2, v2);
        assert_eq!(written_v3, v3);
        // root_submitter = admin
        let written_root_submitter =
            Pubkey::from(<[u8; 32]>::try_from(&out[72..104]).unwrap());
        assert_eq!(written_root_submitter, admin);
    }

    #[test]
    fn config_malformed_667_root_submitter_set_to_admin() {
        let admin = pk(10);
        let attester = pk(30);
        let malformed =
            make_malformed_667_config(&admin, &attester, 1, false, 1, &[pk(20)], 253);
        let out = migrate_config_bytes(&malformed, pk(99), 253, admin).unwrap();
        let written = Pubkey::from(<[u8; 32]>::try_from(&out[72..104]).unwrap());
        assert_eq!(written, admin);
    }

    #[test]
    fn config_canonical_already_migrated() {
        // Output of a successful migration is recognized as canonical on re-entry.
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let canonical = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        let result = migrate_config_bytes(&canonical, pk(30), 253, admin);
        assert_err(result, ShieldedPoolError::AlreadyMigrated);
    }

    #[test]
    fn config_canonical_with_stale_trailing_bytes_already_migrated() {
        // A canonical 699-byte config that has non-zero stale bytes after the dynamic
        // bump position (as left by an addRoot + removeRoot cycle) is still recognized
        // as canonical and returns AlreadyMigrated.
        //
        // For 1 verifier: roots_off=150, roots_len=0, bump_off=154.
        // Stale bytes at [155..187] simulate a removed 32-byte root entry.
        let admin = pk(10);
        let legacy = make_legacy_config(&admin, 1, false, 1, &[pk(20)], 253);
        let mut canonical = migrate_config_bytes(&legacy, pk(30), 253, admin).unwrap();
        for b in canonical[155..187].iter_mut() {
            *b = 0xAB;
        }
        let result = migrate_config_bytes(&canonical, pk(30), 253, admin);
        assert_err(result, ShieldedPoolError::AlreadyMigrated);
    }

    // ── migrate_config — prev canonical 667 → current 699 ────────────────────

    #[test]
    fn config_migrates_canonical_667_to_699() {
        let admin = pk(10);
        let attester = pk(30);
        let prev = make_prev_canonical_config(&admin, &attester, 1, false, 1, &[pk(20)], &[], 253);
        let out = migrate_config_bytes(&prev, pk(99), 253, admin).unwrap();
        assert_eq!(out.len(), CURRENT_CONFIG_LEN);
    }

    #[test]
    fn config_canonical_667_discriminator_preserved() {
        let admin = pk(10);
        let attester = pk(30);
        let prev = make_prev_canonical_config(&admin, &attester, 1, false, 1, &[pk(20)], &[], 253);
        let out = migrate_config_bytes(&prev, pk(99), 253, admin).unwrap();
        assert_eq!(&out[0..8], VerifierConfig::DISCRIMINATOR);
    }

    #[test]
    fn config_canonical_667_admin_preserved() {
        let admin = pk(10);
        let attester = pk(30);
        let prev = make_prev_canonical_config(&admin, &attester, 1, false, 1, &[pk(20)], &[], 253);
        let out = migrate_config_bytes(&prev, pk(99), 253, admin).unwrap();
        let written = Pubkey::from(<[u8; 32]>::try_from(&out[8..40]).unwrap());
        assert_eq!(written, admin);
    }

    #[test]
    fn config_canonical_667_root_submitter_set_to_admin() {
        let admin = pk(10);
        let attester = pk(30);
        let prev = make_prev_canonical_config(&admin, &attester, 1, false, 1, &[pk(20)], &[], 253);
        let out = migrate_config_bytes(&prev, pk(99), 253, admin).unwrap();
        let written = Pubkey::from(<[u8; 32]>::try_from(&out[72..104]).unwrap());
        assert_eq!(written, admin, "root_submitter_authority must equal admin on 667→699 migration");
    }

    #[test]
    fn config_canonical_667_chain_id_preserved() {
        let admin = pk(10);
        let attester = pk(30);
        let prev = make_prev_canonical_config(&admin, &attester, 42, false, 1, &[pk(20)], &[], 253);
        let out = migrate_config_bytes(&prev, pk(99), 253, admin).unwrap();
        let chain_id = u64::from_le_bytes(out[104..112].try_into().unwrap());
        assert_eq!(chain_id, 42);
    }

    #[test]
    fn config_canonical_667_verifier_preserved() {
        let admin = pk(10);
        let attester = pk(30);
        let v1 = pk(21);
        let prev = make_prev_canonical_config(&admin, &attester, 1, false, 1, &[v1], &[], 253);
        let out = migrate_config_bytes(&prev, pk(99), 253, admin).unwrap();
        let n = u32::from_le_bytes(out[114..118].try_into().unwrap());
        assert_eq!(n, 1);
        let written = Pubkey::from(<[u8; 32]>::try_from(&out[118..150]).unwrap());
        assert_eq!(written, v1);
    }

    #[test]
    fn config_canonical_667_preserves_existing_allowed_roots() {
        // Verify that existing allowed_roots in the old 667-byte config survive the
        // shift migration to 699 bytes.
        //
        // For 1 verifier, 2 roots in old layout:
        //   roots_off(old) = 86+32 = 118, roots at [122..154] and [154..186], bump at [186]
        // After shift (+32) in new layout:
        //   roots_off(new) = 118+32 = 150, roots at [154..186] and [186..218], bump at [218]
        let admin = pk(10);
        let attester = pk(30);
        let root1 = [1u8; 32];
        let root2 = [2u8; 32];
        let prev = make_prev_canonical_config(
            &admin, &attester, 1, false, 1, &[pk(20)], &[root1, root2], 253,
        );
        let out = migrate_config_bytes(&prev, pk(99), 253, admin).unwrap();
        assert_eq!(out.len(), CURRENT_CONFIG_LEN);
        let roots_len = u32::from_le_bytes(out[150..154].try_into().unwrap());
        assert_eq!(roots_len, 2, "allowed_roots count must be preserved");
        assert_eq!(&out[154..186], &root1, "root1 must be preserved");
        assert_eq!(&out[186..218], &root2, "root2 must be preserved");
        assert_eq!(out[218], 253, "bump must be at new dynamic position");
    }

    #[test]
    fn config_canonical_667_already_migrated_returns_error() {
        // A canonical 667-byte config cannot be re-migrated once output is 699 bytes.
        let admin = pk(10);
        let attester = pk(30);
        let prev = make_prev_canonical_config(&admin, &attester, 1, false, 1, &[pk(20)], &[], 253);
        let canonical_699 = migrate_config_bytes(&prev, pk(99), 253, admin).unwrap();
        let result = migrate_config_bytes(&canonical_699, pk(99), 253, admin);
        assert_err(result, ShieldedPoolError::AlreadyMigrated);
    }

    #[test]
    fn config_canonical_667_unauthorized_admin_returns_error() {
        let admin = pk(10);
        let wrong = pk(11);
        let attester = pk(30);
        let prev = make_prev_canonical_config(&admin, &attester, 1, false, 1, &[pk(20)], &[], 253);
        let result = migrate_config_bytes(&prev, pk(99), 253, wrong);
        assert_err(result, ShieldedPoolError::UnauthorizedAdmin);
    }

    #[test]
    fn config_canonical_667_bad_discriminator_returns_error() {
        let admin = pk(10);
        let attester = pk(30);
        let mut prev =
            make_prev_canonical_config(&admin, &attester, 1, false, 1, &[pk(20)], &[], 253);
        prev[0] ^= 0xff;
        let result = migrate_config_bytes(&prev, pk(99), 253, admin);
        assert_err(result, ShieldedPoolError::InvalidAccountData);
    }
}
