import { spawnSync } from "child_process";
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ReadOnlyConnectionLike,
  TransactionLike,
} from "../lib/zk_indexer/rpc_adapter";
import { TREE_DEPTH, EMPTY_SUBTREES } from "../lib/zk_indexer/constants";
import {
  parseArgs,
  runRpcIndexer,
  redactRpcUrl,
  RpcIndexerArgs,
  usageText,
  isHelpRequested,
} from "../scripts/zk_indexer_rpc_fetch";

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
    meta: { logMessages, ...(err !== undefined ? { err } : {}) },
  };
}

function tmpFile(tag: string): string {
  return path.join(os.tmpdir(), `zk_rpc_fetch_test_${process.pid}_${tag}.json`);
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

function baseArgs(overrides: Partial<RpcIndexerArgs> = {}): RpcIndexerArgs {
  return {
    rpcUrl: "http://mock",
    address: "mockAddress",
    outputPath: "/dev/null",
    includeFailed: false,
    sort: true,
    dryRun: false,
    decoder: "event-json",
    ...overrides,
  };
}

// ── Anchor EventParser fixtures and helpers ───────────────────────────────────

const ANCHOR_PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";
const ANCHOR_IDL_PATH = path.resolve(
  __dirname,
  "../idl/shielded_pool_anchor.json"
);

// Minimal argv prefix for parseArgs tests.
const PARSE_BASE = [
  "--rpc-url",
  "http://x",
  "--address",
  "addr",
  "--output",
  "out.json",
];

// Minimal argv prefix for parseArgs tests in exact-signature mode.
const PARSE_BASE_SIG = [
  "--rpc-url",
  "http://x",
  "--signature",
  "testSig123",
  "--output",
  "out.json",
];

function makeAnchorLogs(programId: string, ...b64Events: string[]): string[] {
  const logs: string[] = [`Program ${programId} invoke [1]`];
  for (const b64 of b64Events) {
    logs.push(`Program data: ${b64}`);
  }
  logs.push(`Program ${programId} success`);
  return logs;
}

// Build a Borsh-encoded NoteDeposited base64 fixture.
//
// Layout: 8-byte discriminator [27,177,212,105,19,136,143,45]
//       + 32-byte commitment (zeros, last byte = commitment31)
//       + 8-byte denomination u64 LE (100_000_000)
//       + 8-byte leaf_index u64 LE
//       + 32-byte depositor ([2, 0, ..., 0] → "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh")
//       + 8-byte slot u64 LE (100)
function makeFixtureB64(leafIndex: number, commitment31 = 0x11): string {
  const disc = [27, 177, 212, 105, 19, 136, 143, 45];
  const commitment = [...Array(31).fill(0), commitment31];
  const depositor = [2, ...Array(31).fill(0)];
  const buf = Buffer.alloc(96);
  let off = 0;
  for (const b of disc) buf[off++] = b;
  for (const b of commitment) buf[off++] = b;
  buf.writeBigUInt64LE(100_000_000n, off);
  off += 8;
  buf.writeBigUInt64LE(BigInt(leafIndex), off);
  off += 8;
  for (const b of depositor) buf[off++] = b;
  buf.writeBigUInt64LE(100n, off);
  return buf.toString("base64");
}

function anchorArgs(overrides: Partial<RpcIndexerArgs> = {}): RpcIndexerArgs {
  return baseArgs({
    decoder: "anchor-event-parser",
    idlPath: ANCHOR_IDL_PATH,
    programId: ANCHOR_PROGRAM_ID,
    ...overrides,
  });
}

function sigArgs(overrides: Partial<RpcIndexerArgs> = {}): RpcIndexerArgs {
  return {
    rpcUrl: "http://mock",
    signature: "testSignature",
    outputPath: "/dev/null",
    includeFailed: false,
    sort: true,
    dryRun: false,
    decoder: "event-json",
    ...overrides,
  };
}

function anchorSigArgs(
  overrides: Partial<RpcIndexerArgs> = {}
): RpcIndexerArgs {
  return sigArgs({
    decoder: "anchor-event-parser",
    idlPath: ANCHOR_IDL_PATH,
    programId: ANCHOR_PROGRAM_ID,
    ...overrides,
  });
}

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("zk_indexer: rpc_fetch — parseArgs", function () {
  it("1. parses required args and defaults: includeFailed=false, sort=true", () => {
    const args = parseArgs([
      "--rpc-url",
      "https://api.mainnet-beta.solana.com",
      "--address",
      "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe",
      "--output",
      "/tmp/snap.json",
    ]);
    expect(args.rpcUrl).to.equal("https://api.mainnet-beta.solana.com");
    expect(args.address).to.equal(
      "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe"
    );
    expect(args.outputPath).to.equal("/tmp/snap.json");
    expect(args.includeFailed).to.equal(false);
    expect(args.sort).to.equal(true);
    expect(args.limit).to.be.undefined;
    expect(args.before).to.be.undefined;
    expect(args.until).to.be.undefined;
    expect(args.commitment).to.be.undefined;
  });

  it("2. parses --limit, --before, --until, --commitment", () => {
    const args = parseArgs([
      "--rpc-url",
      "http://localhost:8899",
      "--address",
      "addr",
      "--output",
      "out.json",
      "--limit",
      "50",
      "--before",
      "sigBefore",
      "--until",
      "sigUntil",
      "--commitment",
      "finalized",
    ]);
    expect(args.limit).to.equal(50);
    expect(args.before).to.equal("sigBefore");
    expect(args.until).to.equal("sigUntil");
    expect(args.commitment).to.equal("finalized");
  });

  it("3. parses --include-failed", () => {
    const args = parseArgs([
      "--rpc-url",
      "http://x",
      "--address",
      "addr",
      "--output",
      "out.json",
      "--include-failed",
    ]);
    expect(args.includeFailed).to.equal(true);
    expect(args.sort).to.equal(true);
  });

  it("4. parses --no-sort", () => {
    const args = parseArgs([
      "--rpc-url",
      "http://x",
      "--address",
      "addr",
      "--output",
      "out.json",
      "--no-sort",
    ]);
    expect(args.sort).to.equal(false);
    expect(args.includeFailed).to.equal(false);
  });

  it("5. rejects missing --rpc-url", () => {
    let err: Error | undefined;
    try {
      parseArgs(["--address", "addr", "--output", "out.json"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--rpc-url");
  });

  it("6. rejects missing --address", () => {
    let err: Error | undefined;
    try {
      parseArgs(["--rpc-url", "http://x", "--output", "out.json"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--address");
  });

  it("7. rejects missing --output", () => {
    let err: Error | undefined;
    try {
      parseArgs(["--rpc-url", "http://x", "--address", "addr"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--output");
  });

  it("8. rejects invalid --limit values: 0, -1, 1.5, non-number", () => {
    const base = [
      "--rpc-url",
      "http://x",
      "--address",
      "addr",
      "--output",
      "out.json",
    ];
    for (const bad of ["0", "-1", "1.5", "foo"]) {
      let err: Error | undefined;
      try {
        parseArgs([...base, "--limit", bad]);
      } catch (e) {
        err = e as Error;
      }
      expect(err, `limit "${bad}" should throw`).to.exist;
      expect(err!.message).to.include("--limit");
    }
  });

  it("9. rejects unknown flags", () => {
    let err: Error | undefined;
    try {
      parseArgs([
        "--rpc-url",
        "http://x",
        "--address",
        "addr",
        "--output",
        "out.json",
        "--unknown-flag",
      ]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("unknown flag");
  });

  it("10. rejects missing values after valued flags", () => {
    for (const flag of [
      "--rpc-url",
      "--address",
      "--output",
      "--limit",
      "--before",
      "--until",
      "--commitment",
    ]) {
      let err: Error | undefined;
      try {
        parseArgs([flag]);
      } catch (e) {
        err = e as Error;
      }
      expect(err, `${flag} with no following value should throw`).to.exist;
      expect(err!.message).to.include("missing value");
    }
  });

  it("22. default decoder is 'event-json' when --decoder is omitted", () => {
    const args = parseArgs([...PARSE_BASE]);
    expect(args.decoder).to.equal("event-json");
    expect(args.idlPath).to.be.undefined;
    expect(args.programId).to.be.undefined;
  });

  it("23. parses --decoder event-json explicitly", () => {
    const args = parseArgs([...PARSE_BASE, "--decoder", "event-json"]);
    expect(args.decoder).to.equal("event-json");
  });

  it("24. parses --decoder anchor-event-parser with --idl and --program-id", () => {
    const args = parseArgs([
      ...PARSE_BASE,
      "--decoder",
      "anchor-event-parser",
      "--idl",
      "/tmp/foo.json",
      "--program-id",
      ANCHOR_PROGRAM_ID,
    ]);
    expect(args.decoder).to.equal("anchor-event-parser");
    expect(args.idlPath).to.equal("/tmp/foo.json");
    expect(args.programId).to.equal(ANCHOR_PROGRAM_ID);
  });

  it("25. parses --idl into idlPath", () => {
    const args = parseArgs([
      ...PARSE_BASE,
      "--decoder",
      "anchor-event-parser",
      "--idl",
      "/path/to/idl.json",
      "--program-id",
      "somePid",
    ]);
    expect(args.idlPath).to.equal("/path/to/idl.json");
  });

  it("26. parses --program-id into programId", () => {
    const args = parseArgs([
      ...PARSE_BASE,
      "--decoder",
      "anchor-event-parser",
      "--idl",
      "/foo.json",
      "--program-id",
      ANCHOR_PROGRAM_ID,
    ]);
    expect(args.programId).to.equal(ANCHOR_PROGRAM_ID);
  });

  it("27. rejects unknown --decoder value", () => {
    let err: Error | undefined;
    try {
      parseArgs([...PARSE_BASE, "--decoder", "bogus-mode"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--decoder");
  });

  it("28. rejects --decoder anchor-event-parser without --idl", () => {
    let err: Error | undefined;
    try {
      parseArgs([
        ...PARSE_BASE,
        "--decoder",
        "anchor-event-parser",
        "--program-id",
        "pid",
      ]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--idl");
  });

  it("29. rejects --decoder anchor-event-parser without --program-id", () => {
    let err: Error | undefined;
    try {
      parseArgs([
        ...PARSE_BASE,
        "--decoder",
        "anchor-event-parser",
        "--idl",
        "/foo.json",
      ]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--program-id");
  });

  it("30. accepts --decoder event-json without --idl or --program-id", () => {
    const args = parseArgs([...PARSE_BASE, "--decoder", "event-json"]);
    expect(args.decoder).to.equal("event-json");
    expect(args.idlPath).to.be.undefined;
    expect(args.programId).to.be.undefined;
  });

  it("41. --dry-run parses as dryRun=true", () => {
    const args = parseArgs([...PARSE_BASE, "--dry-run"]);
    expect(args.dryRun).to.equal(true);
  });

  it("42. default dryRun is false when --dry-run is omitted", () => {
    const args = parseArgs([...PARSE_BASE]);
    expect(args.dryRun).to.equal(false);
  });

  it("43. --dry-run works with --decoder event-json", () => {
    const args = parseArgs([
      ...PARSE_BASE,
      "--dry-run",
      "--decoder",
      "event-json",
    ]);
    expect(args.dryRun).to.equal(true);
    expect(args.decoder).to.equal("event-json");
  });

  it("44. --dry-run works with --decoder anchor-event-parser", () => {
    const args = parseArgs([
      ...PARSE_BASE,
      "--dry-run",
      "--decoder",
      "anchor-event-parser",
      "--idl",
      "/foo.json",
      "--program-id",
      ANCHOR_PROGRAM_ID,
    ]);
    expect(args.dryRun).to.equal(true);
    expect(args.decoder).to.equal("anchor-event-parser");
  });

  it("45. --dry-run still requires --output", () => {
    let err: Error | undefined;
    try {
      parseArgs(["--rpc-url", "http://x", "--address", "addr", "--dry-run"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--output");
  });

  it("55. usageText() contains CLI name, --dry-run, --decoder anchor-event-parser, --idl, --program-id", () => {
    const text = usageText();
    expect(text).to.include("zk_indexer_rpc_fetch");
    expect(text).to.include("--dry-run");
    expect(text).to.include("--decoder anchor-event-parser");
    expect(text).to.include("--idl");
    expect(text).to.include("--program-id");
  });

  it("56. usageText() contains safety claims: No transactions, No roots", () => {
    const text = usageText();
    expect(text).to.include("No transactions");
    expect(text).to.include("No roots");
  });

  it("57. isHelpRequested returns true for --help and -h", () => {
    expect(isHelpRequested(["--help"])).to.equal(true);
    expect(isHelpRequested(["-h"])).to.equal(true);
    expect(isHelpRequested(["--help", "--rpc-url", "http://x"])).to.equal(true);
  });

  it("58. isHelpRequested returns false for normal args and empty argv", () => {
    expect(isHelpRequested([])).to.equal(false);
    expect(isHelpRequested([...PARSE_BASE])).to.equal(false);
    expect(isHelpRequested(["--rpc-url", "http://x", "--dry-run"])).to.equal(
      false
    );
  });

  // ── --signature mode ──────────────────────────────────────────────────────

  it("61. --signature <sig> accepted; sets args.signature, args.address undefined", () => {
    const args = parseArgs([...PARSE_BASE_SIG]);
    expect(args.signature).to.equal("testSig123");
    expect(args.address).to.be.undefined;
    expect(args.rpcUrl).to.equal("http://x");
    expect(args.outputPath).to.equal("out.json");
  });

  it("62. --signature missing value rejects with 'missing value'", () => {
    let err: Error | undefined;
    try {
      parseArgs(["--rpc-url", "http://x", "--signature", "--output", "o.json"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("missing value");
  });

  it("63. --signature + --address rejects", () => {
    let err: Error | undefined;
    try {
      parseArgs([...PARSE_BASE_SIG, "--address", "someaddr"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--address");
    expect(err!.message).to.include("--signature");
  });

  it("64. --signature + --limit rejects", () => {
    let err: Error | undefined;
    try {
      parseArgs([...PARSE_BASE_SIG, "--limit", "10"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--limit");
    expect(err!.message).to.include("--signature");
  });

  it("65. --signature + --before rejects", () => {
    let err: Error | undefined;
    try {
      parseArgs([...PARSE_BASE_SIG, "--before", "somesig"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--before");
    expect(err!.message).to.include("--signature");
  });

  it("66. --signature + --until rejects", () => {
    let err: Error | undefined;
    try {
      parseArgs([...PARSE_BASE_SIG, "--until", "somesig"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--until");
    expect(err!.message).to.include("--signature");
  });

  it("67. --signature does not require --address", () => {
    expect(() => parseArgs([...PARSE_BASE_SIG])).to.not.throw();
    const args = parseArgs([...PARSE_BASE_SIG]);
    expect(args.address).to.be.undefined;
    expect(args.signature).to.equal("testSig123");
  });

  it("68. address mode still requires --address when --signature is absent", () => {
    let err: Error | undefined;
    try {
      parseArgs(["--rpc-url", "http://x", "--output", "out.json"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--address");
  });

  it("76. usageText() contains --signature, 'signature mode', and mutual exclusivity note", () => {
    const text = usageText();
    expect(text).to.include("--signature");
    expect(text).to.include("signature mode");
    expect(text).to.include("--address");
  });
});

// ── runRpcIndexer ─────────────────────────────────────────────────────────────

describe("zk_indexer: rpc_fetch — runRpcIndexer", function () {
  this.timeout(60_000);

  function mockConn(
    txMap: Record<string, TransactionLike | null>
  ): ReadOnlyConnectionLike {
    return {
      async getSignaturesForAddress() {
        return Object.keys(txMap).map((sig) => ({ signature: sig }));
      },
      async getTransaction(sig) {
        return txMap[sig] ?? null;
      },
    };
  }

  it("11. happy path: two EVENT_JSON transactions → extracted=2, leaf_count=2, root non-empty", async () => {
    const outPath = tmpFile("t11");
    try {
      const conn = mockConn({
        sig0: makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 100),
        sig1: makeTx([eventJsonLog("noteDeposited", noteData(C1, 1))], 101),
      });
      const result = await runRpcIndexer(baseArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      expect(result.extracted).to.equal(2);
      expect(result.leaf_count).to.equal(2);
      expect(result.root_be_hex).to.not.equal("");
      expect(result.root_be_hex).to.not.equal(EMPTY_SUBTREES[TREE_DEPTH]);
    } finally {
      cleanup(outPath);
    }
  });

  it("12. snapshot has version=2, tree_depth=20, events length=2, last_root_be_hex matches result, meta present", async () => {
    const outPath = tmpFile("t12");
    try {
      const conn = mockConn({
        sig0: makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 100),
        sig1: makeTx([eventJsonLog("noteDeposited", noteData(C1, 1))], 101),
      });
      const result = await runRpcIndexer(baseArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      const snapshot = JSON.parse(fs.readFileSync(outPath, "utf-8"));
      expect(snapshot.version).to.equal(2);
      expect(snapshot.tree_depth).to.equal(TREE_DEPTH);
      expect(snapshot.events).to.have.length(2);
      expect(snapshot.last_root_be_hex).to.equal(result.root_be_hex);
      expect(snapshot.meta).to.exist;
      expect(snapshot.meta.source_mode).to.equal("address");
    } finally {
      cleanup(outPath);
    }
  });

  it("13. sort=true corrects out-of-order events [leaf1, leaf0] → snapshot events[0].leaf_index=0", async () => {
    const outPath = tmpFile("t13");
    try {
      // Connection returns leaf1 before leaf0 — intentionally out of order
      const conn = mockConn({
        sig1: makeTx([eventJsonLog("noteDeposited", noteData(C1, 1))], 100),
        sig0: makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 101),
      });
      const result = await runRpcIndexer(
        baseArgs({ outputPath: outPath, sort: true }),
        { connection: conn, address: "mockAddress" }
      );
      expect(result.sorted).to.equal(true);
      expect(result.extracted).to.equal(2);
      expect(result.leaf_count).to.equal(2);
      const snapshot = JSON.parse(fs.readFileSync(outPath, "utf-8"));
      expect(snapshot.events[0].leaf_index).to.equal(0);
      expect(snapshot.events[1].leaf_index).to.equal(1);
    } finally {
      cleanup(outPath);
    }
  });

  it("14. sort=false rejects out-of-order events with expectedLeafIndex error", async () => {
    const outPath = tmpFile("t14");
    try {
      const conn = mockConn({
        sig1: makeTx([eventJsonLog("noteDeposited", noteData(C1, 1))], 100),
        sig0: makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 101),
      });
      let err: Error | undefined;
      try {
        await runRpcIndexer(baseArgs({ outputPath: outPath, sort: false }), {
          connection: conn,
          address: "mockAddress",
        });
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.exist;
      expect(err!.message).to.include("expectedLeafIndex");
    } finally {
      cleanup(outPath);
    }
  });

  it("15. includeFailed=false skips failed transactions by default", async () => {
    const outPath = tmpFile("t15");
    try {
      const conn: ReadOnlyConnectionLike = {
        async getSignaturesForAddress() {
          return [{ signature: "failSig" }, { signature: "okSig" }];
        },
        async getTransaction(sig) {
          if (sig === "failSig")
            return makeTx(
              [eventJsonLog("noteDeposited", noteData(C1, 1))],
              100,
              { err: "Custom" }
            );
          return makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 101);
        },
      };
      const result = await runRpcIndexer(
        baseArgs({ outputPath: outPath, includeFailed: false }),
        { connection: conn, address: "mockAddress" }
      );
      expect(result.extracted).to.equal(1);
      expect(result.leaf_count).to.equal(1);
    } finally {
      cleanup(outPath);
    }
  });

  it("16. includeFailed=true includes failed transactions", async () => {
    const outPath = tmpFile("t16");
    try {
      const conn: ReadOnlyConnectionLike = {
        async getSignaturesForAddress() {
          return [{ signature: "sig0" }, { signature: "sig1" }];
        },
        async getTransaction(sig) {
          if (sig === "sig0")
            return makeTx(
              [eventJsonLog("noteDeposited", noteData(C0, 0))],
              100,
              { err: "Custom" }
            );
          return makeTx([eventJsonLog("noteDeposited", noteData(C1, 1))], 101);
        },
      };
      const result = await runRpcIndexer(
        baseArgs({ outputPath: outPath, includeFailed: true }),
        { connection: conn, address: "mockAddress" }
      );
      expect(result.extracted).to.equal(2);
    } finally {
      cleanup(outPath);
    }
  });

  it("17. null transaction is skipped", async () => {
    const outPath = tmpFile("t17");
    try {
      const conn: ReadOnlyConnectionLike = {
        async getSignaturesForAddress() {
          return [{ signature: "nullSig" }, { signature: "okSig" }];
        },
        async getTransaction(sig) {
          if (sig === "nullSig") return null;
          return makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 100);
        },
      };
      const result = await runRpcIndexer(baseArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      expect(result.extracted).to.equal(1);
    } finally {
      cleanup(outPath);
    }
  });

  it("18. no matching events: leaf_count=0, root equals empty subtree root", async () => {
    const outPath = tmpFile("t18");
    try {
      const conn: ReadOnlyConnectionLike = {
        async getSignaturesForAddress() {
          return [];
        },
        async getTransaction() {
          return null;
        },
      };
      const result = await runRpcIndexer(baseArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      expect(result.extracted).to.equal(0);
      expect(result.leaf_count).to.equal(0);
      const snapshot = JSON.parse(fs.readFileSync(outPath, "utf-8"));
      expect(snapshot.events).to.have.length(0);
      expect(snapshot.last_root_be_hex).to.equal(EMPTY_SUBTREES[TREE_DEPTH]);
    } finally {
      cleanup(outPath);
    }
  });

  it("19. preserves outputPath in result", async () => {
    const outPath = tmpFile("t19");
    try {
      const conn: ReadOnlyConnectionLike = {
        async getSignaturesForAddress() {
          return [];
        },
        async getTransaction() {
          return null;
        },
      };
      const result = await runRpcIndexer(baseArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      expect(result.outputPath).to.equal(outPath);
    } finally {
      cleanup(outPath);
    }
  });

  it("20. uses mock connection: getSignaturesForAddress and getTransaction are called; no real RPC", async () => {
    const outPath = tmpFile("t20");
    let getSignaturesCalled = false;
    let getTransactionCalled = false;
    try {
      const conn: ReadOnlyConnectionLike = {
        async getSignaturesForAddress() {
          getSignaturesCalled = true;
          return [{ signature: "sig0" }];
        },
        async getTransaction() {
          getTransactionCalled = true;
          return makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 100);
        },
      };
      await runRpcIndexer(baseArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      expect(getSignaturesCalled).to.be.true;
      expect(getTransactionCalled).to.be.true;
    } finally {
      cleanup(outPath);
    }
  });

  // ── anchor-event-parser mode ──────────────────────────────────────────────

  it("31. anchor-event-parser: one mocked tx with NoteDeposited log writes snapshot with one event", async () => {
    const outPath = tmpFile("t31");
    const conn = mockConn({
      sig0: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)), 100),
    });
    try {
      const result = await runRpcIndexer(anchorArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      expect(result.extracted).to.equal(1);
      expect(result.leaf_count).to.equal(1);
      const snapshot = JSON.parse(fs.readFileSync(outPath, "utf-8"));
      expect(snapshot.events).to.have.length(1);
    } finally {
      cleanup(outPath);
    }
  });

  it("32. anchor-event-parser: two mocked txs write two normalized events", async () => {
    const outPath = tmpFile("t32");
    const conn = mockConn({
      sig0: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)), 100),
      sig1: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(1)), 101),
    });
    try {
      const result = await runRpcIndexer(anchorArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      expect(result.extracted).to.equal(2);
      expect(result.leaf_count).to.equal(2);
    } finally {
      cleanup(outPath);
    }
  });

  it("33. anchor-event-parser: decoded fields match expected commitment, denomination, leaf_index, depositor, slot", async () => {
    const outPath = tmpFile("t33");
    const conn = mockConn({
      sig0: makeTx(
        makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0, 0x11)),
        100
      ),
    });
    try {
      await runRpcIndexer(anchorArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      const snapshot = JSON.parse(fs.readFileSync(outPath, "utf-8"));
      const ev = snapshot.events[0];
      expect(ev.commitment_be_hex).to.equal(
        "0000000000000000000000000000000000000000000000000000000000000011"
      );
      expect(ev.denomination).to.equal("100000000");
      expect(ev.leaf_index).to.equal(0);
      expect(ev.depositor).to.equal(
        "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh"
      );
      expect(ev.slot).to.equal("100");
      expect(ev.signature).to.equal("sig0");
    } finally {
      cleanup(outPath);
    }
  });

  it("34. anchor-event-parser: ignores logs from a different program", async () => {
    const outPath = tmpFile("t34");
    const otherProgram = "11111111111111111111111111111111";
    const conn = mockConn({
      sig0: makeTx(makeAnchorLogs(otherProgram, makeFixtureB64(0)), 100),
    });
    try {
      const result = await runRpcIndexer(anchorArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      expect(result.extracted).to.equal(0);
      expect(result.leaf_count).to.equal(0);
    } finally {
      cleanup(outPath);
    }
  });

  it("35. anchor-event-parser: invalid IDL path throws error containing 'cannot read IDL file'", async () => {
    const conn = mockConn({});
    let err: Error | undefined;
    try {
      await runRpcIndexer(
        anchorArgs({
          outputPath: tmpFile("t35"),
          idlPath: "/nonexistent/path/to/idl.json",
        }),
        { connection: conn, address: "mockAddress" }
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("cannot read IDL file");
  });

  it("36. anchor-event-parser: invalid JSON IDL throws error containing 'invalid IDL JSON'", async () => {
    const badIdlPath = tmpFile("bad_idl_t36");
    fs.writeFileSync(badIdlPath, "{ not valid json }", "utf-8");
    const conn = mockConn({});
    let err: Error | undefined;
    try {
      await runRpcIndexer(
        anchorArgs({ outputPath: tmpFile("t36"), idlPath: badIdlPath }),
        { connection: conn, address: "mockAddress" }
      );
    } catch (e) {
      err = e as Error;
    } finally {
      cleanup(badIdlPath);
    }
    expect(err).to.exist;
    expect(err!.message).to.include("invalid IDL JSON");
  });

  it("37. anchor-event-parser: sort=true sorts out-of-order decoded events before snapshot", async () => {
    const outPath = tmpFile("t37");
    // Connection returns leaf_index=1 before leaf_index=0 — intentionally reversed
    const conn = mockConn({
      sigA: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(1)), 100),
      sigB: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)), 101),
    });
    try {
      const result = await runRpcIndexer(
        anchorArgs({ outputPath: outPath, sort: true }),
        { connection: conn, address: "mockAddress" }
      );
      expect(result.sorted).to.equal(true);
      expect(result.extracted).to.equal(2);
      expect(result.leaf_count).to.equal(2);
      const snapshot = JSON.parse(fs.readFileSync(outPath, "utf-8"));
      expect(snapshot.events[0].leaf_index).to.equal(0);
      expect(snapshot.events[1].leaf_index).to.equal(1);
    } finally {
      cleanup(outPath);
    }
  });

  it("38. anchor-event-parser: sort=false rejects out-of-order decoded events with expectedLeafIndex error", async () => {
    const outPath = tmpFile("t38");
    // leaf_index=1 arrives before leaf_index=0; sort=false preserves that order
    const conn = mockConn({
      sigA: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(1)), 100),
      sigB: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)), 101),
    });
    let err: Error | undefined;
    try {
      await runRpcIndexer(anchorArgs({ outputPath: outPath, sort: false }), {
        connection: conn,
        address: "mockAddress",
      });
    } catch (e) {
      err = e as Error;
    } finally {
      cleanup(outPath);
    }
    expect(err).to.exist;
    expect(err!.message).to.include("expectedLeafIndex");
  });

  // ── Direct-call guards ────────────────────────────────────────────────────

  it("39. direct-call guard: anchor-event-parser without idlPath throws error containing 'idlPath'", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };
    let err: Error | undefined;
    try {
      await runRpcIndexer(
        baseArgs({
          decoder: "anchor-event-parser",
          programId: ANCHOR_PROGRAM_ID,
        }),
        { connection: conn, address: "mockAddress" }
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("idlPath");
  });

  it("40. direct-call guard: anchor-event-parser without programId throws error containing 'programId'", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };
    let err: Error | undefined;
    try {
      await runRpcIndexer(
        baseArgs({ decoder: "anchor-event-parser", idlPath: ANCHOR_IDL_PATH }),
        { connection: conn, address: "mockAddress" }
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("programId");
  });

  // ── dry-run / post-write verification ────────────────────────────────────

  it("46. normal write returns wroteSnapshot=true, verifiedSnapshot=true, dryRun=false", async () => {
    const outPath = tmpFile("t46");
    try {
      const conn: ReadOnlyConnectionLike = {
        async getSignaturesForAddress() {
          return [];
        },
        async getTransaction() {
          return null;
        },
      };
      const result = await runRpcIndexer(baseArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      expect(result.dryRun).to.equal(false);
      expect(result.wroteSnapshot).to.equal(true);
      expect(result.verifiedSnapshot).to.equal(true);
      expect(fs.existsSync(outPath)).to.equal(true);
    } finally {
      cleanup(outPath);
    }
  });

  it("47. dry-run does not create output file and returns wroteSnapshot=false", async () => {
    const outPath = tmpFile("t47");
    try {
      const conn = mockConn({
        sig0: makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 100),
      });
      const result = await runRpcIndexer(
        baseArgs({ outputPath: outPath, dryRun: true }),
        { connection: conn, address: "mockAddress" }
      );
      expect(result.dryRun).to.equal(true);
      expect(result.wroteSnapshot).to.equal(false);
      expect(result.verifiedSnapshot).to.equal(false);
      expect(result.extracted).to.equal(1);
      expect(result.leaf_count).to.equal(1);
      expect(fs.existsSync(outPath)).to.equal(false);
    } finally {
      cleanup(outPath);
    }
  });

  it("48. dry-run with zero events returns empty root, does not create file", async () => {
    const outPath = tmpFile("t48");
    try {
      const conn: ReadOnlyConnectionLike = {
        async getSignaturesForAddress() {
          return [];
        },
        async getTransaction() {
          return null;
        },
      };
      const result = await runRpcIndexer(
        baseArgs({ outputPath: outPath, dryRun: true }),
        { connection: conn, address: "mockAddress" }
      );
      expect(result.extracted).to.equal(0);
      expect(result.leaf_count).to.equal(0);
      expect(result.root_be_hex).to.equal(EMPTY_SUBTREES[TREE_DEPTH]);
      expect(result.wroteSnapshot).to.equal(false);
      expect(fs.existsSync(outPath)).to.equal(false);
    } finally {
      cleanup(outPath);
    }
  });

  it("49. dry-run sort=false still rejects out-of-order events with expectedLeafIndex", async () => {
    const outPath = tmpFile("t49");
    const conn = mockConn({
      sig1: makeTx([eventJsonLog("noteDeposited", noteData(C1, 1))], 100),
      sig0: makeTx([eventJsonLog("noteDeposited", noteData(C0, 0))], 101),
    });
    let err: Error | undefined;
    try {
      await runRpcIndexer(
        baseArgs({ outputPath: outPath, sort: false, dryRun: true }),
        { connection: conn, address: "mockAddress" }
      );
    } catch (e) {
      err = e as Error;
    } finally {
      cleanup(outPath);
    }
    expect(err).to.exist;
    expect(err!.message).to.include("expectedLeafIndex");
    expect(fs.existsSync(outPath)).to.equal(false);
  });

  it("50. write to path in non-existent directory throws clear error containing 'snapshot'", async () => {
    const badPath = `/tmp/zk_test_nodir_${process.pid}_t50/snap.json`;
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };
    let err: Error | undefined;
    try {
      await runRpcIndexer(baseArgs({ outputPath: badPath }), {
        connection: conn,
        address: "mockAddress",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("snapshot");
  });

  it("51. anchor-event-parser dry-run decodes fixture and does not create file", async () => {
    const outPath = tmpFile("t51");
    const conn = mockConn({
      sig0: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)), 100),
    });
    try {
      const result = await runRpcIndexer(
        anchorArgs({ outputPath: outPath, dryRun: true }),
        { connection: conn, address: "mockAddress" }
      );
      expect(result.extracted).to.equal(1);
      expect(result.leaf_count).to.equal(1);
      expect(result.dryRun).to.equal(true);
      expect(result.wroteSnapshot).to.equal(false);
      expect(fs.existsSync(outPath)).to.equal(false);
    } finally {
      cleanup(outPath);
    }
  });

  it("52. anchor-event-parser normal write verifies snapshot after reload", async () => {
    const outPath = tmpFile("t52");
    const conn = mockConn({
      sig0: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)), 100),
      sig1: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(1)), 101),
    });
    try {
      const result = await runRpcIndexer(anchorArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      expect(result.wroteSnapshot).to.equal(true);
      expect(result.verifiedSnapshot).to.equal(true);
      expect(result.extracted).to.equal(2);
    } finally {
      cleanup(outPath);
    }
  });

  it("53. anchor-event-parser dry-run sort=true succeeds with out-of-order events, no file created", async () => {
    const outPath = tmpFile("t53");
    const conn = mockConn({
      sigA: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(1)), 100),
      sigB: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)), 101),
    });
    try {
      const result = await runRpcIndexer(
        anchorArgs({ outputPath: outPath, sort: true, dryRun: true }),
        { connection: conn, address: "mockAddress" }
      );
      expect(result.extracted).to.equal(2);
      expect(result.leaf_count).to.equal(2);
      expect(result.dryRun).to.equal(true);
      expect(result.wroteSnapshot).to.equal(false);
      expect(fs.existsSync(outPath)).to.equal(false);
    } finally {
      cleanup(outPath);
    }
  });

  it("54. anchor-event-parser dry-run sort=false rejects out-of-order events with expectedLeafIndex", async () => {
    const outPath = tmpFile("t54");
    const conn = mockConn({
      sigA: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(1)), 100),
      sigB: makeTx(makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)), 101),
    });
    let err: Error | undefined;
    try {
      await runRpcIndexer(
        anchorArgs({ outputPath: outPath, sort: false, dryRun: true }),
        { connection: conn, address: "mockAddress" }
      );
    } catch (e) {
      err = e as Error;
    } finally {
      cleanup(outPath);
    }
    expect(err).to.exist;
    expect(err!.message).to.include("expectedLeafIndex");
    expect(fs.existsSync(outPath)).to.equal(false);
  });

  // ── exact-signature mode ──────────────────────────────────────────────────

  it("69. exact-signature: getTransaction called once with exact sig; getSignaturesForAddress never called", async () => {
    const getTransactionCalls: string[] = [];
    let getSignaturesCalled = false;
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        getSignaturesCalled = true;
        return [];
      },
      async getTransaction(sig) {
        getTransactionCalls.push(sig);
        return makeTx([], 200);
      },
    };
    await runRpcIndexer(sigArgs({ outputPath: "/dev/null", dryRun: true }), {
      connection: conn,
    });
    expect(getSignaturesCalled).to.equal(false);
    expect(getTransactionCalls).to.deep.equal(["testSignature"]);
  });

  it("70. exact-signature anchor-event-parser: decodes one fixture event → extracted=1, leaf_count=1", async () => {
    const outPath = tmpFile("t70");
    const THE_SIG = "knownDepositSig";
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction(sig) {
        if (sig === THE_SIG)
          return makeTx(
            makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)),
            300
          );
        return null;
      },
    };
    try {
      const result = await runRpcIndexer(
        anchorSigArgs({ signature: THE_SIG, outputPath: outPath }),
        { connection: conn }
      );
      expect(result.extracted).to.equal(1);
      expect(result.leaf_count).to.equal(1);
      expect(result.wroteSnapshot).to.equal(true);
      expect(result.verifiedSnapshot).to.equal(true);
    } finally {
      cleanup(outPath);
    }
  });

  it("71. exact-signature dry-run: wroteSnapshot=false, verifiedSnapshot=false, no file created", async () => {
    const outPath = tmpFile("t71");
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return makeTx(
          makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)),
          300
        );
      },
    };
    try {
      const result = await runRpcIndexer(
        anchorSigArgs({ outputPath: outPath, dryRun: true }),
        { connection: conn }
      );
      expect(result.extracted).to.equal(1);
      expect(result.dryRun).to.equal(true);
      expect(result.wroteSnapshot).to.equal(false);
      expect(result.verifiedSnapshot).to.equal(false);
      expect(fs.existsSync(outPath)).to.equal(false);
    } finally {
      cleanup(outPath);
    }
  });

  it("72. exact-signature normal write: wroteSnapshot=true, verifiedSnapshot=true", async () => {
    const outPath = tmpFile("t72");
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return makeTx(
          makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)),
          300
        );
      },
    };
    try {
      const result = await runRpcIndexer(
        anchorSigArgs({ outputPath: outPath }),
        { connection: conn }
      );
      expect(result.wroteSnapshot).to.equal(true);
      expect(result.verifiedSnapshot).to.equal(true);
      expect(fs.existsSync(outPath)).to.equal(true);
    } finally {
      cleanup(outPath);
    }
  });

  it("73. exact-signature: transaction not found throws error containing the signature", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };
    let err: Error | undefined;
    try {
      await runRpcIndexer(
        sigArgs({ outputPath: tmpFile("t73"), dryRun: true }),
        { connection: conn }
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("testSignature");
    expect(err!.message).to.include("not found");
  });

  it("74. exact-signature: failed tx with includeFailed=false → extracted=0", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return makeTx(
          makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)),
          300,
          { err: "Custom" }
        );
      },
    };
    const result = await runRpcIndexer(
      anchorSigArgs({
        outputPath: "/dev/null",
        dryRun: true,
        includeFailed: false,
      }),
      { connection: conn }
    );
    expect(result.extracted).to.equal(0);
  });

  it("75. exact-signature: failed tx with includeFailed=true → extracted=1", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return makeTx(
          makeAnchorLogs(ANCHOR_PROGRAM_ID, makeFixtureB64(0)),
          300,
          { err: "Custom" }
        );
      },
    };
    const result = await runRpcIndexer(
      anchorSigArgs({
        outputPath: "/dev/null",
        dryRun: true,
        includeFailed: true,
      }),
      { connection: conn }
    );
    expect(result.extracted).to.equal(1);
  });

  it("77. address mode: missing deps.address throws clear error", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };
    let err: Error | undefined;
    try {
      await runRpcIndexer(
        {
          rpcUrl: "http://mock",
          address: "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o",
          outputPath: "/dev/null",
          dryRun: true,
          sort: true,
          includeFailed: false,
          decoder: "event-json",
        },
        { connection: conn }
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("address dependency is required");
  });

  // ── fetch provenance metadata ─────────────────────────────────────────────

  it("78. address mode: result.meta.source_mode equals 'address'", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };
    const result = await runRpcIndexer(
      baseArgs({ dryRun: true, outputPath: "/dev/null" }),
      { connection: conn, address: "mockAddress" }
    );
    expect(result.meta.source_mode).to.equal("address");
  });

  it("79. exact-signature mode: result.meta.source_mode equals 'exact-signature'", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return makeTx([], 100);
      },
    };
    const result = await runRpcIndexer(
      sigArgs({ dryRun: true, outputPath: "/dev/null" }),
      { connection: conn }
    );
    expect(result.meta.source_mode).to.equal("exact-signature");
  });

  it("80. commitment provided: result.meta.fetch_commitment matches supplied value", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };
    const result = await runRpcIndexer(
      baseArgs({
        dryRun: true,
        outputPath: "/dev/null",
        commitment: "confirmed",
      }),
      { connection: conn, address: "mockAddress" }
    );
    expect(result.meta.fetch_commitment).to.equal("confirmed");
  });

  it("81. no commitment: result.meta.fetch_commitment is undefined", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };
    const result = await runRpcIndexer(
      baseArgs({ dryRun: true, outputPath: "/dev/null" }),
      { connection: conn, address: "mockAddress" }
    );
    expect(result.meta.fetch_commitment).to.be.undefined;
  });

  it("82. redactRpcUrl strips query string from provider URL", () => {
    expect(redactRpcUrl("https://rpc.example.com/?api-key=abc123")).to.equal(
      "https://rpc.example.com/"
    );
  });

  it("83. redactRpcUrl preserves plain URL (accepts trailing slash from URL constructor)", () => {
    const result = redactRpcUrl("https://api.devnet.solana.com");
    expect(result).to.equal("https://api.devnet.solana.com/");
  });

  it("84. program_id recorded in meta when programId is in args", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };
    const result = await runRpcIndexer(
      anchorArgs({ dryRun: true, outputPath: "/dev/null" }),
      { connection: conn, address: "mockAddress" }
    );
    expect(result.meta.program_id).to.equal(ANCHOR_PROGRAM_ID);
  });

  it("85. address mode: meta.address set to args.address, meta.signature undefined", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };
    const result = await runRpcIndexer(
      baseArgs({
        dryRun: true,
        outputPath: "/dev/null",
        address: "mockAddress",
      }),
      { connection: conn, address: "mockAddress" }
    );
    expect(result.meta.address).to.equal("mockAddress");
    expect(result.meta.signature).to.be.undefined;
  });

  it("86. exact-signature mode: meta.signature set to args.signature, meta.address undefined", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return makeTx([], 100);
      },
    };
    const result = await runRpcIndexer(
      sigArgs({
        dryRun: true,
        outputPath: "/dev/null",
        signature: "testSignature",
      }),
      { connection: conn }
    );
    expect(result.meta.signature).to.equal("testSignature");
    expect(result.meta.address).to.be.undefined;
  });

  it("87. created_at is ISO 8601 format", async () => {
    const conn: ReadOnlyConnectionLike = {
      async getSignaturesForAddress() {
        return [];
      },
      async getTransaction() {
        return null;
      },
    };
    const result = await runRpcIndexer(
      baseArgs({ dryRun: true, outputPath: "/dev/null" }),
      { connection: conn, address: "mockAddress" }
    );
    expect(result.meta.created_at).to.match(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });

  it("88. dry-run: result.meta accessible with correct source_mode; no output file created", async () => {
    const outPath = tmpFile("t88");
    try {
      const conn: ReadOnlyConnectionLike = {
        async getSignaturesForAddress() {
          return [];
        },
        async getTransaction() {
          return null;
        },
      };
      const result = await runRpcIndexer(
        baseArgs({ dryRun: true, outputPath: outPath }),
        { connection: conn, address: "mockAddress" }
      );
      expect(result.meta.source_mode).to.equal("address");
      expect(result.wroteSnapshot).to.equal(false);
      expect(fs.existsSync(outPath)).to.equal(false);
    } finally {
      cleanup(outPath);
    }
  });

  it("89. write mode: written snapshot file is version 2 with meta field", async () => {
    const outPath = tmpFile("t89");
    try {
      const conn: ReadOnlyConnectionLike = {
        async getSignaturesForAddress() {
          return [];
        },
        async getTransaction() {
          return null;
        },
      };
      await runRpcIndexer(baseArgs({ outputPath: outPath }), {
        connection: conn,
        address: "mockAddress",
      });
      const parsed = JSON.parse(fs.readFileSync(outPath, "utf-8"));
      expect(parsed.version).to.equal(2);
      expect(parsed.meta).to.exist;
      expect(parsed.meta.source_mode).to.equal("address");
    } finally {
      cleanup(outPath);
    }
  });
});

// ── CLI entry guard ───────────────────────────────────────────────────────────

describe("zk_indexer: rpc_fetch — CLI entry guard", function () {
  it("21. importing the script does not execute CLI main (require.main !== script module)", () => {
    const scriptPath = require.resolve("../scripts/zk_indexer_rpc_fetch");
    const scriptModule = require.cache[scriptPath];
    // If the CLI main had run, process.exit(1) would have killed this process
    // before reaching this assertion. Reaching here confirms the guard worked.
    expect(require.main).to.not.equal(scriptModule);
  });
});

// ── CLI subprocess smoke ──────────────────────────────────────────────────────

describe("zk_indexer: rpc_fetch — CLI subprocess smoke", function () {
  this.timeout(60_000);

  const REPO_ROOT = path.resolve(__dirname, "..");

  it("59. --help exits 0 with usage text; does not fail on missing required flags", () => {
    const result = spawnSync(
      "npx",
      ["ts-node", "scripts/zk_indexer_rpc_fetch.ts", "--help"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 }
    );
    expect(result.status).to.equal(0);
    const out = result.stdout ?? "";
    expect(out).to.include("Usage:");
    expect(out).to.include("zk_indexer_rpc_fetch.ts");
    expect(out).to.include("--dry-run");
    expect(out).to.include("anchor-event-parser");
    expect(out).to.include("No transactions");
    expect(out).to.include("No roots");
    const err = result.stderr ?? "";
    expect(err).to.not.include("--rpc-url is required");
    expect(err).to.not.include("--address is required");
    expect(err).to.not.include("--output is required");
  });

  it("60. -h exits 0 with usage text containing --help, -h flag entry", () => {
    const result = spawnSync(
      "npx",
      ["ts-node", "scripts/zk_indexer_rpc_fetch.ts", "-h"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 }
    );
    expect(result.status).to.equal(0);
    const out = result.stdout ?? "";
    expect(out).to.include("Usage:");
    expect(out).to.include("--help, -h");
  });
});
