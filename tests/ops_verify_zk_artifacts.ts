import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync } from "child_process";
import { expect } from "chai";
import {
  ARTIFACT_SPECS,
  sha256File,
  loadManifest,
  expectedHashFor,
  verifyArtifact,
  evaluate,
  parseArgs,
  selectedArtifacts,
} from "../scripts/ops/verify_zk_artifacts";

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "ops",
  "verify_zk_artifacts.ts"
);
const REPO_ROOT = path.join(__dirname, "..");
const REAL_MANIFEST = path.join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "zk",
  "withdraw_sol_v1",
  "artifact_manifest.json"
);

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ── Temp scratch (outside the repo) ─────────────────────────────────────────────

let tmpDir: string;
let counter = 0;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-zk-"));
});
after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function freshDir(): string {
  const d = path.join(tmpDir, `c${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Distinct marker strings let test 8 assert that file CONTENTS are never printed.
const WASM_CONTENT = Buffer.from("dummy-wasm-bytes-MARKER_WASM_b91");
const ZKEY_CONTENT = Buffer.from("dummy-zkey-bytes-MARKER_ZKEY_a47");
const VK_CONTENT = Buffer.from('{"vk":"dummy-MARKER_VK_c12"}');

interface Fixture {
  dir: string;
  wasmPath: string;
  zkeyPath: string;
  vkPath: string;
  wasmHash: string;
  zkeyHash: string;
  vkHash: string;
}

function makeArtifacts(): Fixture {
  const dir = freshDir();
  const wasmPath = path.join(dir, "circuit.wasm");
  const zkeyPath = path.join(dir, "circuit.zkey");
  const vkPath = path.join(dir, "verification_key.json");
  fs.writeFileSync(wasmPath, WASM_CONTENT);
  fs.writeFileSync(zkeyPath, ZKEY_CONTENT);
  fs.writeFileSync(vkPath, VK_CONTENT);
  return {
    dir,
    wasmPath,
    zkeyPath,
    vkPath,
    wasmHash: sha256(WASM_CONTENT),
    zkeyHash: sha256(ZKEY_CONTENT),
    vkHash: sha256(VK_CONTENT),
  };
}

function writeManifest(dir: string, obj: unknown): string {
  const p = path.join(dir, "manifest.json");
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

// ── CLI runner ──────────────────────────────────────────────────────────────────

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliResult {
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

// ── 1. valid manifest + matching temp files ─────────────────────────────────────

describe("verify_zk_artifacts: matching artifacts", () => {
  it("1. accepts a manifest + temp files whose sha256 matches expected values", () => {
    const a = makeArtifacts();
    const manifestPath = writeManifest(a.dir, {
      proving_key_hash_sha256: a.zkeyHash,
      wasm_hash_sha256: a.wasmHash,
      verification_key_hash_sha256: a.vkHash,
    });
    const m = loadManifest(manifestPath);
    const results = [
      verifyArtifact(m, ARTIFACT_SPECS.zkey, a.zkeyPath),
      verifyArtifact(m, ARTIFACT_SPECS.wasm, a.wasmPath),
      verifyArtifact(m, ARTIFACT_SPECS.vk, a.vkPath),
    ];
    expect(results.map((r) => r.status)).to.deep.equal([
      "MATCH",
      "MATCH",
      "MATCH",
    ]);
    expect(evaluate(results, false).ok).to.equal(true);
  });

  it("1b. CLI exits 0 and reports PASS when all artifacts match", () => {
    const a = makeArtifacts();
    const manifestPath = writeManifest(a.dir, {
      proving_key_hash_sha256: a.zkeyHash,
      wasm_hash_sha256: a.wasmHash,
      verification_key_hash_sha256: a.vkHash,
    });
    const res = runCli([
      "--manifest",
      manifestPath,
      "--zkey",
      a.zkeyPath,
      "--wasm",
      a.wasmPath,
      "--vk",
      a.vkPath,
    ]);
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("RESULT: PASS");
    expect(res.stdout).to.include("MATCH");
  });
});

// ── 2-5. error paths ─────────────────────────────────────────────────────────────

describe("verify_zk_artifacts: error paths", () => {
  it("2. rejects a missing manifest", () => {
    const missing = path.join(freshDir(), "nope.json");
    expect(() => loadManifest(missing)).to.throw(/cannot read manifest/);
    const a = makeArtifacts();
    const res = runCli(["--manifest", missing, "--zkey", a.zkeyPath]);
    expect(res.status).to.not.equal(0);
  });

  it("3. rejects a missing artifact file", () => {
    const a = makeArtifacts();
    const manifestPath = writeManifest(a.dir, {
      proving_key_hash_sha256: a.zkeyHash,
    });
    const m = loadManifest(manifestPath);
    const missing = path.join(a.dir, "absent.zkey");
    const r = verifyArtifact(m, ARTIFACT_SPECS.zkey, missing);
    expect(r.status).to.equal("FILE_MISSING");
    expect(evaluate([r], false).ok).to.equal(false);

    const res = runCli(["--manifest", manifestPath, "--zkey", missing]);
    expect(res.status).to.not.equal(0);
  });

  it("4. rejects a malformed JSON manifest", () => {
    const dir = freshDir();
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{ not valid json ");
    expect(() => loadManifest(bad)).to.throw(/not valid JSON/);
    const a = makeArtifacts();
    const res = runCli(["--manifest", bad, "--zkey", a.zkeyPath]);
    expect(res.status).to.not.equal(0);
  });

  it("4b. rejects a manifest that is not a JSON object (unsupported shape)", () => {
    const dir = freshDir();
    const arr = path.join(dir, "arr.json");
    fs.writeFileSync(arr, "[1,2,3]");
    expect(() => loadManifest(arr)).to.throw(/unsupported manifest shape/);
  });

  it("5. rejects a hash mismatch", () => {
    const a = makeArtifacts();
    const manifestPath = writeManifest(a.dir, {
      proving_key_hash_sha256: "00".repeat(32),
    });
    const m = loadManifest(manifestPath);
    const r = verifyArtifact(m, ARTIFACT_SPECS.zkey, a.zkeyPath);
    expect(r.status).to.equal("MISMATCH");
    expect(r.actualHash).to.equal(a.zkeyHash);
    expect(evaluate([r], false).ok).to.equal(false);
  });
});

// ── 6. --json output ─────────────────────────────────────────────────────────────

describe("verify_zk_artifacts: --json output", () => {
  it("6. emits parseable JSON with ok + artifacts", () => {
    const a = makeArtifacts();
    const manifestPath = writeManifest(a.dir, {
      proving_key_hash_sha256: a.zkeyHash,
    });
    const res = runCli([
      "--manifest",
      manifestPath,
      "--zkey",
      a.zkeyPath,
      "--json",
    ]);
    expect(res.status, res.stderr).to.equal(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).to.equal(true);
    expect(parsed.artifacts).to.be.an("array").with.length(1);
    expect(parsed.artifacts[0].artifact).to.equal("zkey");
    expect(parsed.artifacts[0].status).to.equal("MATCH");
    expect(parsed.artifacts[0].expected_sha256).to.equal(a.zkeyHash);
  });
});

// ── 7. CLI exits non-zero on mismatch ────────────────────────────────────────────

describe("verify_zk_artifacts: CLI exit code", () => {
  it("7. exits non-zero on a hash mismatch", () => {
    const a = makeArtifacts();
    const manifestPath = writeManifest(a.dir, {
      proving_key_hash_sha256: "ab".repeat(32),
    });
    const res = runCli(["--manifest", manifestPath, "--zkey", a.zkeyPath]);
    expect(res.status).to.not.equal(0);
    expect(res.stdout).to.include("RESULT: FAIL");
    expect(res.stdout).to.include("hash mismatch");
  });
});

// ── 8. never prints artifact contents ────────────────────────────────────────────

describe("verify_zk_artifacts: does not print artifact contents", () => {
  it("8. CLI output excludes the artifact file contents", () => {
    const a = makeArtifacts();
    const manifestPath = writeManifest(a.dir, {
      proving_key_hash_sha256: a.zkeyHash,
      wasm_hash_sha256: a.wasmHash,
      verification_key_hash_sha256: a.vkHash,
    });
    const res = runCli([
      "--manifest",
      manifestPath,
      "--zkey",
      a.zkeyPath,
      "--wasm",
      a.wasmPath,
      "--vk",
      a.vkPath,
    ]);
    const out = res.stdout + res.stderr;
    expect(out).to.not.include("MARKER_WASM_b91");
    expect(out).to.not.include("MARKER_ZKEY_a47");
    expect(out).to.not.include("MARKER_VK_c12");
    // the hashes themselves must be present
    expect(out).to.include(a.zkeyHash);
  });
});

// ── Safe-by-default: NO_EXPECTED_HASH ────────────────────────────────────────────

describe("verify_zk_artifacts: missing manifest hash is a failure by default", () => {
  it("fails by default when the manifest has no hash for a provided artifact", () => {
    const a = makeArtifacts();
    // manifest has a zkey hash but NO wasm hash
    const manifestPath = writeManifest(a.dir, {
      proving_key_hash_sha256: a.zkeyHash,
    });
    const m = loadManifest(manifestPath);
    const r = verifyArtifact(m, ARTIFACT_SPECS.wasm, a.wasmPath);
    expect(r.status).to.equal("NO_EXPECTED_HASH");
    expect(r.field).to.equal(null);
    expect(evaluate([r], false).ok).to.equal(false);

    const res = runCli([
      "--manifest",
      manifestPath,
      "--zkey",
      a.zkeyPath,
      "--wasm",
      a.wasmPath,
    ]);
    expect(res.status).to.not.equal(0);
    expect(res.stdout).to.include("RESULT: FAIL");
    expect(res.stdout).to.include("cannot be verified");
  });

  it("passes the same case only with --allow-unverified, marked UNVERIFIED", () => {
    const a = makeArtifacts();
    const manifestPath = writeManifest(a.dir, {
      proving_key_hash_sha256: a.zkeyHash,
    });
    const m = loadManifest(manifestPath);
    const r = verifyArtifact(m, ARTIFACT_SPECS.wasm, a.wasmPath);
    expect(evaluate([r], true).ok).to.equal(true);

    const res = runCli([
      "--manifest",
      manifestPath,
      "--zkey",
      a.zkeyPath,
      "--wasm",
      a.wasmPath,
      "--allow-unverified",
    ]);
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("UNVERIFIED");
    expect(res.stdout).to.include("RESULT: PASS");
  });
});

// ── Real fixture manifest robustness ─────────────────────────────────────────────

describe("verify_zk_artifacts: real fixture manifest shape", () => {
  it("resolves zkey and vk fields, but the wasm has no hash in the current manifest", () => {
    const m = loadManifest(REAL_MANIFEST);
    const z = expectedHashFor(m, ARTIFACT_SPECS.zkey);
    const v = expectedHashFor(m, ARTIFACT_SPECS.vk);
    const w = expectedHashFor(m, ARTIFACT_SPECS.wasm);
    expect(z.field).to.equal("proving_key_hash_sha256");
    expect(z.hash).to.match(/^[0-9a-f]{64}$/);
    expect(v.field).to.equal("verification_key_hash_sha256");
    expect(v.hash).to.match(/^[0-9a-f]{64}$/);
    // The current manifest records no wasm hash — must not be guessed.
    expect(w.field).to.equal(null);
    expect(w.hash).to.equal(null);
  });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("verify_zk_artifacts: parseArgs", () => {
  it("requires --manifest", () => {
    expect(() => parseArgs(["--zkey", "/x.zkey"])).to.throw(
      /--manifest is required/
    );
  });

  it("requires at least one of --zkey / --wasm / --vk", () => {
    expect(() => parseArgs(["--manifest", "/m.json"])).to.throw(
      /at least one of/
    );
  });

  it("parses flags and selects the provided artifacts in order", () => {
    const args = parseArgs([
      "--manifest",
      "/m.json",
      "--zkey",
      "/a.zkey",
      "--wasm",
      "/a.wasm",
      "--json",
      "--allow-unverified",
    ]);
    expect(args.manifest).to.equal("/m.json");
    expect(args.zkey).to.equal("/a.zkey");
    expect(args.wasm).to.equal("/a.wasm");
    expect(args.vk).to.equal(undefined);
    expect(args.json).to.equal(true);
    expect(args.allowUnverified).to.equal(true);
    const sel = selectedArtifacts(args).map((s) => s.spec.key);
    expect(sel).to.deep.equal(["zkey", "wasm"]);
  });

  it("rejects unknown flags and missing values", () => {
    expect(() => parseArgs(["--nope"])).to.throw(/unknown flag/);
    expect(() => parseArgs(["--manifest"])).to.throw(/requires a value/);
  });

  it("sha256File matches the node crypto digest of the same bytes", () => {
    const a = makeArtifacts();
    expect(sha256File(a.zkeyPath)).to.equal(sha256(ZKEY_CONTENT));
    expect(sha256File(a.zkeyPath)).to.match(/^[0-9a-f]{64}$/);
  });
});

// ── 9-11. static safety scan ─────────────────────────────────────────────────────
//
// Patterns are assembled with join() so this test file does not itself contain
// the forbidden substrings consecutively (avoids repository safety-grep noise).

describe("verify_zk_artifacts: static safety scan", () => {
  const join = (...parts: string[]) => parts.join("");
  let src: string;

  before(() => {
    src = fs.readFileSync(SCRIPT_PATH, "utf8");
  });

  it("9. no network / RPC / keypair usage", () => {
    expect(src).to.not.include(join("send", "RawTransaction"));
    expect(src).to.not.include(join("send", "Transaction"));
    expect(src).to.not.include(join(".", "rpc", "("));
    expect(src).to.not.include(join("request", "Airdrop"));
    expect(src).to.not.include(join("@solana", "/web3.js"));
    expect(src).to.not.include(join("new ", "Connection"));
    expect(src).to.not.include(join("Web", "Socket"));
    expect(src).to.not.include(join("Key", "pair"));
  });

  it("10. no file-write APIs (read-only)", () => {
    expect(src).to.not.include(join("write", "FileSync"));
    expect(src).to.not.include(join("append", "FileSync"));
    expect(src).to.not.include(join("create", "WriteStream"));
    expect(src).to.not.include(join("mkdir", "Sync"));
    expect(src).to.not.include(join("unlink", "Sync"));
    expect(src).to.not.include(join("rm", "Sync"));
  });

  it("11. uses only read-oriented fs APIs", () => {
    expect(src).to.include("readFileSync");
    expect(src).to.include("existsSync");
    expect(src).to.include("createHash");
  });
});
