import * as anchor from "@anchor-lang/core";
import { BN, EventParser } from "@anchor-lang/core";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";
import {
  computeIntentHash,
  computeHandshakeHash,
  makeEd25519Instruction,
  randomBytes32,
} from "../lib/crypto";

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

function intentHash(intent: WithdrawIntent): Buffer {
  return computeIntentHash({
    recipient: intent.recipient,
    relayer: intent.relayer,
    amount: intent.amount,
    fee: intent.fee,
    nonce: intent.nonce,
    chainId: intent.chain_id,
    nullifier: intent.nullifier,
    commitment: intent.commitment,
    merkleRoot: intent.merkle_root,
    auditHash: intent.audit_hash,
    policyId: intent.policy_id,
  });
}

function handshakeHash(
  programId: PublicKey,
  poolPda: PublicKey,
  configPda: PublicKey,
  expirySlot: BN,
  ih: Buffer,
  intent: WithdrawIntent
): Buffer {
  return computeHandshakeHash({
    programId,
    poolPda,
    configPda,
    expirySlot,
    intentHash: ih,
    auditHash: intent.audit_hash,
    policyId: intent.policy_id,
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
    if (err?.message === "Expected transaction to fail, but it succeeded") {
      throw err;
    }
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

describe("withdraw", function () {
  this.timeout(1000000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program: any = anchor.workspace.ShieldedPoolAnchor;

  const payer = provider.wallet as anchor.Wallet;
  const relayer = Keypair.generate();
  const verifier = Keypair.generate();
  const recipient = Keypair.generate();

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

  let currentIntent: WithdrawIntent;
  let currentExpirySlot: BN;

  async function ensureInitialized(): Promise<void> {
    const poolInfo = await provider.connection.getAccountInfo(poolStatePda);
    const configInfo = await provider.connection.getAccountInfo(configPda);

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
  }

  async function fundPool(lamports: number): Promise<void> {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: poolStatePda,
        lamports,
      })
    );
    await provider.sendAndConfirm(tx, []);
  }

  async function buildWithdrawTx(
    intent: WithdrawIntent,
    expirySlot: BN,
    accountsRelayer: PublicKey
  ) {
    const ih = intentHash(intent);
    const hh = handshakeHash(
      program.programId,
      poolStatePda,
      configPda,
      expirySlot,
      ih,
      intent
    );

    const ed25519Ix = makeEd25519Instruction(verifier, hh);

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
        relayer: accountsRelayer,
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

  function makeIntent(nonce: BN): WithdrawIntent {
    return {
      commitment: randomBytes32(),
      nullifier: randomBytes32(),
      recipient: recipient.publicKey,
      amount,
      fee,
      relayer: relayer.publicKey,
      chain_id: chainId,
      nonce,
      audit_hash: randomBytes32(),
      policy_id: 1,
      merkle_root: randomBytes32(),
    };
  }

  before(async () => {
    await airdropIfNeeded(
      provider.connection,
      relayer.publicKey,
      5 * LAMPORTS_PER_SOL
    );

    await ensureInitialized();
    await fundPool(15 * LAMPORTS_PER_SOL);

    fee = new BN(
      await provider.connection.getMinimumBalanceForRentExemption(9)
    ).add(new BN(50_000));

    const slot = await provider.connection.getSlot("confirmed");
    currentExpirySlot = new BN(slot + 100);

    currentIntent = {
      commitment: randomBytes32(),
      nullifier: randomBytes32(),
      recipient: recipient.publicKey,
      amount,
      fee,
      relayer: relayer.publicKey,
      chain_id: chainId,
      nonce: new BN(1),
      audit_hash: randomBytes32(),
      policy_id: 1,
      merkle_root: randomBytes32(),
    };
  });

  it("withdraws successfully on the happy path", async () => {
    const poolBefore = await provider.connection.getBalance(poolStatePda);
    const recipientBefore = await provider.connection.getBalance(
      recipient.publicKey
    );
    const relayerBefore = await provider.connection.getBalance(
      relayer.publicKey
    );

    const { tx, nullifierMarkerPda } = await buildWithdrawTx(
      currentIntent,
      currentExpirySlot,
      currentIntent.relayer
    );

    await provider.sendAndConfirm(tx, [relayer]);

    const poolAfter = await provider.connection.getBalance(poolStatePda);
    const recipientAfter = await provider.connection.getBalance(
      recipient.publicKey
    );
    const relayerAfter = await provider.connection.getBalance(
      relayer.publicKey
    );
    const nullifierMarkerRent =
      await provider.connection.getMinimumBalanceForRentExemption(9);

    expect(poolBefore - poolAfter).to.equal(currentIntent.amount.toNumber());
    expect(recipientAfter - recipientBefore).to.equal(
      currentIntent.amount.sub(currentIntent.fee).toNumber()
    );
    // Relayer receives intent.fee from the pool, but Anchor deducts nullifier-marker
    // rent from the relayer's balance during init_if_needed (payer = relayer).
    // tx.feePayer = payer.publicKey, so Solana tx fee is not charged to the relayer.
    expect(relayerAfter - relayerBefore).to.equal(
      currentIntent.fee.toNumber() - nullifierMarkerRent
    );

    const nullifierAccount = await program.account.nullifierMarker.fetch(
      nullifierMarkerPda
    );
    expect(nullifierAccount.used).to.equal(true);
  });

  it("emits WithdrawExecuted and NullifierConsumed events with correct payload", async () => {
    const intent = makeIntent(new BN(50));
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
    const sig = await provider.sendAndConfirm(tx, [relayer]);

    const events = await getTransactionEvents(
      program,
      provider.connection,
      sig
    );

    const weEvent = events.find((e) => e.name === "withdrawExecuted");
    expect(weEvent, "withdrawExecuted event missing").to.not.be.undefined;

    const expectedIH = intentHash(intent);
    const expectedHH = handshakeHash(
      program.programId,
      poolStatePda,
      configPda,
      expirySlot,
      expectedIH,
      intent
    );

    expect(Array.from(weEvent!.data.intentHash as number[])).to.deep.equal(
      Array.from(expectedIH)
    );
    expect(Array.from(weEvent!.data.handshakeHash as number[])).to.deep.equal(
      Array.from(expectedHH)
    );
    expect(Array.from(weEvent!.data.nullifier as number[])).to.deep.equal(
      Array.from(intent.nullifier)
    );
    expect((weEvent!.data.recipient as PublicKey).toBase58()).to.equal(
      recipient.publicKey.toBase58()
    );
    expect((weEvent!.data.relayer as PublicKey).toBase58()).to.equal(
      relayer.publicKey.toBase58()
    );
    expect((weEvent!.data.amount as BN).toNumber()).to.equal(
      intent.amount.toNumber()
    );
    expect((weEvent!.data.fee as BN).toNumber()).to.equal(
      intent.fee.toNumber()
    );
    expect(weEvent!.data.signerCount).to.equal(1);
    expect(weEvent!.data.threshold).to.equal(1);

    const ncEvent = events.find((e) => e.name === "nullifierConsumed");
    expect(ncEvent, "nullifierConsumed event missing").to.not.be.undefined;
    expect(Array.from(ncEvent!.data.nullifier as number[])).to.deep.equal(
      Array.from(intent.nullifier)
    );
  });

  it("rejects an expired slot", async () => {
    const expiredSlot = new BN(
      (await provider.connection.getSlot("confirmed")) - 1
    );
    const { tx } = await buildWithdrawTx(
      currentIntent,
      expiredSlot,
      currentIntent.relayer
    );
    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "SettlementExpired"
    );
  });

  it("rejects a mismatched relayer", async () => {
    const wrongRelayer = Keypair.generate();
    await airdropIfNeeded(
      provider.connection,
      wrongRelayer.publicKey,
      2 * LAMPORTS_PER_SOL
    );

    const badIntent: WithdrawIntent = {
      ...currentIntent,
      relayer: Keypair.generate().publicKey,
      nonce: new BN(2),
      nullifier: randomBytes32(),
      commitment: randomBytes32(),
      merkle_root: randomBytes32(),
    };

    const { tx } = await buildWithdrawTx(
      badIntent,
      currentExpirySlot,
      wrongRelayer.publicKey
    );
    await expectTxToFail(
      provider.sendAndConfirm(tx, [wrongRelayer]),
      "Unauthorized"
    );
  });

  it("rejects replaying the same nullifier", async () => {
    const freshNullifier = randomBytes32();
    const replayIntent: WithdrawIntent = {
      ...currentIntent,
      nullifier: freshNullifier,
      nonce: new BN(3),
    };

    const slot = await provider.connection.getSlot("confirmed");
    const replayExpiry = new BN(slot + 200);

    const { tx: tx1 } = await buildWithdrawTx(
      replayIntent,
      replayExpiry,
      replayIntent.relayer
    );
    await provider.sendAndConfirm(tx1, [relayer]);

    const { tx: tx2 } = await buildWithdrawTx(
      replayIntent,
      replayExpiry,
      replayIntent.relayer
    );
    await expectTxToFail(
      provider.sendAndConfirm(tx2, [relayer]),
      "NullifierAlreadyUsed"
    );
  });

  it("rejects replay of consumed nullifier even with different intent parameters", async () => {
    // Replay protection is keyed on the nullifier bytes alone, not the full intent.
    // Even if amount, fee, nonce, commitment, and merkle_root differ, the same
    // nullifier bytes must not be usable after they have been consumed.
    const sharedNullifier = randomBytes32();

    const firstIntent: WithdrawIntent = {
      ...makeIntent(new BN(5001)),
      nullifier: sharedNullifier,
    };
    const slot1 = await provider.connection.getSlot("confirmed");
    const { tx: tx1 } = await buildWithdrawTx(
      firstIntent,
      new BN(slot1 + 200),
      firstIntent.relayer
    );
    await provider.sendAndConfirm(tx1, [relayer]);

    // Different amount, nonce, commitment, merkle_root — same nullifier.
    const secondIntent: WithdrawIntent = {
      ...makeIntent(new BN(5002)),
      nullifier: sharedNullifier,
      amount: new BN(500_000_000),
    };
    const slot2 = await provider.connection.getSlot("confirmed");
    const { tx: tx2 } = await buildWithdrawTx(
      secondIntent,
      new BN(slot2 + 200),
      secondIntent.relayer
    );
    await expectTxToFail(
      provider.sendAndConfirm(tx2, [relayer]),
      "NullifierAlreadyUsed"
    );
  });

  it("failed transaction (FeeTooLow) does not consume nullifier — retry succeeds", async () => {
    // Solana transaction atomicity: if the instruction fails, all account
    // mutations are rolled back — including the NullifierMarker account creation
    // performed by init_if_needed during Anchor's accounts validation phase.
    const rentCost =
      await provider.connection.getMinimumBalanceForRentExemption(9);
    const sharedNullifier = randomBytes32();

    const nullifierMarkerPda = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), Buffer.from(sharedNullifier)],
      program.programId
    )[0];

    // First attempt: fee below rent minimum — fails with FeeTooLow.
    const badIntent: WithdrawIntent = {
      ...makeIntent(new BN(5010)),
      nullifier: sharedNullifier,
      fee: new BN(rentCost - 1),
      amount: new BN(LAMPORTS_PER_SOL),
    };
    const slot1 = await provider.connection.getSlot("confirmed");
    const { tx: tx1 } = await buildWithdrawTx(
      badIntent,
      new BN(slot1 + 200),
      badIntent.relayer
    );
    await expectTxToFail(provider.sendAndConfirm(tx1, [relayer]), "FeeTooLow");

    // Nullifier marker must not exist — the failed transaction was fully rolled back.
    const markerInfo = await provider.connection.getAccountInfo(
      nullifierMarkerPda
    );
    expect(markerInfo).to.be.null;

    // Retry with the same nullifier and a valid fee — must succeed.
    const goodIntent: WithdrawIntent = {
      ...makeIntent(new BN(5011)),
      nullifier: sharedNullifier,
    };
    const slot2 = await provider.connection.getSlot("confirmed");
    const { tx: tx2 } = await buildWithdrawTx(
      goodIntent,
      new BN(slot2 + 200),
      goodIntent.relayer
    );
    await provider.sendAndConfirm(tx2, [relayer]);

    const marker = await program.account.nullifierMarker.fetch(
      nullifierMarkerPda
    );
    expect(marker.used).to.equal(true);
  });

  it("attestation failure does not consume nullifier — retry with correct signature succeeds", async () => {
    const sharedNullifier = randomBytes32();
    const intent: WithdrawIntent = {
      ...makeIntent(new BN(5020)),
      nullifier: sharedNullifier,
    };

    const nullifierMarkerPda = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), Buffer.from(sharedNullifier)],
      program.programId
    )[0];

    const fakeAttester = Keypair.generate();

    // First attempt: signed by a key not in the verifier set — fails with AttestationFailed.
    {
      const slot = await provider.connection.getSlot("confirmed");
      const expirySlot = new BN(slot + 200);
      const ih = intentHash(intent);
      const hh = handshakeHash(
        program.programId,
        poolStatePda,
        configPda,
        expirySlot,
        ih,
        intent
      );
      const ed25519Ix = makeEd25519Instruction(fakeAttester, hh);
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
      await expectTxToFail(
        provider.sendAndConfirm(tx, [relayer]),
        "AttestationFailed"
      );
    }

    // Nullifier marker must not exist — the failed transaction was fully rolled back.
    const markerInfo = await provider.connection.getAccountInfo(
      nullifierMarkerPda
    );
    expect(markerInfo).to.be.null;

    // Retry with the correct verifier key — must succeed.
    const slot = await provider.connection.getSlot("confirmed");
    const { tx: tx2 } = await buildWithdrawTx(
      intent,
      new BN(slot + 200),
      intent.relayer
    );
    await provider.sendAndConfirm(tx2, [relayer]);

    const marker = await program.account.nullifierMarker.fetch(
      nullifierMarkerPda
    );
    expect(marker.used).to.equal(true);
  });

  it("rejects a signature from a key outside the verifier set", async () => {
    const fakeAttester = Keypair.generate();
    const intent: WithdrawIntent = {
      ...currentIntent,
      nullifier: randomBytes32(),
      commitment: randomBytes32(),
      merkle_root: randomBytes32(),
      nonce: new BN(10),
    };

    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    const ih = intentHash(intent);
    const hh = handshakeHash(
      program.programId,
      poolStatePda,
      configPda,
      expirySlot,
      ih,
      intent
    );

    const ed25519Ix = makeEd25519Instruction(fakeAttester, hh);

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

    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "AttestationFailed"
    );
  });

  it("rejects a tampered handshake message", async () => {
    const intent: WithdrawIntent = {
      ...currentIntent,
      nullifier: randomBytes32(),
      commitment: randomBytes32(),
      merkle_root: randomBytes32(),
      nonce: new BN(11),
    };

    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    const ih = intentHash(intent);
    const hh = handshakeHash(
      program.programId,
      poolStatePda,
      configPda,
      expirySlot,
      ih,
      intent
    );

    const tamperedHash = Buffer.from(hh);
    tamperedHash[0] ^= 0xff;

    const ed25519Ix = makeEd25519Instruction(verifier, tamperedHash);

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

    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "AttestationFailed"
    );
  });

  // ── Boundary / adversarial tests ──────────────────────────────────────────

  it("rejects amount zero (InvalidAmount)", async () => {
    const intent = {
      ...makeIntent(new BN(812)),
      amount: new BN(0),
      fee: new BN(0),
    };
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);
    const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "InvalidAmount"
    );
  });

  it("rejects fee exceeding amount (InvalidFee)", async () => {
    const intent = {
      ...makeIntent(new BN(813)),
      fee: amount.addn(1),
    };
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);
    const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
    await expectTxToFail(provider.sendAndConfirm(tx, [relayer]), "InvalidFee");
  });

  it("rejects fee below rent threshold (FeeTooLow)", async () => {
    const rentCost =
      await provider.connection.getMinimumBalanceForRentExemption(9);
    const intent = {
      ...makeIntent(new BN(814)),
      fee: new BN(rentCost - 1),
      amount: new BN(LAMPORTS_PER_SOL),
    };
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);
    const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
    await expectTxToFail(provider.sendAndConfirm(tx, [relayer]), "FeeTooLow");
  });

  it("succeeds when fee equals amount (net recipient zero)", async () => {
    const intent = { ...makeIntent(new BN(900)), fee: amount };
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);
    const { tx, nullifierMarkerPda } = await buildWithdrawTx(
      intent,
      expirySlot,
      intent.relayer
    );

    const recipientBefore = await provider.connection.getBalance(
      recipient.publicKey
    );
    await provider.sendAndConfirm(tx, [relayer]);
    const recipientAfter = await provider.connection.getBalance(
      recipient.publicKey
    );

    expect(recipientAfter - recipientBefore).to.equal(0);
    const marker = await program.account.nullifierMarker.fetch(
      nullifierMarkerPda
    );
    expect(marker.used).to.equal(true);
  });

  it("succeeds when fee equals NullifierMarker rent floor (relayer breaks even on rent)", async () => {
    // fee == rent_cost is the minimum valid fee. Relayer nets 0 above rent cost.
    // Recipient receives amount - fee = 1 SOL - rent_cost.
    const rentCost =
      await provider.connection.getMinimumBalanceForRentExemption(9);
    const intent = {
      ...makeIntent(new BN(907)),
      amount: new BN(LAMPORTS_PER_SOL),
      fee: new BN(rentCost),
    };
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);
    const { tx, nullifierMarkerPda } = await buildWithdrawTx(
      intent,
      expirySlot,
      intent.relayer
    );

    const relayerBefore = await provider.connection.getBalance(
      relayer.publicKey
    );
    const recipientBefore = await provider.connection.getBalance(
      recipient.publicKey
    );
    await provider.sendAndConfirm(tx, [relayer]);
    const relayerAfter = await provider.connection.getBalance(
      relayer.publicKey
    );
    const recipientAfter = await provider.connection.getBalance(
      recipient.publicKey
    );

    // fee == rentCost: relayer pays NullifierMarker rent and receives the same
    // amount back as intent.fee. tx.feePayer = payer.publicKey so Solana tx fee
    // is not deducted from the relayer. Net relayer change = 0.
    expect(relayerAfter - relayerBefore).to.equal(0);
    expect(recipientAfter - recipientBefore).to.equal(
      LAMPORTS_PER_SOL - rentCost
    );
    const marker = await program.account.nullifierMarker.fetch(
      nullifierMarkerPda
    );
    expect(marker.used).to.equal(true);
  });

  it("rejects amount exceeding pool balance (InsufficientPoolBalance)", async () => {
    const poolBalance = await provider.connection.getBalance(poolStatePda);
    const intent = {
      ...makeIntent(new BN(901)),
      amount: new BN(poolBalance + LAMPORTS_PER_SOL),
      fee,
    };
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);
    const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "InsufficientPoolBalance"
    );
  });

  it("rejects withdrawal that would drain pool rent-exempt reserve", async () => {
    // PoolState account size: 8 (discriminator) + 32 + 8 + 8 + 1 = 57 bytes.
    // Requesting intent.amount = full pool balance includes the rent reserve —
    // this must be rejected to keep the PoolState account alive.
    const poolBalance = await provider.connection.getBalance(poolStatePda);
    const intent = {
      ...makeIntent(new BN(905)),
      amount: new BN(poolBalance),
      fee,
    };
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);
    const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "InsufficientPoolBalance"
    );
  });

  it("rejects withdrawal 1 lamport above spendable balance (rent floor enforced)", async () => {
    // pool_spendable = pool_lamports - pool_rent_min; requesting spendable+1 must fail.
    const poolBalance = await provider.connection.getBalance(poolStatePda);
    const poolRentMin =
      await provider.connection.getMinimumBalanceForRentExemption(57);
    const spendable = poolBalance - poolRentMin;
    expect(spendable).to.be.greaterThan(0);
    const intent = {
      ...makeIntent(new BN(906)),
      amount: new BN(spendable + 1),
      fee,
    };
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);
    const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "InsufficientPoolBalance"
    );
  });

  it("rejects intent chain_id mismatch (InvalidChainId)", async () => {
    const intent = { ...makeIntent(new BN(902)), chain_id: new BN(999) };
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);
    const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "InvalidChainId"
    );
  });

  it("rejects Ed25519 instruction placed after withdraw instruction", async () => {
    const intent = makeIntent(new BN(903));
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    const ih = intentHash(intent);
    const hh = handshakeHash(
      program.programId,
      poolStatePda,
      configPda,
      expirySlot,
      ih,
      intent
    );
    const ed25519Ix = makeEd25519Instruction(verifier, hh);

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

    const tx = new Transaction().add(withdrawIx, ed25519Ix);
    tx.feePayer = payer.publicKey;
    const latest = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = latest.blockhash;

    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "AttestationFailed"
    );
  });

  it("rejects wrong recipient account binding (BindingMismatch)", async () => {
    const intent = makeIntent(new BN(904));
    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

    const ih = intentHash(intent);
    const hh = handshakeHash(
      program.programId,
      poolStatePda,
      configPda,
      expirySlot,
      ih,
      intent
    );
    const ed25519Ix = makeEd25519Instruction(verifier, hh);

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

    const wrongRecipient = Keypair.generate();

    const withdrawIx = await program.methods
      .withdraw(wireIntent, expirySlot)
      .accounts({
        relayer: relayer.publicKey,
        poolState: poolStatePda,
        config: configPda,
        nullifierMarker: nullifierMarkerPda,
        recipient: wrongRecipient.publicKey,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix, withdrawIx);
    tx.feePayer = payer.publicKey;
    const latest = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = latest.blockhash;

    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "BindingMismatch"
    );
  });

  it("total_withdrawn_lamports accumulates correctly over sequential withdrawals", async () => {
    const stateBefore = await program.account.poolState.fetch(poolStatePda);
    const totalBefore: BN = stateBefore.totalWithdrawals;

    const withdrawAmounts = [
      new BN(5_000_000),
      new BN(7_000_000),
      new BN(11_000_000),
    ];

    for (let i = 0; i < withdrawAmounts.length; i++) {
      const intent = {
        ...makeIntent(new BN(1001 + i)),
        amount: withdrawAmounts[i],
      };
      const slot = await provider.connection.getSlot("confirmed");
      const expirySlot = new BN(slot + 200);
      const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
      await provider.sendAndConfirm(tx, [relayer]);
    }

    const stateAfter = await program.account.poolState.fetch(poolStatePda);
    const totalAfter: BN = stateAfter.totalWithdrawals;

    const expectedIncrease = withdrawAmounts.reduce(
      (acc, a) => acc.add(a),
      new BN(0)
    );
    expect(totalAfter.sub(totalBefore).toNumber()).to.equal(
      expectedIncrease.toNumber()
    );
  });

  it("rejects a missing attestation instruction", async () => {
    const intent: WithdrawIntent = {
      ...currentIntent,
      nullifier: randomBytes32(),
      commitment: randomBytes32(),
      merkle_root: randomBytes32(),
      nonce: new BN(12),
    };

    const slot = await provider.connection.getSlot("confirmed");
    const expirySlot = new BN(slot + 200);

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

    const tx = new Transaction().add(withdrawIx);
    tx.feePayer = payer.publicKey;
    const latest = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = latest.blockhash;

    await expectTxToFail(
      provider.sendAndConfirm(tx, [relayer]),
      "AttestationFailed"
    );
  });

  // ── Merkle root registry ───────────────────────────────────────────────────

  describe("Merkle root registry", function () {
    const testRoot = randomBytes32();
    const anotherRoot = randomBytes32();

    after(async () => {
      const cfg = await program.account.verifierConfig.fetch(configPda);
      for (const root of cfg.allowedRoots as number[][]) {
        await program.methods
          .removeAllowedRoot(Array.from(root))
          .accounts({ rootSubmitter: payer.publicKey, config: configPda })
          .rpc();
      }
    });

    it("withdraw succeeds in open mode (empty allowed_roots)", async () => {
      const intent = makeIntent(new BN(2001));
      const slot = await provider.connection.getSlot("confirmed");
      const expirySlot = new BN(slot + 200);
      const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
      await provider.sendAndConfirm(tx, [relayer]);
    });

    it("non-root-submitter cannot add a root (UnauthorizedRootSubmitter)", async () => {
      const fakeSubmitter = Keypair.generate();
      await airdropIfNeeded(
        provider.connection,
        fakeSubmitter.publicKey,
        LAMPORTS_PER_SOL
      );
      await expectTxToFail(
        program.methods
          .addAllowedRoot(testRoot)
          .accounts({
            rootSubmitter: fakeSubmitter.publicKey,
            config: configPda,
          })
          .signers([fakeSubmitter])
          .rpc(),
        "UnauthorizedRootSubmitter"
      );
    });

    it("all-zero root rejected (DefaultMerkleRoot)", async () => {
      const zeroRoot = Array(32).fill(0);
      await expectTxToFail(
        program.methods
          .addAllowedRoot(zeroRoot)
          .accounts({ rootSubmitter: payer.publicKey, config: configPda })
          .rpc(),
        "DefaultMerkleRoot"
      );
    });

    it("root-submitter can add an allowed root", async () => {
      await program.methods
        .addAllowedRoot(testRoot)
        .accounts({ rootSubmitter: payer.publicKey, config: configPda })
        .rpc();
      const cfg = await program.account.verifierConfig.fetch(configPda);
      expect((cfg.allowedRoots as number[][]).length).to.equal(1);
    });

    it("duplicate root rejected (DuplicateMerkleRoot)", async () => {
      await expectTxToFail(
        program.methods
          .addAllowedRoot(testRoot)
          .accounts({ rootSubmitter: payer.publicKey, config: configPda })
          .rpc(),
        "DuplicateMerkleRoot"
      );
    });

    it("withdraw succeeds when merkle_root is in allowed_roots", async () => {
      const intent = { ...makeIntent(new BN(2002)), merkle_root: testRoot };
      const slot = await provider.connection.getSlot("confirmed");
      const expirySlot = new BN(slot + 200);
      const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
      await provider.sendAndConfirm(tx, [relayer]);
    });

    it("withdraw fails when merkle_root not in allowed_roots (UnknownMerkleRoot)", async () => {
      const intent = { ...makeIntent(new BN(2003)), merkle_root: anotherRoot };
      const slot = await provider.connection.getSlot("confirmed");
      const expirySlot = new BN(slot + 200);
      const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
      await expectTxToFail(
        provider.sendAndConfirm(tx, [relayer]),
        "UnknownMerkleRoot"
      );
    });

    it("remove root works; withdraw with removed root fails", async () => {
      await program.methods
        .addAllowedRoot(anotherRoot)
        .accounts({ rootSubmitter: payer.publicKey, config: configPda })
        .rpc();

      await program.methods
        .removeAllowedRoot(testRoot)
        .accounts({ rootSubmitter: payer.publicKey, config: configPda })
        .rpc();

      const cfg = await program.account.verifierConfig.fetch(configPda);
      expect((cfg.allowedRoots as number[][]).length).to.equal(1);

      const intent = { ...makeIntent(new BN(2004)), merkle_root: testRoot };
      const slot = await provider.connection.getSlot("confirmed");
      const expirySlot = new BN(slot + 200);
      const { tx } = await buildWithdrawTx(intent, expirySlot, intent.relayer);
      await expectTxToFail(
        provider.sendAndConfirm(tx, [relayer]),
        "UnknownMerkleRoot"
      );
    });

    it("non-root-submitter cannot remove a root (UnauthorizedRootSubmitter)", async () => {
      const fakeSubmitter = Keypair.generate();
      await airdropIfNeeded(
        provider.connection,
        fakeSubmitter.publicKey,
        LAMPORTS_PER_SOL
      );
      await expectTxToFail(
        program.methods
          .removeAllowedRoot(anotherRoot)
          .accounts({
            rootSubmitter: fakeSubmitter.publicKey,
            config: configPda,
          })
          .signers([fakeSubmitter])
          .rpc(),
        "UnauthorizedRootSubmitter"
      );
    });

    it("rejects removal of a root that is not in the registry (MerkleRootNotFound)", async () => {
      const neverAddedRoot = randomBytes32();
      await expectTxToFail(
        program.methods
          .removeAllowedRoot(neverAddedRoot)
          .accounts({ rootSubmitter: payer.publicKey, config: configPda })
          .rpc(),
        "MerkleRootNotFound"
      );
    });

    it("unknown root failure does not consume nullifier — retry after root is added succeeds", async () => {
      // freshRoot is not in the registry; the root check triggers because
      // anotherRoot is present (non-empty registry → open mode is off).
      const freshRoot = randomBytes32();
      const sharedNullifier = randomBytes32();

      const nullifierMarkerPda = PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier"), Buffer.from(sharedNullifier)],
        program.programId
      )[0];

      const intent: WithdrawIntent = {
        ...makeIntent(new BN(6001)),
        nullifier: sharedNullifier,
        merkle_root: freshRoot,
      };

      // First attempt: root not in registry — fails with UnknownMerkleRoot.
      const slot1 = await provider.connection.getSlot("confirmed");
      const { tx: tx1 } = await buildWithdrawTx(
        intent,
        new BN(slot1 + 200),
        intent.relayer
      );
      await expectTxToFail(
        provider.sendAndConfirm(tx1, [relayer]),
        "UnknownMerkleRoot"
      );

      // Nullifier marker must not exist — transaction was fully rolled back.
      const markerInfo = await provider.connection.getAccountInfo(
        nullifierMarkerPda
      );
      expect(markerInfo).to.be.null;

      // Add the root to the registry.
      await program.methods
        .addAllowedRoot(freshRoot)
        .accounts({ rootSubmitter: payer.publicKey, config: configPda })
        .rpc();

      // Retry with the same nullifier and now-allowed root — must succeed.
      const slot2 = await provider.connection.getSlot("confirmed");
      const { tx: tx2 } = await buildWithdrawTx(
        intent,
        new BN(slot2 + 200),
        intent.relayer
      );
      await provider.sendAndConfirm(tx2, [relayer]);

      const marker = await program.account.nullifierMarker.fetch(
        nullifierMarkerPda
      );
      expect(marker.used).to.equal(true);
    });

    it("rejects adding a root when the registry is at capacity (MerkleRootSetFull)", async () => {
      // Fill the registry to MAX_ROOTS (10) from current count, then verify
      // that one more add fails with MerkleRootSetFull.
      const cfg = await program.account.verifierConfig.fetch(configPda);
      const currentCount = (cfg.allowedRoots as number[][]).length;

      for (let i = currentCount; i < 10; i++) {
        await program.methods
          .addAllowedRoot(randomBytes32())
          .accounts({ rootSubmitter: payer.publicKey, config: configPda })
          .rpc();
      }

      const cfgFull = await program.account.verifierConfig.fetch(configPda);
      expect((cfgFull.allowedRoots as number[][]).length).to.equal(10);

      await expectTxToFail(
        program.methods
          .addAllowedRoot(randomBytes32())
          .accounts({ rootSubmitter: payer.publicKey, config: configPda })
          .rpc(),
        "MerkleRootSetFull"
      );
    });
  });
});
