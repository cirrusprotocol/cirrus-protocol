import * as anchor from "@anchor-lang/core";
import { BN, EventParser } from "@anchor-lang/core";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { expect } from "chai";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import { computePubkeysHash, computeTxHash } from "../lib/zk_prover/witness";

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

// Build the local-test-only mock proof fixture for a given set of withdrawal parameters.
//
// This is NOT a Groth16 proof. It encodes the expected public inputs and account
// pubkeys into the proof byte arrays so that the mock-verifier path in withdraw_zk.rs
// can verify them deterministically. This fixture only works with the mock-verifier build
// and provides no cryptographic proof security.
//
// Fixture format (all values are 32-byte big-endian):
//   proofA[0..32]   = root
//   proofA[32..64]  = nullifierHash
//   proofB[0..32]   = tx_hash (Poseidon over pubkeys_hash + scalar params)
//   proofB[32..64]  = programId
//   proofB[64..96]  = poolStatePda
//   proofB[96..128] = configPda
//   proofC[0..32]   = recipientPk
//   proofC[32..64]  = relayerPk
//
// Requires initPoseidon() to have been called before use.
function buildMockWithdrawProof(opts: {
  root: Buffer;
  nullifierHash: Buffer;
  denomination: BN;
  fee: BN;
  expirySlot: BN;
  circuitVersion: BN;
  recipientPk: PublicKey;
  relayerPk: PublicKey;
  programId: PublicKey;
  poolStatePda: PublicKey;
  configPda: PublicKey;
  chainId: bigint;
}): { proofA: number[]; proofB: number[]; proofC: number[] } {
  const pubkeysHex = computePubkeysHash(
    opts.programId.toBase58(),
    opts.poolStatePda.toBase58(),
    opts.configPda.toBase58(),
    opts.recipientPk.toBase58(),
    opts.relayerPk.toBase58()
  );

  const txHashHex = computeTxHash(
    pubkeysHex,
    BigInt(opts.denomination.toString()),
    BigInt(opts.fee.toString()),
    opts.chainId,
    BigInt(opts.expirySlot.toString()),
    BigInt(opts.circuitVersion.toString())
  );

  const txHashBuf = Buffer.from(txHashHex, "hex");

  // proofA = root || nullifierHash
  const proofA = [...opts.root, ...opts.nullifierHash];

  // proofB = tx_hash || programId || poolStatePda || configPda
  const proofB = [
    ...txHashBuf,
    ...opts.programId.toBytes(),
    ...opts.poolStatePda.toBytes(),
    ...opts.configPda.toBytes(),
  ];

  // proofC = recipientPk || relayerPk
  const proofC = [...opts.recipientPk.toBytes(), ...opts.relayerPk.toBytes()];

  return { proofA, proofB, proofC };
}

// Unique nullifier hashes for each test that performs a successful withdrawal.
// Using distinct values prevents NullifierAlreadyUsed across tests.
const NULLIFIER_SUCCESS = Buffer.from(Array(31).fill(0).concat([0x11]));
const NULLIFIER_ACCOUNTING = Buffer.from(Array(31).fill(0).concat([0x22]));
const NULLIFIER_REPLAY_A = Buffer.from(Array(31).fill(0).concat([0x33]));
const NULLIFIER_WRONG_ROOT = Buffer.from(Array(31).fill(0).concat([0x44]));
const NULLIFIER_NONCANONICAL_ROOT = Buffer.from(
  Array(31).fill(0).concat([0x60])
);
const NULLIFIER_NONCANONICAL_NULLIFIER = Buffer.from(
  Array(31).fill(0).concat([0x61])
);

// Nullifiers for mock proof fixture binding tests.
const NULLIFIER_INVALID_PROOF = Buffer.from(Array(31).fill(0).concat([0x80]));
const NULLIFIER_ROOT_BINDING = Buffer.from(Array(31).fill(0).concat([0x81]));
const NULLIFIER_NULLIFIER_BINDING = Buffer.from(
  Array(31).fill(0).concat([0x82])
);
const NULLIFIER_RECIPIENT_BINDING = Buffer.from(
  Array(31).fill(0).concat([0x83])
);
const NULLIFIER_FEE_BINDING = Buffer.from(Array(31).fill(0).concat([0x84]));
const NULLIFIER_CHAIN_ID_BINDING = Buffer.from(
  Array(31).fill(0).concat([0x85])
);

const VALID_ROOT = Buffer.from(Array(31).fill(0).concat([0x01]));
const UNKNOWN_ROOT = Buffer.from(Array(31).fill(0).concat([0x99]));

// BN254 Fr modulus — not a canonical field element (equals p, not < p).
// hex: 30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
const BN254_P = Buffer.from(
  "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
  "hex"
);

const DENOMINATION = new BN(100_000_000); // 0.1 SOL, valid bucket
const LARGE_DENOMINATION = new BN(10_000_000_000); // 10 SOL, valid bucket (exceeds pool)
const CIRCUIT_VERSION = new BN(1);
const EXPIRY_FAR_FUTURE = new BN(1_000_000_000); // slot far in the future

// chain_id matches the value used in initializeConfig (new BN(1)).
const CHAIN_ID = 1n;

describe("withdraw_zk", function () {
  this.timeout(1_000_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program: any = anchor.workspace.ShieldedPoolAnchor;
  const payer = provider.wallet as anchor.Wallet;

  const recipient = Keypair.generate();

  const [poolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    program.programId
  );
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_config")],
    program.programId
  );

  let rentMin = 0; // NullifierMarker rent-exempt minimum (9 bytes)
  let poolLamportsBefore = 0;
  let totalWithdrawalsBefore = 0;

  function nullifierMarkerPda(nullifierHash: Buffer): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), nullifierHash],
      program.programId
    );
    return pda;
  }

  // Build the correct mock proof fixture for a withdrawZkRpc call.
  // Wraps buildMockWithdrawProof with the fixed suite-level accounts.
  function buildProof(opts: {
    root: Buffer;
    nullifierHash: Buffer;
    denomination: BN;
    fee: BN;
    expirySlot: BN;
    circuitVersion: BN;
    recipientPk: PublicKey;
  }) {
    return buildMockWithdrawProof({
      ...opts,
      relayerPk: payer.publicKey,
      programId: program.programId,
      poolStatePda,
      configPda,
      chainId: CHAIN_ID,
    });
  }

  function withdrawZkRpc(opts: {
    nullifierHash?: Buffer;
    root?: Buffer;
    denomination?: BN;
    fee?: BN;
    expirySlot?: BN;
    circuitVersion?: BN;
    recipientPk?: PublicKey;
    proofAOverride?: number[];
    proofBOverride?: number[];
    proofCOverride?: number[];
  }) {
    const nullifierHash = opts.nullifierHash ?? NULLIFIER_SUCCESS;
    const root = opts.root ?? VALID_ROOT;
    const denomination = opts.denomination ?? DENOMINATION;
    const fee = opts.fee ?? new BN(rentMin);
    const expirySlot = opts.expirySlot ?? EXPIRY_FAR_FUTURE;
    const circuitVersion = opts.circuitVersion ?? CIRCUIT_VERSION;
    const recipientPk = opts.recipientPk ?? recipient.publicKey;

    const { proofA, proofB, proofC } = buildProof({
      root,
      nullifierHash,
      denomination,
      fee,
      expirySlot,
      circuitVersion,
      recipientPk,
    });

    return program.methods
      .withdrawZk(
        opts.proofAOverride ?? proofA,
        opts.proofBOverride ?? proofB,
        opts.proofCOverride ?? proofC,
        Array.from(root),
        Array.from(nullifierHash),
        denomination,
        fee,
        expirySlot,
        circuitVersion
      )
      .accounts({
        relayer: payer.publicKey,
        poolState: poolStatePda,
        config: configPda,
        nullifierMarker: nullifierMarkerPda(nullifierHash),
        recipient: recipientPk,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  before(async () => {
    // initPoseidon must be called before any buildMockWithdrawProof call.
    await initPoseidon();

    await airdropIfNeeded(
      provider.connection,
      payer.publicKey,
      20 * LAMPORTS_PER_SOL
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
        .initializeConfig(payer.publicKey, [payer.publicKey], 1, new BN(1))
        .accounts({
          admin: payer.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    // Add VALID_ROOT to allowed_roots
    const configData = await program.account.verifierConfig.fetch(configPda);
    const rootAlreadyPresent = (configData.allowedRoots as number[][]).some(
      (r) => Buffer.from(r).equals(VALID_ROOT)
    );
    if (!rootAlreadyPresent) {
      await program.methods
        .addAllowedRoot(Array.from(VALID_ROOT))
        .accounts({ rootSubmitter: payer.publicKey, config: configPda })
        .rpc();
    }

    // Fund pool: 0.5 SOL is enough for multiple 0.1 SOL withdrawals
    await program.methods
      .deposit(new BN(500_000_000))
      .accounts({
        depositor: payer.publicKey,
        poolState: poolStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    rentMin = await provider.connection.getMinimumBalanceForRentExemption(9);

    poolLamportsBefore = await provider.connection.getBalance(poolStatePda);
    const poolStateData = await program.account.poolState.fetch(poolStatePda);
    totalWithdrawalsBefore = poolStateData.totalWithdrawals.toNumber();
  });

  // ── Happy path ────────────────────────────────────────────────────────────────

  it("withdraw_zk succeeds with valid mock proof fixture", async () => {
    const sig = await withdrawZkRpc({ nullifierHash: NULLIFIER_SUCCESS });
    expect(sig).to.be.a("string").with.length.greaterThan(0);
  });

  it("NullifierMarker.used is true after success", async () => {
    const marker = await program.account.nullifierMarker.fetch(
      nullifierMarkerPda(NULLIFIER_SUCCESS)
    );
    expect(marker.used).to.equal(true);
  });

  // ── Lamport accounting ────────────────────────────────────────────────────────

  it("pool decreases by denomination and recipient receives denomination minus fee", async () => {
    const fee = new BN(rentMin);
    const recipientBefore = await provider.connection.getBalance(
      recipient.publicKey
    );
    const poolBefore = await provider.connection.getBalance(poolStatePda);

    await withdrawZkRpc({
      nullifierHash: NULLIFIER_ACCOUNTING,
      fee,
    });

    const poolAfter = await provider.connection.getBalance(poolStatePda);
    const recipientAfter = await provider.connection.getBalance(
      recipient.publicKey
    );

    expect(poolBefore - poolAfter).to.equal(DENOMINATION.toNumber());
    expect(recipientAfter - recipientBefore).to.equal(
      DENOMINATION.toNumber() - rentMin
    );
  });

  it("pool_state.total_withdrawals increases by denomination", async () => {
    const poolStateData = await program.account.poolState.fetch(poolStatePda);
    // Two successful withdrawals have occurred (NULLIFIER_SUCCESS + NULLIFIER_ACCOUNTING)
    expect(poolStateData.totalWithdrawals.toNumber()).to.equal(
      totalWithdrawalsBefore + 2 * DENOMINATION.toNumber()
    );
  });

  // ── Nullifier replay protection ───────────────────────────────────────────────

  it("replay same nullifier_hash returns NullifierAlreadyUsed", async () => {
    await expectTxToFail(
      withdrawZkRpc({ nullifierHash: NULLIFIER_SUCCESS }),
      "NullifierAlreadyUsed"
    );
  });

  it("double-submit: first call succeeds, second fails with NullifierAlreadyUsed", async () => {
    await withdrawZkRpc({ nullifierHash: NULLIFIER_REPLAY_A });
    await expectTxToFail(
      withdrawZkRpc({ nullifierHash: NULLIFIER_REPLAY_A }),
      "NullifierAlreadyUsed"
    );
  });

  // ── Semantic error cases ──────────────────────────────────────────────────────

  it("paused config returns Paused", async () => {
    await program.methods
      .updateVerifierConfig(1, [payer.publicKey], true)
      .accounts({ admin: payer.publicKey, config: configPda })
      .rpc();

    try {
      await expectTxToFail(
        withdrawZkRpc({
          nullifierHash: Buffer.from(Array(31).fill(0).concat([0x55])),
        }),
        "Paused"
      );
    } finally {
      await program.methods
        .updateVerifierConfig(1, [payer.publicKey], false)
        .accounts({ admin: payer.publicKey, config: configPda })
        .rpc();
    }
  });

  it("wrong circuit_version returns InvalidCircuitVersion", async () => {
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: Buffer.from(Array(31).fill(0).concat([0x56])),
        circuitVersion: new BN(99),
      }),
      "InvalidCircuitVersion"
    );
  });

  it("denomination not in ALLOWED_BUCKET_AMOUNTS returns InvalidDenomination", async () => {
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: Buffer.from(Array(31).fill(0).concat([0x57])),
        denomination: new BN(12_345_678),
      }),
      "InvalidDenomination"
    );
  });

  it("fee greater than denomination returns InvalidFee", async () => {
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: Buffer.from(Array(31).fill(0).concat([0x58])),
        fee: new BN(DENOMINATION.toNumber() + 1),
      }),
      "InvalidFee"
    );
  });

  it("fee less than NullifierMarker rent returns FeeTooLow", async () => {
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: Buffer.from(Array(31).fill(0).concat([0x59])),
        fee: new BN(0),
      }),
      "FeeTooLow"
    );
  });

  it("expired slot returns SettlementExpired", async () => {
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: Buffer.from(Array(31).fill(0).concat([0x5a])),
        expirySlot: new BN(0),
      }),
      "SettlementExpired"
    );
  });

  it("non-canonical root (root = BN254_P) returns NonCanonicalRoot", async () => {
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: NULLIFIER_NONCANONICAL_ROOT,
        root: BN254_P,
      }),
      "NonCanonicalRoot"
    );
  });

  it("non-canonical nullifier_hash (= BN254_P) returns NonCanonicalNullifierHash", async () => {
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: BN254_P,
        root: VALID_ROOT,
      }),
      "NonCanonicalNullifierHash"
    );
  });

  it("empty allowed_roots returns NoAllowedRootsConfigured", async () => {
    // Fetch the live allowed_roots and remove every entry so the list is
    // provably empty regardless of what was added before this test.
    // This is defensive against any extra roots that could have entered
    // config.allowed_roots through setup or future test ordering changes.
    const configData = await program.account.verifierConfig.fetch(configPda);
    const currentRoots: number[][] = configData.allowedRoots;
    for (const root of currentRoots) {
      await program.methods
        .removeAllowedRoot(root)
        .accounts({ rootSubmitter: payer.publicKey, config: configPda })
        .rpc();
    }

    try {
      await expectTxToFail(
        withdrawZkRpc({
          nullifierHash: Buffer.from(Array(31).fill(0).concat([0x5b])),
        }),
        "NoAllowedRootsConfigured"
      );
    } finally {
      // Restore exactly VALID_ROOT so all subsequent tests continue to work.
      await program.methods
        .addAllowedRoot(Array.from(VALID_ROOT))
        .accounts({ rootSubmitter: payer.publicKey, config: configPda })
        .rpc();
    }
  });

  it("root not in allowed_roots returns UnknownMerkleRoot", async () => {
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: NULLIFIER_WRONG_ROOT,
        root: UNKNOWN_ROOT,
      }),
      "UnknownMerkleRoot"
    );
  });

  it("pool balance less than denomination returns InsufficientPoolBalance", async () => {
    // Pool has ~0.2 SOL remaining (started at 0.5 SOL, drained 0.3 SOL across success tests).
    // 10 SOL (LARGE_DENOMINATION) exceeds pool_spendable -> InsufficientPoolBalance.
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: Buffer.from(Array(31).fill(0).concat([0x5c])),
        denomination: LARGE_DENOMINATION,
        fee: new BN(rentMin),
      }),
      "InsufficientPoolBalance"
    );
  });

  // ── Mock proof fixture binding tests ─────────────────────────────────────────
  //
  // These tests verify that the mock-verifier path validates the deterministic
  // local-test-only proof fixture. They confirm that the public-input boundary
  // will be exercised by the real Groth16 verifier.
  //
  // None of these tests provide cryptographic proof security. They only verify
  // the fixture format and the on-chain byte comparison logic.

  it("random/zero proof bytes return InvalidProof (semantic inputs valid)", async () => {
    // All semantic checks pass; proof bytes are all-zero → fixture mismatch → InvalidProof.
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: NULLIFIER_INVALID_PROOF,
        proofAOverride: Array(64).fill(0),
        proofBOverride: Array(128).fill(0),
        proofCOverride: Array(64).fill(0),
      }),
      "InvalidProof"
    );
  });

  it("proof fixture built with wrong root returns InvalidProof", async () => {
    // Proof encodes a root that differs from the instruction root.
    // The instruction root (VALID_ROOT) passes the allowlist check, but the
    // fixture's proofA[0..32] holds the wrong root → mismatch → InvalidProof.
    const wrongRoot = Buffer.from(Array(31).fill(0).concat([0x02]));
    const wrongProofA = [...wrongRoot, ...NULLIFIER_ROOT_BINDING];
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: NULLIFIER_ROOT_BINDING,
        root: VALID_ROOT,
        proofAOverride: wrongProofA,
      }),
      "InvalidProof"
    );
  });

  it("proof fixture built with wrong nullifier_hash returns InvalidProof", async () => {
    // Proof encodes a nullifier_hash that differs from the instruction arg.
    // All semantic checks use NULLIFIER_NULLIFIER_BINDING; the fixture encodes
    // a different value in proofA[32..64] → mismatch → InvalidProof.
    const wrongNullifierInProof = Buffer.alloc(32, 0xde);
    const wrongProofA = [...VALID_ROOT, ...wrongNullifierInProof];
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: NULLIFIER_NULLIFIER_BINDING,
        root: VALID_ROOT,
        proofAOverride: wrongProofA,
      }),
      "InvalidProof"
    );
  });

  it("proof fixture built for different recipient returns InvalidProof", async () => {
    // Instruction uses altRecipient as the recipient account.
    // proofCOverride encodes the original recipient pubkey instead.
    // On-chain expects proofC[0..32] == altRecipient.publicKey → mismatch → InvalidProof.
    const altRecipient = Keypair.generate();
    // proofB is built by withdrawZkRpc for altRecipient (tx_hash matches on-chain).
    // proofC encodes original recipient → mismatch on proof_c[0..32].
    const wrongProofC = [
      ...recipient.publicKey.toBytes(),
      ...payer.publicKey.toBytes(),
    ];
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: NULLIFIER_RECIPIENT_BINDING,
        recipientPk: altRecipient.publicKey,
        proofCOverride: wrongProofC,
      }),
      "InvalidProof"
    );
  });

  it("proof fixture built with wrong fee returns InvalidProof", async () => {
    // Proof encodes tx_hash computed with fee+1; instruction uses rentMin.
    // On-chain recomputes tx_hash with rentMin → proofB[0..32] mismatch → InvalidProof.
    const instructionFee = new BN(rentMin);
    const wrongFee = new BN(rentMin + 1);
    const { proofB: wrongProofB } = buildProof({
      root: VALID_ROOT,
      nullifierHash: NULLIFIER_FEE_BINDING,
      denomination: DENOMINATION,
      fee: wrongFee,
      expirySlot: EXPIRY_FAR_FUTURE,
      circuitVersion: CIRCUIT_VERSION,
      recipientPk: recipient.publicKey,
    });
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: NULLIFIER_FEE_BINDING,
        fee: instructionFee,
        proofBOverride: wrongProofB,
      }),
      "InvalidProof"
    );
  });

  it("proof fixture built with wrong chain_id returns InvalidProof", async () => {
    // Proof encodes tx_hash computed with chain_id=2; config has chain_id=1.
    // On-chain recomputes tx_hash with chain_id=1 → proofB[0..32] mismatch → InvalidProof.
    const wrongChainId = CHAIN_ID + 1n;
    const { proofB: wrongProofB } = buildMockWithdrawProof({
      root: VALID_ROOT,
      nullifierHash: NULLIFIER_CHAIN_ID_BINDING,
      denomination: DENOMINATION,
      fee: new BN(rentMin),
      expirySlot: EXPIRY_FAR_FUTURE,
      circuitVersion: CIRCUIT_VERSION,
      recipientPk: recipient.publicKey,
      relayerPk: payer.publicKey,
      programId: program.programId,
      poolStatePda,
      configPda,
      chainId: wrongChainId,
    });
    await expectTxToFail(
      withdrawZkRpc({
        nullifierHash: NULLIFIER_CHAIN_ID_BINDING,
        proofBOverride: wrongProofB,
      }),
      "InvalidProof"
    );
  });

  // ── Event emission ────────────────────────────────────────────────────────────

  it("emits NullifierConsumed and ZkWithdrawExecuted events on success", async () => {
    // Re-fund pool for this test since previous tests may have drained it
    await program.methods
      .deposit(new BN(200_000_000))
      .accounts({
        depositor: payer.publicKey,
        poolState: poolStatePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const eventNullifier = Buffer.from(Array(31).fill(0).concat([0x77]));
    const sig = await withdrawZkRpc({ nullifierHash: eventNullifier });

    const events = await getTransactionEvents(
      program,
      provider.connection,
      sig
    );

    const nullifierConsumed = events.find(
      (e) => e.name === "nullifierConsumed"
    );
    expect(nullifierConsumed, "NullifierConsumed event not found").to.exist;
    expect(
      Array.from(nullifierConsumed!.data.nullifier as Uint8Array)
    ).to.deep.equal(Array.from(eventNullifier));
    expect(nullifierConsumed!.data.slot.toNumber()).to.be.greaterThan(0);

    const zkWithdraw = events.find((e) => e.name === "zkWithdrawExecuted");
    expect(zkWithdraw, "ZkWithdrawExecuted event not found").to.exist;
    expect(
      Array.from(zkWithdraw!.data.nullifierHash as Uint8Array)
    ).to.deep.equal(Array.from(eventNullifier));
    expect(zkWithdraw!.data.denomination.toNumber()).to.equal(
      DENOMINATION.toNumber()
    );
    expect(zkWithdraw!.data.fee.toNumber()).to.equal(rentMin);
    expect(zkWithdraw!.data.circuitVersion.toNumber()).to.equal(1);
    expect(zkWithdraw!.data.slot.toNumber()).to.be.greaterThan(0);
  });

  // ── Non-mock build note ───────────────────────────────────────────────────────
  //
  // The non-mock (default features) build always returns InvalidProof from withdraw_zk
  // before any state mutation. This behavior is enforced by:
  //   #[cfg(not(feature = "mock-verifier"))] { return Err(error!(InvalidProof)); }
  // in the handler. It cannot be tested in this validator-backed suite because the suite
  // builds with --features mock-verifier. Verifying the non-mock path requires a separate
  // build without the feature flag.
  //
  // Relayer binding note:
  // A relayer binding test (proof_c[32..64] encodes wrong relayer pubkey) is not included
  // because the instruction requires the relayer to be the transaction signer. Testing with
  // an alternate relayer would require generating, funding, and signing with a second
  // keypair, which is not supported by the current withdrawZkRpc helper without significant
  // additional test infrastructure. This binding is covered indirectly: any alternate
  // relayer produces a different tx_hash (via pubkeys_hash), causing proofB[0..32] to
  // mismatch if the proof was built for the original relayer.
});
