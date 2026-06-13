// Pure helpers for constructing withdraw_zk Anchor instruction data and
// TransactionInstruction. No filesystem, network, RPC, keypairs, or Anchor provider.

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

// Anchor discriminator: sha256("global:withdraw_zk")[0..8]
export const WITHDRAW_ZK_INSTRUCTION_DISCRIMINATOR: Buffer = Buffer.from([
  0xc8, 0x9d, 0x25, 0x36, 0x3c, 0x6a, 0x81, 0xcc,
]);

export interface WithdrawZkInstructionDataInput {
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  rootBeHex: string;
  nullifierHashBeHex: string;
  denomination: bigint;
  fee: bigint;
  expirySlot: bigint;
  circuitVersion: bigint;
}

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const U64_MAX = 2n ** 64n - 1n;

function validateHex64(value: string, label: string): void {
  if (!HEX64_RE.test(value)) {
    throw new Error(
      `buildWithdrawZkInstructionData: ${label} must be exactly 64 hex chars, got ${JSON.stringify(
        value
      )}`
    );
  }
}

function validateU64(value: unknown, label: string): void {
  if (typeof value !== "bigint") {
    throw new Error(
      `buildWithdrawZkInstructionData: ${label} must be a bigint, got ${typeof value}`
    );
  }
  if (value < 0n || value > U64_MAX) {
    throw new Error(
      `buildWithdrawZkInstructionData: ${label} must be in [0, 2^64 - 1], got ${value}`
    );
  }
}

/**
 * Build the exact 360-byte Anchor instruction data buffer for withdraw_zk.
 *
 * Layout (bytes):
 *   [0,   8)  discriminator
 *   [8,  72)  proof_a
 *   [72, 200) proof_b
 *   [200,264) proof_c
 *   [264,296) root      (BE hex -> bytes)
 *   [296,328) nullifier_hash (BE hex -> bytes)
 *   [328,336) denomination  u64 LE
 *   [336,344) fee           u64 LE
 *   [344,352) expiry_slot   u64 LE
 *   [352,360) circuit_version u64 LE
 */
export function buildWithdrawZkInstructionData(
  input: WithdrawZkInstructionDataInput
): Buffer {
  const {
    proofA,
    proofB,
    proofC,
    rootBeHex,
    nullifierHashBeHex,
    denomination,
    fee,
    expirySlot,
    circuitVersion,
  } = input;

  if (proofA.length !== 64) {
    throw new Error(
      `buildWithdrawZkInstructionData: proofA must be 64 bytes, got ${proofA.length}`
    );
  }
  if (proofB.length !== 128) {
    throw new Error(
      `buildWithdrawZkInstructionData: proofB must be 128 bytes, got ${proofB.length}`
    );
  }
  if (proofC.length !== 64) {
    throw new Error(
      `buildWithdrawZkInstructionData: proofC must be 64 bytes, got ${proofC.length}`
    );
  }

  validateHex64(rootBeHex, "rootBeHex");
  validateHex64(nullifierHashBeHex, "nullifierHashBeHex");
  validateU64(denomination, "denomination");
  validateU64(fee, "fee");
  validateU64(expirySlot, "expirySlot");
  validateU64(circuitVersion, "circuitVersion");

  const buf = Buffer.alloc(360);
  let offset = 0;

  WITHDRAW_ZK_INSTRUCTION_DISCRIMINATOR.copy(buf, offset);
  offset += 8;

  Buffer.from(proofA).copy(buf, offset);
  offset += 64;

  Buffer.from(proofB).copy(buf, offset);
  offset += 128;

  Buffer.from(proofC).copy(buf, offset);
  offset += 64;

  Buffer.from(rootBeHex.toLowerCase(), "hex").copy(buf, offset);
  offset += 32;

  Buffer.from(nullifierHashBeHex.toLowerCase(), "hex").copy(buf, offset);
  offset += 32;

  buf.writeBigUInt64LE(denomination, offset);
  offset += 8;

  buf.writeBigUInt64LE(fee, offset);
  offset += 8;

  buf.writeBigUInt64LE(expirySlot, offset);
  offset += 8;

  buf.writeBigUInt64LE(circuitVersion, offset);

  return buf;
}

// ── TransactionInstruction builder ───────────────────────────────────────────

export interface WithdrawZkInstructionAccounts {
  programId: PublicKey;
  relayer: PublicKey;
  poolState: PublicKey;
  config: PublicKey;
  nullifierMarker: PublicKey;
  recipient: PublicKey;
  systemProgram?: PublicKey;
}

export interface BuildWithdrawZkInstructionInput
  extends WithdrawZkInstructionAccounts {
  data: Buffer | Uint8Array;
}

function validatePublicKey(value: unknown, label: string): void {
  if (!(value instanceof PublicKey)) {
    throw new Error(
      `buildWithdrawZkInstruction: ${label} must be a PublicKey, got ${typeof value}`
    );
  }
}

/**
 * Build the TransactionInstruction for withdraw_zk from pre-built instruction
 * data and resolved account public keys.
 *
 * Account order (matches Rust #[derive(Accounts)] WithdrawZk):
 *   0. relayer         signer=true,  writable=true
 *   1. poolState       signer=false, writable=true
 *   2. config          signer=false, writable=false
 *   3. nullifierMarker signer=false, writable=true
 *   4. recipient       signer=false, writable=true
 *   5. systemProgram   signer=false, writable=false
 */
export function buildWithdrawZkInstruction(
  input: BuildWithdrawZkInstructionInput
): TransactionInstruction {
  const {
    programId,
    relayer,
    poolState,
    config,
    nullifierMarker,
    recipient,
    data,
  } = input;
  const systemProgram = input.systemProgram ?? SystemProgram.programId;

  validatePublicKey(programId, "programId");
  validatePublicKey(relayer, "relayer");
  validatePublicKey(poolState, "poolState");
  validatePublicKey(config, "config");
  validatePublicKey(nullifierMarker, "nullifierMarker");
  validatePublicKey(recipient, "recipient");
  validatePublicKey(systemProgram, "systemProgram");

  if (!(data instanceof Buffer) && !(data instanceof Uint8Array)) {
    throw new Error(
      `buildWithdrawZkInstruction: data must be a Buffer or Uint8Array, got ${typeof data}`
    );
  }
  if (data.length !== 360) {
    throw new Error(
      `buildWithdrawZkInstruction: data must be exactly 360 bytes, got ${data.length}`
    );
  }

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: nullifierMarker, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: systemProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}
