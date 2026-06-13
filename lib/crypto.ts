/**
 * Canonical cryptographic primitives for the Shielded Pool protocol.
 *
 * Single source of truth for:
 *   - Intent preimage layout (248 bytes, Keccak256)
 *   - Handshake preimage layout (196 bytes, Keccak256)
 *   - Ed25519 instruction construction (single and multi-signer)
 *
 * All constants and field ordering mirror the Rust canonical implementation in
 * crates/shielded-pool-interface/src/instruction.rs.
 * Any change here must be reflected there, and vice versa.
 */

import { randomBytes } from "crypto";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const keccak = require("keccak");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nacl = require("tweetnacl");

// ── Protocol constants (must match Rust instruction.rs exactly) ─────────────

/** "SHIELDED_POOL_INTENT_V1" — 23 bytes */
export const INTENT_DOMAIN_TAG = Buffer.from("SHIELDED_POOL_INTENT_V1", "utf8");

/** "SHIELDED_POOL_HANDSHAKE_V1" — 26 bytes */
export const HANDSHAKE_DOMAIN_TAG = Buffer.from(
  "SHIELDED_POOL_HANDSHAKE_V1",
  "utf8"
);

export const PROTOCOL_VERSION_BYTE = 0x10;
export const INTENT_PREIMAGE_SIZE = 248;
export const HANDSHAKE_PREIMAGE_SIZE = 196;

const ED25519_PROGRAM_ID = new PublicKey(
  "Ed25519SigVerify111111111111111111111111111"
);
const U64_MAX = BigInt("18446744073709551615");

// ── Types ────────────────────────────────────────────────────────────────────

/** Any 32-byte representation accepted as input */
export type Bytes32 = number[] | Buffer | Uint8Array;

/**
 * Any representation of a u64 value accepted by the helper.
 * BN satisfies this via its toString() method.
 */
export type U64Like = bigint | number | { toString(): string };

/**
 * All fields needed to compute the canonical intent hash.
 * Mirrors the Rust WithdrawalIntentV1 struct.
 */
export interface IntentInput {
  recipient: PublicKey;
  relayer: PublicKey;
  amount: U64Like;
  fee: U64Like;
  nonce: U64Like;
  chainId: U64Like;
  nullifier: Bytes32;
  commitment: Bytes32;
  merkleRoot: Bytes32;
  auditHash: Bytes32;
  policyId: number;
}

/**
 * All fields needed to compute the canonical handshake hash.
 * The handshake pins intent_hash to program + PDAs + expiry.
 */
export interface HandshakeInput {
  programId: PublicKey;
  poolPda: PublicKey;
  configPda: PublicKey;
  expirySlot: U64Like;
  intentHash: Buffer;
  auditHash: Bytes32;
  policyId: number;
}

// ── Encoding helpers ─────────────────────────────────────────────────────────

/** Encode a u64 as 8 little-endian bytes. Rejects overflow and negative values. */
export function u64LE(value: U64Like): Buffer {
  const n = typeof value === "bigint" ? value : BigInt(value.toString());
  if (n < 0n || n > U64_MAX) {
    throw new RangeError(`u64 overflow: ${n} not in [0, 2^64-1]`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n);
  return buf;
}

/** Normalize any Bytes32 to a Buffer without copying if already a Buffer. */
export function toBuffer(b: Bytes32): Buffer {
  return Buffer.isBuffer(b) ? b : Buffer.from(b);
}

// ── Preimage builders ────────────────────────────────────────────────────────

/**
 * Build the canonical 248-byte intent preimage.
 *
 * Field order (mirrors Rust build_intent_preimage_v1):
 *   TAG(23) | recipient(32) | relayer(32) | amount(8) | fee(8) | nonce(8) |
 *   chain_id(8) | nullifier(32) | commitment(32) | merkle_root(32) |
 *   audit_hash(32) | policy_id(1)
 *   = 248 bytes total
 */
export function buildIntentPreimage(input: IntentInput): Buffer {
  const preimage = Buffer.concat([
    INTENT_DOMAIN_TAG,
    input.recipient.toBuffer(),
    input.relayer.toBuffer(),
    u64LE(input.amount),
    u64LE(input.fee),
    u64LE(input.nonce),
    u64LE(input.chainId),
    toBuffer(input.nullifier),
    toBuffer(input.commitment),
    toBuffer(input.merkleRoot),
    toBuffer(input.auditHash),
    Buffer.from([input.policyId]),
  ]);
  if (preimage.length !== INTENT_PREIMAGE_SIZE) {
    throw new Error(
      `Intent preimage size mismatch: got ${preimage.length}, expected ${INTENT_PREIMAGE_SIZE}`
    );
  }
  return preimage;
}

/**
 * Build the canonical 196-byte handshake preimage.
 *
 * Field order (mirrors Rust build_handshake_preimage_v1):
 *   TAG(26) | version(1) | program_id(32) | pool_pda(32) | config_pda(32) |
 *   expiry_slot(8) | audit_hash(32) | intent_hash(32) | policy_id(1)
 *   = 196 bytes total
 */
export function buildHandshakePreimage(input: HandshakeInput): Buffer {
  const preimage = Buffer.concat([
    HANDSHAKE_DOMAIN_TAG,
    Buffer.from([PROTOCOL_VERSION_BYTE]),
    input.programId.toBuffer(),
    input.poolPda.toBuffer(),
    input.configPda.toBuffer(),
    u64LE(input.expirySlot),
    toBuffer(input.auditHash),
    input.intentHash,
    Buffer.from([input.policyId]),
  ]);
  if (preimage.length !== HANDSHAKE_PREIMAGE_SIZE) {
    throw new Error(
      `Handshake preimage size mismatch: got ${preimage.length}, expected ${HANDSHAKE_PREIMAGE_SIZE}`
    );
  }
  return preimage;
}

// ── Hash functions ───────────────────────────────────────────────────────────

export function keccak256(data: Buffer): Buffer {
  return keccak("keccak256").update(data).digest();
}

/** Canonical intent hash: keccak256(buildIntentPreimage(input)) */
export function computeIntentHash(input: IntentInput): Buffer {
  return keccak256(buildIntentPreimage(input));
}

/** Canonical handshake hash: keccak256(buildHandshakePreimage(input)) */
export function computeHandshakeHash(input: HandshakeInput): Buffer {
  return keccak256(buildHandshakePreimage(input));
}

// ── Ed25519 instruction builders ─────────────────────────────────────────────

/**
 * Build a single-signer Ed25519 precompile instruction.
 *
 * Layout:
 *   [0]     num_sigs = 1
 *   [1]     padding
 *   [2..16] 14-byte offset struct
 *   [16..48]  pubkey (32 bytes)
 *   [48..112] signature (64 bytes)
 *   [112..]   message
 */
export function makeEd25519Instruction(
  signer: Keypair,
  message: Buffer
): TransactionInstruction {
  const signature = nacl.sign.detached(message, signer.secretKey);
  const pubkeyOffset = 16;
  const signatureOffset = 48;
  const messageOffset = 112;
  const data = Buffer.alloc(messageOffset + message.length);

  data[0] = 1; // num_sigs
  data[1] = 0; // padding
  data.writeUInt16LE(signatureOffset, 2);
  data.writeUInt16LE(0xffff, 4); // sig instruction index = current
  data.writeUInt16LE(pubkeyOffset, 6);
  data.writeUInt16LE(0xffff, 8); // pubkey instruction index = current
  data.writeUInt16LE(messageOffset, 10);
  data.writeUInt16LE(message.length, 12);
  data.writeUInt16LE(0xffff, 14); // msg instruction index = current

  signer.publicKey.toBuffer().copy(data, pubkeyOffset);
  Buffer.from(signature).copy(data, signatureOffset);
  message.copy(data, messageOffset);

  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data,
  });
}

/**
 * Build a multi-signer Ed25519 precompile instruction packing N signatures
 * over the same message into a single instruction.
 *
 * The on-chain parser (attestation.rs) iterates all sig entries per
 * instruction, so packing multiple signatures here is fully supported.
 *
 * Layout:
 *   [0]       num_sigs = N
 *   [1]       padding
 *   [2..]     N × 14-byte offset structs
 *   [..]      N × pubkey (32 bytes each)
 *   [..]      N × signature (64 bytes each)
 *   [..]      message (shared, written once)
 */
export function makeMultiEd25519Instruction(
  signers: Keypair[],
  message: Buffer
): TransactionInstruction {
  const n = signers.length;
  const offsetStructSize = 14;
  const offsetsEnd = 2 + n * offsetStructSize;
  const pubkeysStart = offsetsEnd;
  const signaturesStart = pubkeysStart + n * 32;
  const messageStart = signaturesStart + n * 64;
  const data = Buffer.alloc(messageStart + message.length);

  data[0] = n;
  data[1] = 0;

  for (let i = 0; i < n; i++) {
    const base = 2 + i * offsetStructSize;
    data.writeUInt16LE(signaturesStart + i * 64, base);
    data.writeUInt16LE(0xffff, base + 2);
    data.writeUInt16LE(pubkeysStart + i * 32, base + 4);
    data.writeUInt16LE(0xffff, base + 6);
    data.writeUInt16LE(messageStart, base + 8);
    data.writeUInt16LE(message.length, base + 10);
    data.writeUInt16LE(0xffff, base + 12);

    signers[i].publicKey.toBuffer().copy(data, pubkeysStart + i * 32);
    Buffer.from(nacl.sign.detached(message, signers[i].secretKey)).copy(
      data,
      signaturesStart + i * 64
    );
  }

  message.copy(data, messageStart);

  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data,
  });
}

/**
 * Convenience: pick single or multi Ed25519 instruction based on signer count.
 */
export function buildAttestationInstruction(
  signers: Keypair[],
  message: Buffer
): TransactionInstruction {
  return signers.length === 1
    ? makeEd25519Instruction(signers[0], message)
    : makeMultiEd25519Instruction(signers, message);
}

// ── Test utilities ───────────────────────────────────────────────────────────

/** Generate 32 cryptographically random bytes as a number array. */
export function randomBytes32(): number[] {
  return Array.from(randomBytes(32));
}
