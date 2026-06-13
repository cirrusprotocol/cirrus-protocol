/**
 * Parity gate: lib/crypto.ts ↔ Rust instruction.rs
 *
 * Loads golden vectors from tests/fixtures/parity_vectors.json.
 * Those vectors were computed by the authoritative Rust implementation
 * (crates/shielded-pool-interface/examples/parity_vectors.rs).
 *
 * Each vector asserts that the TypeScript preimage builder and hash function
 * produce bit-for-bit identical output to the Rust canonical implementation.
 *
 * No Anchor provider, no validator, no network — pure in-memory computation.
 *
 * To regenerate the fixture after a layout or tag change:
 *   cargo run -p shielded-pool-interface --example parity_vectors \
 *     > tests/fixtures/parity_vectors.json
 * Then commit the updated fixture and re-run this test.
 */

import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  buildIntentPreimage,
  computeIntentHash,
  buildHandshakePreimage,
  computeHandshakeHash,
  INTENT_PREIMAGE_SIZE,
  HANDSHAKE_PREIMAGE_SIZE,
  IntentInput,
  HandshakeInput,
} from "../lib/crypto";

// ── Fixture types ────────────────────────────────────────────────────────────

interface VectorIntent {
  recipient: string;
  relayer: string;
  amount: string;
  fee: string;
  nonce: string;
  chain_id: string;
  nullifier: string;
  commitment: string;
  merkle_root: string;
  audit_hash: string;
  policy_id: number;
}

interface VectorHandshake {
  program_id: string;
  pool_pda: string;
  config_pda: string;
  expiry_slot: string;
  policy_id: number;
}

interface VectorExpected {
  intent_preimage: string;
  intent_hash: string;
  handshake_preimage: string;
  handshake_hash: string;
}

interface ParityVector {
  name: string;
  intent: VectorIntent;
  handshake: VectorHandshake;
  expected: VectorExpected;
}

// ── Load fixture ─────────────────────────────────────────────────────────────

const fixturePath = path.join(__dirname, "fixtures", "parity_vectors.json");
const vectors: ParityVector[] = JSON.parse(
  fs.readFileSync(fixturePath, "utf8")
);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Parity: lib/crypto.ts ↔ Rust instruction.rs", () => {
  it("fixture loads 5 vectors", () => {
    expect(vectors).to.have.length(5);
  });

  for (const v of vectors) {
    describe(`vector: ${v.name}`, () => {
      const intentInput: IntentInput = {
        recipient: new PublicKey(Buffer.from(v.intent.recipient, "hex")),
        relayer: new PublicKey(Buffer.from(v.intent.relayer, "hex")),
        amount: BigInt(v.intent.amount),
        fee: BigInt(v.intent.fee),
        nonce: BigInt(v.intent.nonce),
        chainId: BigInt(v.intent.chain_id),
        nullifier: Buffer.from(v.intent.nullifier, "hex"),
        commitment: Buffer.from(v.intent.commitment, "hex"),
        merkleRoot: Buffer.from(v.intent.merkle_root, "hex"),
        auditHash: Buffer.from(v.intent.audit_hash, "hex"),
        policyId: v.intent.policy_id,
      };

      // Use the Rust-authoritative intent hash as the handshake input.
      // This keeps intent and handshake assertions independent: a bug in
      // computeIntentHash will not cascade into a false handshake failure.
      const handshakeInput: HandshakeInput = {
        programId: new PublicKey(Buffer.from(v.handshake.program_id, "hex")),
        poolPda: new PublicKey(Buffer.from(v.handshake.pool_pda, "hex")),
        configPda: new PublicKey(Buffer.from(v.handshake.config_pda, "hex")),
        expirySlot: BigInt(v.handshake.expiry_slot),
        intentHash: Buffer.from(v.expected.intent_hash, "hex"),
        auditHash: Buffer.from(v.intent.audit_hash, "hex"),
        policyId: v.handshake.policy_id,
      };

      it("intent preimage matches Rust", () => {
        const preimage = buildIntentPreimage(intentInput);
        expect(preimage.length).to.equal(
          INTENT_PREIMAGE_SIZE,
          "intent preimage size"
        );
        expect(preimage.toString("hex")).to.equal(v.expected.intent_preimage);
      });

      it("intent hash matches Rust", () => {
        const hash = computeIntentHash(intentInput);
        expect(hash.toString("hex")).to.equal(v.expected.intent_hash);
      });

      it("handshake preimage matches Rust", () => {
        const preimage = buildHandshakePreimage(handshakeInput);
        expect(preimage.length).to.equal(
          HANDSHAKE_PREIMAGE_SIZE,
          "handshake preimage size"
        );
        expect(preimage.toString("hex")).to.equal(
          v.expected.handshake_preimage
        );
      });

      it("handshake hash matches Rust", () => {
        const hash = computeHandshakeHash(handshakeInput);
        expect(hash.toString("hex")).to.equal(v.expected.handshake_hash);
      });
    });
  }
});
