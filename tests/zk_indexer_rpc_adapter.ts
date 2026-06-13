import { expect } from "chai";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import { IncrementalMerkleTree } from "../lib/zk_indexer/incremental_tree";
import {
  sortEventsForReplay,
  replayNoteDeposits,
} from "../lib/zk_indexer/event_log";
import { TREE_DEPTH, EMPTY_SUBTREES } from "../lib/zk_indexer/constants";
import {
  SignatureInfoLike,
  TransactionLike,
  ReadOnlyConnectionLike,
  FetchedTransaction,
  fetchSignaturesForAddress,
  fetchTransactionsForSignatures,
  transactionToEventFixture,
  transactionsToEventFixtures,
  extractNoteDepositedEventsFromTransactions,
  fetchAndExtractNoteDepositedEvents,
} from "../lib/zk_indexer/rpc_adapter";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DEPOSITOR = "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe";
const C0 = "0101010101010101010101010101010101010101010101010101010101010101";
const C1 = "0202020202020202020202020202020202020202020202020202020202020202";

function eventJsonLog(name: string, data: Record<string, unknown>): string {
  return `Program log: EVENT_JSON:${JSON.stringify({ name, data })}`;
}

function noteData(
  commitmentHex: string,
  leafIndex: number,
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    commitment: commitmentHex,
    denomination: "100000000",
    leafIndex,
    depositor: DEPOSITOR,
    slot: "100",
    ...extras,
  };
}

function makeTx(
  logMessages: string[],
  slot?: number,
  err?: unknown
): TransactionLike {
  return {
    slot,
    meta: {
      logMessages,
      ...(err !== undefined ? { err } : {}),
    },
  };
}

// ── fetchSignaturesForAddress ─────────────────────────────────────────────────

describe("zk_indexer: rpc_adapter — fetchSignaturesForAddress", function () {
  it("1. calls connection.getSignaturesForAddress with address, options, commitment", async () => {
    let capturedAddress: unknown;
    let capturedOptions: unknown;
    let capturedCommitment: unknown;

    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress(address, options, commitment) {
        capturedAddress = address;
        capturedOptions = options;
        capturedCommitment = commitment;
        return [];
      },
      async getTransaction() {
        return null;
      },
    };

    await fetchSignaturesForAddress(conn, "myProgram", {
      limit: 10,
      before: "sig0",
      until: "sig99",
      commitment: "confirmed",
    });

    expect(capturedAddress).to.equal("myProgram");
    expect(capturedOptions).to.deep.equal({
      limit: 10,
      before: "sig0",
      until: "sig99",
    });
    expect(capturedCommitment).to.equal("confirmed");
  });

  it("2. validates limit must be positive safe integer", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };

    for (const badLimit of [0, -1, 1.5]) {
      let err: Error | undefined;
      try {
        await fetchSignaturesForAddress(conn, "addr", { limit: badLimit });
      } catch (e) {
        err = e as Error;
      }
      expect(err, `limit ${badLimit} should throw`).to.exist;
      expect(err!.message).to.include("limit");
    }

    // Valid limit — must not throw
    const result = await fetchSignaturesForAddress(conn, "addr", { limit: 10 });
    expect(result).to.be.an("array");
  });

  it("3. rejects malformed signature entries from connection response", async () => {
    // Empty string
    const conn1: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [{ signature: "" }];
      },
      async getTransaction() {
        return null;
      },
    };
    let err1: Error | undefined;
    try {
      await fetchSignaturesForAddress(conn1, "addr");
    } catch (e) {
      err1 = e as Error;
    }
    expect(err1, "empty string signature").to.exist;
    expect(err1!.message).to.include("malformed signature");

    // Non-string (cast to bypass TypeScript)
    const conn2: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [{ signature: 42 as unknown as string }];
      },
      async getTransaction() {
        return null;
      },
    };
    let err2: Error | undefined;
    try {
      await fetchSignaturesForAddress(conn2, "addr");
    } catch (e) {
      err2 = e as Error;
    }
    expect(err2, "non-string signature").to.exist;
    expect(err2!.message).to.include("malformed signature");
  });
});

// ── fetchTransactionsForSignatures ────────────────────────────────────────────

describe("zk_indexer: rpc_adapter — fetchTransactionsForSignatures", function () {
  it("4. accepts string[] signatures and calls getTransaction for each", async () => {
    const called: string[] = [];
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction(sig) {
        called.push(sig);
        return makeTx([], 100);
      },
    };

    await fetchTransactionsForSignatures(conn, ["sigA", "sigB"]);
    expect(called).to.deep.equal(["sigA", "sigB"]);
  });

  it("5. accepts SignatureInfoLike[] signatures and preserves order", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction(sig) {
        return makeTx([], sig === "sig1" ? 100 : 200);
      },
    };

    const sigs: SignatureInfoLike[] = [
      { signature: "sig1", slot: 10 },
      { signature: "sig2", slot: 20 },
    ];
    const results = await fetchTransactionsForSignatures(conn, sigs);

    expect(results).to.have.length(2);
    expect(results[0].signature).to.equal("sig1");
    expect(results[1].signature).to.equal("sig2");
  });

  it("6. skips null transactions", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction(sig) {
        return sig === "nullSig" ? null : makeTx([], 100);
      },
    };

    const results = await fetchTransactionsForSignatures(conn, [
      "nullSig",
      "okSig",
    ]);
    expect(results).to.have.length(1);
    expect(results[0].signature).to.equal("okSig");
  });

  it("7. skips failed transactions by default when meta.err is present", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction(sig) {
        return sig === "failSig"
          ? makeTx([], 100, { InstructionError: [0, "Custom"] })
          : makeTx([], 101);
      },
    };

    const results = await fetchTransactionsForSignatures(conn, [
      "failSig",
      "okSig",
    ]);
    expect(results).to.have.length(1);
    expect(results[0].signature).to.equal("okSig");
  });

  it("8. includes failed transactions when includeFailed=true", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction(sig) {
        return sig === "failSig"
          ? makeTx([], 100, { InstructionError: [0, "Custom"] })
          : makeTx([], 101);
      },
    };

    const results = await fetchTransactionsForSignatures(
      conn,
      ["failSig", "okSig"],
      {
        includeFailed: true,
      }
    );
    expect(results).to.have.length(2);
  });

  it("9. passes maxSupportedTransactionVersion=0 by default", async () => {
    let capturedVersion: number | undefined;
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction(_sig, config) {
        capturedVersion = config?.maxSupportedTransactionVersion;
        return null;
      },
    };

    await fetchTransactionsForSignatures(conn, ["sig1"]);
    expect(capturedVersion).to.equal(0);
  });

  it("10. respects custom maxSupportedTransactionVersion", async () => {
    let capturedVersion: number | undefined;
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction(_sig, config) {
        capturedVersion = config?.maxSupportedTransactionVersion;
        return null;
      },
    };

    await fetchTransactionsForSignatures(conn, ["sig1"], {
      maxSupportedTransactionVersion: 2,
    });
    expect(capturedVersion).to.equal(2);
  });

  it("10b. rejects malformed input signatures (empty string[] entry and empty SignatureInfoLike.signature)", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };

    // Empty string in string[]
    let err1: Error | undefined;
    try {
      await fetchTransactionsForSignatures(conn, [""]);
    } catch (e) {
      err1 = e as Error;
    }
    expect(err1, "empty string in string[]").to.exist;
    expect(err1!.message).to.include("malformed signature");

    // SignatureInfoLike with empty .signature
    let err2: Error | undefined;
    try {
      await fetchTransactionsForSignatures(conn, [{ signature: "" }]);
    } catch (e) {
      err2 = e as Error;
    }
    expect(err2, "SignatureInfoLike with empty signature").to.exist;
    expect(err2!.message).to.include("malformed signature");
  });
});

// ── transactionToEventFixture / transactionsToEventFixtures ───────────────────

describe("zk_indexer: rpc_adapter — transactionToEventFixture / transactionsToEventFixtures", function () {
  it("11. converts transaction.meta.logMessages to fixture.logs", () => {
    const logs = [
      "Program log: Instruction: DepositNote",
      eventJsonLog("noteDeposited", noteData(C0, 0)),
    ];
    const fixture = transactionToEventFixture({
      signature: "sig1",
      transaction: makeTx(logs, 100),
    });
    expect(fixture.logs).to.deep.equal(logs);
  });

  it("12. uses transaction.slot over input.slot when both exist", () => {
    const fixture = transactionToEventFixture({
      signature: "sig1",
      slot: 5,
      transaction: { slot: 99, meta: { logMessages: [] } },
    });
    expect(fixture.slot).to.equal(99);
  });

  it("13. falls back to input.slot when transaction.slot is missing", () => {
    const fixture = transactionToEventFixture({
      signature: "sig1",
      slot: 42,
      transaction: { meta: { logMessages: [] } },
    });
    expect(fixture.slot).to.equal(42);
  });

  it("14. handles missing/null logMessages as []", () => {
    const fx1 = transactionToEventFixture({
      signature: "s1",
      transaction: { meta: { logMessages: null } },
    });
    const fx2 = transactionToEventFixture({
      signature: "s2",
      transaction: { meta: null },
    });
    const fx3 = transactionToEventFixture({
      signature: "s3",
      transaction: {},
    });
    expect(fx1.logs).to.deep.equal([]);
    expect(fx2.logs).to.deep.equal([]);
    expect(fx3.logs).to.deep.equal([]);
  });

  it("15. maps multiple transactions preserving order", () => {
    const inputs: FetchedTransaction[] = [
      { signature: "sigA", transaction: makeTx(["A-log"], 10) },
      { signature: "sigB", transaction: makeTx(["B-log"], 20) },
    ];
    const fixtures = transactionsToEventFixtures(inputs);
    expect(fixtures).to.have.length(2);
    expect(fixtures[0].signature).to.equal("sigA");
    expect(fixtures[0].logs).to.deep.equal(["A-log"]);
    expect(fixtures[1].signature).to.equal("sigB");
    expect(fixtures[1].logs).to.deep.equal(["B-log"]);
  });
});

// ── extractNoteDepositedEventsFromTransactions ────────────────────────────────

describe("zk_indexer: rpc_adapter — extractNoteDepositedEventsFromTransactions", function () {
  it("16. extracts NoteDeposited events from EVENT_JSON logs", () => {
    const inputs: FetchedTransaction[] = [
      {
        signature: "sig1",
        transaction: makeTx(
          [eventJsonLog("noteDeposited", noteData(C0, 0))],
          100
        ),
      },
    ];
    const result = extractNoteDepositedEventsFromTransactions(inputs);
    expect(result).to.have.length(1);
    expect(result[0].commitment_be_hex).to.equal(C0);
    expect(result[0].leaf_index).to.equal(0);
  });

  it("17. attaches transaction signature to normalized event", () => {
    const inputs: FetchedTransaction[] = [
      {
        signature: "txSig1",
        transaction: makeTx(
          [eventJsonLog("noteDeposited", noteData(C0, 0))],
          100
        ),
      },
    ];
    const result = extractNoteDepositedEventsFromTransactions(inputs);
    expect(result[0].signature).to.equal("txSig1");
  });

  it("18. attaches slot fallback to normalized event when event data has no slot", () => {
    const dataNoSlot: Record<string, unknown> = {
      commitment: C0,
      denomination: "100000000",
      leafIndex: 0,
      depositor: DEPOSITOR,
      // slot deliberately absent
    };
    const inputs: FetchedTransaction[] = [
      {
        signature: "sig1",
        transaction: makeTx([eventJsonLog("noteDeposited", dataNoSlot)], 500),
      },
    ];
    const result = extractNoteDepositedEventsFromTransactions(inputs);
    expect(result[0].slot).to.equal(500n);
  });

  it("19. ignores unrelated logs and non-noteDeposited event names", () => {
    const inputs: FetchedTransaction[] = [
      {
        signature: "sig1",
        transaction: makeTx(
          [
            "Program log: Instruction: DepositNote",
            eventJsonLog("SomeOtherEvent", { foo: "bar" }),
            eventJsonLog("noteDeposited", noteData(C0, 0)),
            "Program log: Program success",
          ],
          100
        ),
      },
    ];
    const result = extractNoteDepositedEventsFromTransactions(inputs);
    expect(result).to.have.length(1);
    expect(result[0].commitment_be_hex).to.equal(C0);
  });

  it("20. preserves unsorted extraction order; does not sort", () => {
    // C1@leaf1 first, C0@leaf0 second
    const inputs: FetchedTransaction[] = [
      {
        signature: "sigC1",
        transaction: makeTx(
          [eventJsonLog("noteDeposited", noteData(C1, 1))],
          100
        ),
      },
      {
        signature: "sigC0",
        transaction: makeTx(
          [eventJsonLog("noteDeposited", noteData(C0, 0))],
          101
        ),
      },
    ];
    const result = extractNoteDepositedEventsFromTransactions(inputs);
    expect(result).to.have.length(2);
    expect(result[0].leaf_index).to.equal(1);
    expect(result[1].leaf_index).to.equal(0);
  });
});

// ── fetchAndExtractNoteDepositedEvents ────────────────────────────────────────

describe("zk_indexer: rpc_adapter — fetchAndExtractNoteDepositedEvents", function () {
  it("21. end-to-end mocked flow: signatures → transactions → EVENT_JSON logs → normalized events", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [{ signature: "sig1" }, { signature: "sig2" }];
      },
      async getTransaction(sig) {
        if (sig === "sig1")
          return makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 100);
        if (sig === "sig2")
          return makeTx([eventJsonLog("noteDeposited", noteData(C1, 1))], 101);
        return null;
      },
    };

    const events = await fetchAndExtractNoteDepositedEvents(conn, "programId");
    expect(events).to.have.length(2);
    expect(events[0].commitment_be_hex).to.equal(C0);
    expect(events[1].commitment_be_hex).to.equal(C1);
  });

  it("22. end-to-end skips null and failed tx by default", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [
          { signature: "nullSig" },
          { signature: "failedSig" },
          { signature: "validSig" },
        ];
      },
      async getTransaction(sig) {
        if (sig === "nullSig") return null;
        if (sig === "failedSig")
          return makeTx([eventJsonLog("noteDeposited", noteData(C1, 1))], 200, {
            InstructionError: [0, "Custom"],
          });
        if (sig === "validSig")
          return makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 201);
        return null;
      },
    };

    const events = await fetchAndExtractNoteDepositedEvents(conn, "programId");
    expect(events).to.have.length(1);
    expect(events[0].commitment_be_hex).to.equal(C0);
  });

  it("23. end-to-end includeFailed=true includes failed tx events", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [{ signature: "failedSig" }, { signature: "validSig" }];
      },
      async getTransaction(sig) {
        if (sig === "failedSig")
          return makeTx([eventJsonLog("noteDeposited", noteData(C1, 1))], 200, {
            InstructionError: [0, "Custom"],
          });
        if (sig === "validSig")
          return makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 201);
        return null;
      },
    };

    const events = await fetchAndExtractNoteDepositedEvents(conn, "programId", {
      includeFailed: true,
    });
    expect(events).to.have.length(2);
  });

  it("24. does not replay or sort; extraction order is preserved as [1, 0]", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [{ signature: "sigC1" }, { signature: "sigC0" }];
      },
      async getTransaction(sig) {
        if (sig === "sigC1")
          return makeTx([eventJsonLog("noteDeposited", noteData(C1, 1))], 100);
        if (sig === "sigC0")
          return makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 101);
        return null;
      },
    };

    const events = await fetchAndExtractNoteDepositedEvents(conn, "programId");
    expect(events).to.have.length(2);
    // C1@leaf1 fetched first — extraction preserves that order
    expect(events[0].leaf_index).to.equal(1);
    expect(events[1].leaf_index).to.equal(0);
  });
});

// ── Integration with existing local pipeline ──────────────────────────────────

describe("zk_indexer: rpc_adapter — integration with existing local pipeline", function () {
  this.timeout(60_000);

  before(async () => {
    await initPoseidon();
  });

  it("25. adapter output feeds sortEventsForReplay + replayNoteDeposits: leaf_count=2, root non-empty", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [{ signature: "sigC1" }, { signature: "sigC0" }];
      },
      async getTransaction(sig) {
        if (sig === "sigC1")
          return makeTx([eventJsonLog("noteDeposited", noteData(C1, 1))], 100);
        if (sig === "sigC0")
          return makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 101);
        return null;
      },
    };

    // Adapter extracts but does not sort or replay
    const events = await fetchAndExtractNoteDepositedEvents(conn, "programId");
    expect(events).to.have.length(2);
    expect(events[0].leaf_index).to.equal(1); // not sorted yet

    // Caller is responsible for sort and replay
    const sorted = sortEventsForReplay(events);
    const tree = new IncrementalMerkleTree();
    const result = replayNoteDeposits(tree, sorted);

    expect(result.inserted).to.equal(2);
    expect(result.leaf_count).to.equal(2);
    expect(result.root_be_hex).to.not.equal(EMPTY_SUBTREES[TREE_DEPTH]);
  });
});
