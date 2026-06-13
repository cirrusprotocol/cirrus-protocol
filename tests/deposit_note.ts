import * as anchor from "@anchor-lang/core";
import { BN, EventParser } from "@anchor-lang/core";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { expect } from "chai";

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
): Promise<void> {
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

async function getTransactionEvents(
  program: any,
  connection: anchor.web3.Connection,
  sig: string
): Promise<{ name: string; data: any }[]> {
  let txResult = null;
  for (let i = 0; i < 8; i++) {
    txResult = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (txResult?.meta?.logMessages?.length) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!txResult?.meta?.logMessages?.length) return [];
  const logs = txResult.meta!.logMessages!;
  const parser = new EventParser(program.programId, program.coder);
  return [...parser.parseLogs(logs)];
}

const BN254_FR_MODULUS = Buffer.from([
  0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81,
  0x81, 0x58, 0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1,
  0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
]);

const BN254_FR_P_MINUS_1 = Buffer.from([
  0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81,
  0x81, 0x58, 0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1,
  0xf5, 0x93, 0xf0, 0x00, 0x00, 0x00,
]);

const ABOVE_FR_MODULUS = Buffer.from([
  0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81,
  0x81, 0x58, 0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1,
  0xf5, 0x93, 0xf0, 0x00, 0x00, 0x02,
]);

const VALID_COMMITMENT = Buffer.from([
  0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89,
  0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23,
  0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
]);

const SECOND_COMMITMENT = Buffer.from([
  0x02, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x02, 0x34, 0x56, 0x78, 0x9a,
  0xbc, 0xde, 0xf0, 0x02, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x02, 0x34,
  0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
]);

const DENOMINATION = new BN(100_000_000);

describe("deposit_note", function () {
  this.timeout(1_000_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program: any = anchor.workspace.ShieldedPoolAnchor;
  const payer = provider.wallet as anchor.Wallet;
  const chainId = new BN(1);
  const verifier = Keypair.generate();

  const [poolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    program.programId
  );
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_config")],
    program.programId
  );
  const [noteTreeStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("note_tree")],
    program.programId
  );

  let poolLamportsBefore = 0;
  let totalDepositsBefore = 0;
  let firstDepositSig = "";

  before(async () => {
    await airdropIfNeeded(
      provider.connection,
      payer.publicKey,
      10 * LAMPORTS_PER_SOL
    );

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

    const configInfo = await provider.connection.getAccountInfo(configPda);
    if (!configInfo) {
      await program.methods
        .initializeConfig(verifier.publicKey, [verifier.publicKey], 1, chainId)
        .accounts({
          admin: payer.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const treeInfo = await provider.connection.getAccountInfo(noteTreeStatePda);
    if (!treeInfo) {
      await program.methods
        .initNoteTree()
        .accounts({
          admin: payer.publicKey,
          config: configPda,
          noteTreeState: noteTreeStatePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    poolLamportsBefore = await provider.connection.getBalance(poolStatePda);
    const poolState = await program.account.poolState.fetch(poolStatePda);
    totalDepositsBefore = poolState.totalDeposits.toNumber();
  });

  // ── Happy path: first deposit ─────────────────────────────────

  it("deposit_note succeeds for valid commitment and denomination", async () => {
    firstDepositSig = await program.methods
      .depositNote(Array.from(VALID_COMMITMENT), DENOMINATION)
      .accounts({
        depositor: payer.publicKey,
        poolState: poolStatePda,
        config: configPda,
        noteTreeState: noteTreeStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    expect(firstDepositSig).to.be.a("string").with.length.greaterThan(0);
  });

  it("pool_state lamports increase by denomination", async () => {
    const after = await provider.connection.getBalance(poolStatePda);
    expect(after - poolLamportsBefore).to.equal(DENOMINATION.toNumber());
  });

  it("pool_state.total_deposits increments by denomination", async () => {
    const state = await program.account.poolState.fetch(poolStatePda);
    expect(state.totalDeposits.toNumber()).to.equal(
      totalDepositsBefore + DENOMINATION.toNumber()
    );
  });

  it("note_tree_state.leaf_count increments from 0 to 1", async () => {
    const tree = await program.account.noteTreeState.fetch(noteTreeStatePda);
    expect(tree.leafCount.toNumber()).to.equal(1);
  });

  it("NoteDeposited event has correct commitment, denomination, leaf_index=0, depositor, slot", async () => {
    const events = await getTransactionEvents(
      program,
      provider.connection,
      firstDepositSig
    );
    const event = events.find((e) => e.name === "noteDeposited");
    expect(event, "NoteDeposited event not found").to.exist;
    expect(Array.from(event!.data.commitment as Uint8Array)).to.deep.equal(
      Array.from(VALID_COMMITMENT)
    );
    expect(event!.data.denomination.toNumber()).to.equal(
      DENOMINATION.toNumber()
    );
    expect(event!.data.leafIndex.toNumber()).to.equal(0);
    expect(event!.data.depositor.toBase58()).to.equal(
      payer.publicKey.toBase58()
    );
    expect(event!.data.slot.toNumber()).to.be.greaterThan(0);
  });

  // ── Second deposit: leaf_index advances ──────────────────────

  it("second deposit emits leaf_index=1 and leaf_count becomes 2", async () => {
    const sig = await program.methods
      .depositNote(Array.from(SECOND_COMMITMENT), DENOMINATION)
      .accounts({
        depositor: payer.publicKey,
        poolState: poolStatePda,
        config: configPda,
        noteTreeState: noteTreeStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const events = await getTransactionEvents(
      program,
      provider.connection,
      sig
    );
    const event = events.find((e) => e.name === "noteDeposited");
    expect(event, "NoteDeposited event not found on second deposit").to.exist;
    expect(event!.data.leafIndex.toNumber()).to.equal(1);

    const tree = await program.account.noteTreeState.fetch(noteTreeStatePda);
    expect(tree.leafCount.toNumber()).to.equal(2);
  });

  // ── Commitment validation ──────────────────────────────────────

  it("zero commitment rejected with InvalidCommitment", async () => {
    const zero = Array.from(Buffer.alloc(32));
    await expectTxToFail(
      program.methods
        .depositNote(zero, DENOMINATION)
        .accounts({
          depositor: payer.publicKey,
          poolState: poolStatePda,
          config: configPda,
          noteTreeState: noteTreeStatePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "InvalidCommitment"
    );
  });

  it("commitment equal to BN254 modulus rejected with NonCanonicalCommitment", async () => {
    await expectTxToFail(
      program.methods
        .depositNote(Array.from(BN254_FR_MODULUS), DENOMINATION)
        .accounts({
          depositor: payer.publicKey,
          poolState: poolStatePda,
          config: configPda,
          noteTreeState: noteTreeStatePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "NonCanonicalCommitment"
    );
  });

  it("commitment one above BN254 modulus rejected with NonCanonicalCommitment", async () => {
    await expectTxToFail(
      program.methods
        .depositNote(Array.from(ABOVE_FR_MODULUS), DENOMINATION)
        .accounts({
          depositor: payer.publicKey,
          poolState: poolStatePda,
          config: configPda,
          noteTreeState: noteTreeStatePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "NonCanonicalCommitment"
    );
  });

  it("commitment p-1 (max canonical BN254 Fr element) accepted", async () => {
    const sig = await program.methods
      .depositNote(Array.from(BN254_FR_P_MINUS_1), DENOMINATION)
      .accounts({
        depositor: payer.publicKey,
        poolState: poolStatePda,
        config: configPda,
        noteTreeState: noteTreeStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    expect(sig).to.be.a("string").with.length.greaterThan(0);
  });

  // ── Denomination validation ────────────────────────────────────

  it("invalid denomination rejected with InvalidDenomination", async () => {
    const badDenom = new BN(12_345_678);
    await expectTxToFail(
      program.methods
        .depositNote(Array.from(VALID_COMMITMENT), badDenom)
        .accounts({
          depositor: payer.publicKey,
          poolState: poolStatePda,
          config: configPda,
          noteTreeState: noteTreeStatePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "InvalidDenomination"
    );
  });

  // ── Protocol pause ─────────────────────────────────────────────

  it("paused protocol rejects deposit_note with Paused", async () => {
    await program.methods
      .updateVerifierConfig(1, [verifier.publicKey], true)
      .accounts({ admin: payer.publicKey, config: configPda })
      .rpc();

    try {
      await expectTxToFail(
        program.methods
          .depositNote(Array.from(VALID_COMMITMENT), DENOMINATION)
          .accounts({
            depositor: payer.publicKey,
            poolState: poolStatePda,
            config: configPda,
            noteTreeState: noteTreeStatePda,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
        "Paused"
      );
    } finally {
      await program.methods
        .updateVerifierConfig(1, [verifier.publicKey], false)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();
    }
  });

  // ── Account validation ─────────────────────────────────────────

  it("wrong note_tree_state PDA fails", async () => {
    const fakeNoteTreePda = Keypair.generate().publicKey;
    await expectTxToFail(
      program.methods
        .depositNote(Array.from(VALID_COMMITMENT), DENOMINATION)
        .accounts({
          depositor: payer.publicKey,
          poolState: poolStatePda,
          config: configPda,
          noteTreeState: fakeNoteTreePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  });

  // ── Non-ZK deposit compatibility ───────────────────────────────

  it("existing non-ZK deposit still works and does not increment note_tree_state.leaf_count", async () => {
    const treeBefore = await program.account.noteTreeState.fetch(
      noteTreeStatePda
    );
    const leafCountBefore = treeBefore.leafCount.toNumber();

    await program.methods
      .deposit(new BN(1_000_000))
      .accounts({
        depositor: payer.publicKey,
        poolState: poolStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const treeAfter = await program.account.noteTreeState.fetch(
      noteTreeStatePda
    );
    expect(treeAfter.leafCount.toNumber()).to.equal(leafCountBefore);
  });
});
