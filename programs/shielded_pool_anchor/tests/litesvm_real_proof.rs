//! LiteSVM integration test: real Groth16 proof path + CU benchmark.
//!
//! Loads the compiled shielded_pool_anchor BPF so, sets up pool/config state via
//! instruction chain (initialize_pool → initialize_config → add_allowed_root), then
//! sends a `withdraw_zk` transaction carrying the canonical devnet proof
//! (TEST_SECRET=12345) and measures compute units consumed.
//!
//! NOTE: Instruction-chain setup is intentional — it exercises real state
//! initialization through the program's own instructions rather than direct account
//! injection, which requires no additional dependencies and validates the full
//! setup flow end-to-end.
//!
//! These tests are marked `#[ignore]` because they require a prebuilt BPF artifact
//! from `anchor build`. They are excluded from the default `cargo test` run and must
//! be invoked explicitly:
//!
//!   anchor build
//!   cargo test --manifest-path programs/shielded_pool_anchor/Cargo.toml \
//!       --test litesvm_real_proof -- --ignored --nocapture

use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::{AccountMeta, Address, Instruction, Message, Signature, Transaction};

// ── Proof bytes (canonical devnet proof, TEST_SECRET=12345) ──────────────────
// Encoding: proofA = G1(x_BE‖neg_y_BE), proofB = G2(xc1‖xc0‖yc1‖yc0 each BE),
//           proofC = G1(x_BE‖y_BE).  Verified against proof_encoder.ts output.

const PROOF_A: [u8; 64] = [
    0x11, 0xf3, 0xd8, 0x6e, 0x5d, 0xd5, 0xcf, 0xbd, 0xd9, 0xaf, 0xe8, 0x71, 0x0c, 0x7e, 0x47,
    0x74, 0xf6, 0x1e, 0xad, 0x7a, 0xa3, 0x2d, 0xf1, 0xe1, 0x0b, 0x5f, 0x90, 0xce, 0xeb, 0x12,
    0x81, 0xa8, 0x18, 0x91, 0xa4, 0x96, 0x3d, 0x25, 0x37, 0xf5, 0x96, 0x71, 0xc6, 0xb3, 0xaa,
    0x50, 0xa5, 0xcd, 0x0b, 0x77, 0x51, 0x1d, 0x52, 0xca, 0xc2, 0x8f, 0x32, 0x57, 0x0c, 0xe0,
    0x10, 0xcb, 0x77, 0xa4,
];

const PROOF_B: [u8; 128] = [
    0x10, 0xcb, 0x11, 0xcc, 0x4d, 0xfc, 0x54, 0xe6, 0x84, 0x9c, 0x8c, 0x00, 0x09, 0x83, 0x12,
    0x27, 0x32, 0xdf, 0xf2, 0x29, 0xf0, 0xc9, 0xe0, 0x4f, 0x29, 0x46, 0xc7, 0x17, 0x92, 0x18,
    0x53, 0x85, 0x22, 0x2c, 0x2c, 0xd4, 0xf6, 0x80, 0xbf, 0x7b, 0xc6, 0x7c, 0x1d, 0x4f, 0xdb,
    0x97, 0x5a, 0x8f, 0x02, 0x4a, 0x4e, 0x68, 0xa1, 0x4d, 0xbd, 0x00, 0xf3, 0xb2, 0x0f, 0x11,
    0x34, 0x78, 0x62, 0x9b, 0x29, 0x2c, 0x92, 0x02, 0x54, 0xc6, 0xbf, 0xfa, 0x33, 0xe6, 0xd3,
    0x76, 0xb1, 0xbd, 0x03, 0x02, 0x93, 0x3d, 0xf8, 0x46, 0xa0, 0x0e, 0x24, 0x87, 0x79, 0x60,
    0x34, 0x73, 0x7a, 0x16, 0x6e, 0x94, 0x21, 0x67, 0x90, 0x68, 0x4f, 0x9f, 0x9f, 0xdb, 0xce,
    0x13, 0x99, 0x9c, 0x06, 0xe9, 0xb2, 0x25, 0x35, 0x65, 0x09, 0x28, 0xbc, 0x84, 0xe9, 0xbb,
    0xc5, 0xb4, 0x75, 0xe9, 0xe0, 0x27, 0xb6, 0x17,
];

const PROOF_C: [u8; 64] = [
    0x29, 0x41, 0x8e, 0x2a, 0x1d, 0xd2, 0x57, 0xea, 0xc1, 0xb7, 0x00, 0x82, 0x9a, 0x34, 0x10,
    0xc1, 0xe9, 0x4c, 0x32, 0x54, 0xd0, 0xbd, 0xf0, 0xb8, 0x48, 0xa9, 0xaa, 0xd2, 0xf1, 0x32,
    0x97, 0xd3, 0x1c, 0xc2, 0x1c, 0x91, 0x7e, 0x90, 0x08, 0x10, 0x0b, 0x5a, 0xb3, 0x1c, 0x4a,
    0xaf, 0xa6, 0xb4, 0x12, 0xdb, 0xad, 0x71, 0x80, 0x5b, 0xae, 0x28, 0x0a, 0x50, 0x78, 0x3c,
    0x3d, 0xda, 0x27, 0x74,
];

// ── Public inputs (big-endian, canonical devnet proof) ────────────────────────
const ROOT: [u8; 32] = [
    0x01, 0x94, 0x84, 0xfc, 0x7e, 0x68, 0x25, 0x7f, 0x3b, 0xbf, 0xbd, 0x27, 0x7b, 0xea, 0xbb,
    0x5a, 0x60, 0x82, 0xbc, 0x0d, 0xd6, 0xf9, 0x61, 0x54, 0xbd, 0xeb, 0xde, 0x0b, 0x81, 0xb7,
    0x2f, 0x38,
];

const NULLIFIER_HASH: [u8; 32] = [
    0x27, 0xcb, 0x78, 0xd0, 0x54, 0x1f, 0x39, 0x12, 0xc8, 0x64, 0x5b, 0xd6, 0x0a, 0xcb, 0xe7,
    0xa7, 0x20, 0x52, 0x25, 0xe0, 0xe6, 0xf5, 0x5a, 0x17, 0xf4, 0x84, 0x3a, 0xc7, 0x19, 0xe3,
    0xea, 0xfe,
];

// ── Account addresses ─────────────────────────────────────────────────────────
const PROGRAM_ID: [u8; 32] = [
    0xc2, 0x37, 0x59, 0xbe, 0x31, 0xac, 0xe7, 0xbc, 0xda, 0xe3, 0xfb, 0x83, 0x53, 0xdf, 0x50,
    0xb4, 0x89, 0x98, 0x1d, 0xf0, 0xfa, 0xb6, 0xf5, 0x52, 0xa7, 0x10, 0x87, 0x15, 0x99, 0x0c,
    0xa0, 0x58,
];

const POOL_STATE_PDA: [u8; 32] = [
    0xf6, 0xbd, 0x57, 0xae, 0xf0, 0x32, 0xa0, 0x6e, 0x9f, 0x61, 0x4b, 0x8f, 0x05, 0xa0, 0x73,
    0x1d, 0x5d, 0x71, 0xb7, 0x51, 0xd4, 0xed, 0x5e, 0xab, 0xe8, 0xa3, 0xfb, 0xe7, 0xc4, 0x00,
    0x13, 0xa0,
];

const CONFIG_PDA: [u8; 32] = [
    0x4d, 0x7c, 0x86, 0x4a, 0x26, 0x58, 0xb9, 0xf4, 0x30, 0x6f, 0x1d, 0xbb, 0x79, 0xca, 0x72,
    0x88, 0xe2, 0x46, 0x1b, 0x8e, 0x2d, 0x0c, 0x89, 0x40, 0xa9, 0x5a, 0x6e, 0x2e, 0x63, 0x32,
    0x3e, 0x46,
];

// Canonical proof relayer: 7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe
const RELAYER: [u8; 32] = [
    0x5d, 0x2c, 0x09, 0x0e, 0xd5, 0xcd, 0xb7, 0xfe, 0x80, 0xbd, 0x29, 0xc0, 0x8c, 0x92, 0x8b,
    0x10, 0xe1, 0x6d, 0xe1, 0xac, 0xe2, 0x7f, 0x22, 0xe2, 0x19, 0xdd, 0xc4, 0xfc, 0xf7, 0x40,
    0xcc, 0xe5,
];

// Canonical proof recipient: FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o
const RECIPIENT: [u8; 32] = [
    0xd6, 0xe7, 0x9d, 0x45, 0xa5, 0x82, 0xad, 0x49, 0x2c, 0x5b, 0x5d, 0x80, 0xaa, 0x0f, 0x55,
    0xbf, 0x7d, 0x98, 0xc7, 0xb2, 0x49, 0x26, 0x55, 0x19, 0xe1, 0x99, 0x89, 0xd7, 0x51, 0xac,
    0x24, 0x60,
];

// PDA for seeds=[b"nullifier", NULLIFIER_HASH] under PROGRAM_ID, bump=255
// = 2GXqoSTg4B5bYKjfuJS2uRCRXRe5EppQigQvYDrbV2ga
const NULLIFIER_MARKER_PDA: [u8; 32] = [
    0x12, 0xd6, 0x45, 0x83, 0x46, 0x33, 0xf9, 0xf1, 0xda, 0x61, 0x78, 0xfe, 0x2e, 0x37, 0x81,
    0x12, 0x4e, 0xc5, 0x95, 0xe4, 0x02, 0x99, 0x62, 0x95, 0x33, 0xe6, 0x05, 0xf0, 0x25, 0xaa,
    0xe1, 0xbb,
];

const SYSTEM_PROGRAM_ID: [u8; 32] = [0u8; 32];

// ComputeBudget111111111111111111111111111111
const COMPUTE_BUDGET_PROGRAM_ID: [u8; 32] = [
    0x03, 0x06, 0x46, 0x6f, 0xe5, 0x21, 0x17, 0x32, 0xff, 0xec, 0xad, 0xba, 0x72, 0xc3, 0x9b,
    0xe7, 0xbc, 0x8c, 0xe5, 0xbb, 0xc5, 0xf7, 0x12, 0x6b, 0x2c, 0x43, 0x9b, 0x3a, 0x40, 0x00,
    0x00, 0x00,
];

// ── Anchor instruction discriminators (SHA256("global:name")[0..8]) ───────────
const DISC_INIT_POOL: [u8; 8] = [0x5f, 0xb4, 0x0a, 0xac, 0x54, 0xae, 0xe8, 0x28];
const DISC_INIT_CONFIG: [u8; 8] = [0xd0, 0x7f, 0x15, 0x01, 0xc2, 0xbe, 0xc4, 0x46];
const DISC_ADD_ROOT: [u8; 8] = [0xc5, 0x0a, 0x27, 0x4d, 0x75, 0x57, 0xe4, 0xe9];
const DISC_WITHDRAW_ZK: [u8; 8] = [0xc8, 0x9d, 0x25, 0x36, 0x3c, 0x6a, 0x81, 0xcc];

// ── Instruction parameters ────────────────────────────────────────────────────
const DENOMINATION: u64 = 1_000_000_000;
const FEE: u64 = 10_000_000;
const EXPIRY_SLOT: u64 = 500_000;
const CIRCUIT_VERSION: u64 = 1;
const CHAIN_ID: u64 = 1;

fn load_program() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/shielded_pool_anchor.so"
    ))
    .expect("shielded_pool_anchor.so not found — run `anchor build` first")
}

fn send_tx(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Address) {
    let mut msg = Message::new(ixs, Some(payer));
    msg.recent_blockhash = svm.latest_blockhash();
    let n = msg.header.num_required_signatures as usize;
    svm.send_transaction(Transaction {
        signatures: vec![Signature::default(); n],
        message: msg,
    })
    .unwrap_or_else(|e| panic!("setup tx failed: {:?}", e.err));
}

fn setup() -> LiteSVM {
    let program = load_program();
    let mut svm = LiteSVM::new().with_sigverify(false);
    svm.add_program(Address::from(PROGRAM_ID), &program)
        .expect("failed to load shielded_pool_anchor program");

    let admin = Keypair::new();
    let pk = admin.pubkey();
    svm.airdrop(&pk, 100_000_000_000).unwrap();
    svm.airdrop(&Address::from(RELAYER), 100_000_000_000).unwrap();
    svm.airdrop(&Address::from(RECIPIENT), 1_000_000).unwrap();

    // 1. initialize_pool
    {
        let data = DISC_INIT_POOL.to_vec();
        let ix = Instruction {
            program_id: Address::from(PROGRAM_ID),
            accounts: vec![
                AccountMeta::new(pk, true),
                AccountMeta::new(Address::from(POOL_STATE_PDA), false),
                AccountMeta::new_readonly(Address::from(SYSTEM_PROGRAM_ID), false),
            ],
            data,
        };
        send_tx(&mut svm, &[ix], &pk);
    }

    // 2. initialize_config (admin as attester and single verifier, chain_id=CHAIN_ID)
    {
        let mut data = DISC_INIT_CONFIG.to_vec();
        data.extend_from_slice(pk.as_ref()); // attester_pubkey
        data.extend_from_slice(&1u32.to_le_bytes()); // verifier_pubkeys len=1
        data.extend_from_slice(pk.as_ref()); // verifier_pubkeys[0]
        data.push(1u8); // threshold=1
        data.extend_from_slice(&CHAIN_ID.to_le_bytes());
        let ix = Instruction {
            program_id: Address::from(PROGRAM_ID),
            accounts: vec![
                AccountMeta::new(pk, true),
                AccountMeta::new(Address::from(CONFIG_PDA), false),
                AccountMeta::new_readonly(Address::from(SYSTEM_PROGRAM_ID), false),
            ],
            data,
        };
        send_tx(&mut svm, &[ix], &pk);
    }

    // 3. add_allowed_root (the ROOT from the canonical devnet proof)
    {
        let mut data = DISC_ADD_ROOT.to_vec();
        data.extend_from_slice(&ROOT);
        let ix = Instruction {
            program_id: Address::from(PROGRAM_ID),
            accounts: vec![
                AccountMeta::new_readonly(pk, true),
                AccountMeta::new(Address::from(CONFIG_PDA), false),
            ],
            data,
        };
        send_tx(&mut svm, &[ix], &pk);
    }

    // 4. fund pool (denomination + generous buffer so pool_spendable >= denomination)
    svm.airdrop(&Address::from(POOL_STATE_PDA), 2 * DENOMINATION)
        .unwrap();

    svm
}

fn build_withdraw_tx(svm: &LiteSVM, proof_a: &[u8; 64]) -> Transaction {
    // Instruction data layout (Borsh):
    //   8 disc | 64 proof_a | 128 proof_b | 64 proof_c |
    //   32 root | 32 nullifier_hash |
    //   8 denomination | 8 fee | 8 expiry_slot | 8 circuit_version
    let mut data = DISC_WITHDRAW_ZK.to_vec();
    data.extend_from_slice(proof_a);
    data.extend_from_slice(&PROOF_B);
    data.extend_from_slice(&PROOF_C);
    data.extend_from_slice(&ROOT);
    data.extend_from_slice(&NULLIFIER_HASH);
    data.extend_from_slice(&DENOMINATION.to_le_bytes());
    data.extend_from_slice(&FEE.to_le_bytes());
    data.extend_from_slice(&EXPIRY_SLOT.to_le_bytes());
    data.extend_from_slice(&CIRCUIT_VERSION.to_le_bytes());

    let cb_ix = Instruction {
        program_id: Address::from(COMPUTE_BUDGET_PROGRAM_ID),
        accounts: vec![],
        data: vec![0x02, 0xc0, 0x5c, 0x15, 0x00], // SetComputeUnitLimit(1_400_000)
    };
    let withdraw_ix = Instruction {
        program_id: Address::from(PROGRAM_ID),
        accounts: vec![
            AccountMeta::new(Address::from(RELAYER), true), // relayer: Signer, mut
            AccountMeta::new(Address::from(POOL_STATE_PDA), false), // pool_state: mut
            AccountMeta::new_readonly(Address::from(CONFIG_PDA), false), // config: readonly
            AccountMeta::new(Address::from(NULLIFIER_MARKER_PDA), false), // nullifier_marker: init_if_needed
            AccountMeta::new(Address::from(RECIPIENT), false), // recipient: mut
            AccountMeta::new_readonly(Address::from(SYSTEM_PROGRAM_ID), false), // system_program
        ],
        data,
    };

    let relayer_addr = Address::from(RELAYER);
    let mut msg = Message::new(&[cb_ix, withdraw_ix], Some(&relayer_addr));
    msg.recent_blockhash = svm.latest_blockhash();
    let n = msg.header.num_required_signatures as usize;
    Transaction {
        signatures: vec![Signature::default(); n],
        message: msg,
    }
}

// Happy path: real Groth16 proof verifies on-chain, CU are bounded and reported.
// Requires prebuilt target/deploy/shielded_pool_anchor.so — run `anchor build` first.
#[test]
#[ignore]
fn withdraw_zk_real_proof_succeeds_and_reports_cu() {
    let mut svm = setup();
    let tx = build_withdraw_tx(&svm, &PROOF_A);
    let meta = svm
        .send_transaction(tx)
        .expect("withdraw_zk should succeed with real Groth16 proof");

    println!("withdraw_zk CU consumed: {}", meta.compute_units_consumed);
    for log in &meta.logs {
        println!("{}", log);
    }

    assert!(
        meta.compute_units_consumed > 100_000,
        "expected significant CU for BN254 pairing syscall, got {}",
        meta.compute_units_consumed
    );
    assert!(
        meta.compute_units_consumed < 1_400_000,
        "CU exceeded compute budget ceiling of 1_400_000, got {}",
        meta.compute_units_consumed
    );
}

// Tampered proof must be rejected by the on-chain Groth16 verifier.
// Requires prebuilt target/deploy/shielded_pool_anchor.so — run `anchor build` first.
#[test]
#[ignore]
fn withdraw_zk_tampered_proof_rejected() {
    let mut svm = setup();
    let mut bad_a = PROOF_A;
    bad_a[0] ^= 0xff;
    let tx = build_withdraw_tx(&svm, &bad_a);
    assert!(
        svm.send_transaction(tx).is_err(),
        "tampered proof_a must be rejected by on-chain Groth16 verifier"
    );
}
