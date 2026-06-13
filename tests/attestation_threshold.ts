import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import { randomBytes } from "crypto";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const keccak = require("keccak");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nacl = require("tweetnacl");

type WithdrawIntent = {
  commitment: number[];
  nullifier: number[];
  recipient: PublicKey;
  amount: BN;
  fee: BN;
  relayer: PublicKey;
  chain_id: BN;
  nonce: BN;
  audit_hash: number[];
  policy_id: number;
  merkle_root: number[];
};

const ED25519_PROGRAM_ID = new PublicKey(
  "Ed25519SigVerify111111111111111111111111111"
);

function bytes32(): number[] {
  return Array.from(randomBytes(32));
}

function bnToLeBytes(value: BN | number | bigint): Buffer {
  return new BN(value.toString()).toArrayLike(Buffer, "le", 8);
}

function computeIntentHash(intent: WithdrawIntent): Buffer {
  const preimage = Buffer.concat([
    Buffer.from("SHIELDED_POOL_INTENT_V1", "utf8"),
    intent.recipient.toBuffer(),
    intent.relayer.toBuffer(),
    bnToLeBytes(intent.amount),
    bnToLeBytes(intent.fee),
    bnToLeBytes(intent.nonce),
    bnToLeBytes(intent.chain_id),
    Buffer.from(intent.nullifier),
    Buffer.from(intent.commitment),
    Buffer.from(intent.merkle_root),
    Buffer.from(intent.audit_hash),
    Buffer.from([intent.policy_id]),
  ]);

  if (preimage.length !== 248) {
    throw new Error(`intent preimage length mismatch: ${preimage.length}`);
  }

  return keccak("keccak256").update(preimage).digest();
}

function computeHandshakeHash(
  programId: PublicKey,
  poolPda: PublicKey,
  configPda: PublicKey,
  expirySlot: BN | number | bigint,
  intentHash: Buffer,
  auditHash: number[],
  policyId: number
): Buffer {
  const preimage = Buffer.concat([
    Buffer.from("SHIELDED_POOL_HANDSHAKE_V1", "utf8"),
    Buffer.from([0x10]),
    programId.toBuffer(),
    poolPda.toBuffer(),
    configPda.toBuffer(),
    bnToLeBytes(expirySlot),
    Buffer.from(auditHash),
    intentHash,
    Buffer.from([policyId]),
  ]);

  if (preimage.length !== 196) {
    throw new Error(`handshake preimage length mismatch: ${preimage.length}`);
  }

  return keccak("keccak256").update(preimage).digest();
}

// ---------------------------------------------------------------------------
// Ed25519 instruction builders
// ---------------------------------------------------------------------------

/**
 * Build a single Ed25519 instruction carrying ONE signature.
 * Used for single-signer scenarios.
 */
function makeEd25519Instruction(
  signer: Keypair,
  message: Buffer
): TransactionInstruction {
  const signature = nacl.sign.detached(message, signer.secretKey);

  const pubkeyOffset = 16;
  const signatureOffset = 48;
  const messageOffset = 112;
  const totalLen = messageOffset + message.length;

  const data = Buffer.alloc(totalLen);
  data[0] = 1;
  data[1] = 0;

  data.writeUInt16LE(signatureOffset, 2);
  data.writeUInt16LE(0xffff, 4);
  data.writeUInt16LE(pubkeyOffset, 6);
  data.writeUInt16LE(0xffff, 8);
  data.writeUInt16LE(messageOffset, 10);
  data.writeUInt16LE(message.length, 12);
  data.writeUInt16LE(0xffff, 14);

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
 * Build a single Ed25519 instruction carrying MULTIPLE signatures over the
 * same message.  The on-chain parser (attestation.rs:60) iterates
 * `for sig_idx in 0..num_sigs` inside each Ed25519 instruction, so packing
 * all attestor signatures into one instruction is fully supported and avoids
 * any Solana runtime issues with multiple Ed25519 precompile instructions
 * in the same transaction.
 *
 * Layout per the Ed25519 precompile spec:
 *   [0]       num_signatures  (u8)
 *   [1]       padding         (u8)
 *   [2..]     N × 14-byte offset structs
 *   [..]      pubkeys (32 bytes each)
 *   [..]      signatures (64 bytes each)
 *   [..]      message (shared, written once)
 */
function makeMultiEd25519Instruction(
  signers: Keypair[],
  message: Buffer
): TransactionInstruction {
  const numSigs = signers.length;
  const offsetStructSize = 14;

  // Compute layout offsets
  const offsetsStart = 2;
  const offsetsEnd = offsetsStart + numSigs * offsetStructSize;
  const pubkeysStart = offsetsEnd;
  const signaturesStart = pubkeysStart + numSigs * 32;
  const messageStart = signaturesStart + numSigs * 64;
  const totalLen = messageStart + message.length;

  const data = Buffer.alloc(totalLen);
  data[0] = numSigs;
  data[1] = 0; // padding

  for (let i = 0; i < numSigs; i++) {
    const base = offsetsStart + i * offsetStructSize;
    const sigOffset = signaturesStart + i * 64;
    const pkOffset = pubkeysStart + i * 32;

    data.writeUInt16LE(sigOffset, base); // signature_offset
    data.writeUInt16LE(0xffff, base + 2); // signature_instruction_index
    data.writeUInt16LE(pkOffset, base + 4); // public_key_offset
    data.writeUInt16LE(0xffff, base + 6); // public_key_instruction_index
    data.writeUInt16LE(messageStart, base + 8); // message_data_offset
    data.writeUInt16LE(message.length, base + 10); // message_data_size
    data.writeUInt16LE(0xffff, base + 12); // message_instruction_index

    signers[i].publicKey.toBuffer().copy(data, pkOffset);
    const sig = nacl.sign.detached(message, signers[i].secretKey);
    Buffer.from(sig).copy(data, sigOffset);
  }

  message.copy(data, messageStart);

  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function airdropIfNeeded(
  connection: anchor.web3.Connection,
  pubkey: PublicKey,
  lamports: number
): Promise<void> {
  const before = await connection.getBalance(pubkey);
  if (before >= lamports) return;

  const sig = await connection.requestAirdrop(pubkey, lamports - before);
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    {
      signature: sig,
      ...latest,
    },
    "confirmed"
  );
}

async function expectTxToFail(
  promise: Promise<unknown>,
  expectedError?: string
) {
  try {
    await promise;
    expect.fail("Expected transaction to fail, but it succeeded");
  } catch (err: any) {
    if (err?.message === "Expected transaction to fail, but it succeeded") {
      throw err;
    }
    if (expectedError) {
      expect(String(err)).to.include(expectedError);
    }
  }
}

// ---------------------------------------------------------------------------
// Threshold attestation test suite
// ---------------------------------------------------------------------------
// This suite MUST run on a fresh validator (separate from withdraw.ts) because
// the config PDA (seed: "verifier_config") can only be initialized once and
// here we set threshold=2 with 3 verifier pubkeys.
// ---------------------------------------------------------------------------

describe("attestation threshold", function () {
  this.timeout(1000000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program: any = anchor.workspace.ShieldedPoolAnchor;

  const payer = provider.wallet as anchor.Wallet;
  const relayer = Keypair.generate();
  const recipient = Keypair.generate();

  // Three verifier keypairs — config.threshold will be 2
  const v1 = Keypair.generate();
  const v2 = Keypair.generate();
  const v3 = Keypair.generate();

  const chainId = new BN(1);
  const amount = new BN(1_000_000_000);
  let fee: BN;

  const [poolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    program.programId
  );
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_config")],
    program.programId
  );

  function makeIntent(nonce: BN): WithdrawIntent {
    return {
      commitment: bytes32(),
      nullifier: bytes32(),
      recipient: recipient.publicKey,
      amount,
      fee,
      relayer: relayer.publicKey,
      chain_id: chainId,
      nonce,
      audit_hash: bytes32(),
      policy_id: 1,
      merkle_root: bytes32(),
    };
  }

  /**
   * Build a withdraw transaction with the given attestors.
   * All attestor signatures are packed into a SINGLE Ed25519 instruction
   * with num_sigs = attestors.length.  This matches the on-chain parser
   * which iterates `for sig_idx in 0..num_sigs` per instruction.
   */
  async function buildWithdrawTxMultiAttest(opts: {
    intent: WithdrawIntent;
    expirySlot: BN;
    attestors: Keypair[];
  }) {
    const { intent, expirySlot, attestors } = opts;

    const intentHash = computeIntentHash(intent);
    const handshakeHash = computeHandshakeHash(
      program.programId,
      poolStatePda,
      configPda,
      expirySlot,
      intentHash,
      intent.audit_hash,
      intent.policy_id
    );

    const ed25519Ix = makeMultiEd25519Instruction(attestors, handshakeHash);

    const nullifierMarkerPda = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), Buffer.from(intent.nullifier)],
      program.programId
    )[0];

    const wireIntent = {
      commitment: intent.commitment,
      nullifier: intent.nullifier,
      recipient: intent.recipient,
      amount: intent.amount,
      fee: intent.fee,
      relayer: intent.relayer,
      chainId: intent.chain_id,
      nonce: intent.nonce,
      auditHash: intent.audit_hash,
      policyId: intent.policy_id,
      merkleRoot: intent.merkle_root,
    };

    const withdrawIx = await program.methods
      .withdraw(wireIntent, expirySlot)
      .accounts({
        relayer: relayer.publicKey,
        poolState: poolStatePda,
        config: configPda,
        nullifierMarker: nullifierMarkerPda,
        recipient: recipient.publicKey,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix, withdrawIx);
    tx.feePayer = payer.publicKey;

    const latest = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = latest.blockhash;

    return { tx, nullifierMarkerPda };
  }

  before(async () => {
    await airdropIfNeeded(
      provider.connection,
      relayer.publicKey,
      5 * LAMPORTS_PER_SOL
    );

    // Initialize pool
    const poolInfo = await provider.connection.getAccountInfo(poolStatePda);
    if (!poolInfo) {
      await program.methods
        .initializePool()
        .accounts({
          authority: payer.publicKey,
          poolState: poolStatePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    // Initialize config: threshold=2, verifiers=[v1, v2, v3]
    const configInfo = await provider.connection.getAccountInfo(configPda);
    if (!configInfo) {
      await program.methods
        .initializeConfig(
          v1.publicKey,
          [v1.publicKey, v2.publicKey, v3.publicKey],
          2,
          chainId
        )
        .accounts({
          admin: payer.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    // ── Config runtime guard ─────────────────────────────────────────────
    // The config PDA uses `init` (not `init_if_needed`), so it can only be
    // created once per validator lifetime.  If a previous withdraw.ts run
    // already initialized it with threshold=1 and a different verifier set,
    // the suite will silently mis-behave.  Fail fast with a clear message.
    // ─────────────────────────────────────────────────────────────────────
    const cfg = await program.account.verifierConfig.fetch(configPda);

    const staleErrors: string[] = [];

    if (cfg.threshold !== 2) {
      staleErrors.push(`threshold=${cfg.threshold}, expected 2`);
    }

    if (!cfg.attesterPubkey.equals(v1.publicKey)) {
      staleErrors.push(
        `attesterPubkey=${cfg.attesterPubkey.toBase58()}, expected ${v1.publicKey.toBase58()}`
      );
    }

    if (cfg.paused !== false) {
      staleErrors.push(`paused=${cfg.paused}, expected false`);
    }

    const expectedVerifiers = [v1.publicKey, v2.publicKey, v3.publicKey];
    const actualKeys = (cfg.verifierPubkeys as PublicKey[]).map(
      (k: PublicKey) => k.toBase58()
    );
    for (const expected of expectedVerifiers) {
      if (!actualKeys.includes(expected.toBase58())) {
        staleErrors.push(
          `verifierPubkeys missing ${expected.toBase58().slice(0, 8)}…`
        );
      }
    }

    if (staleErrors.length > 0) {
      throw new Error(
        `Stale config detected – this suite needs a fresh validator.\n` +
          `Mismatches: ${staleErrors.join("; ")}\n` +
          `Fix: set Anchor.toml [scripts] test to attestation_threshold.ts, then run: anchor test`
      );
    }

    // Fund pool
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: poolStatePda,
        lamports: 5 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(fundTx, []);

    // Set fee
    fee = new BN(
      await provider.connection.getMinimumBalanceForRentExemption(9)
    ).add(new BN(50_000));
  });

  it("passes with two distinct valid signers", async () => {
    const intent = makeIntent(new BN(1));
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    const { tx, nullifierMarkerPda } = await buildWithdrawTxMultiAttest({
      intent,
      expirySlot,
      attestors: [v1, v2],
    });

    await provider.sendAndConfirm(tx, [relayer]);

    const marker = await program.account.nullifierMarker.fetch(
      nullifierMarkerPda
    );
    expect(marker.used).to.equal(true);
  });

  it("fails with only one valid signer", async () => {
    const intent = makeIntent(new BN(2));
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    const { tx } = await buildWithdrawTxMultiAttest({
      intent,
      expirySlot,
      attestors: [v1],
    });

    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "AttestationFailed"
    );
  });

  it("fails with duplicate signer counted once", async () => {
    const intent = makeIntent(new BN(3));
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    // Same keypair twice — on-chain unique_count stays 1
    const { tx } = await buildWithdrawTxMultiAttest({
      intent,
      expirySlot,
      attestors: [v1, v1],
    });

    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "AttestationFailed"
    );
  });

  it("fails with one valid and one invalid signer", async () => {
    const fakeSigner = Keypair.generate();
    const intent = makeIntent(new BN(4));
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    // v1 is valid, fakeSigner is NOT in config.verifier_pubkeys
    const { tx } = await buildWithdrawTxMultiAttest({
      intent,
      expirySlot,
      attestors: [v1, fakeSigner],
    });

    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "AttestationFailed"
    );
  });
});
