// Parity vector generator for the shielded pool canonical hash functions.
//
// Prints a JSON array of test vectors to stdout. Regenerate the committed fixture with:
//   cargo run -p shielded-pool-interface --example parity_vectors > tests/fixtures/parity_vectors.json
//
// Re-run whenever instruction.rs layout or domain tags change, then commit the updated fixture.

use shielded_pool_interface::instruction::{
    build_handshake_preimage_v1, build_intent_preimage_v1, compute_handshake_hash_v1,
    compute_intent_hash_v1, WithdrawalIntentV1,
};
use solana_program::pubkey::Pubkey;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

struct Params {
    name: &'static str,
    // intent fields
    recipient: [u8; 32],
    relayer: [u8; 32],
    amount: u64,
    fee: u64,
    nonce: u64,
    chain_id: u64,
    nullifier: [u8; 32],
    commitment: [u8; 32],
    merkle_root: [u8; 32],
    audit_hash: [u8; 32],
    policy_id: u8,
    // handshake-only fields
    program_id: [u8; 32],
    pool_pda: [u8; 32],
    config_pda: [u8; 32],
    expiry_slot: u64,
}

fn main() {
    let vectors: Vec<Params> = vec![
        // V1 — all zeros / minimum values
        Params {
            name: "zero_baseline",
            recipient: [0u8; 32],
            relayer: [0u8; 32],
            amount: 0,
            fee: 0,
            nonce: 0,
            chain_id: 0,
            nullifier: [0u8; 32],
            commitment: [0u8; 32],
            merkle_root: [0u8; 32],
            audit_hash: [0u8; 32],
            policy_id: 0,
            program_id: [0u8; 32],
            pool_pda: [0u8; 32],
            config_pda: [0u8; 32],
            expiry_slot: 0,
        },
        // V2 — realistic devnet-like values
        Params {
            name: "devnet_typical",
            recipient: [0x01u8; 32],
            relayer: [0x02u8; 32],
            amount: 1_000_000_000,
            fee: 200_000,
            nonce: 1_748_000_000_000,
            chain_id: 1,
            nullifier: [0xabu8; 32],
            commitment: [0xcdu8; 32],
            merkle_root: [0xefu8; 32],
            audit_hash: [0x12u8; 32],
            policy_id: 1,
            program_id: [0x11u8; 32],
            pool_pda: [0x22u8; 32],
            config_pda: [0x33u8; 32],
            expiry_slot: 464_200_000,
        },
        // V3 — maximum u64 fields and max policy_id
        Params {
            name: "max_u64_fields",
            recipient: [0xffu8; 32],
            relayer: [0xfeu8; 32],
            amount: u64::MAX,
            fee: u64::MAX / 2,
            nonce: u64::MAX,
            chain_id: u64::MAX,
            nullifier: [0xaau8; 32],
            commitment: [0xbbu8; 32],
            merkle_root: [0xccu8; 32],
            audit_hash: [0xddu8; 32],
            policy_id: 255,
            program_id: [0xeeu8; 32],
            pool_pda: [0xf0u8; 32],
            config_pda: [0xf1u8; 32],
            expiry_slot: u64::MAX,
        },
        // V4 — different chain_id and policy_id
        Params {
            name: "chain2_policy5",
            recipient: [0x41u8; 32],
            relayer: [0x42u8; 32],
            amount: 500_000_000,
            fee: 100_000,
            nonce: 42,
            chain_id: 2,
            nullifier: [0x55u8; 32],
            commitment: [0x66u8; 32],
            merkle_root: [0x77u8; 32],
            audit_hash: [0x88u8; 32],
            policy_id: 5,
            program_id: [0x99u8; 32],
            pool_pda: [0xaau8; 32],
            config_pda: [0xbbu8; 32],
            expiry_slot: 100_000,
        },
        // V5 — distinct byte patterns per field; tests audit_hash presence in both preimages
        Params {
            name: "distinct_fields",
            recipient: {
                let mut b = [0u8; 32];
                b[0] = 0xde;
                b[31] = 0xad;
                b
            },
            relayer: {
                let mut b = [0u8; 32];
                b[0] = 0xbe;
                b[31] = 0xef;
                b
            },
            amount: 250_000_000,
            fee: 50_000,
            nonce: 9999,
            chain_id: 1,
            nullifier: {
                let mut b = [0u8; 32];
                for i in 0..32usize {
                    b[i] = i as u8;
                }
                b
            },
            commitment: {
                let mut b = [0u8; 32];
                for i in 0..32usize {
                    b[i] = (255 - i) as u8;
                }
                b
            },
            merkle_root: [0x7fu8; 32],
            audit_hash: {
                let mut b = [0u8; 32];
                for i in 0..32usize {
                    b[i] = (i * 2) as u8;
                }
                b
            },
            policy_id: 3,
            program_id: [0x34u8; 32],
            pool_pda: [0x56u8; 32],
            config_pda: [0x78u8; 32],
            expiry_slot: 1_000_000_000,
        },
    ];

    let n = vectors.len();
    println!("[");
    for (idx, p) in vectors.iter().enumerate() {
        let intent = WithdrawalIntentV1 {
            commitment: p.commitment,
            nullifier: p.nullifier,
            recipient: Pubkey::new_from_array(p.recipient),
            amount: p.amount,
            fee: p.fee,
            relayer: Pubkey::new_from_array(p.relayer),
            chain_id: p.chain_id,
            nonce: p.nonce,
            audit_hash: p.audit_hash,
            policy_id: p.policy_id,
            merkle_root: p.merkle_root,
        };

        let intent_preimage = build_intent_preimage_v1(
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
        let intent_hash = compute_intent_hash_v1(&intent);

        let hs_preimage = build_handshake_preimage_v1(
            &Pubkey::new_from_array(p.program_id),
            &Pubkey::new_from_array(p.pool_pda),
            &Pubkey::new_from_array(p.config_pda),
            p.expiry_slot,
            &p.audit_hash,
            &intent_hash,
            p.policy_id,
        );
        let hs_hash = compute_handshake_hash_v1(
            &Pubkey::new_from_array(p.program_id),
            &Pubkey::new_from_array(p.pool_pda),
            &Pubkey::new_from_array(p.config_pda),
            p.expiry_slot,
            &intent_hash,
            &p.audit_hash,
            p.policy_id,
        );

        let trail = if idx + 1 < n { "," } else { "" };
        println!("  {{");
        println!("    \"name\": \"{}\",", p.name);
        println!("    \"intent\": {{");
        println!("      \"recipient\": \"{}\",", hex(&p.recipient));
        println!("      \"relayer\": \"{}\",", hex(&p.relayer));
        println!("      \"amount\": \"{}\",", p.amount);
        println!("      \"fee\": \"{}\",", p.fee);
        println!("      \"nonce\": \"{}\",", p.nonce);
        println!("      \"chain_id\": \"{}\",", p.chain_id);
        println!("      \"nullifier\": \"{}\",", hex(&p.nullifier));
        println!("      \"commitment\": \"{}\",", hex(&p.commitment));
        println!("      \"merkle_root\": \"{}\",", hex(&p.merkle_root));
        println!("      \"audit_hash\": \"{}\",", hex(&p.audit_hash));
        println!("      \"policy_id\": {}", p.policy_id);
        println!("    }},");
        println!("    \"handshake\": {{");
        println!("      \"program_id\": \"{}\",", hex(&p.program_id));
        println!("      \"pool_pda\": \"{}\",", hex(&p.pool_pda));
        println!("      \"config_pda\": \"{}\",", hex(&p.config_pda));
        println!("      \"expiry_slot\": \"{}\",", p.expiry_slot);
        println!("      \"policy_id\": {}", p.policy_id);
        println!("    }},");
        println!("    \"expected\": {{");
        println!("      \"intent_preimage\": \"{}\",", hex(&intent_preimage));
        println!("      \"intent_hash\": \"{}\",", hex(&intent_hash));
        println!("      \"handshake_preimage\": \"{}\",", hex(&hs_preimage));
        println!("      \"handshake_hash\": \"{}\"", hex(&hs_hash));
        println!("    }}");
        println!("  }}{}", trail);
    }
    println!("]");
}
