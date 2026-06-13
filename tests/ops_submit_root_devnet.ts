import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  PROGRAM_ID,
  MAX_ROOTS,
  SubmitRootArgs,
  SubmitRootDeps,
  parseArgs,
  parseSnapshotFile,
  validateRootHex,
  validateIdlAddress,
  deriveConfigPda,
  runSubmitRoot,
  helpText,
  buildSubmitHint,
} from "../scripts/ops/submit_root_devnet";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import {
  buildSnapshot,
  SnapshotFetchMeta,
} from "../lib/zk_indexer/persistence";
import { normalizeNoteDepositedEvent } from "../lib/zk_indexer/event_log";

// ── Test constants ────────────────────────────────────────────────────────────

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "ops",
  "submit_root_devnet.ts"
);

const REPO_ROOT = path.join(__dirname, "..");

function runCli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(
    process.execPath,
    ["-r", "ts-node/register/transpile-only", SCRIPT_PATH, ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1" },
      timeout: 55000,
    }
  );
  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

// Known positive smoke root produced by deposit of SMOKE_COMMITMENT at leaf 0.
const KNOWN_ROOT =
  "2a065f5ccc90a22c2d5789d4ec9c65dc0189c18c43c785d3ac54fd00e93f8dd3";

const SMOKE_COMMITMENT_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const ADMIN_PUBKEY = new PublicKey(
  "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o"
);
const OTHER_PUBKEY = new PublicKey("11111111111111111111111111111111");
// Distinct pubkey used as root_submitter_authority in authority-separation tests.
const ROOT_SUBMITTER_PUBKEY = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpPath(tag: string): string {
  return path.join(os.tmpdir(), `submit_root_test_${tag}_${Date.now()}.json`);
}

function writeJson(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

// Minimal snapshot JSON that passes parseSnapshotFile basic checks.
// Does NOT require initPoseidon (no tree replay).
function minimalValidSnapshot(root = KNOWN_ROOT): object {
  return {
    version: 1,
    tree_depth: 20,
    events: [
      {
        commitment_be_hex: SMOKE_COMMITMENT_HEX,
        denomination: "1000",
        leaf_index: 0,
        depositor: "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o",
        slot: "466467891",
      },
    ],
    last_root_be_hex: root,
    leaf_count: 1,
  };
}

// Build and write a cryptographically valid snapshot (requires initPoseidon).
// Returns the actual root written.
async function writeValidSnapshot(p: string): Promise<string> {
  const event = normalizeNoteDepositedEvent({
    commitment: SMOKE_COMMITMENT_HEX,
    denomination: "1000",
    leaf_index: 0,
    depositor: "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o",
    slot: "466467891",
    signature:
      "5GQ7eK13VzqkegN9mwA9BJF5jhHt9XAXpFu61kfccQZgv8yhg9ZE7xSwfDhGu9nSXpiay3Y4M1s7MVrRuBK7bGGW",
  });
  const snapshot = buildSnapshot([event]);
  fs.writeFileSync(p, JSON.stringify(snapshot, null, 2), "utf-8");
  return snapshot.last_root_be_hex;
}

// Minimal v2 snapshot fixture for parseSnapshotFile tests (no tree replay).
function minimalValidSnapshotV2(root = KNOWN_ROOT): object {
  return {
    ...minimalValidSnapshot(root),
    version: 2,
    meta: {
      fetch_commitment: "confirmed",
      source_mode: "address",
      rpc_url: "https://api.devnet.solana.com/",
      program_id: PROGRAM_ID,
      address: PROGRAM_ID,
      created_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

// Build and write a cryptographically valid v2 snapshot (requires initPoseidon).
// metaOverrides is merged into the default meta block.
// Returns the actual root written.
async function writeValidSnapshotV2(
  p: string,
  metaOverrides: Partial<SnapshotFetchMeta> = {}
): Promise<string> {
  const event = normalizeNoteDepositedEvent({
    commitment: SMOKE_COMMITMENT_HEX,
    denomination: "1000",
    leaf_index: 0,
    depositor: "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o",
    slot: "466467891",
    signature:
      "5GQ7eK13VzqkegN9mwA9BJF5jhHt9XAXpFu61kfccQZgv8yhg9ZE7xSwfDhGu9nSXpiay3Y4M1s7MVrRuBK7bGGW",
  });
  const meta: SnapshotFetchMeta = {
    fetch_commitment: "confirmed",
    source_mode: "address",
    rpc_url: "https://api.devnet.solana.com/",
    program_id: PROGRAM_ID,
    address: PROGRAM_ID,
    created_at: "2026-01-01T00:00:00.000Z",
    ...metaOverrides,
  };
  const snapshot = buildSnapshot([event], meta);
  fs.writeFileSync(p, JSON.stringify(snapshot, null, 2), "utf-8");
  return snapshot.last_root_be_hex;
}

function dryRunArgs(
  snapshotPath: string,
  overrides: Partial<SubmitRootArgs> = {}
): SubmitRootArgs {
  return {
    snapshotPath,
    programId: PROGRAM_ID,
    commitment: "confirmed",
    allowExisting: false,
    dryRun: true,
    yes: false,
    ...overrides,
  };
}

function yesArgs(
  snapshotPath: string,
  overrides: Partial<SubmitRootArgs> = {}
): SubmitRootArgs {
  return {
    snapshotPath,
    programId: PROGRAM_ID,
    commitment: "confirmed",
    allowExisting: false,
    dryRun: false,
    yes: true,
    ...overrides,
  };
}

function makeSuccessDeps(root: string): SubmitRootDeps {
  const rootBytes = Array.from(Buffer.from(root, "hex"));
  return {
    rootSubmitterPubkey: ADMIN_PUBKEY,
    fetchConfig: async () => ({
      adminAuthority: ADMIN_PUBKEY,
      rootSubmitterAuthority: ADMIN_PUBKEY,
      paused: false,
      allowedRoots: [],
    }),
    sendAddAllowedRoot: async () => "mockTxSig",
    refetchConfig: async () => ({
      adminAuthority: ADMIN_PUBKEY,
      rootSubmitterAuthority: ADMIN_PUBKEY,
      paused: false,
      allowedRoots: [rootBytes],
    }),
  };
}

// ── Module guard ──────────────────────────────────────────────────────────────

describe("submit_root_devnet: module guard", () => {
  it("1. exports are accessible; require.main guard prevents execution on import", () => {
    expect(PROGRAM_ID).to.be.a("string").with.length.greaterThan(0);
    expect(MAX_ROOTS).to.equal(10);
    expect(parseArgs).to.be.a("function");
    expect(parseSnapshotFile).to.be.a("function");
    expect(validateRootHex).to.be.a("function");
    expect(validateIdlAddress).to.be.a("function");
    expect(deriveConfigPda).to.be.a("function");
    expect(runSubmitRoot).to.be.a("function");
  });
});

// ── validateIdlAddress ────────────────────────────────────────────────────────

describe("submit_root_devnet: validateIdlAddress", () => {
  it("2. rejects missing address field", () => {
    expect(() => validateIdlAddress({})).to.throw(/missing/i);
  });

  it("3. rejects an address that is not a valid public key", () => {
    expect(() => validateIdlAddress({ address: "not-a-pubkey" })).to.throw(
      /not a valid public key/i
    );
  });

  it("4. rejects a valid pubkey that does not match PROGRAM_ID", () => {
    expect(() =>
      validateIdlAddress({ address: "11111111111111111111111111111111" })
    ).to.throw(/mismatch/i);
  });

  it("5. accepts PROGRAM_ID and returns a PublicKey equal to PROGRAM_ID (verifies pk.toBase58() comparison)", () => {
    const pk = validateIdlAddress({ address: PROGRAM_ID });
    expect(pk).to.be.instanceof(PublicKey);
    expect(pk.toBase58()).to.equal(PROGRAM_ID);
  });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("submit_root_devnet: parseArgs", () => {
  const BASE = ["--snapshot", "/tmp/snap.json", "--program-id", PROGRAM_ID];

  it("6. rejects missing --snapshot", () => {
    expect(() => parseArgs(["--program-id", PROGRAM_ID])).to.throw(
      /--snapshot is required/
    );
  });

  it("7. accepts --snapshot and sets snapshotPath", () => {
    const args = parseArgs([...BASE]);
    expect(args.snapshotPath).to.equal("/tmp/snap.json");
    expect(args.programId).to.equal(PROGRAM_ID);
  });

  it("8. rejects --snapshot when next token is another flag (missing value)", () => {
    expect(() =>
      parseArgs(["--snapshot", "--program-id", PROGRAM_ID])
    ).to.throw(/requires a value/);
  });

  it("9. rejects missing --program-id", () => {
    expect(() => parseArgs(["--snapshot", "/tmp/snap.json"])).to.throw(
      /--program-id is required/
    );
  });

  it("10. rejects --program-id when value is missing (end of args)", () => {
    expect(() =>
      parseArgs(["--snapshot", "/tmp/snap.json", "--program-id"])
    ).to.throw(/requires a value/);
  });

  it("11. accepts --dry-run; dryRun=true, yes=false", () => {
    const args = parseArgs([...BASE, "--dry-run"]);
    expect(args.dryRun).to.equal(true);
    expect(args.yes).to.equal(false);
  });

  it("12. accepts --yes; yes=true, dryRun=false", () => {
    const args = parseArgs([...BASE, "--yes"]);
    expect(args.yes).to.equal(true);
    expect(args.dryRun).to.equal(false);
  });

  it("13. rejects --dry-run + --yes together", () => {
    expect(() => parseArgs([...BASE, "--dry-run", "--yes"])).to.throw(
      /mutually exclusive/
    );
  });

  it("14. accepts --expected-root and stores the value", () => {
    const args = parseArgs([...BASE, "--expected-root", KNOWN_ROOT]);
    expect(args.expectedRoot).to.equal(KNOWN_ROOT);
  });

  it("15. rejects --expected-root when value is missing", () => {
    expect(() => parseArgs([...BASE, "--expected-root"])).to.throw(
      /requires a value/
    );
  });

  it("16. accepts --allow-existing; sets allowExisting=true", () => {
    const args = parseArgs([...BASE, "--allow-existing"]);
    expect(args.allowExisting).to.equal(true);
  });

  it("17. accepts --commitment confirmed", () => {
    expect(
      parseArgs([...BASE, "--commitment", "confirmed"]).commitment
    ).to.equal("confirmed");
  });

  it("18. accepts --commitment finalized", () => {
    expect(
      parseArgs([...BASE, "--commitment", "finalized"]).commitment
    ).to.equal("finalized");
  });

  it("19. accepts --commitment processed", () => {
    expect(
      parseArgs([...BASE, "--commitment", "processed"]).commitment
    ).to.equal("processed");
  });

  it("20. rejects invalid --commitment value", () => {
    expect(() => parseArgs([...BASE, "--commitment", "instant"])).to.throw(
      /--commitment must be/
    );
  });

  it("21. defaults: commitment=confirmed, allowExisting=false, dryRun=false, yes=false", () => {
    const args = parseArgs([...BASE]);
    expect(args.commitment).to.equal("confirmed");
    expect(args.allowExisting).to.equal(false);
    expect(args.dryRun).to.equal(false);
    expect(args.yes).to.equal(false);
    expect(args.expectedRoot).to.be.undefined;
  });

  it("22. rejects unknown flag", () => {
    expect(() => parseArgs([...BASE, "--unknown"])).to.throw(/unknown flag/);
  });
});

// ── parseSnapshotFile ─────────────────────────────────────────────────────────

describe("submit_root_devnet: parseSnapshotFile", () => {
  it("23. valid snapshot parses and returns snapshot object with correct fields", () => {
    const p = tmpPath("valid");
    try {
      writeJson(p, minimalValidSnapshot());
      const snap = parseSnapshotFile(p);
      expect(snap.last_root_be_hex).to.equal(KNOWN_ROOT);
      expect(snap.leaf_count).to.equal(1);
      expect(snap.events).to.have.length(1);
    } finally {
      cleanup(p);
    }
  });

  it("24. rejects missing file", () => {
    expect(() =>
      parseSnapshotFile("/tmp/does-not-exist-submit-root-95783.json")
    ).to.throw(/cannot read snapshot/);
  });

  it("25. rejects invalid JSON", () => {
    const p = tmpPath("badjson");
    try {
      fs.writeFileSync(p, "{ not valid json }", "utf-8");
      expect(() => parseSnapshotFile(p)).to.throw(/invalid JSON/);
    } finally {
      cleanup(p);
    }
  });

  it("26. rejects leaf_count=0", () => {
    const p = tmpPath("lc0");
    try {
      writeJson(p, { ...minimalValidSnapshot(), leaf_count: 0 });
      expect(() => parseSnapshotFile(p)).to.throw(/leaf_count/);
    } finally {
      cleanup(p);
    }
  });

  it("27. rejects events=[]", () => {
    const p = tmpPath("noevents");
    try {
      writeJson(p, { ...minimalValidSnapshot(), events: [] });
      expect(() => parseSnapshotFile(p)).to.throw(/events/);
    } finally {
      cleanup(p);
    }
  });

  it("28. rejects missing last_root_be_hex field", () => {
    const p = tmpPath("noroot");
    try {
      const { last_root_be_hex: _, ...rest } = minimalValidSnapshot() as any;
      writeJson(p, rest);
      expect(() => parseSnapshotFile(p)).to.throw(/last_root_be_hex/);
    } finally {
      cleanup(p);
    }
  });

  it("29. rejects malformed hex root (fewer than 64 chars)", () => {
    const p = tmpPath("badhex");
    try {
      writeJson(p, { ...minimalValidSnapshot(), last_root_be_hex: "deadbeef" });
      expect(() => parseSnapshotFile(p)).to.throw(/64 hex/);
    } finally {
      cleanup(p);
    }
  });

  it("30. rejects all-zero root", () => {
    const p = tmpPath("zeroroot");
    try {
      writeJson(p, {
        ...minimalValidSnapshot(),
        last_root_be_hex: "0".repeat(64),
      });
      expect(() => parseSnapshotFile(p)).to.throw(/all-zero/);
    } finally {
      cleanup(p);
    }
  });
});

// ── runSubmitRoot — dry-run ───────────────────────────────────────────────────

describe("submit_root_devnet: runSubmitRoot dry-run", () => {
  let validSnapshotPath: string;
  let actualRoot: string;

  before(async () => {
    await initPoseidon();
    validSnapshotPath = tmpPath("dryrun");
    actualRoot = await writeValidSnapshot(validSnapshotPath);
  });

  after(() => {
    cleanup(validSnapshotPath);
  });

  it("31. dry-run returns correct result: sent=false, postSendVerified=false, dryRun=true", async () => {
    const result = await runSubmitRoot(dryRunArgs(validSnapshotPath));
    expect(result.dryRun).to.equal(true);
    expect(result.sent).to.equal(false);
    expect(result.postSendVerified).to.equal(false);
    expect(result.txSignature).to.be.undefined;
    expect(result.root).to.equal(actualRoot);
    expect(result.leafCount).to.equal(1);
    expect(result.eventCount).to.equal(1);
  });

  it("32. dry-run does not invoke sendAddAllowedRoot even if deps are supplied", async () => {
    let sendCalled = false;
    const deps: SubmitRootDeps = {
      rootSubmitterPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => null,
      sendAddAllowedRoot: async () => {
        sendCalled = true;
        return "shouldNotBeCalled";
      },
      refetchConfig: async () => null,
    };
    await runSubmitRoot(dryRunArgs(validSnapshotPath), deps);
    expect(sendCalled).to.equal(false);
  });

  it("33. rejects expected-root mismatch", async () => {
    const wrongRoot = "a".repeat(64);
    let err: Error | undefined;
    try {
      await runSubmitRoot(
        dryRunArgs(validSnapshotPath, { expectedRoot: wrongRoot })
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("expected-root mismatch");
  });

  it("34. accepts matching expected-root and returns correct result", async () => {
    const result = await runSubmitRoot(
      dryRunArgs(validSnapshotPath, { expectedRoot: actualRoot })
    );
    expect(result.root).to.equal(actualRoot);
    expect(result.dryRun).to.equal(true);
    expect(result.sent).to.equal(false);
  });

  it("35. neither dry-run nor yes throws 'yes is required'; sendAddAllowedRoot never called", async () => {
    let sendCalled = false;
    const deps: SubmitRootDeps = {
      rootSubmitterPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
        paused: false,
        allowedRoots: [],
      }),
      sendAddAllowedRoot: async () => {
        sendCalled = true;
        return "shouldNotBeCalled";
      },
      refetchConfig: async () => null,
    };
    let err: Error | undefined;
    try {
      await runSubmitRoot(
        {
          snapshotPath: validSnapshotPath,
          programId: PROGRAM_ID,
          commitment: "confirmed",
          allowExisting: false,
          dryRun: false,
          yes: false,
        },
        deps
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--yes is required");
    expect(sendCalled).to.equal(false);
  });
});

// ── runSubmitRoot — --yes mocked ──────────────────────────────────────────────

describe("submit_root_devnet: runSubmitRoot --yes mocked", () => {
  let validSnapshotPath: string;
  let actualRoot: string;

  before(async () => {
    await initPoseidon();
    validSnapshotPath = tmpPath("yes");
    actualRoot = await writeValidSnapshot(validSnapshotPath);
  });

  after(() => {
    cleanup(validSnapshotPath);
  });

  it("36. rejects if verifier config not found (fetchConfig returns null)", async () => {
    const deps: SubmitRootDeps = {
      rootSubmitterPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => null,
      sendAddAllowedRoot: async () => "never",
      refetchConfig: async () => null,
    };
    let err: Error | undefined;
    try {
      await runSubmitRoot(yesArgs(validSnapshotPath), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("not found");
  });

  it("37. rejects if wallet pubkey does not match config root_submitter_authority", async () => {
    const deps: SubmitRootDeps = {
      rootSubmitterPubkey: OTHER_PUBKEY,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
        paused: false,
        allowedRoots: [],
      }),
      sendAddAllowedRoot: async () => "never",
      refetchConfig: async () => null,
    };
    let err: Error | undefined;
    try {
      await runSubmitRoot(yesArgs(validSnapshotPath), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("root_submitter_authority");
  });

  it("38. rejects if root already present and --allow-existing is false", async () => {
    const rootBytes = Array.from(Buffer.from(actualRoot, "hex"));
    const deps: SubmitRootDeps = {
      rootSubmitterPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
        paused: false,
        allowedRoots: [rootBytes],
      }),
      sendAddAllowedRoot: async () => "never",
      refetchConfig: async () => null,
    };
    let err: Error | undefined;
    try {
      await runSubmitRoot(yesArgs(validSnapshotPath), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("already present");
  });

  it("39. exits success without sending if root already present and --allow-existing is true", async () => {
    const rootBytes = Array.from(Buffer.from(actualRoot, "hex"));
    let sendCalled = false;
    const deps: SubmitRootDeps = {
      rootSubmitterPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
        paused: false,
        allowedRoots: [rootBytes],
      }),
      sendAddAllowedRoot: async () => {
        sendCalled = true;
        return "never";
      },
      refetchConfig: async () => null,
    };
    const result = await runSubmitRoot(
      yesArgs(validSnapshotPath, { allowExisting: true }),
      deps
    );
    expect(sendCalled).to.equal(false);
    expect(result.sent).to.equal(false);
    expect(result.postSendVerified).to.equal(true);
  });

  it("40. rejects if allowed_roots is at max capacity and root is absent", async () => {
    const fullRoots = Array.from({ length: MAX_ROOTS }, (_, i) =>
      Array.from({ length: 32 }, (_b, j) => (i + j + 1) % 256)
    );
    const deps: SubmitRootDeps = {
      rootSubmitterPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
        paused: false,
        allowedRoots: fullRoots,
      }),
      sendAddAllowedRoot: async () => "never",
      refetchConfig: async () => null,
    };
    let err: Error | undefined;
    try {
      await runSubmitRoot(yesArgs(validSnapshotPath), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("full");
    expect(err!.message).to.include(String(MAX_ROOTS));
  });

  it("41. calls sendAddAllowedRoot exactly once with 32-byte root array", async () => {
    let sendCallCount = 0;
    let receivedRoot: number[] | undefined;
    const deps = makeSuccessDeps(actualRoot);
    deps.sendAddAllowedRoot = async (root) => {
      sendCallCount++;
      receivedRoot = root;
      return "mockTxSig42";
    };
    const result = await runSubmitRoot(yesArgs(validSnapshotPath), deps);
    expect(sendCallCount).to.equal(1);
    expect(receivedRoot).to.have.length(32);
    expect(Buffer.from(receivedRoot!).toString("hex")).to.equal(actualRoot);
    expect(result.txSignature).to.equal("mockTxSig42");
    expect(result.sent).to.equal(true);
  });

  it("42. postSendVerified=true when root appears in re-fetched config", async () => {
    const result = await runSubmitRoot(
      yesArgs(validSnapshotPath),
      makeSuccessDeps(actualRoot)
    );
    expect(result.postSendVerified).to.equal(true);
    expect(result.sent).to.equal(true);
  });

  it("43. rejects if post-send config does not contain the submitted root", async () => {
    const deps: SubmitRootDeps = {
      rootSubmitterPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
        paused: false,
        allowedRoots: [],
      }),
      sendAddAllowedRoot: async () => "txSig",
      refetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
        paused: false,
        allowedRoots: [], // root absent after send
      }),
    };
    let err: Error | undefined;
    try {
      await runSubmitRoot(yesArgs(validSnapshotPath), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("post-send verification failed");
  });

  it("44. paused config does not block send (addAllowedRoot has no paused guard on-chain)", async () => {
    let sendCalled = false;
    const rootBytes = Array.from(Buffer.from(actualRoot, "hex"));
    const deps: SubmitRootDeps = {
      rootSubmitterPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
        paused: true,
        allowedRoots: [],
      }),
      sendAddAllowedRoot: async () => {
        sendCalled = true;
        return "txSig";
      },
      refetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
        paused: true,
        allowedRoots: [rootBytes],
      }),
    };
    const result = await runSubmitRoot(yesArgs(validSnapshotPath), deps);
    expect(sendCalled).to.equal(true);
    expect(result.sent).to.equal(true);
    expect(result.postSendVerified).to.equal(true);
  });
});

// ── Source scan ───────────────────────────────────────────────────────────────
//
// Strings built with join() so this test file itself does not contain the
// forbidden call patterns consecutively and does not self-flag.
// Documentation prose ("Does not call deposit_note") does not have "(" after
// the function name; these tests match actual invocation patterns only.

describe("submit_root_devnet: source scan", () => {
  const join = (...parts: string[]) => parts.join("");
  let src: string;

  before(() => {
    src = fs.readFileSync(SCRIPT_PATH, "utf8");
  });

  it("45. script does not invoke deposit_note / depositNote", () => {
    // Match call patterns like `.depositNote(` or `depositNote(` — not prose.
    expect(src).to.not.include(join(".", "deposit", "_note("));
    expect(src).to.not.include(join("deposit", "Note("));
  });

  it("46. script does not invoke withdraw_zk / withdrawZk", () => {
    expect(src).to.not.include(join(".", "withdraw", "_zk("));
    expect(src).to.not.include(join("withdraw", "Zk("));
  });

  it("47. script does not invoke Keypair.generate", () => {
    expect(src).to.not.include(join("Keypair", ".", "generate"));
  });

  it("48. script does not invoke requestAirdrop", () => {
    expect(src).to.not.include(join("request", "Airdrop"));
  });

  it("49. actual send call (await deps.sendAddAllowedRoot) is after the yes guard", () => {
    const guard = "if (!args.yes)";
    // The actual call site — not the interface declaration (which has no "await deps.").
    const sendCall = join("await deps.", "send", "AddAllowedRoot");
    const guardIdx = src.indexOf(guard);
    const sendIdx = src.indexOf(sendCall);
    expect(guardIdx, "yes guard must exist in source").to.be.greaterThan(-1);
    expect(
      sendIdx,
      "sendAddAllowedRoot call must exist in source"
    ).to.be.greaterThan(-1);
    expect(sendIdx).to.be.greaterThan(guardIdx);
  });
});

// ── runSubmitRoot — commitment and capacity warnings ──────────────────────────

describe("submit_root_devnet: runSubmitRoot warnings", () => {
  let validSnapshotPath: string;
  let actualRoot: string;

  before(async () => {
    await initPoseidon();
    validSnapshotPath = tmpPath("warnings");
    actualRoot = await writeValidSnapshot(validSnapshotPath);
  });

  after(() => {
    cleanup(validSnapshotPath);
  });

  it("50. warns when --commitment is processed; submission still proceeds", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(String(args[0]));
        origWarn(...args);
      };
      const result = await runSubmitRoot(
        yesArgs(validSnapshotPath, { commitment: "processed" }),
        makeSuccessDeps(actualRoot)
      );
      expect(result.sent).to.equal(true);
      expect(result.postSendVerified).to.equal(true);
      expect(warnings.some((w) => w.includes("processed"))).to.equal(
        true,
        "expected a warning mentioning processed commitment"
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it("51. warns when allowed_roots is at MAX_ROOTS - 2; submission still proceeds", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(String(args[0]));
        origWarn(...args);
      };
      const nearCapacityRoots = Array.from({ length: MAX_ROOTS - 2 }, (_, i) =>
        Array.from({ length: 32 }, (_b, j) => (i + j + 1) % 256)
      );
      const rootBytes = Array.from(Buffer.from(actualRoot, "hex"));
      const deps: SubmitRootDeps = {
        rootSubmitterPubkey: ADMIN_PUBKEY,
        fetchConfig: async () => ({
          adminAuthority: ADMIN_PUBKEY,
          rootSubmitterAuthority: ADMIN_PUBKEY,
          paused: false,
          allowedRoots: nearCapacityRoots,
        }),
        sendAddAllowedRoot: async () => "mockTxSigCapacity",
        refetchConfig: async () => ({
          adminAuthority: ADMIN_PUBKEY,
          rootSubmitterAuthority: ADMIN_PUBKEY,
          paused: false,
          allowedRoots: [...nearCapacityRoots, rootBytes],
        }),
      };
      const result = await runSubmitRoot(yesArgs(validSnapshotPath), deps);
      expect(result.sent).to.equal(true);
      expect(result.postSendVerified).to.equal(true);
      expect(
        warnings.some(
          (w) =>
            w.includes(String(MAX_ROOTS - 2)) || w.includes("allowed_roots")
        )
      ).to.equal(true, "expected a capacity approach warning");
    } finally {
      console.warn = origWarn;
    }
  });
});

// ── Root submitter authority separation ───────────────────────────────────────

describe("submit_root_devnet: root submitter authority separation", () => {
  let validSnapshotPath: string;
  let actualRoot: string;

  before(async () => {
    await initPoseidon();
    validSnapshotPath = tmpPath("authority");
    actualRoot = await writeValidSnapshot(validSnapshotPath);
  });

  after(() => {
    cleanup(validSnapshotPath);
  });

  it("52. rejects when rootSubmitterPubkey != rootSubmitterAuthority; sendAddAllowedRoot not called", async () => {
    let sendCalled = false;
    const deps: SubmitRootDeps = {
      rootSubmitterPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ROOT_SUBMITTER_PUBKEY,
        paused: false,
        allowedRoots: [],
      }),
      sendAddAllowedRoot: async () => {
        sendCalled = true;
        return "shouldNotBeCalled";
      },
      refetchConfig: async () => null,
    };
    let err: Error | undefined;
    try {
      await runSubmitRoot(yesArgs(validSnapshotPath), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("root_submitter_authority");
    expect(sendCalled).to.equal(false);
  });

  it("53. accepts when rootSubmitterPubkey == rootSubmitterAuthority (differs from adminAuthority); sendAddAllowedRoot called", async () => {
    const rootBytes = Array.from(Buffer.from(actualRoot, "hex"));
    let sendCalled = false;
    const deps: SubmitRootDeps = {
      rootSubmitterPubkey: ROOT_SUBMITTER_PUBKEY,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ROOT_SUBMITTER_PUBKEY,
        paused: false,
        allowedRoots: [],
      }),
      sendAddAllowedRoot: async () => {
        sendCalled = true;
        return "mockTxSig53";
      },
      refetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ROOT_SUBMITTER_PUBKEY,
        paused: false,
        allowedRoots: [rootBytes],
      }),
    };
    const result = await runSubmitRoot(yesArgs(validSnapshotPath), deps);
    expect(sendCalled).to.equal(true);
    expect(result.sent).to.equal(true);
    expect(result.postSendVerified).to.equal(true);
  });
});

// ── Source scan — authority model ─────────────────────────────────────────────

describe("submit_root_devnet: source scan authority", () => {
  const join = (...parts: string[]) => parts.join("");
  let src: string;

  before(() => {
    src = fs.readFileSync(SCRIPT_PATH, "utf8");
  });

  it("54. addAllowedRoot account mapping uses rootSubmitter: rootSubmitterKeypair.publicKey, not admin: adminKeypair.publicKey", () => {
    // Exact new mapping present in the CLI send path.
    expect(src).to.include(
      join("root", "Submitter: root", "SubmitterKeypair.publicKey")
    );
    // Exact old mapping must be absent.
    expect(src).to.not.include(join("admin: admin", "Keypair.publicKey"));
  });

  it("55. script does not contain stale adminPubkey or adminKeypair variable names", () => {
    expect(src).to.not.include(join("admin", "Pubkey"));
    expect(src).to.not.include(join("admin", "Keypair"));
  });
});

// ── parseSnapshotFile — v2 acceptance ────────────────────────────────────────

describe("submit_root_devnet: parseSnapshotFile v2 acceptance", () => {
  it("56. parseSnapshotFile accepts version 2 snapshot with meta block", () => {
    const p = tmpPath("v2parse");
    try {
      writeJson(p, minimalValidSnapshotV2());
      const snap = parseSnapshotFile(p);
      expect(snap.last_root_be_hex).to.equal(KNOWN_ROOT);
      expect(snap.version).to.equal(2);
      expect(snap.meta).to.exist;
      expect((snap.meta as any).fetch_commitment).to.equal("confirmed");
    } finally {
      cleanup(p);
    }
  });
});

// ── runSubmitRoot — v2 snapshot meta preflight ────────────────────────────────

describe("submit_root_devnet: runSubmitRoot v2 snapshot meta", () => {
  let v2SnapshotPath: string;
  let v1SnapshotPath: string;
  let actualRoot: string;

  before(async () => {
    await initPoseidon();
    v2SnapshotPath = tmpPath("v2meta");
    v1SnapshotPath = tmpPath("v1meta");
    actualRoot = await writeValidSnapshotV2(v2SnapshotPath);
    await writeValidSnapshot(v1SnapshotPath);
  });

  after(() => {
    cleanup(v2SnapshotPath, v1SnapshotPath);
  });

  it("57. dry-run with v2 snapshot: snapshotVersion=2, snapshotMeta present, fetch_commitment=confirmed", async () => {
    const result = await runSubmitRoot(dryRunArgs(v2SnapshotPath));
    expect(result.snapshotVersion).to.equal(2);
    expect(result.snapshotMeta).to.exist;
    expect(result.snapshotMeta!.fetch_commitment).to.equal("confirmed");
    expect(result.snapshotMeta!.source_mode).to.equal("address");
    expect(result.dryRun).to.equal(true);
    expect(result.root).to.equal(actualRoot);
  });

  it("58. dry-run warns when snapshot meta.fetch_commitment is 'processed'", async () => {
    const p = tmpPath("v2processed");
    try {
      await writeValidSnapshotV2(p, { fetch_commitment: "processed" });
      const warnings: string[] = [];
      const origWarn = console.warn;
      try {
        console.warn = (...args: unknown[]) => {
          warnings.push(String(args[0]));
          origWarn(...args);
        };
        await runSubmitRoot(dryRunArgs(p));
      } finally {
        console.warn = origWarn;
      }
      expect(
        warnings.some(
          (w) => w.includes("meta.fetch_commitment") && w.includes("processed")
        )
      ).to.equal(
        true,
        "expected a warning mentioning meta.fetch_commitment=processed"
      );
    } finally {
      cleanup(p);
    }
  });

  it("59. dry-run: no fetch_commitment warning when meta.fetch_commitment is 'confirmed'", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(String(args[0]));
        origWarn(...args);
      };
      await runSubmitRoot(dryRunArgs(v2SnapshotPath));
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.some((w) => w.includes("meta.fetch_commitment"))).to.equal(
      false,
      "expected no meta.fetch_commitment warning for confirmed snapshot"
    );
  });

  it("60. dry-run: no fetch_commitment warning for v1 snapshot with no meta", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(String(args[0]));
        origWarn(...args);
      };
      await runSubmitRoot(dryRunArgs(v1SnapshotPath));
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.some((w) => w.includes("meta.fetch_commitment"))).to.equal(
      false,
      "expected no meta.fetch_commitment warning for v1 snapshot"
    );
  });

  it("61. dry-run warns when snapshot meta.program_id does not match --program-id", async () => {
    const p = tmpPath("v2wrongpid");
    try {
      await writeValidSnapshotV2(p, {
        program_id: "So11111111111111111111111111111111111111112",
      });
      const warnings: string[] = [];
      const origWarn = console.warn;
      try {
        console.warn = (...args: unknown[]) => {
          warnings.push(String(args[0]));
          origWarn(...args);
        };
        await runSubmitRoot(dryRunArgs(p));
      } finally {
        console.warn = origWarn;
      }
      expect(
        warnings.some(
          (w) => w.includes("meta.program_id") && w.includes("does not match")
        )
      ).to.equal(
        true,
        "expected a warning mentioning meta.program_id does not match"
      );
    } finally {
      cleanup(p);
    }
  });

  it("62. dry-run: no program_id mismatch warning when meta.program_id matches --program-id", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(String(args[0]));
        origWarn(...args);
      };
      await runSubmitRoot(dryRunArgs(v2SnapshotPath));
    } finally {
      console.warn = origWarn;
    }
    expect(
      warnings.some((w) => w.includes("meta.program_id does not match"))
    ).to.equal(false, "expected no program_id mismatch warning when IDs match");
  });
});

// ── --help output ─────────────────────────────────────────────────────────────

describe("submit_root_devnet: --help output", () => {
  it("63. helpText states the purpose and lists required + optional flags", () => {
    const help = helpText();
    expect(help).to.include("submit_root_devnet");
    expect(help.toLowerCase()).to.include("allowed_roots");
    expect(help).to.include("--snapshot");
    expect(help).to.include("--program-id");
    expect(help).to.include("--expected-root");
    expect(help).to.include("--commitment");
    expect(help).to.include("--dry-run");
    expect(help).to.include("--yes");
    expect(help).to.include("--allow-existing");
    expect(help).to.include("--help");
  });

  it("64. helpText documents env vars, no-tx dry-run, single addAllowedRoot send, and operator-managed roots", () => {
    const help = helpText();
    expect(help).to.include("ANCHOR_PROVIDER_URL");
    expect(help).to.include("ANCHOR_WALLET");
    // dry-run does not send a transaction
    expect(help).to.match(/dry-run[\s\S]*no transaction/i);
    // --yes sends exactly one addAllowedRoot transaction
    expect(help).to.include("exactly one addAllowedRoot transaction");
    expect(help.toLowerCase()).to.include("operator-managed");
    // devnet-only / not mainnet
    expect(help.toLowerCase()).to.include("devnet only");
    expect(help.toLowerCase()).to.include("mainnet");
  });

  it("65. helpText omits concrete key paths", () => {
    const help = helpText();
    expect(help).to.not.include("keys/");
    expect(help).to.not.include("id.json");
    expect(help).to.not.include(".config/solana");
  });

  it("66. CLI --help exits 0 and prints usage", () => {
    const res = runCli(["--help"]);
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("submit_root_devnet");
    expect(res.stdout).to.include("--snapshot");
    expect(res.stdout).to.include("--program-id");
  });

  it("67. CLI -h exits 0 and prints usage", () => {
    const res = runCli(["-h"]);
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("addAllowedRoot");
  });
});

// ── buildSubmitHint (path-safe copy-paste hint) ───────────────────────────────

describe("submit_root_devnet: buildSubmitHint is path-safe", () => {
  it("68. uses placeholders only and leaks no local snapshot/wallet paths", () => {
    const hint = buildSubmitHint();
    expect(hint).to.include("<root-submitter-keypair-path>");
    expect(hint).to.include("<snapshot-path>");
    expect(hint).to.include("<program-id>");
    expect(hint).to.include("<root>");
    expect(hint).to.include("<commitment>");

    // Forbidden samples are assembled from pieces so this source text itself does
    // not contain the literal paths a hygiene scanner would flag.
    const repoKeyPath = ["keys", "root_submitter.json"].join("/");
    const unixHomePath = "/" + ["home", "example"].join("/") + "/";
    const macHomePath = "/" + ["Users", "example"].join("/") + "/";
    const windowsHomePath = ["C:", "Users", "example"].join("\\");
    expect(hint).to.not.include(repoKeyPath);
    expect(hint).to.not.include(unixHomePath);
    expect(hint).to.not.include(macHomePath);
    expect(hint).to.not.include(windowsHomePath);
  });
});
