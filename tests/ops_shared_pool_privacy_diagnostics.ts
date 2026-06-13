import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { expect } from "chai";
import {
  Diagnostic,
  DiagnosticsResult,
  DiagArgs,
  parseArgs,
  parseSnapshot,
  validateRootHex,
  readSnapshotFile,
  analyze,
  formatText,
  formatJson,
  helpText,
} from "../scripts/ops/shared_pool_privacy_diagnostics";

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "ops",
  "shared_pool_privacy_diagnostics.ts"
);
const REPO_ROOT = path.join(__dirname, "..");

const ROOT_A = "ab".repeat(32);
const ROOT_B = "cd".repeat(32);

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let counter = 0;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-diag-"));
});
after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function snapshotObj(
  leafCount: number,
  root = ROOT_A,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    version: 2,
    tree_depth: 20,
    events: [
      {
        commitment_be_hex: "11".repeat(32),
        denomination: "1000000000",
        leaf_index: 0,
        depositor: "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o",
        slot: "466467891",
      },
    ],
    last_root_be_hex: root,
    leaf_count: leafCount,
    meta: {
      fetch_commitment: "confirmed",
      source_mode: "address",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    ...extra,
  };
}

function writeSnapshot(
  leafCount: number,
  root = ROOT_A,
  extra: Record<string, unknown> = {}
): string {
  const p = path.join(tmpDir, `snap_${counter++}.json`);
  fs.writeFileSync(p, JSON.stringify(snapshotObj(leafCount, root, extra)));
  return p;
}

function baseArgs(overrides: Partial<DiagArgs> = {}): DiagArgs {
  return {
    snapshot: "/dev/null",
    leafIndex: 0,
    json: false,
    ...overrides,
  };
}

function byCode(list: Diagnostic[], code: string): Diagnostic | undefined {
  return list.find((d) => d.code === code);
}

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

// ── validateRootHex / parseSnapshot ──────────────────────────────────────────

describe("privacy_diagnostics: validateRootHex / parseSnapshot", () => {
  it("validateRootHex accepts 64-hex and rejects malformed / all-zero", () => {
    expect(() => validateRootHex(ROOT_A)).to.not.throw();
    expect(() => validateRootHex("deadbeef")).to.throw(/64 hex/);
    expect(() => validateRootHex("0".repeat(64))).to.throw(/all-zero/);
  });

  it("parseSnapshot accepts version 2 and normalizes root, leafCount, eventCount, meta", () => {
    const parsed = parseSnapshot(snapshotObj(16, ROOT_A.toUpperCase()));
    expect(parsed.version).to.equal(2);
    expect(parsed.root).to.equal(ROOT_A); // lowercased
    expect(parsed.leafCount).to.equal(16);
    expect(parsed.eventCount).to.equal(1);
    expect(parsed.meta).to.be.an("object");
  });

  it("parseSnapshot rejects version 1 (v2-only policy)", () => {
    expect(() =>
      parseSnapshot({ version: 1, last_root_be_hex: ROOT_A, leaf_count: 1 })
    ).to.throw(/version/);
  });

  it("parseSnapshot rejects malformed snapshots", () => {
    expect(() => parseSnapshot(null)).to.throw(/JSON object/);
    expect(() => parseSnapshot([])).to.throw(/JSON object/);
    expect(() =>
      parseSnapshot({ version: 3, last_root_be_hex: ROOT_A, leaf_count: 1 })
    ).to.throw(/version/);
    expect(() => parseSnapshot({ version: 2, leaf_count: 1 })).to.throw(
      /last_root_be_hex/
    );
    expect(() =>
      parseSnapshot({ version: 2, last_root_be_hex: ROOT_A, leaf_count: 0 })
    ).to.throw(/leaf_count/);
  });
});

// ── parseArgs ────────────────────────────────────────────────────────────────

describe("privacy_diagnostics: parseArgs", () => {
  it("requires --snapshot and --leaf-index", () => {
    expect(() => parseArgs(["--leaf-index", "0"])).to.throw(
      /--snapshot is required/
    );
    expect(() => parseArgs(["--snapshot", "/x"])).to.throw(
      /--leaf-index is required/
    );
  });

  it("parses all flags", () => {
    const a = parseArgs([
      "--snapshot",
      "/x/snap",
      "--leaf-index",
      "5",
      "--root",
      ROOT_A,
      "--denomination",
      "1000000000",
      "--fee",
      "1200000",
      "--recipient",
      "DiuasKhcjWKHnP5gtDf5cBEVUMqoQhcMMUZCtYb7egdv",
      "--relayer",
      "3NpDL8TgCvgVqig4REBPDos1YuQarFqh7PEebcq7WGhu",
      "--commitment-age-slots",
      "120",
      "--json",
    ]);
    expect(a.snapshot).to.equal("/x/snap");
    expect(a.leafIndex).to.equal(5);
    expect(a.root).to.equal(ROOT_A);
    expect(a.denomination).to.equal("1000000000");
    expect(a.fee).to.equal("1200000");
    expect(a.recipient).to.match(/^Diuas/);
    expect(a.relayer).to.match(/^3NpD/);
    expect(a.commitmentAgeSlots).to.equal(120);
    expect(a.json).to.equal(true);
  });

  it("rejects unknown flags, missing values, and malformed numeric/root", () => {
    expect(() => parseArgs(["--nope"])).to.throw(/unknown flag/);
    expect(() => parseArgs(["--snapshot"])).to.throw(/requires a value/);
    expect(() =>
      parseArgs(["--snapshot", "/x", "--leaf-index", "-1"])
    ).to.throw(/non-negative integer/);
    expect(() =>
      parseArgs(["--snapshot", "/x", "--leaf-index", "0", "--root", "xyz"])
    ).to.throw(/64 hex/);
    expect(() =>
      parseArgs(["--snapshot", "/x", "--leaf-index", "0", "--fee", "abc"])
    ).to.throw(/--fee/);
  });

  it("rejects integers beyond the safe integer range; accepts normal values", () => {
    // 9007199254740992 === 2^53 === Number.MAX_SAFE_INTEGER + 1
    expect(() =>
      parseArgs(["--snapshot", "/x", "--leaf-index", "9007199254740992"])
    ).to.throw(/safe integer range/);
    expect(() =>
      parseArgs([
        "--snapshot",
        "/x",
        "--leaf-index",
        "0",
        "--commitment-age-slots",
        "9007199254740992",
      ])
    ).to.throw(/safe integer range/);
    const ok = parseArgs([
      "--snapshot",
      "/x",
      "--leaf-index",
      "5",
      "--commitment-age-slots",
      "120",
    ]);
    expect(ok.leafIndex).to.equal(5);
    expect(ok.commitmentAgeSlots).to.equal(120);
  });
});

// ── analyze: anonymity set ───────────────────────────────────────────────────

describe("privacy_diagnostics: analyze anonymity set", () => {
  it("leaf_count < 8 => SMALL_ANONYMITY_SET high", () => {
    const r = analyze(
      parseSnapshot(snapshotObj(4)),
      baseArgs({ leafIndex: 0 })
    );
    const d = byCode(r.warnings, "SMALL_ANONYMITY_SET");
    expect(d, "expected SMALL_ANONYMITY_SET").to.exist;
    expect(d!.severity).to.equal("high");
    expect(r.ok).to.equal(true); // warnings do not fail
  });

  it("8 <= leaf_count < 32 => SMALL_ANONYMITY_SET warning", () => {
    const r = analyze(
      parseSnapshot(snapshotObj(16)),
      baseArgs({ leafIndex: 8 })
    );
    const d = byCode(r.warnings, "SMALL_ANONYMITY_SET");
    expect(d, "expected SMALL_ANONYMITY_SET").to.exist;
    expect(d!.severity).to.equal("warning");
  });

  it("leaf_count >= 32 => no SMALL_ANONYMITY_SET", () => {
    const r = analyze(
      parseSnapshot(snapshotObj(64)),
      baseArgs({ leafIndex: 30 })
    );
    expect(byCode(r.warnings, "SMALL_ANONYMITY_SET")).to.be.undefined;
  });
});

// ── analyze: leaf position ───────────────────────────────────────────────────

describe("privacy_diagnostics: analyze leaf position", () => {
  it("latest leaf => SELECTED_LEAF_IS_LATEST high", () => {
    const r = analyze(
      parseSnapshot(snapshotObj(40)),
      baseArgs({ leafIndex: 39 })
    );
    const d = byCode(r.warnings, "SELECTED_LEAF_IS_LATEST");
    expect(d, "expected SELECTED_LEAF_IS_LATEST").to.exist;
    expect(d!.severity).to.equal("high");
    expect(byCode(r.warnings, "SELECTED_LEAF_NEAR_EDGE")).to.be.undefined;
  });

  it("near-edge (front) leaf => SELECTED_LEAF_NEAR_EDGE warning", () => {
    const r = analyze(
      parseSnapshot(snapshotObj(40)),
      baseArgs({ leafIndex: 1 })
    );
    const d = byCode(r.warnings, "SELECTED_LEAF_NEAR_EDGE");
    expect(d, "expected SELECTED_LEAF_NEAR_EDGE").to.exist;
    expect(d!.severity).to.equal("warning");
  });

  it("middle leaf => neither latest nor near-edge", () => {
    const r = analyze(
      parseSnapshot(snapshotObj(40)),
      baseArgs({ leafIndex: 20 })
    );
    expect(byCode(r.warnings, "SELECTED_LEAF_IS_LATEST")).to.be.undefined;
    expect(byCode(r.warnings, "SELECTED_LEAF_NEAR_EDGE")).to.be.undefined;
  });

  it("out-of-range leaf index => LEAF_INDEX_OUT_OF_RANGE failure, ok=false", () => {
    const r = analyze(
      parseSnapshot(snapshotObj(4)),
      baseArgs({ leafIndex: 99 })
    );
    const d = byCode(r.failures, "LEAF_INDEX_OUT_OF_RANGE");
    expect(d, "expected LEAF_INDEX_OUT_OF_RANGE").to.exist;
    expect(d!.severity).to.equal("high");
    expect(r.ok).to.equal(false);
  });
});

// ── analyze: root mismatch + visibility + always-on ──────────────────────────

describe("privacy_diagnostics: analyze root + visibility", () => {
  it("root mismatch => ROOT_MISMATCH failure, ok=false", () => {
    const r = analyze(
      parseSnapshot(snapshotObj(40, ROOT_A)),
      baseArgs({ leafIndex: 20, root: ROOT_B })
    );
    const d = byCode(r.failures, "ROOT_MISMATCH");
    expect(d, "expected ROOT_MISMATCH").to.exist;
    expect(r.ok).to.equal(false);
  });

  it("matching root => no ROOT_MISMATCH, ok=true", () => {
    const r = analyze(
      parseSnapshot(snapshotObj(40, ROOT_A)),
      baseArgs({ leafIndex: 20, root: ROOT_A.toUpperCase() })
    );
    expect(byCode(r.failures, "ROOT_MISMATCH")).to.be.undefined;
    expect(r.ok).to.equal(true);
  });

  it("visibility warnings appear only when their flags are present", () => {
    const without = analyze(
      parseSnapshot(snapshotObj(40)),
      baseArgs({ leafIndex: 20 })
    );
    expect(byCode(without.warnings, "AMOUNT_VISIBILITY")).to.be.undefined;
    expect(byCode(without.warnings, "FEE_VISIBILITY")).to.be.undefined;
    expect(byCode(without.warnings, "RECIPIENT_VISIBILITY")).to.be.undefined;
    expect(byCode(without.warnings, "RELAYER_VISIBILITY")).to.be.undefined;

    const withAll = analyze(
      parseSnapshot(snapshotObj(40)),
      baseArgs({
        leafIndex: 20,
        denomination: "1000000000",
        fee: "1200000",
        recipient: "DiuasKhcjWKHnP5gtDf5cBEVUMqoQhcMMUZCtYb7egdv",
        relayer: "3NpDL8TgCvgVqig4REBPDos1YuQarFqh7PEebcq7WGhu",
      })
    );
    expect(byCode(withAll.warnings, "AMOUNT_VISIBILITY")).to.exist;
    expect(byCode(withAll.warnings, "FEE_VISIBILITY")).to.exist;
    expect(byCode(withAll.warnings, "RECIPIENT_VISIBILITY")).to.exist;
    expect(byCode(withAll.warnings, "RELAYER_VISIBILITY")).to.exist;
  });

  it("always emits timing, operator-root, and simulate-only diagnostics", () => {
    const r = analyze(
      parseSnapshot(snapshotObj(64)),
      baseArgs({ leafIndex: 30 })
    );
    expect(byCode(r.warnings, "TIMING_RISK")).to.exist;
    expect(byCode(r.warnings, "OPERATOR_ROOT_RISK")).to.exist;
    expect(byCode(r.warnings, "SIMULATE_ONLY_NOT_PRIVACY")).to.exist;
  });
});

// ── formatting ───────────────────────────────────────────────────────────────

describe("privacy_diagnostics: formatting", () => {
  it("formatJson emits a stable, parseable object with snapshot metadata", () => {
    const result = analyze(
      parseSnapshot(snapshotObj(16)),
      baseArgs({ leafIndex: 8 })
    );
    const parsed = JSON.parse(formatJson(result)) as DiagnosticsResult;
    expect(parsed).to.have.all.keys(
      "ok",
      "root",
      "snapshotVersion",
      "leafCount",
      "eventCount",
      "selectedLeafIndex",
      "warnings",
      "failures"
    );
    expect(parsed.root).to.equal(ROOT_A);
    expect(parsed.snapshotVersion).to.equal(2);
    expect(parsed.leafCount).to.equal(16);
    expect(parsed.eventCount).to.equal(1);
    expect(parsed.selectedLeafIndex).to.equal(8);
    expect(parsed.warnings).to.be.an("array");
    expect(parsed.failures).to.be.an("array");
  });

  it("formatText is human-readable and lists snapshot metadata and codes", () => {
    const result = analyze(
      parseSnapshot(snapshotObj(4)),
      baseArgs({ leafIndex: 3 })
    );
    const text = formatText(result);
    expect(text).to.include("privacy diagnostics");
    expect(text).to.include("snapshot_version:");
    expect(text).to.include("event_count:");
    expect(text).to.include("leaf_count:");
    expect(text).to.include("SMALL_ANONYMITY_SET");
  });
});

// ── readSnapshotFile ─────────────────────────────────────────────────────────

describe("privacy_diagnostics: readSnapshotFile", () => {
  it("reads a valid snapshot file", () => {
    const p = writeSnapshot(16);
    const parsed = readSnapshotFile(p);
    expect(parsed.leafCount).to.equal(16);
    expect(parsed.root).to.equal(ROOT_A);
  });

  it("throws on a missing file and on invalid JSON", () => {
    expect(() => readSnapshotFile(path.join(tmpDir, "nope.json"))).to.throw(
      /cannot read snapshot/
    );
    const bad = path.join(tmpDir, "bad.json");
    fs.writeFileSync(bad, "{ not json }");
    expect(() => readSnapshotFile(bad)).to.throw(/invalid JSON/);
  });
});

// ── CLI (spawn) ──────────────────────────────────────────────────────────────

describe("privacy_diagnostics: CLI", () => {
  it("--help exits 0 and describes offline/read-only scope", () => {
    const res = runCli(["--help"]);
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("shared_pool_privacy_diagnostics");
    expect(res.stdout.toLowerCase()).to.include("offline");
    expect(res.stdout.toLowerCase()).to.include("read-only");
  });

  it("-h exits 0", () => {
    const res = runCli(["-h"]);
    expect(res.status, res.stderr).to.equal(0);
  });

  it("valid snapshot text run exits 0", () => {
    const p = writeSnapshot(40);
    const res = runCli(["--snapshot", p, "--leaf-index", "20"]);
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("privacy diagnostics");
  });

  it("--json run emits a parseable object", () => {
    const p = writeSnapshot(16);
    const res = runCli(["--snapshot", p, "--leaf-index", "8", "--json"]);
    expect(res.status, res.stderr).to.equal(0);
    const parsed = JSON.parse(res.stdout) as DiagnosticsResult;
    expect(parsed.ok).to.equal(true);
    expect(parsed.leafCount).to.equal(16);
  });

  it("root mismatch exits non-zero", () => {
    const p = writeSnapshot(40, ROOT_A);
    const res = runCli([
      "--snapshot",
      p,
      "--leaf-index",
      "20",
      "--root",
      ROOT_B,
    ]);
    expect(res.status).to.not.equal(0);
  });

  it("out-of-range leaf index exits non-zero", () => {
    const p = writeSnapshot(4);
    const res = runCli(["--snapshot", p, "--leaf-index", "99"]);
    expect(res.status).to.not.equal(0);
  });

  it("malformed snapshot exits non-zero", () => {
    const bad = path.join(tmpDir, "malformed.json");
    fs.writeFileSync(bad, JSON.stringify({ version: 2, leaf_count: 0 }));
    const res = runCli(["--snapshot", bad, "--leaf-index", "0"]);
    expect(res.status).to.not.equal(0);
  });
});

// ── help safety + source scan ────────────────────────────────────────────────

describe("privacy_diagnostics: help safety and source scan", () => {
  it("help uses placeholders only — no concrete key paths", () => {
    const help = helpText();
    expect(help).to.not.include("keys/");
    expect(help).to.not.include("id.json");
    expect(help).to.not.include(".config/solana");
  });

  it("help states it is offline/read-only and reads no secrets, keys, proofs, or witnesses", () => {
    const help = helpText().toLowerCase();
    expect(help).to.include("offline");
    expect(help).to.include("read-only");
    expect(help).to.include("secret");
    expect(help).to.include("proof");
    expect(help).to.include("witness");
  });

  it("script source performs no chain mutation and no key handling", () => {
    const src = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(src).to.not.include("@solana/web3.js");
    expect(src).to.not.include("sendTransaction");
    expect(src).to.not.include(".rpc(");
    expect(src).to.not.include("requestAirdrop");
    expect(src).to.not.include("addAllowedRoot");
    expect(src).to.not.include("depositNote(");
    expect(src).to.not.include("deposit_note(");
    expect(src).to.not.include("withdrawZk(");
    expect(src).to.not.include("withdraw_zk(");
    expect(src).to.not.include("Keypair.generate");
    expect(src).to.not.include("new Keypair");
    expect(src).to.not.include("readKeypair");
  });

  it("script source reads no proof / public / witness / wasm / zkey / ptau artifacts", () => {
    const src = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(src).to.not.include("proof.json");
    expect(src).to.not.include("public.json");
    expect(src).to.not.include("witness.json");
    expect(src).to.not.include(".zkey");
    expect(src).to.not.include(".wasm");
    expect(src).to.not.include(".ptau");
  });
});
