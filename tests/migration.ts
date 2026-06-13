import * as anchor from "@anchor-lang/core";
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

// ═════════════════════════════════════════════════════════════════════════════
// Migration guard tests
//
// These tests verify the on-chain guard logic for migratePool and migrateConfig:
//   - AlreadyMigrated is returned when the account is already in current layout
//   - UnauthorizedAdmin is returned when the signer is not config.admin_authority
//
// The actual legacy-to-current migration happy paths (17→57 bytes for pool,
// 311→667 bytes for config) require legacy-sized accounts at the PDA addresses.
// Those cannot be created via standard Anchor TypeScript on a fresh localnet
// without pre-loading account fixtures (--account flag) or an in-process test
// harness. The byte-level migration logic is covered by 45 Rust unit tests in
// programs/shielded_pool_anchor/src/migration.rs.
// ═════════════════════════════════════════════════════════════════════════════

describe("migration guards", function () {
  this.timeout(1000000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program: any = anchor.workspace.ShieldedPoolAnchor;
  const payer = provider.wallet as anchor.Wallet;

  const chainId = new anchor.BN(1);
  const attesterKey = Keypair.generate();

  const [poolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    program.programId
  );
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_config")],
    program.programId
  );

  before(async () => {
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
        .initializeConfig(
          attesterKey.publicKey,
          [attesterKey.publicKey],
          1,
          chainId
        )
        .accounts({
          admin: payer.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  });

  // ── migratePool ───────────────────────────────────────────────────────────

  it("migratePool returns AlreadyMigrated when pool is in current layout", async () => {
    await expectTxToFail(
      program.methods
        .migratePool(payer.publicKey)
        .accounts({
          admin: payer.publicKey,
          poolState: poolStatePda,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "AlreadyMigrated"
    );
  });

  it("migratePool rejects non-admin signer", async () => {
    const fakeAdmin = Keypair.generate();
    await airdropIfNeeded(
      provider.connection,
      fakeAdmin.publicKey,
      LAMPORTS_PER_SOL
    );
    await expectTxToFail(
      program.methods
        .migratePool(fakeAdmin.publicKey)
        .accounts({
          admin: fakeAdmin.publicKey,
          poolState: poolStatePda,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([fakeAdmin])
        .rpc(),
      "UnauthorizedAdmin"
    );
  });

  // ── migrateConfig ─────────────────────────────────────────────────────────

  it("migrateConfig returns AlreadyMigrated when config is in current layout", async () => {
    await expectTxToFail(
      program.methods
        .migrateConfig(attesterKey.publicKey)
        .accounts({
          admin: payer.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "AlreadyMigrated"
    );
  });

  it("migrateConfig rejects non-admin signer", async () => {
    const fakeAdmin = Keypair.generate();
    await airdropIfNeeded(
      provider.connection,
      fakeAdmin.publicKey,
      LAMPORTS_PER_SOL
    );
    await expectTxToFail(
      program.methods
        .migrateConfig(attesterKey.publicKey)
        .accounts({
          admin: fakeAdmin.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([fakeAdmin])
        .rpc(),
      "UnauthorizedAdmin"
    );
  });
});
