import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { expect } from "chai";
import { CIRRUS_DEVNET_ALPHA_PROFILE } from "../scripts/ops/cirrus_devnet_alpha_profile";
import {
  WithdrawSimArgs,
  FlowDeps,
  parseArgs,
  assertNotePathOutsideRepo,
  assertSnapshotPathOutsideRepo,
  normalizeArtifactInput,
  evaluateStatusGate,
  evaluateDiagnosticsGate,
  verifyPublicInputs,
  buildStatusArgv,
  buildDiagnosticsArgv,
  buildExportArgv,
  buildProveArgv,
  buildSimulateArgv,
  buildNullifierArgv,
  runGuidedFlow,
  runCliFlow,
  formatSummary,
  helpText,
} from "../scripts/ops/shared_pool_tester_withdraw_simulate";

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "ops",
  "shared_pool_tester_withdraw_simulate.ts"
);
const REPO_ROOT = path.join(__dirname, "..");
const P = CIRRUS_DEVNET_ALPHA_PROFILE;

// Token pieces assembled at runtime so this source stays scan-clean.
const J = (...p: string[]) => p.join("");

const ROOT_A = "ab".repeat(32);
const RECIPIENT = "DiuasKhcjWKHnP5gtDf5cBEVUMqoQhcMMUZCtYb7egdv";
const RELAYER = "3NpDL8TgCvgVqig4REBPDos1YuQarFqh7PEebcq7WGhu";

const REQUIRED = [
  "--note",
  "/x/n.bin",
  "--snapshot",
  "/x/snap.json",
  "--leaf-index",
  "6",
  "--root",
  ROOT_A,
  "--recipient",
  RECIPIENT,
  "--relayer",
  RELAYER,
];

function args(overrides: Partial<WithdrawSimArgs> = {}): WithdrawSimArgs {
  return {
    note: "/x/n.bin",
    snapshot: "/x/snap.json",
    leafIndex: 6,
    root: ROOT_A,
    recipient: RECIPIENT,
    relayer: RELAYER,
    rpc: P.rpc,
    denomination: P.defaultDenomination,
    fee: P.defaultFee,
    wasm: "/x/c.wasm",
    zkey: "/x/c.zkey",
    simulate: false,
    ...overrides,
  };
}

const READY_STATUS = {
  configExists: true,
  paused: false,
  expectedRootPresent: true,
  ready: true,
  allowedRootCount: 7,
  maxRoots: 10,
};

const DIAG_OK = {
  ok: true,
  warnings: [
    { code: "SMALL_ANONYMITY_SET", severity: "high" },
    { code: "SELECTED_LEAF_IS_LATEST", severity: "high" },
  ],
  failures: [],
};

/** Fake deps that record call order; every step succeeds by default. */
function makeDeps(
  calls: string[],
  overrides: Partial<FlowDeps> = {}
): FlowDeps {
  return {
    fetchStatus: async () => {
      calls.push("fetchStatus");
      return READY_STATUS;
    },
    runDiagnostics: async () => {
      calls.push("runDiagnostics");
      return DIAG_OK;
    },
    currentSlot: async () => {
      calls.push("currentSlot");
      return 468_000_000;
    },
    makeTempDir: () => {
      calls.push("makeTempDir");
      return "/x/tempdir";
    },
    exportProvingInputs: async () => {
      calls.push("exportProvingInputs");
    },
    generateProvingOutput: async () => {
      calls.push("generateProvingOutput");
    },
    readPublicInputs: () => {
      calls.push("readPublicInputs");
      return {
        root_be_hex: ROOT_A,
        nullifier_hash_be_hex: "cd".repeat(32),
      };
    },
    simulate: async () => {
      calls.push("simulate");
      return {
        simulationOk: true,
        unitsConsumed: 121_734,
        logCount: 12,
        settlementObserved: true,
      };
    },
    checkNullifierUnspent: async () => {
      calls.push("checkNullifierUnspent");
      return true;
    },
    cleanupTempDir: () => {
      calls.push("cleanupTempDir");
    },
    ...overrides,
  };
}

function runCli(cliArgs: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(
    process.execPath,
    ["-r", "ts-node/register/transpile-only", SCRIPT_PATH, ...cliArgs],
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

// ── parseArgs ────────────────────────────────────────────────────────────────

describe("withdraw_simulate: parseArgs", () => {
  it("requires note, snapshot, leaf-index, root, recipient, relayer", () => {
    const drop = (flag: string): string[] => {
      const out: string[] = [];
      for (let i = 0; i < REQUIRED.length; i += 2) {
        if (REQUIRED[i] !== flag) out.push(REQUIRED[i], REQUIRED[i + 1]);
      }
      return out;
    };
    for (const flag of [
      "--note",
      "--snapshot",
      "--leaf-index",
      "--root",
      "--recipient",
      "--relayer",
    ]) {
      expect(() => parseArgs(drop(flag)), flag).to.throw(
        new RegExp(`${flag} is required`)
      );
    }
  });

  it("parses the full argument set with profile defaults", () => {
    const a = parseArgs(REQUIRED);
    expect(a.leafIndex).to.equal(6);
    expect(a.root).to.equal(ROOT_A);
    expect(a.rpc).to.equal(P.rpc);
    expect(a.denomination).to.equal(P.defaultDenomination);
    expect(a.fee).to.equal(P.defaultFee);
    expect(a.simulate).to.equal(false);
  });

  it("rejects an invalid root and invalid pubkeys", () => {
    const swap = (flag: string, value: string): string[] => {
      const out = [...REQUIRED];
      out[out.indexOf(flag) + 1] = value;
      return out;
    };
    expect(() => parseArgs(swap("--root", "xyz"))).to.throw(/64 hex/);
    expect(() => parseArgs(swap("--root", "0".repeat(64)))).to.throw(
      /all-zero/
    );
    expect(() => parseArgs(swap("--recipient", "not-a-key"))).to.throw(
      /--recipient is not a valid public key/
    );
    expect(() => parseArgs(swap("--relayer", "also-bad"))).to.throw(
      /--relayer is not a valid public key/
    );
  });

  it("rejects recipient equal to relayer", () => {
    const same = [...REQUIRED];
    same[same.indexOf("--relayer") + 1] = RECIPIENT;
    expect(() => parseArgs(same)).to.throw(
      /--recipient and --relayer must be distinct/
    );
  });

  it("rejects a negative or unsafe leaf index", () => {
    const swap = [...REQUIRED];
    swap[swap.indexOf("--leaf-index") + 1] = "-1";
    expect(() => parseArgs(swap)).to.throw(/non-negative integer/);
    swap[swap.indexOf("--leaf-index") + 1] = "9007199254740992";
    expect(() => parseArgs(swap)).to.throw(/safe integer range/);
  });

  it("requires --wasm and --zkey only with --simulate", () => {
    expect(() => parseArgs([...REQUIRED, "--simulate"])).to.throw(
      /--wasm <path> is required with --simulate/
    );
    expect(() =>
      parseArgs([...REQUIRED, "--simulate", "--wasm", "/x/c.wasm"])
    ).to.throw(/--zkey <path> is required with --simulate/);
    const a = parseArgs([
      ...REQUIRED,
      "--simulate",
      "--wasm",
      "/x/c.wasm",
      "--zkey",
      "/x/c.zkey",
    ]);
    expect(a.simulate).to.equal(true);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs([...REQUIRED, "--send"])).to.throw(/unknown flag/);
    expect(() => parseArgs([...REQUIRED, "--yes"])).to.throw(/unknown flag/);
  });

  it("rejects a zero denomination; fee may be zero", () => {
    expect(() => parseArgs([...REQUIRED, "--denomination", "0"])).to.throw(
      /--denomination must be a positive \(non-zero\)/
    );
    const a = parseArgs([...REQUIRED, "--fee", "0"]);
    expect(a.fee).to.equal(0);
  });
});

// ── input-file guards (note material, snapshot, artifacts) ──────────────────

describe("withdraw_simulate: input-file guards", () => {
  let guardTmp: string;
  before(() => {
    guardTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cirrus-test-"));
  });
  after(() => {
    try {
      fs.rmSync(guardTmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("rejects a missing outside-repo note material file without echoing the path", () => {
    const missing = path.join(guardTmp, "missing-n.bin");
    let message = "";
    try {
      assertNotePathOutsideRepo(missing, REPO_ROOT);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).to.equal("note material file does not exist");
    expect(message).to.not.include(guardTmp);
  });

  it("rejects a note material path that is not a regular file", () => {
    const dir = path.join(guardTmp, "a-directory");
    fs.mkdirSync(dir);
    expect(() => assertNotePathOutsideRepo(dir, REPO_ROOT)).to.throw(
      /^note material path is not a regular file$/
    );
  });

  it("rejects an existing note material file inside the repository", () => {
    const inRepo = path.join(REPO_ROOT, "package.json"); // exists, regular, in-repo
    expect(() => assertNotePathOutsideRepo(inRepo, REPO_ROOT)).to.throw(
      /^note material path must be outside the repository$/
    );
  });

  it("accepts an existing regular outside-repo note material file and returns the absolute path", () => {
    const ok = path.join(guardTmp, "n.bin");
    fs.writeFileSync(ok, "00", { mode: 0o600 });
    const resolved = assertNotePathOutsideRepo(ok, REPO_ROOT);
    expect(path.isAbsolute(resolved)).to.equal(true);
  });

  it("applies the same guard to the snapshot input with snapshot wording", () => {
    const missing = path.join(guardTmp, "missing-snap.json");
    let message = "";
    try {
      assertSnapshotPathOutsideRepo(missing, REPO_ROOT);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).to.equal("snapshot file does not exist");
    expect(message).to.not.include(guardTmp);

    const inRepo = path.join(REPO_ROOT, "package.json");
    expect(() => assertSnapshotPathOutsideRepo(inRepo, REPO_ROOT)).to.throw(
      /^snapshot path must be outside the repository$/
    );

    const ok = path.join(guardTmp, "snap.json");
    fs.writeFileSync(ok, "{}");
    expect(assertSnapshotPathOutsideRepo(ok, REPO_ROOT)).to.equal(
      fs.realpathSync(ok)
    );
  });

  it("rejects an outside-repo symlink that targets an in-repo file", function () {
    const link = path.join(guardTmp, "sneaky-link.json");
    try {
      fs.symlinkSync(path.join(REPO_ROOT, "package.json"), link);
    } catch {
      this.skip(); // platform/permissions without symlink support
      return;
    }
    let message = "";
    try {
      assertNotePathOutsideRepo(link, REPO_ROOT);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).to.equal(
      "note material path must be outside the repository"
    );
    expect(message).to.not.include(guardTmp);
  });

  it("normalizeArtifactInput resolves relative paths and fails path-safely", () => {
    const ok = path.join(guardTmp, "c.wasm");
    fs.writeFileSync(ok, "0");
    const relative = path.relative(process.cwd(), ok);
    const resolved = normalizeArtifactInput("circuit wasm", relative);
    expect(path.isAbsolute(resolved)).to.equal(true);
    expect(resolved).to.equal(ok);

    let message = "";
    try {
      normalizeArtifactInput("proving key", path.join(guardTmp, "nope.zkey"));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).to.equal("proving key file does not exist");
    expect(message).to.not.include(guardTmp);
  });
});

// ── gates ────────────────────────────────────────────────────────────────────

describe("withdraw_simulate: status gate", () => {
  it("passes when ready, unpaused, and root present", () => {
    const g = evaluateStatusGate(READY_STATUS);
    expect(g.ok).to.equal(true);
    expect(g.reasons).to.deep.equal([]);
  });

  it("blocks when expectedRootPresent=false", () => {
    const g = evaluateStatusGate({
      ...READY_STATUS,
      expectedRootPresent: false,
    });
    expect(g.ok).to.equal(false);
    expect(g.reasons.join(" ")).to.include("operator");
  });

  it("blocks when paused=true", () => {
    const g = evaluateStatusGate({ ...READY_STATUS, paused: true });
    expect(g.ok).to.equal(false);
    expect(g.reasons.join(" ")).to.include("paused");
  });

  it("blocks when ready is not true", () => {
    const g = evaluateStatusGate({ ...READY_STATUS, ready: false });
    expect(g.ok).to.equal(false);
  });

  it("passes a root capacity warning through as operational-only", () => {
    const g = evaluateStatusGate({
      ...READY_STATUS,
      rootCapacitySeverity: "warning",
      rootCapacityWarning:
        "Root capacity is low: 7/10 allowed roots used; 3 slots remain.",
    });
    expect(g.ok).to.equal(true);
    expect(g.operationalWarnings).to.have.length(1);
    expect(g.operationalWarnings[0]).to.include("Root capacity is low");
  });
});

describe("withdraw_simulate: diagnostics gate", () => {
  it("allows high-severity warnings", () => {
    const g = evaluateDiagnosticsGate(DIAG_OK);
    expect(g.ok).to.equal(true);
  });

  it("blocks when ok=false or failures exist", () => {
    expect(evaluateDiagnosticsGate({ ok: false }).ok).to.equal(false);
    const g = evaluateDiagnosticsGate({
      ok: false,
      failures: [{ code: "ROOT_MISMATCH" }],
    });
    expect(g.ok).to.equal(false);
    expect(g.reasons.join(" ")).to.include("ROOT_MISMATCH");
  });
});

describe("withdraw_simulate: public-input verification", () => {
  it("passes when the root matches and the nullifier hash is well-formed", () => {
    const v = verifyPublicInputs(
      {
        root_be_hex: ROOT_A.toUpperCase(),
        nullifier_hash_be_hex: "cd".repeat(32),
      },
      ROOT_A
    );
    expect(v.ok).to.equal(true);
    expect(v.nullifierHash).to.equal("cd".repeat(32));
  });

  it("fails on a root mismatch", () => {
    const v = verifyPublicInputs(
      { root_be_hex: "ef".repeat(32), nullifier_hash_be_hex: "cd".repeat(32) },
      ROOT_A
    );
    expect(v.ok).to.equal(false);
    expect(v.reasons.join(" ")).to.include("root");
  });

  it("fails when the nullifier hash is missing", () => {
    const v = verifyPublicInputs({ root_be_hex: ROOT_A }, ROOT_A);
    expect(v.ok).to.equal(false);
  });
});

// ── mode behavior (dependency-injected) ──────────────────────────────────────

describe("withdraw_simulate: mode behavior", () => {
  it("preview runs only the gates — no proving or simulation deps", async () => {
    const calls: string[] = [];
    const r = await runGuidedFlow(args({ simulate: false }), makeDeps(calls));
    expect(r.blocked).to.equal(false);
    expect(r.mode).to.equal("preview");
    expect(calls).to.deep.equal(["fetchStatus", "runDiagnostics"]);
  });

  it("--simulate runs the full flow in order and cleans up", async () => {
    const calls: string[] = [];
    const r = await runGuidedFlow(args({ simulate: true }), makeDeps(calls));
    expect(r.blocked).to.equal(false);
    expect(r.simulation?.simulationOk).to.equal(true);
    expect(r.simulation?.unitsConsumed).to.equal(121_734);
    expect(r.nullifierUnspentAfter).to.equal(true);
    expect(r.tempCleaned).to.equal(true);
    expect(calls).to.deep.equal([
      "fetchStatus",
      "runDiagnostics",
      "currentSlot",
      "makeTempDir",
      "exportProvingInputs",
      "generateProvingOutput",
      "readPublicInputs",
      "simulate",
      "checkNullifierUnspent",
      "cleanupTempDir",
    ]);
  });

  it("blocks on a not-ready status without touching later deps", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      fetchStatus: async () => {
        calls.push("fetchStatus");
        return { ...READY_STATUS, ready: false, expectedRootPresent: false };
      },
    });
    const r = await runGuidedFlow(args({ simulate: true }), deps);
    expect(r.blocked).to.equal(true);
    expect(calls).to.deep.equal(["fetchStatus"]);
  });

  it("blocks on diagnostics failures without generating artifacts", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      runDiagnostics: async () => {
        calls.push("runDiagnostics");
        return { ok: false, failures: [{ code: "LEAF_INDEX_OUT_OF_RANGE" }] };
      },
    });
    const r = await runGuidedFlow(args({ simulate: true }), deps);
    expect(r.blocked).to.equal(true);
    expect(calls).to.deep.equal(["fetchStatus", "runDiagnostics"]);
  });

  it("blocks on a public-input root mismatch and still cleans up", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      readPublicInputs: () => {
        calls.push("readPublicInputs");
        return {
          root_be_hex: "ef".repeat(32),
          nullifier_hash_be_hex: "cd".repeat(32),
        };
      },
    });
    const r = await runGuidedFlow(args({ simulate: true }), deps);
    expect(r.blocked).to.equal(true);
    expect(r.publicInputsVerified).to.equal(false);
    expect(calls).to.include("cleanupTempDir");
    expect(calls).to.not.include("simulate");
  });

  it("cleans up the temp dir even when simulation throws", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      simulate: async () => {
        calls.push("simulate");
        throw new Error("rpc unavailable");
      },
    });
    let threw = false;
    try {
      await runGuidedFlow(args({ simulate: true }), deps);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
    expect(calls).to.include("cleanupTempDir");
  });

  it("blocks when simulationOk is not true", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      simulate: async () => {
        calls.push("simulate");
        return { simulationOk: false };
      },
    });
    const r = await runGuidedFlow(args({ simulate: true }), deps);
    expect(r.blocked).to.equal(true);
    expect(r.blockedReasons.join(" ")).to.include("simulationOk");
    expect(calls).to.not.include("checkNullifierUnspent");
    expect(calls).to.include("cleanupTempDir");
  });
});

// ── runCliFlow error containment ─────────────────────────────────────────────

describe("withdraw_simulate: runCliFlow error containment", () => {
  it("a dependency failure prints only the error message — no stack trace", async () => {
    const logged: string[] = [];
    const errors: string[] = [];
    const deps = makeDeps([], {
      fetchStatus: async () => {
        throw new Error("rpc unavailable");
      },
    });
    const code = await runCliFlow(
      args({ simulate: true }),
      deps,
      (s) => logged.push(s),
      (s) => errors.push(s)
    );
    expect(code).to.equal(1);
    expect(logged).to.deep.equal([]);
    expect(errors).to.deep.equal(["rpc unavailable"]);
    // No stack frames and no module paths in what was printed.
    expect(errors[0]).to.not.include("at ");
    expect(errors[0]).to.not.include(".ts");
  });

  it("a successful flow returns 0 and prints the public-safe summary", async () => {
    const logged: string[] = [];
    const code = await runCliFlow(
      args({ simulate: true }),
      makeDeps([]),
      (s) => logged.push(s),
      () => {
        throw new Error("logError must not be called on success");
      }
    );
    expect(code).to.equal(0);
    expect(logged.join("\n")).to.include("No live withdrawal was sent.");
  });

  it("a blocked flow returns 1 but still prints the summary, not a trace", async () => {
    const logged: string[] = [];
    const errors: string[] = [];
    const deps = makeDeps([], {
      fetchStatus: async () => ({ ...READY_STATUS, ready: false }),
    });
    const code = await runCliFlow(
      args({ simulate: true }),
      deps,
      (s) => logged.push(s),
      (s) => errors.push(s)
    );
    expect(code).to.equal(1);
    expect(errors).to.deep.equal([]);
    expect(logged.join("\n")).to.include("BLOCKED");
  });
});

// ── command builders ─────────────────────────────────────────────────────────

describe("withdraw_simulate: command builders", () => {
  const a = args({ simulate: true });

  it("status/diagnostics argv target the canonical read-only tools", () => {
    expect(buildStatusArgv(ROOT_A).join(" ")).to.include(
      "shared_pool_status_devnet.ts"
    );
    expect(
      buildDiagnosticsArgv({
        snapshot: a.snapshot,
        leafIndex: a.leafIndex,
        root: a.root,
        denomination: a.denomination,
      }).join(" ")
    ).to.include("shared_pool_privacy_diagnostics.ts");
  });

  it("export argv uses the canonical export tool with the profile PDAs and fresh expiry", () => {
    const argv = buildExportArgv(a, 468_100_000, "/x/tempdir").join(" ");
    expect(argv).to.include("zk_prover_export_");
    expect(argv).to.include("--expiry-slot 468100000");
    expect(argv).to.include(`--pool-pda ${P.poolPda}`);
    expect(argv).to.include(`--config-pda ${P.configPda}`);
    expect(argv).to.include(`--program-id ${P.programId}`);
  });

  it("prove argv pins snarkjs@0.7.4", () => {
    expect(buildProveArgv(a, "/x/tempdir").join(" ")).to.include(
      "snarkjs@0.7.4"
    );
  });

  it("simulate argv is simulate-only — includes --simulate, never a live-send flag", () => {
    const argv = buildSimulateArgv(a, 468_100_000, "/x/tempdir");
    const joined = argv.join(" ");
    expect(argv).to.include("--simulate");
    expect(joined).to.include(`--expected-root ${ROOT_A}`);
    expect(joined).to.include("withdraw_zk_devnet.ts");
    expect(argv).to.not.include(J("--", "send"));
    expect(argv).to.not.include(J("--", "yes"));
  });

  it("nullifier argv targets the read-only inspector", () => {
    expect(
      buildNullifierArgv({ rpc: P.rpc, nullifierHash: "cd".repeat(32) }).join(
        " "
      )
    ).to.include("inspect_nullifier_state_devnet.ts");
  });
});

// ── summary output hygiene ───────────────────────────────────────────────────

describe("withdraw_simulate: summary output", () => {
  // Sample local-looking paths assembled from pieces; source stays scan-clean.
  const unixHome = "/" + ["home", "tester"].join("/");
  const fakeNote = `${unixHome}/private/n.bin`;
  const fakeSnap = `${unixHome}/private/snap.json`;

  it("includes the public fields and never the note/snapshot paths", async () => {
    const calls: string[] = [];
    const a = args({ simulate: true, note: fakeNote, snapshot: fakeSnap });
    const r = await runGuidedFlow(a, makeDeps(calls));
    const out = formatSummary(a, r);
    expect(out).to.include(ROOT_A);
    expect(out).to.include("leaf index:          6");
    expect(out).to.include(RECIPIENT);
    expect(out).to.include(RELAYER);
    expect(out).to.include("simulationOk:        true");
    expect(out).to.include("unitsConsumed:       121734");
    expect(out).to.include("settlement log:      observed");
    expect(out).to.include("nullifier after sim: unspent");
    expect(out).to.include("No live withdrawal was sent.");
    expect(out).to.not.include(fakeNote);
    expect(out).to.not.include(fakeSnap);
    expect(out).to.not.include(unixHome);
    expect(out).to.include("path not shown");
  });

  it("preview summary says nothing was generated and points at --simulate", async () => {
    const calls: string[] = [];
    const a = args({ simulate: false });
    const r = await runGuidedFlow(a, makeDeps(calls));
    const out = formatSummary(a, r);
    expect(out).to.include("Preview only");
    expect(out).to.include("--simulate");
    expect(out).to.include("no live-send mode");
  });

  it("blocked summary lists public-safe reasons", async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls, {
      fetchStatus: async () => ({ ...READY_STATUS, ready: false }),
    });
    const a = args({ simulate: true });
    const r = await runGuidedFlow(a, deps);
    const out = formatSummary(a, r);
    expect(out).to.include("BLOCKED");
    expect(out).to.not.include("/x/tempdir");
  });
});

// ── help ─────────────────────────────────────────────────────────────────────

describe("withdraw_simulate: help", () => {
  it("recommends the silent npm form and states the simulate-only posture", () => {
    const help = helpText();
    expect(help).to.include("npm run --silent alpha:withdraw:simulate --");
    expect(help.toLowerCase()).to.include("devnet alpha only");
    expect(help.toLowerCase()).to.include("simulate-only");
    expect(help.toLowerCase()).to.include("no live withdrawal");
    expect(help.toLowerCase()).to.include("not");
    expect(help.toLowerCase()).to.include("production privacy");
    expect(help.toLowerCase()).to.include("does not spend the note");
    expect(help.toLowerCase()).to.include("remain unspent");
    expect(help.toLowerCase()).to.include("operator-managed");
    expect(help.toLowerCase()).to.include("privacy diagnostics");
    expect(help.toLowerCase()).to.include("outside the repo");
  });

  it("states that recipient and relayer must be distinct", () => {
    const help = helpText().toLowerCase();
    expect(help).to.include("distinct");
    expect(help).to.include("recipient and relayer");
  });

  it("uses placeholders only — no key paths or local paths", () => {
    const help = helpText();
    expect(help).to.include("<outside-repo-note-path>");
    expect(help).to.include("<snapshot-path>");
    expect(help).to.include("<recipient-pubkey>");
    expect(help).to.include("<relayer-pubkey>");
    expect(help).to.not.include(J("keys", "/"));
    expect(help).to.not.include(J("id", ".json"));
    expect(help).to.not.include(J(".config", "/solana"));
    expect(help).to.not.include("/" + ["home", ""].join("/"));
    expect(help).to.not.include(J("--", "send"));
  });
});

// ── CLI (spawn — pre-network validation paths only) ──────────────────────────

describe("withdraw_simulate: CLI", () => {
  let cliTmp: string;
  let noteFile: string;
  let snapFile: string;

  before(() => {
    cliTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cirrus-test-"));
    noteFile = path.join(cliTmp, "n.bin");
    snapFile = path.join(cliTmp, "snap.json");
    fs.writeFileSync(noteFile, "00", { mode: 0o600 });
    fs.writeFileSync(snapFile, "{}");
  });
  after(() => {
    try {
      fs.rmSync(cliTmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  /** REQUIRED with existing temp note/snapshot files swapped in. */
  function requiredWithFiles(): string[] {
    const out = [...REQUIRED];
    out[out.indexOf("--note") + 1] = noteFile;
    out[out.indexOf("--snapshot") + 1] = snapFile;
    return out;
  }

  it("--help exits 0", () => {
    const res = runCli(["--help"]);
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("shared_pool_tester_withdraw_simulate");
  });

  it("-h exits 0", () => {
    const res = runCli(["-h"]);
    expect(res.status, res.stderr).to.equal(0);
  });

  it("rejects a mainnet RPC before any flow runs", () => {
    const res = runCli([
      ...REQUIRED,
      "--rpc",
      "https://api.mainnet-beta.solana.com",
    ]);
    expect(res.status).to.not.equal(0);
    expect(res.stderr.toLowerCase()).to.include("devnet");
  });

  it("missing outside-repo note material file fails path-safely before the flow", () => {
    const missingNote = path.join(cliTmp, "missing-n.bin");
    const argvList = requiredWithFiles();
    argvList[argvList.indexOf("--note") + 1] = missingNote;
    const res = runCli(argvList);
    expect(res.status).to.not.equal(0);
    expect(res.stderr).to.include("note material file does not exist");
    expect(res.stderr).to.not.include(missingNote);
  });

  it("missing outside-repo snapshot file fails path-safely before the flow", () => {
    const missingSnap = path.join(cliTmp, "missing-snap.json");
    const argvList = requiredWithFiles();
    argvList[argvList.indexOf("--snapshot") + 1] = missingSnap;
    const res = runCli(argvList);
    expect(res.status).to.not.equal(0);
    expect(res.stderr).to.include("snapshot file does not exist");
    expect(res.stderr).to.not.include(missingSnap);
  });

  it("rejects an in-repo note material file", () => {
    const argvList = requiredWithFiles();
    argvList[argvList.indexOf("--note") + 1] = path.join(
      REPO_ROOT,
      "package.json"
    );
    const res = runCli(argvList);
    expect(res.status).to.not.equal(0);
    expect(res.stderr).to.include(
      "note material path must be outside the repository"
    );
  });

  it("--simulate with a missing wasm or proving key fails path-safely", () => {
    const missingWasm = path.join(cliTmp, "missing.wasm");
    const res = runCli([
      ...requiredWithFiles(),
      "--simulate",
      "--wasm",
      missingWasm,
      "--zkey",
      path.join(cliTmp, "missing.zkey"),
    ]);
    expect(res.status).to.not.equal(0);
    expect(res.stderr).to.include("circuit wasm file does not exist");
    expect(res.stderr).to.not.include(missingWasm);
  });

  it("--simulate with an existing wasm but missing proving key fails path-safely", () => {
    const okWasm = path.join(cliTmp, "ok.wasm");
    fs.writeFileSync(okWasm, "0");
    const missingZkey = path.join(cliTmp, "missing.zkey");
    const res = runCli([
      ...requiredWithFiles(),
      "--simulate",
      "--wasm",
      okWasm,
      "--zkey",
      missingZkey,
    ]);
    expect(res.status).to.not.equal(0);
    expect(res.stderr).to.include("proving key file does not exist");
    expect(res.stderr).to.not.include(missingZkey);
  });

  it("rejects an in-repo snapshot file path-safely", () => {
    const inRepoSnap = path.join(REPO_ROOT, "package.json");
    const argvList = requiredWithFiles();
    argvList[argvList.indexOf("--snapshot") + 1] = inRepoSnap;
    const res = runCli(argvList);
    expect(res.status).to.not.equal(0);
    expect(res.stderr).to.include(
      "snapshot path must be outside the repository"
    );
    expect(res.stderr).to.not.include(inRepoSnap);
  });

  it("rejects missing required flags", () => {
    const res = runCli(["--note", "/x/n.bin"]);
    expect(res.status).to.not.equal(0);
    expect(res.stderr).to.include("required");
  });

  it("rejects recipient equal to relayer before any network or proving step", () => {
    // No real files and no --simulate: parseArgs rejects this before the RPC
    // guard, the path guards, or any flow dependency is reached.
    const argvList = [...REQUIRED];
    argvList[argvList.indexOf("--relayer") + 1] = RECIPIENT;
    const res = runCli(argvList);
    expect(res.status).to.not.equal(0);
    expect(res.stderr).to.include(
      "--recipient and --relayer must be distinct pubkeys"
    );
  });
});

// ── npm wiring + source scan ─────────────────────────────────────────────────

describe("withdraw_simulate: npm wiring and source scan", () => {
  it("package.json wires alpha:withdraw:simulate to this script", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.["alpha:withdraw:simulate"];
    expect(script, "expected an alpha:withdraw:simulate npm script").to.be.a(
      "string"
    );
    expect(script).to.include("shared_pool_tester_withdraw_simulate.ts");
  });

  it("source has no live-send path: no send flag construction, no signing", () => {
    const src = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(src).to.not.include(J('"--', 'send"'));
    expect(src).to.not.include(J("send", "Transaction"));
    expect(src).to.not.include(J("sign", "Transaction"));
    expect(src).to.not.include(J("Key", "pair.fromSecretKey"));
    expect(src).to.not.include(J("request", "Airdrop"));
    expect(src).to.not.include(J("add", "AllowedRoot"));
  });
});
