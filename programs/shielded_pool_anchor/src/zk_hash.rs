use anchor_lang::prelude::*;
use solana_poseidon::{hashv, Endianness, Parameters, PoseidonSyscallError};

use crate::errors::ShieldedPoolError;

// Domain tags (match lib/zk_indexer/constants.ts and spec §1)
const TAG_TX_INNER: u64 = 5;
const TAG_TX: u64 = 4;

// Encode a u64 value as a 32-byte big-endian field element.
// 24 zero bytes followed by the 8-byte big-endian representation.
fn u64_to_be_bytes32(v: u64) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[24..].copy_from_slice(&v.to_be_bytes());
    b
}

// Encode a u128 value as a 32-byte big-endian field element.
// 16 zero bytes followed by the 16-byte big-endian representation.
// Safe: u128::MAX < BN254 Fr modulus.
fn u128_to_be_bytes32(v: u128) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[16..].copy_from_slice(&v.to_be_bytes());
    b
}

// Split a 32-byte Solana pubkey into two 128-bit little-endian field elements.
//
// Convention (locked, must match lib/zk_prover/witness.ts::splitPubkey):
//   lo = pk[0..16]  as little-endian u128
//   hi = pk[16..32] as little-endian u128
fn split_pubkey_le_u128(pk: &Pubkey) -> (u128, u128) {
    let b = pk.to_bytes();
    let lo = u128::from_le_bytes(b[0..16].try_into().unwrap());
    let hi = u128::from_le_bytes(b[16..32].try_into().unwrap());
    (lo, hi)
}

fn poseidon_err(_: PoseidonSyscallError) -> anchor_lang::error::Error {
    error!(ShieldedPoolError::HashComputationFailed)
}

// Compute pubkeys_hash from the five on-chain account pubkeys.
//
// Formula (locked, spec §1):
//   pubkeys_hash = Poseidon(TAG_TX_INNER=5,
//                    program_id_lo, program_id_hi,
//                    pool_pda_lo,   pool_pda_hi,
//                    config_pda_lo, config_pda_hi,
//                    recipient_lo,  recipient_hi,
//                    relayer_lo,    relayer_hi)
//
// Each input is a 32-byte big-endian field element. Pubkey halves use the
// locked little-endian split convention: lo = pk[0..16] as LE u128.
//
// Returns 32-byte big-endian BN254 Fr output. Matches TS computePubkeysHash.
pub(crate) fn compute_pubkeys_hash(
    program_id: &Pubkey,
    pool_pda: &Pubkey,
    config_pda: &Pubkey,
    recipient: &Pubkey,
    relayer: &Pubkey,
) -> Result<[u8; 32]> {
    let (pid_lo, pid_hi) = split_pubkey_le_u128(program_id);
    let (pool_lo, pool_hi) = split_pubkey_le_u128(pool_pda);
    let (cfg_lo, cfg_hi) = split_pubkey_le_u128(config_pda);
    let (rec_lo, rec_hi) = split_pubkey_le_u128(recipient);
    let (rel_lo, rel_hi) = split_pubkey_le_u128(relayer);

    let tag = u64_to_be_bytes32(TAG_TX_INNER);
    let pid_lo_b = u128_to_be_bytes32(pid_lo);
    let pid_hi_b = u128_to_be_bytes32(pid_hi);
    let pool_lo_b = u128_to_be_bytes32(pool_lo);
    let pool_hi_b = u128_to_be_bytes32(pool_hi);
    let cfg_lo_b = u128_to_be_bytes32(cfg_lo);
    let cfg_hi_b = u128_to_be_bytes32(cfg_hi);
    let rec_lo_b = u128_to_be_bytes32(rec_lo);
    let rec_hi_b = u128_to_be_bytes32(rec_hi);
    let rel_lo_b = u128_to_be_bytes32(rel_lo);
    let rel_hi_b = u128_to_be_bytes32(rel_hi);

    let hash = hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[
            &tag, &pid_lo_b, &pid_hi_b, &pool_lo_b, &pool_hi_b, &cfg_lo_b, &cfg_hi_b,
            &rec_lo_b, &rec_hi_b, &rel_lo_b, &rel_hi_b,
        ],
    )
    .map_err(poseidon_err)?;

    Ok(hash.to_bytes())
}

// Compute tx_hash from the five account pubkeys plus withdrawal parameters.
//
// Formula (locked, spec §1):
//   tx_hash = Poseidon(TAG_TX=4,
//               pubkeys_hash, denomination, fee,
//               chain_id, expiry_slot, circuit_version)
//
// chain_id must come from config.chain_id — it is NOT an instruction arg.
// Returns 32-byte big-endian BN254 Fr output. Matches TS computeTxHash.
pub(crate) fn compute_tx_hash(
    program_id: &Pubkey,
    pool_pda: &Pubkey,
    config_pda: &Pubkey,
    recipient: &Pubkey,
    relayer: &Pubkey,
    denomination: u64,
    fee: u64,
    chain_id: u64,
    expiry_slot: u64,
    circuit_version: u64,
) -> Result<[u8; 32]> {
    let pubkeys_hash =
        compute_pubkeys_hash(program_id, pool_pda, config_pda, recipient, relayer)?;

    let tag = u64_to_be_bytes32(TAG_TX);
    let denom_b = u64_to_be_bytes32(denomination);
    let fee_b = u64_to_be_bytes32(fee);
    let chain_b = u64_to_be_bytes32(chain_id);
    let expiry_b = u64_to_be_bytes32(expiry_slot);
    let circuit_b = u64_to_be_bytes32(circuit_version);

    // pubkeys_hash is already a 32-byte big-endian field element; pass directly.
    let hash = hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[&tag, &pubkeys_hash, &denom_b, &fee_b, &chain_b, &expiry_b, &circuit_b],
    )
    .map_err(poseidon_err)?;

    Ok(hash.to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Test constants (match tests/zk_prover_witness.ts BASE_PARAMS) ──────────
    // E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq
    const TEST_PROGRAM_ID: [u8; 32] = [
        0xc2, 0x37, 0x59, 0xbe, 0x31, 0xac, 0xe7, 0xbc, 0xda, 0xe3, 0xfb, 0x83, 0x53, 0xdf,
        0x50, 0xb4, 0x89, 0x98, 0x1d, 0xf0, 0xfa, 0xb6, 0xf5, 0x52, 0xa7, 0x10, 0x87, 0x15,
        0x99, 0x0c, 0xa0, 0x58,
    ];
    // HcAkT4obzEEaHyevyVvmU7drEtSUg1m4XxF1VTWGoCdm (real pool_state PDA)
    const TEST_POOL_PDA: [u8; 32] = [
        0xf6, 0xbd, 0x57, 0xae, 0xf0, 0x32, 0xa0, 0x6e, 0x9f, 0x61, 0x4b, 0x8f, 0x05, 0xa0,
        0x73, 0x1d, 0x5d, 0x71, 0xb7, 0x51, 0xd4, 0xed, 0x5e, 0xab, 0xe8, 0xa3, 0xfb, 0xe7,
        0xc4, 0x00, 0x13, 0xa0,
    ];
    // 6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu (real config PDA)
    const TEST_CONFIG_PDA: [u8; 32] = [
        0x4d, 0x7c, 0x86, 0x4a, 0x26, 0x58, 0xb9, 0xf4, 0x30, 0x6f, 0x1d, 0xbb, 0x79, 0xca,
        0x72, 0x88, 0xe2, 0x46, 0x1b, 0x8e, 0x2d, 0x0c, 0x89, 0x40, 0xa9, 0x5a, 0x6e, 0x2e,
        0x63, 0x32, 0x3e, 0x46,
    ];
    // FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o
    const TEST_RECIPIENT: [u8; 32] = [
        0xd6, 0xe7, 0x9d, 0x45, 0xa5, 0x82, 0xad, 0x49, 0x2c, 0x5b, 0x5d, 0x80, 0xaa, 0x0f,
        0x55, 0xbf, 0x7d, 0x98, 0xc7, 0xb2, 0x49, 0x26, 0x55, 0x19, 0xe1, 0x99, 0x89, 0xd7,
        0x51, 0xac, 0x24, 0x60,
    ];
    // 7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe
    const TEST_RELAYER: [u8; 32] = [
        0x5d, 0x2c, 0x09, 0x0e, 0xd5, 0xcd, 0xb7, 0xfe, 0x80, 0xbd, 0x29, 0xc0, 0x8c, 0x92,
        0x8b, 0x10, 0xe1, 0x6d, 0xe1, 0xac, 0xe2, 0x7f, 0x22, 0xe2, 0x19, 0xdd, 0xc4, 0xfc,
        0xf7, 0x40, 0xcc, 0xe5,
    ];

    const TEST_DENOMINATION: u64 = 1_000_000_000;
    const TEST_FEE: u64 = 10_000_000;
    const TEST_CHAIN_ID: u64 = 1;
    const TEST_EXPIRY_SLOT: u64 = 500_000;
    const TEST_CIRCUIT_VERSION: u64 = 1;

    // Expected values computed from circomlibjs 0.1.7 via TS computePubkeysHash /
    // computeTxHash with the constants above. Confirmed identical to the
    // solana_poseidon native path (light-poseidon 0.4.0 hash_bytes_be).
    const EXPECTED_PUBKEYS_HASH: [u8; 32] = [
        0x25, 0x7d, 0xb0, 0x79, 0xc3, 0x7d, 0x4c, 0x65, 0x4e, 0x63, 0x76, 0x3d, 0x53, 0x60,
        0x6e, 0xe5, 0xd3, 0x26, 0x96, 0x92, 0xde, 0xce, 0x03, 0x4e, 0x82, 0x60, 0x6e, 0x8e,
        0xb3, 0x65, 0x7d, 0x7a,
    ];
    const EXPECTED_TX_HASH: [u8; 32] = [
        0x17, 0x11, 0x5e, 0x27, 0x28, 0x98, 0xa4, 0xcc, 0xa8, 0x17, 0x77, 0x91, 0xe2, 0xe9,
        0x9f, 0x51, 0xb2, 0xe0, 0x1e, 0x7b, 0xc2, 0xd1, 0x38, 0x11, 0x64, 0x21, 0x7f, 0x6e,
        0xf9, 0x31, 0xbc, 0xac,
    ];
    // pubkeys_hash when recipient is replaced with the relayer address
    const EXPECTED_PUBKEYS_HASH_ALT_RECIPIENT: [u8; 32] = [
        0x1d, 0xda, 0x74, 0xc4, 0x5b, 0x98, 0x7c, 0x67, 0xa4, 0xc4, 0x6e, 0xd2, 0xaf, 0x67,
        0x28, 0x87, 0x33, 0xca, 0x01, 0xa9, 0x66, 0xe9, 0x23, 0x0f, 0xa8, 0xe1, 0xeb, 0xee,
        0xa0, 0xcb, 0x61, 0x49,
    ];
    // pubkeys_hash when relayer is replaced with the recipient address
    const EXPECTED_PUBKEYS_HASH_ALT_RELAYER: [u8; 32] = [
        0x2d, 0x6b, 0xae, 0x2d, 0x8e, 0x26, 0x17, 0x2c, 0x5e, 0xe2, 0x60, 0x5c, 0x56, 0xc6,
        0x40, 0xf8, 0xcd, 0x05, 0xdb, 0x96, 0x68, 0x6c, 0x1c, 0x1f, 0x69, 0x61, 0x95, 0x5f,
        0x6d, 0x08, 0x64, 0x99,
    ];

    fn pubkey_from(bytes: [u8; 32]) -> Pubkey {
        Pubkey::from(bytes)
    }

    // 1. split_pubkey_le_u128: all-zero pubkey gives (0, 0)
    #[test]
    fn split_all_zero_gives_zero() {
        let (lo, hi) = split_pubkey_le_u128(&Pubkey::from([0u8; 32]));
        assert_eq!(lo, 0u128);
        assert_eq!(hi, 0u128);
    }

    // 2. split_pubkey_le_u128: known LE vector
    //    bytes[0]=0x01 → lo=1; bytes[16]=0x02 → hi=2
    #[test]
    fn split_known_le_vector() {
        let mut b = [0u8; 32];
        b[0] = 0x01;
        b[16] = 0x02;
        let (lo, hi) = split_pubkey_le_u128(&Pubkey::from(b));
        assert_eq!(lo, 1u128);
        assert_eq!(hi, 2u128);
    }

    // 3. compute_pubkeys_hash matches expected circomlibjs/TS vector
    #[test]
    fn compute_pubkeys_hash_matches_ts_vector() {
        let result = compute_pubkeys_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RELAYER),
        )
        .unwrap();
        assert_eq!(result, EXPECTED_PUBKEYS_HASH);
    }

    // 4. compute_tx_hash matches expected circomlibjs/TS vector
    #[test]
    fn compute_tx_hash_matches_ts_vector() {
        let result = compute_tx_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RELAYER),
            TEST_DENOMINATION,
            TEST_FEE,
            TEST_CHAIN_ID,
            TEST_EXPIRY_SLOT,
            TEST_CIRCUIT_VERSION,
        )
        .unwrap();
        assert_eq!(result, EXPECTED_TX_HASH);
    }

    // 5. Changing recipient changes pubkeys_hash
    #[test]
    fn changing_recipient_changes_pubkeys_hash() {
        let base = compute_pubkeys_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RELAYER),
        )
        .unwrap();
        let alt = compute_pubkeys_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RELAYER), // use relayer addr as recipient
            &pubkey_from(TEST_RELAYER),
        )
        .unwrap();
        assert_ne!(base, alt);
        assert_eq!(alt, EXPECTED_PUBKEYS_HASH_ALT_RECIPIENT);
    }

    // 6. Changing relayer changes pubkeys_hash
    #[test]
    fn changing_relayer_changes_pubkeys_hash() {
        let base = compute_pubkeys_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RELAYER),
        )
        .unwrap();
        let alt = compute_pubkeys_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RECIPIENT), // use recipient addr as relayer
        )
        .unwrap();
        assert_ne!(base, alt);
        assert_eq!(alt, EXPECTED_PUBKEYS_HASH_ALT_RELAYER);
    }

    // 7. Changing fee changes tx_hash
    #[test]
    fn changing_fee_changes_tx_hash() {
        let base = compute_tx_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RELAYER),
            TEST_DENOMINATION,
            TEST_FEE,
            TEST_CHAIN_ID,
            TEST_EXPIRY_SLOT,
            TEST_CIRCUIT_VERSION,
        )
        .unwrap();
        let alt = compute_tx_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RELAYER),
            TEST_DENOMINATION,
            TEST_FEE + 1,
            TEST_CHAIN_ID,
            TEST_EXPIRY_SLOT,
            TEST_CIRCUIT_VERSION,
        )
        .unwrap();
        assert_ne!(base, alt);
    }

    // 8. Changing expiry_slot changes tx_hash
    #[test]
    fn changing_expiry_slot_changes_tx_hash() {
        let base = compute_tx_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RELAYER),
            TEST_DENOMINATION,
            TEST_FEE,
            TEST_CHAIN_ID,
            TEST_EXPIRY_SLOT,
            TEST_CIRCUIT_VERSION,
        )
        .unwrap();
        let alt = compute_tx_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RELAYER),
            TEST_DENOMINATION,
            TEST_FEE,
            TEST_CHAIN_ID,
            TEST_EXPIRY_SLOT + 1,
            TEST_CIRCUIT_VERSION,
        )
        .unwrap();
        assert_ne!(base, alt);
    }

    // 9. Changing chain_id changes tx_hash
    #[test]
    fn changing_chain_id_changes_tx_hash() {
        let base = compute_tx_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RELAYER),
            TEST_DENOMINATION,
            TEST_FEE,
            TEST_CHAIN_ID,
            TEST_EXPIRY_SLOT,
            TEST_CIRCUIT_VERSION,
        )
        .unwrap();
        let alt = compute_tx_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RELAYER),
            TEST_DENOMINATION,
            TEST_FEE,
            TEST_CHAIN_ID + 1,
            TEST_EXPIRY_SLOT,
            TEST_CIRCUIT_VERSION,
        )
        .unwrap();
        assert_ne!(base, alt);
    }

    // 10. Changing circuit_version changes tx_hash
    #[test]
    fn changing_circuit_version_changes_tx_hash() {
        let base = compute_tx_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RELAYER),
            TEST_DENOMINATION,
            TEST_FEE,
            TEST_CHAIN_ID,
            TEST_EXPIRY_SLOT,
            TEST_CIRCUIT_VERSION,
        )
        .unwrap();
        let alt = compute_tx_hash(
            &pubkey_from(TEST_PROGRAM_ID),
            &pubkey_from(TEST_POOL_PDA),
            &pubkey_from(TEST_CONFIG_PDA),
            &pubkey_from(TEST_RECIPIENT),
            &pubkey_from(TEST_RELAYER),
            TEST_DENOMINATION,
            TEST_FEE,
            TEST_CHAIN_ID,
            TEST_EXPIRY_SLOT,
            TEST_CIRCUIT_VERSION + 1,
        )
        .unwrap();
        assert_ne!(base, alt);
    }
}
