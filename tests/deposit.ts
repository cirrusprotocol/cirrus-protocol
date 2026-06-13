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

describe("deposit", function () {
  this.timeout(1000000);

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
  });

  it("deposit transfers lamports into pool PDA and updates total_deposits", async () => {
    const amount = new BN(1_000_000);

    const poolLamportsBefore = await provider.connection.getBalance(
      poolStatePda
    );
    const stateBefore = await program.account.poolState.fetch(poolStatePda);

    await program.methods
      .deposit(amount)
      .accounts({
        depositor: payer.publicKey,
        poolState: poolStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const poolLamportsAfter = await provider.connection.getBalance(
      poolStatePda
    );
    const stateAfter = await program.account.poolState.fetch(poolStatePda);

    expect(poolLamportsAfter - poolLamportsBefore).to.equal(1_000_000);
    expect(stateAfter.totalDeposits.toNumber()).to.equal(
      stateBefore.totalDeposits.toNumber() + 1_000_000
    );
  });

  it("deposit emits DepositReceived event", async () => {
    const amount = new BN(500_000);

    const sig = await program.methods
      .deposit(amount)
      .accounts({
        depositor: payer.publicKey,
        poolState: poolStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const events = await getTransactionEvents(
      program,
      provider.connection,
      sig
    );
    const depositEvent = events.find((e) => e.name === "depositReceived");

    expect(depositEvent, "DepositReceived event not found").to.exist;
    expect(depositEvent!.data.depositor.toBase58()).to.equal(
      payer.publicKey.toBase58()
    );
    expect(depositEvent!.data.amount.toNumber()).to.equal(500_000);
  });

  it("deposit rejects amount = 0 with InvalidDepositAmount", async () => {
    await expectTxToFail(
      program.methods
        .deposit(new BN(0))
        .accounts({
          depositor: payer.publicKey,
          poolState: poolStatePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "InvalidDepositAmount"
    );
  });

  it("successive deposits accumulate total_deposits correctly", async () => {
    const stateBefore = await program.account.poolState.fetch(poolStatePda);
    const depositsBefore = stateBefore.totalDeposits.toNumber();

    const amount1 = 200_000;
    const amount2 = 300_000;

    await program.methods
      .deposit(new BN(amount1))
      .accounts({
        depositor: payer.publicKey,
        poolState: poolStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .deposit(new BN(amount2))
      .accounts({
        depositor: payer.publicKey,
        poolState: poolStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const stateAfter = await program.account.poolState.fetch(poolStatePda);
    expect(stateAfter.totalDeposits.toNumber()).to.equal(
      depositsBefore + amount1 + amount2
    );
  });
});
