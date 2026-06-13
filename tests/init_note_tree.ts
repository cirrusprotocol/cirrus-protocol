import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
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

describe("init_note_tree", function () {
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
  const [noteTreeStatePda, noteTreeBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("note_tree")],
    program.programId
  );

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

    // note_tree_state is intentionally NOT created here; each test that requires
    // it to not exist must run before the successful initialization below.
  });

  // ── Authorization (must run before successful init) ────────────

  it("non-admin initialization fails with UnauthorizedAdmin", async () => {
    const fakeAdmin = Keypair.generate();
    await airdropIfNeeded(
      provider.connection,
      fakeAdmin.publicKey,
      LAMPORTS_PER_SOL
    );

    await expectTxToFail(
      program.methods
        .initNoteTree()
        .accounts({
          admin: fakeAdmin.publicKey,
          config: configPda,
          noteTreeState: noteTreeStatePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([fakeAdmin])
        .rpc(),
      "UnauthorizedAdmin"
    );
  });

  // ── Happy path ─────────────────────────────────────────────────

  it("initializes note tree successfully with admin", async () => {
    await program.methods
      .initNoteTree()
      .accounts({
        admin: payer.publicKey,
        config: configPda,
        noteTreeState: noteTreeStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it('account exists at PDA [b"note_tree"]', async () => {
    const info = await provider.connection.getAccountInfo(noteTreeStatePda);
    expect(info, "noteTreeState account must exist").to.not.be.null;
  });

  it("leaf_count = 0", async () => {
    const state = await program.account.noteTreeState.fetch(noteTreeStatePda);
    expect(state.leafCount.toNumber()).to.equal(0);
  });

  it("tree_depth = 20", async () => {
    const state = await program.account.noteTreeState.fetch(noteTreeStatePda);
    expect(state.treeDepth).to.equal(20);
  });

  it("bump matches PDA bump", async () => {
    const state = await program.account.noteTreeState.fetch(noteTreeStatePda);
    expect(state.bump).to.equal(noteTreeBump);
  });

  it("padding all zero", async () => {
    const state = await program.account.noteTreeState.fetch(noteTreeStatePda);
    const paddingBytes = Array.from(state.padding as Uint8Array | number[]);
    expect(paddingBytes).to.deep.equal([0, 0, 0, 0, 0, 0]);
  });

  it("account data length = 24", async () => {
    const info = await provider.connection.getAccountInfo(noteTreeStatePda);
    expect(info!.data.length).to.equal(24);
  });

  // ── Idempotency ────────────────────────────────────────────────

  it("second initialization fails", async () => {
    await expectTxToFail(
      program.methods
        .initNoteTree()
        .accounts({
          admin: payer.publicKey,
          config: configPda,
          noteTreeState: noteTreeStatePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  });

  // ── Non-ZK deposit compatibility ───────────────────────────────

  it("existing non-ZK deposit still works after init_note_tree", async () => {
    const amount = new BN(1_000_000);
    const balanceBefore = await provider.connection.getBalance(poolStatePda);

    await program.methods
      .deposit(amount)
      .accounts({
        depositor: payer.publicKey,
        poolState: poolStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const balanceAfter = await provider.connection.getBalance(poolStatePda);
    expect(balanceAfter - balanceBefore).to.equal(1_000_000);
  });

  it("existing non-ZK deposit does not change note_tree_state.leaf_count", async () => {
    const state = await program.account.noteTreeState.fetch(noteTreeStatePda);
    expect(state.leafCount.toNumber()).to.equal(0);
  });
});
