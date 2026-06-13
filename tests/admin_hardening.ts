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

const keccak = require("keccak");
const nacl = require("tweetnacl");

// ── Types ────────────────────────────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────────
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
  if (preimage.length !== 248)
    throw new Error(`intent preimage length mismatch: ${preimage.length}`);
  return keccak("keccak256").update(preimage).digest();
}

function computeHandshakeHash(
  programId: PublicKey,
  poolPda: PublicKey,
  configPda: PublicKey,
  expirySlot: BN,
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
  if (preimage.length !== 196)
    throw new Error(`handshake preimage length mismatch: ${preimage.length}`);
  return keccak("keccak256").update(preimage).digest();
}

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
    { signature: sig, ...latest },
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
    if (err?.message === "Expected transaction to fail, but it succeeded")
      throw err;
    if (expectedError) {
      expect(String(err)).to.include(expectedError);
    }
  }
}

function rootBytesPresent(roots: number[][], root: number[]): boolean {
  return roots.some(
    (r) => r.length === root.length && r.every((b, i) => b === root[i])
  );
}

// ═════════════════════════════════════════════════════════════════
// Test Suite
// ═════════════════════════════════════════════════════════════════

describe("admin hardening", function () {
  this.timeout(1000000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program: any = anchor.workspace.ShieldedPoolAnchor;
  const payer = provider.wallet as anchor.Wallet;

  const relayer = Keypair.generate();
  const recipient = Keypair.generate();

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

  async function buildWithdrawTx(
    intent: WithdrawIntent,
    expirySlot: BN,
    attestor: Keypair
  ) {
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
    const ed25519Ix = makeEd25519Instruction(attestor, handshakeHash);
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

  // ── Setup ──────────────────────────────────────────────────────

  before(async () => {
    await airdropIfNeeded(
      provider.connection,
      relayer.publicKey,
      10 * LAMPORTS_PER_SOL
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

    // Initialize config: threshold=1, verifiers=[v1]
    const configInfo = await provider.connection.getAccountInfo(configPda);
    if (!configInfo) {
      await program.methods
        .initializeConfig(v1.publicKey, [v1.publicKey], 1, chainId)
        .accounts({
          admin: payer.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    // Fund pool
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: poolStatePda,
        lamports: 10 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(fundTx, []);

    fee = new BN(
      await provider.connection.getMinimumBalanceForRentExemption(9)
    ).add(new BN(50_000));
  });

  // ═════════════════════════════════════════════════════════════
  // VERIFIER ROTATION TESTS
  // ═════════════════════════════════════════════════════════════

  it("admin can rotate verifier set", async () => {
    await program.methods
      .updateVerifierConfig(
        2,
        [v1.publicKey, v2.publicKey, v3.publicKey],
        false
      )
      .accounts({ admin: payer.publicKey, config: configPda })
      .rpc();

    const cfg = await program.account.verifierConfig.fetch(configPda);
    expect(cfg.threshold).to.equal(2);
    expect(cfg.verifierPubkeys.length).to.equal(3);
    expect(cfg.paused).to.equal(false);
  });

  it("non-admin cannot rotate", async () => {
    const fakeAdmin = Keypair.generate();
    await airdropIfNeeded(
      provider.connection,
      fakeAdmin.publicKey,
      LAMPORTS_PER_SOL
    );

    await expectTxToFail(
      program.methods
        .updateVerifierConfig(1, [v1.publicKey], false)
        .accounts({ admin: fakeAdmin.publicKey, config: configPda })
        .signers([fakeAdmin])
        .rpc(),
      "UnauthorizedAdmin"
    );
  });

  it("duplicate verifiers rejected", async () => {
    await expectTxToFail(
      program.methods
        .updateVerifierConfig(1, [v1.publicKey, v1.publicKey], false)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc(),
      "DuplicateVerifier"
    );
  });

  it("empty verifier set rejected", async () => {
    await expectTxToFail(
      program.methods
        .updateVerifierConfig(1, [], false)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc(),
      "EmptyVerifierSet"
    );
  });

  it("threshold > count rejected", async () => {
    await expectTxToFail(
      program.methods
        .updateVerifierConfig(3, [v1.publicKey, v2.publicKey], false)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc(),
      "InvalidThreshold"
    );
  });

  it("threshold 0 rejected", async () => {
    await expectTxToFail(
      program.methods
        .updateVerifierConfig(0, [v1.publicKey], false)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc(),
      "InvalidThreshold"
    );
  });

  it("default pubkey rejected", async () => {
    await expectTxToFail(
      program.methods
        .updateVerifierConfig(1, [PublicKey.default], false)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc(),
      "DefaultVerifierKey"
    );
  });

  // ═════════════════════════════════════════════════════════════
  // PAUSE BEHAVIOR TESTS
  // ═════════════════════════════════════════════════════════════

  it("paused=true blocks withdraw", async () => {
    // Pause the protocol
    await program.methods
      .updateVerifierConfig(1, [v1.publicKey], true)
      .accounts({ admin: payer.publicKey, config: configPda })
      .rpc();

    const intent = makeIntent(new BN(100));
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    const { tx } = await buildWithdrawTx(intent, expirySlot, v1);

    await expectTxToFail(provider.sendAndConfirm(tx, [relayer]), "Paused");
  });

  it("paused=false restores withdraw", async () => {
    // Unpause
    await program.methods
      .updateVerifierConfig(1, [v1.publicKey], false)
      .accounts({ admin: payer.publicKey, config: configPda })
      .rpc();

    const intent = makeIntent(new BN(101));
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    const { tx, nullifierMarkerPda } = await buildWithdrawTx(
      intent,
      expirySlot,
      v1
    );

    await provider.sendAndConfirm(tx, [relayer]);

    const marker = await program.account.nullifierMarker.fetch(
      nullifierMarkerPda
    );
    expect(marker.used).to.equal(true);
  });

  // ═════════════════════════════════════════════════════════════
  // REPLAY INVARIANT TESTS
  // ═════════════════════════════════════════════════════════════

  it("nullifier replay rejected after verifier rotation", async () => {
    // Setup: do a successful withdraw with v1
    const intent = makeIntent(new BN(200));
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);
    const { tx, nullifierMarkerPda } = await buildWithdrawTx(
      intent,
      expirySlot,
      v1
    );
    await provider.sendAndConfirm(tx, [relayer]);

    // Rotate verifier set to [v2]
    await program.methods
      .updateVerifierConfig(1, [v2.publicKey], false)
      .accounts({ admin: payer.publicKey, config: configPda })
      .rpc();

    // Try replay with v2 (different signer, same nullifier)
    const slot2 = await provider.connection.getSlot("confirmed");
    const expirySlot2 = new BN(slot2 + 200);

    // Re-compute hashes for same intent but with new slot
    const intentHash = computeIntentHash(intent);
    const handshakeHash = computeHandshakeHash(
      program.programId,
      poolStatePda,
      configPda,
      expirySlot2,
      intentHash,
      intent.audit_hash,
      intent.policy_id
    );
    const ed25519Ix = makeEd25519Instruction(v2, handshakeHash);
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
      .withdraw(wireIntent, expirySlot2)
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
    const tx2 = new Transaction().add(ed25519Ix, withdrawIx);
    tx2.feePayer = payer.publicKey;
    const latest = await provider.connection.getLatestBlockhash();
    tx2.recentBlockhash = latest.blockhash;

    await expectTxToFail(
      provider.sendAndConfirm(tx2, [relayer]),
      "NullifierAlreadyUsed"
    );
  });

  it("old attestation fails after verifier rotation", async () => {
    // Current config has [v2] from previous test
    // Try withdraw with v1 (no longer in config)
    const intent = makeIntent(new BN(201));
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    const { tx } = await buildWithdrawTx(intent, expirySlot, v1);

    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "AttestationFailed"
    );
  });

  // ═════════════════════════════════════════════════════════════
  // SUCCESS PATH — 1/1 after rotation
  // ═════════════════════════════════════════════════════════════

  it("1/1 attestation succeeds after rotation to v2", async () => {
    // Config is [v2], threshold=1 from previous tests
    const intent = makeIntent(new BN(300));
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    const { tx, nullifierMarkerPda } = await buildWithdrawTx(
      intent,
      expirySlot,
      v2
    );

    await provider.sendAndConfirm(tx, [relayer]);

    const marker = await program.account.nullifierMarker.fetch(
      nullifierMarkerPda
    );
    expect(marker.used).to.equal(true);
  });

  // ═════════════════════════════════════════════════════════════
  // ═════════════════════════════════════════════════════════════
  // ROOT SUBMITTER AUTHORITY TESTS
  // ═════════════════════════════════════════════════════════════

  describe("root submitter authority", function () {
    const rootSubmitter = Keypair.generate();

    before(async () => {
      await airdropIfNeeded(
        provider.connection,
        rootSubmitter.publicKey,
        2 * LAMPORTS_PER_SOL
      );
    });

    after(async () => {
      // Restore root_submitter_authority to admin (payer).
      try {
        await program.methods
          .setRootSubmitterAuthority(payer.publicKey)
          .accounts({ admin: payer.publicKey, config: configPda })
          .rpc();
      } catch {
        // best effort
      }
    });

    it("initialize_config sets root_submitter_authority == admin_authority", async () => {
      const cfg = await program.account.verifierConfig.fetch(configPda);
      expect(cfg.rootSubmitterAuthority.toBase58()).to.equal(
        payer.publicKey.toBase58()
      );
    });

    it("admin can rotate root_submitter_authority", async () => {
      await program.methods
        .setRootSubmitterAuthority(rootSubmitter.publicKey)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();
      const cfg = await program.account.verifierConfig.fetch(configPda);
      expect(cfg.rootSubmitterAuthority.toBase58()).to.equal(
        rootSubmitter.publicKey.toBase58()
      );
      await program.methods
        .setRootSubmitterAuthority(payer.publicKey)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();
    });

    it("non-admin cannot rotate root_submitter_authority", async () => {
      const fakeAdmin = Keypair.generate();
      await airdropIfNeeded(
        provider.connection,
        fakeAdmin.publicKey,
        LAMPORTS_PER_SOL
      );
      await expectTxToFail(
        program.methods
          .setRootSubmitterAuthority(rootSubmitter.publicKey)
          .accounts({ admin: fakeAdmin.publicKey, config: configPda })
          .signers([fakeAdmin])
          .rpc(),
        "UnauthorizedAdmin"
      );
    });

    it("setRootSubmitterAuthority rejects default pubkey", async () => {
      await expectTxToFail(
        program.methods
          .setRootSubmitterAuthority(PublicKey.default)
          .accounts({ admin: payer.publicKey, config: configPda })
          .rpc(),
        "InvalidRootSubmitterAuthority"
      );
    });

    it("root_submitter (== admin initially) can add and remove allowed root", async () => {
      const root = Array.from(randomBytes(32));
      await program.methods
        .addAllowedRoot(root)
        .accounts({ rootSubmitter: payer.publicKey, config: configPda })
        .rpc();
      let cfg = await program.account.verifierConfig.fetch(configPda);
      expect(rootBytesPresent(cfg.allowedRoots, root)).to.equal(
        true,
        "root must be present after add"
      );

      await program.methods
        .removeAllowedRoot(root)
        .accounts({ rootSubmitter: payer.publicKey, config: configPda })
        .rpc();
      cfg = await program.account.verifierConfig.fetch(configPda);
      expect(rootBytesPresent(cfg.allowedRoots, root)).to.equal(
        false,
        "root must be absent after remove"
      );
    });

    it("root_submitter can add and remove root after authority is rotated", async () => {
      await program.methods
        .setRootSubmitterAuthority(rootSubmitter.publicKey)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();

      const root = Array.from(randomBytes(32));
      await program.methods
        .addAllowedRoot(root)
        .accounts({ rootSubmitter: rootSubmitter.publicKey, config: configPda })
        .signers([rootSubmitter])
        .rpc();
      let cfg = await program.account.verifierConfig.fetch(configPda);
      expect(rootBytesPresent(cfg.allowedRoots, root)).to.equal(
        true,
        "root must be present after add"
      );

      await program.methods
        .removeAllowedRoot(root)
        .accounts({ rootSubmitter: rootSubmitter.publicKey, config: configPda })
        .signers([rootSubmitter])
        .rpc();
      cfg = await program.account.verifierConfig.fetch(configPda);
      expect(rootBytesPresent(cfg.allowedRoots, root)).to.equal(
        false,
        "root must be absent after remove"
      );

      await program.methods
        .setRootSubmitterAuthority(payer.publicKey)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();
    });

    it("admin cannot add allowed root after root_submitter is rotated away", async () => {
      await program.methods
        .setRootSubmitterAuthority(rootSubmitter.publicKey)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();

      const root = Array.from(randomBytes(32));
      await expectTxToFail(
        program.methods
          .addAllowedRoot(root)
          .accounts({ rootSubmitter: payer.publicKey, config: configPda })
          .rpc(),
        "UnauthorizedRootSubmitter"
      );

      await program.methods
        .setRootSubmitterAuthority(payer.publicKey)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();
    });

    it("admin cannot remove allowed root after root_submitter is rotated away", async () => {
      await program.methods
        .setRootSubmitterAuthority(rootSubmitter.publicKey)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();

      const root = Array.from(randomBytes(32));
      await program.methods
        .addAllowedRoot(root)
        .accounts({ rootSubmitter: rootSubmitter.publicKey, config: configPda })
        .signers([rootSubmitter])
        .rpc();

      await expectTxToFail(
        program.methods
          .removeAllowedRoot(root)
          .accounts({ rootSubmitter: payer.publicKey, config: configPda })
          .rpc(),
        "UnauthorizedRootSubmitter"
      );

      await program.methods
        .removeAllowedRoot(root)
        .accounts({ rootSubmitter: rootSubmitter.publicKey, config: configPda })
        .signers([rootSubmitter])
        .rpc();
      await program.methods
        .setRootSubmitterAuthority(payer.publicKey)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();
    });

    it("pause/verifier/threshold admin operations are unaffected by root_submitter rotation", async () => {
      await program.methods
        .setRootSubmitterAuthority(rootSubmitter.publicKey)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();

      await program.methods
        .updateVerifierConfig(1, [v1.publicKey], false)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();
      const cfg = await program.account.verifierConfig.fetch(configPda);
      expect(cfg.threshold).to.equal(1);

      await program.methods
        .setRootSubmitterAuthority(payer.publicKey)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();
    });
  });

  // Restore config for any subsequent runs
  // ═════════════════════════════════════════════════════════════

  after(async () => {
    // Restore to v1 for consistency
    try {
      await program.methods
        .updateVerifierConfig(1, [v1.publicKey], false)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();
    } catch {
      // best effort
    }
  });
});
