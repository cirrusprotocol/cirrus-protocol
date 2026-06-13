import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync } from "child_process";
import { expect } from "chai";
import {
  DEFAULTS,
  PlannerArgs,
  parseArgs,
  validatePrepare,
  validateResume,
  validateSecretOutputPath,
  isSafeOutputDir,
  evaluatePlannerArtifacts,
  caveats,
  planSteps,
  helpText,
  buildDepositCommand,
  buildSubmitRootCommand,
  buildInspectRootCommand,
  buildInspectNullifierCommand,
  buildWitnessExportCommand,
  buildSnarkjsCommand,
  buildSimulateCommand,
} from "../scripts/ops/devnet_alpha_plan";

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "ops",
  "devnet_alpha_plan.ts"
);
const REPO_ROOT = path.join(__dirname, "..");

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

let tmpDir: string;
let counter = 0;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-plan-"));
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

function fullArgs(overrides: Partial<PlannerArgs> = {}): PlannerArgs {
  return {
    rpc: DEFAULTS.rpc,
    programId: DEFAULTS.programId,
    artifactManifest: "/tmp/m.json",
    wasm: "/tmp/c.wasm",
    zkey: "/tmp/c.zkey",
    secretOutput: "/tmp/secret.hex",
    recipient: "DiuasKhcjWKHnP5gtDf5cBEVUMqoQhcMMUZCtYb7egdv",
    relayer: "3NpDL8TgCvgVqig4REBPDos1YuQarFqh7PEebcq7WGhu",
    denomination: DEFAULTS.denomination,
    fee: DEFAULTS.fee,
    outputDir: DEFAULTS.outputDir,
    allowUnverifiedWasm: false,
    dryRun: false,
    snapshot: "/tmp/snap.json",
    leafIndex: 4,
    root: "06ad62f8b0e1a968d51d6fac563586b70f8d8e3946726c2491495c2d644ca381",
    skipNoteGeneration: false,
    ...overrides,
  };
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

// Builds a temp manifest (zkey hash only, no wasm hash) + matching artifact files.
function setupResumeArtifacts(): {
  dir: string;
  manifestPath: string;
  zkey: string;
  wasm: string;
} {
  const dir = freshDir();
  const zkey = path.join(dir, "c.zkey");
  const wasm = path.join(dir, "c.wasm");
  const zkeyBuf = Buffer.from("dummy-zkey-content");
  fs.writeFileSync(zkey, zkeyBuf);
  fs.writeFileSync(wasm, Buffer.from("dummy-wasm-content"));
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ proving_key_hash_sha256: sha256(zkeyBuf) })
  );
  return { dir, manifestPath, zkey, wasm };
}

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("devnet_alpha_plan: parseArgs", () => {
  it("1. applies documented defaults", () => {
    const a = parseArgs([]);
    expect(a.rpc).to.equal("https://api.devnet.solana.com");
    expect(a.programId).to.equal(
      "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq"
    );
    expect(a.denomination).to.equal(1000000000n);
    expect(a.fee).to.equal(1200000n);
    expect(a.outputDir).to.equal("/tmp/cirrus-devnet-alpha");
    expect(a.dryRun).to.equal(false);
    expect(a.allowUnverifiedWasm).to.equal(false);
    expect(a.skipNoteGeneration).to.equal(false);
  });

  it("1b. rejects unknown flags, missing values, malformed numeric/root", () => {
    expect(() => parseArgs(["--nope"])).to.throw(/unknown flag/);
    expect(() => parseArgs(["--rpc"])).to.throw(/requires a value/);
    expect(() => parseArgs(["--leaf-index", "-1"])).to.throw(/non-negative/);
    expect(() => parseArgs(["--root", "xyz"])).to.throw(/64-char hex/);
  });

  it("--json is not a supported flag (removed); it is rejected", () => {
    expect(() => parseArgs(["--json"])).to.throw(/unknown flag: --json/);
  });
});

// ── required fields ─────────────────────────────────────────────────────────────

describe("devnet_alpha_plan: required fields", () => {
  it("prepare mode lists missing required flags", () => {
    const missing = validatePrepare(parseArgs([]));
    expect(missing).to.include.members([
      "--artifact-manifest",
      "--wasm",
      "--zkey",
      "--secret-output",
      "--recipient",
      "--relayer",
    ]);
  });

  it("prepare passes when all required flags are present", () => {
    expect(validatePrepare(fullArgs())).to.deep.equal([]);
  });

  it("resume mode requires snapshot/leaf-index/root/secret-output/recipient/relayer + wasm/zkey/artifact-manifest", () => {
    const missing = validateResume(parseArgs([]));
    expect(missing).to.include.members([
      "--snapshot",
      "--leaf-index",
      "--root",
      "--secret-output",
      "--recipient",
      "--relayer",
      "--wasm",
      "--zkey",
      "--artifact-manifest",
    ]);
  });
});

// ── secret-output path safety ────────────────────────────────────────────────────

describe("devnet_alpha_plan: secret-output path safety", () => {
  it("refuses an in-repo non-ignored secret-output; allows ignored/outside", () => {
    const inRepo = path.join(REPO_ROOT, "scratch-secret.hex");
    expect(() =>
      validateSecretOutputPath(inRepo, REPO_ROOT, () => false)
    ).to.throw(/inside the repository/i);
    expect(() =>
      validateSecretOutputPath(inRepo, REPO_ROOT, () => true)
    ).to.not.throw();
    expect(() =>
      validateSecretOutputPath(
        path.join(os.tmpdir(), "s.hex"),
        REPO_ROOT,
        () => false
      )
    ).to.not.throw();
  });

  it("isSafeOutputDir accepts outside-repo / tmp, rejects in-repo", () => {
    expect(isSafeOutputDir("/tmp/cirrus-devnet-alpha", REPO_ROOT)).to.equal(
      true
    );
    expect(isSafeOutputDir(path.join(os.tmpdir(), "x"), REPO_ROOT)).to.equal(
      true
    );
    expect(isSafeOutputDir(path.join(REPO_ROOT, "out"), REPO_ROOT)).to.equal(
      false
    );
  });
});

// ── wasm verification gate ───────────────────────────────────────────────────────

describe("devnet_alpha_plan: wasm verification gate", () => {
  it("refuses wasm with no manifest hash unless --allow-unverified-wasm", () => {
    const { manifestPath, zkey, wasm } = setupResumeArtifacts();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const check = evaluatePlannerArtifacts(manifest, zkey, wasm, false);
    expect(check.ok).to.equal(false);
    expect(check.reasons.join(" ")).to.match(/wasm/);
    expect(check.wasmUnverified).to.equal(false);
  });

  it("allows unverified wasm only with the flag, marked UNVERIFIED; zkey stays strict", () => {
    const { manifestPath, zkey, wasm } = setupResumeArtifacts();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const check = evaluatePlannerArtifacts(manifest, zkey, wasm, true);
    expect(check.ok).to.equal(true);
    expect(check.wasmUnverified).to.equal(true);
    const zres = check.results.find((r) => r.key === "zkey");
    expect(zres && zres.status).to.equal("MATCH");
  });

  it("a zkey hash mismatch always fails, even with --allow-unverified-wasm", () => {
    const { zkey, wasm } = setupResumeArtifacts();
    const manifest = { proving_key_hash_sha256: "ab".repeat(32) };
    const check = evaluatePlannerArtifacts(manifest, zkey, wasm, true);
    expect(check.ok).to.equal(false);
    expect(check.reasons.join(" ")).to.match(/zkey: hash mismatch/);
  });
});

// ── command builders: instructions only, no mutations ────────────────────────────

describe("devnet_alpha_plan: command builders are safe instructions", () => {
  const a = fullArgs();
  const allBuilt = [
    buildDepositCommand(a, "deadbeef"),
    buildSubmitRootCommand(a),
    buildInspectRootCommand(a),
    buildInspectNullifierCommand(a),
    buildWitnessExportCommand(a),
    buildSnarkjsCommand(a),
    buildSimulateCommand(a),
  ];

  it("deposit & root-submit & simulate are printed as command strings", () => {
    expect(buildDepositCommand(a, "deadbeef")).to.include(
      "deposit_note_devnet.ts"
    );
    expect(buildSubmitRootCommand(a)).to.include("submit_root_devnet.ts");
    expect(buildSimulateCommand(a)).to.include("withdraw_zk_devnet.ts");
    expect(buildSimulateCommand(a)).to.include("--simulate");
  });

  it("no builder ever constructs a live-send flag", () => {
    for (const cmd of allBuilt) {
      expect(cmd).to.not.include("--" + "send");
    }
  });

  it("the root-submit command is the dry-run form (no live --yes)", () => {
    const sub = buildSubmitRootCommand(a);
    expect(sub).to.include("submit_root_devnet.ts");
    expect(sub).to.include("--dry-run");
    expect(sub).to.not.include("--yes");
  });

  it("keypair references in printed commands are placeholders, not real paths", () => {
    const dep = buildDepositCommand(a, "deadbeef");
    const sub = buildSubmitRootCommand(a);
    expect(dep).to.include("<your-depositor-keypair.json>");
    expect(sub).to.include("<root-submitter-keypair.json>");
    for (const cmd of [dep, sub]) {
      expect(cmd).to.not.include("keys/");
      expect(cmd).to.not.include("id.json");
    }
  });

  it("provides caveats and plan steps and frames itself as a planner", () => {
    const c = caveats().join("\n").toLowerCase();
    expect(c).to.include("planner");
    expect(c).to.include("no privacy guarantee");
    expect(c).to.include("never submits roots");
    expect(planSteps().length).to.be.greaterThan(3);
  });
});

// ── CLI: prepare --dry-run ───────────────────────────────────────────────────────

describe("devnet_alpha_plan: CLI prepare --dry-run", () => {
  it("prints planned steps and does not write the secret (no mutation run)", () => {
    const dir = freshDir();
    const secretOut = path.join(dir, "secret.hex");
    const res = runCli([
      "--dry-run",
      "--artifact-manifest",
      path.join(dir, "manifest.json"),
      "--wasm",
      path.join(dir, "c.wasm"),
      "--zkey",
      path.join(dir, "c.zkey"),
      "--secret-output",
      secretOut,
      "--recipient",
      "DiuasKhcjWKHnP5gtDf5cBEVUMqoQhcMMUZCtYb7egdv",
      "--relayer",
      "3NpDL8TgCvgVqig4REBPDos1YuQarFqh7PEebcq7WGhu",
    ]);
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("DRY RUN");
    expect(res.stdout).to.include("Planned steps");
    expect(res.stdout).to.include("deposit_note_devnet.ts");
    expect(fs.existsSync(secretOut)).to.equal(false);
    expect(res.stdout).to.not.include("--" + "send");
  });
});

// ── CLI: resume verifies artifacts before printing proof/simulate ────────────────

describe("devnet_alpha_plan: CLI resume artifact gate", () => {
  function resumeArgs(
    a: { manifestPath: string; zkey: string; wasm: string },
    extra: string[]
  ): string[] {
    return [
      "--skip-note-generation",
      "--snapshot",
      "/tmp/snap.json",
      "--leaf-index",
      "4",
      "--root",
      "06ad62f8b0e1a968d51d6fac563586b70f8d8e3946726c2491495c2d644ca381",
      "--secret-output",
      "/tmp/secret.hex",
      "--recipient",
      "DiuasKhcjWKHnP5gtDf5cBEVUMqoQhcMMUZCtYb7egdv",
      "--relayer",
      "3NpDL8TgCvgVqig4REBPDos1YuQarFqh7PEebcq7WGhu",
      "--artifact-manifest",
      a.manifestPath,
      "--zkey",
      a.zkey,
      "--wasm",
      a.wasm,
      ...extra,
    ];
  }

  it("fails (exit 1) before printing proof/simulate when wasm is unverified", () => {
    const a = setupResumeArtifacts();
    const res = runCli(resumeArgs(a, []));
    expect(res.status).to.not.equal(0);
    expect(res.stderr).to.include("Artifact verification failed");
    expect(res.stdout).to.not.include("--simulate");
    expect(res.stdout).to.not.include("snarkjs@0.7.4");
  });

  it("with --allow-unverified-wasm: prints UNVERIFIED + the ordered simulate sequence", () => {
    const a = setupResumeArtifacts();
    const res = runCli(resumeArgs(a, ["--allow-unverified-wasm"]));
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("UNVERIFIED");
    expect(res.stdout).to.include("inspect_allowed_roots_devnet.ts");
    expect(res.stdout).to.include("zk_prover_export_witness.ts");
    expect(res.stdout).to.include("snarkjs@0.7.4");
    expect(res.stdout).to.include("--simulate");
    expect(res.stdout).to.not.include("--" + "send");
  });
});

// ── static safety scan ───────────────────────────────────────────────────────────

describe("devnet_alpha_plan: static safety scan", () => {
  const join = (...p: string[]) => p.join("");
  let src: string;
  before(() => {
    src = fs.readFileSync(SCRIPT_PATH, "utf8");
  });

  it("no send/RPC/airdrop/keypair usage and no live-send flag", () => {
    expect(src).to.not.include(join("send", "Transaction"));
    expect(src).to.not.include(join(".", "rpc", "("));
    expect(src).to.not.include(join("request", "Airdrop"));
    expect(src).to.not.include(join("Key", "pair"));
    expect(src).to.not.include(join("--", "send"));
  });

  it("no keypair file reads or hardcoded private key paths", () => {
    expect(src).to.not.include("id.json");
    expect(src).to.not.include(join("keys", "/"));
    expect(src).to.not.include(".config/solana");
  });

  it("never constructs a live submit_root in source (submit is dry-run only)", () => {
    // the submit_root command line must not be paired with a live --yes
    const submitIdx = src.indexOf("submit_root_devnet.ts");
    expect(submitIdx).to.be.greaterThan(-1);
    const after = src.slice(submitIdx, submitIdx + 400);
    expect(after).to.include("--dry-run");
    expect(after).to.not.include("--yes");
  });
});

// ── --help output ────────────────────────────────────────────────────────────────

describe("devnet_alpha_plan: --help output", () => {
  const join = (...p: string[]) => p.join("");

  it("CLI --help exits 0 and prints usage", () => {
    const res = runCli(["--help"]);
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("devnet_alpha_plan");
    expect(res.stdout.toLowerCase()).to.include("planner");
  });

  it("CLI -h exits 0", () => {
    const res = runCli(["-h"]);
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("devnet_alpha_plan");
  });

  it("help documents both modes and the resume flag", () => {
    const help = helpText().toLowerCase();
    expect(help).to.include("prepare");
    expect(help).to.include("resume");
    expect(help).to.include("--skip-note-generation");
  });

  it("help lists prepare/resume required flags", () => {
    const help = helpText();
    expect(help).to.include("--artifact-manifest");
    expect(help).to.include("--wasm");
    expect(help).to.include("--zkey");
    expect(help).to.include("--secret-output");
    expect(help).to.include("--recipient");
    expect(help).to.include("--relayer");
    expect(help).to.include("--snapshot");
    expect(help).to.include("--leaf-index");
    expect(help).to.include("--root");
    expect(help).to.include("--dry-run");
  });

  it("help frames planner-not-runner, simulate-only, operator-managed, no live withdraw", () => {
    const help = helpText().toLowerCase();
    expect(help).to.include("planner");
    expect(help).to.include("not a runner");
    expect(help).to.include("simulate-only");
    expect(help).to.include("operator-managed");
    expect(help).to.include("no live withdraw");
  });

  it("help omits key paths and a live-send flag", () => {
    const help = helpText();
    expect(help).to.not.include("keys/");
    expect(help).to.not.include("id.json");
    expect(help).to.not.include(".config/solana");
    // safety statement only; the help must not spell a live-send flag token
    expect(help).to.not.include(join("--", "send"));
  });
});
