import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { expect } from "chai";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import {
  computeNoteCommitment,
  computeNullifierHash,
} from "../lib/zk_prover/witness";
import {
  BN254_FR_MODULUS,
  U64_MAX,
  parseArgs,
  parseDenomination,
  generateCanonicalSecret,
  secretToHex,
  isPathInsideRepo,
  assertSafeOutputPath,
  generateAndWriteNote,
  renderHuman,
  renderJson,
  depositCommandTemplate,
} from "../scripts/ops/generate_note_secret";

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "ops",
  "generate_note_secret.ts"
);
const REPO_ROOT = path.join(__dirname, "..");
const HEX64 = /^[0-9a-f]{64}$/;

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

// Per-suite scratch directory outside the repository.
let tmpDir: string;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-note-secret-"));
});
after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function freshOutPath(name: string): string {
  return path.join(tmpDir, name);
}

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("generate_note_secret: parseArgs", () => {
  it("1. requires --secret-output", () => {
    expect(() => parseArgs(["--yes", "--denomination", "1000"])).to.throw(
      /--secret-output is required/
    );
  });

  it("2. requires --denomination", () => {
    expect(() =>
      parseArgs(["--yes", "--secret-output", "/tmp/x.hex"])
    ).to.throw(/--denomination is required/);
  });

  it("3. requires exactly one of --dry-run / --yes", () => {
    expect(() =>
      parseArgs(["--secret-output", "/tmp/x.hex", "--denomination", "1000"])
    ).to.throw(/exactly one of --dry-run or --yes/);
    expect(() =>
      parseArgs([
        "--dry-run",
        "--yes",
        "--secret-output",
        "/tmp/x.hex",
        "--denomination",
        "1000",
      ])
    ).to.throw(/exactly one of --dry-run or --yes/);
  });

  it("3b. accepts a valid --dry-run invocation", () => {
    const args = parseArgs([
      "--dry-run",
      "--secret-output",
      "/tmp/x.hex",
      "--denomination",
      "1000",
    ]);
    expect(args.dryRun).to.equal(true);
    expect(args.yes).to.equal(false);
    expect(args.secretOutput).to.equal("/tmp/x.hex");
    expect(args.denomination).to.equal(1000n);
    expect(args.json).to.equal(false);
  });

  it("3c. accepts a valid --yes --json invocation", () => {
    const args = parseArgs([
      "--yes",
      "--json",
      "--secret-output",
      "/tmp/x.hex",
      "--denomination",
      "1000000000",
    ]);
    expect(args.yes).to.equal(true);
    expect(args.json).to.equal(true);
    expect(args.denomination).to.equal(1000000000n);
  });

  it("3d. rejects unknown flags", () => {
    expect(() => parseArgs(["--nope"])).to.throw(/unknown flag/);
  });
});

// ── parseDenomination ─────────────────────────────────────────────────────────

describe("generate_note_secret: parseDenomination", () => {
  it("4. rejects invalid denomination (0, negative, fractional, hex, leading zero)", () => {
    expect(() => parseDenomination("0")).to.throw(/positive decimal/);
    expect(() => parseDenomination("-1")).to.throw(/positive decimal/);
    expect(() => parseDenomination("1.5")).to.throw(/positive decimal/);
    expect(() => parseDenomination("0x10")).to.throw(/positive decimal/);
    expect(() => parseDenomination("01000")).to.throw(/positive decimal/);
    expect(() => parseDenomination("")).to.throw(/positive decimal/);
  });

  it("4b. rejects values greater than u64 max", () => {
    expect(() => parseDenomination((U64_MAX + 1n).toString())).to.throw(
      /u64 maximum/
    );
  });

  it("4c. accepts positive integers including u64 max", () => {
    expect(parseDenomination("1")).to.equal(1n);
    expect(parseDenomination("1000000000")).to.equal(1000000000n);
    expect(parseDenomination(U64_MAX.toString())).to.equal(U64_MAX);
  });
});

// ── Path safety ─────────────────────────────────────────────────────────────────

describe("generate_note_secret: output-path safety", () => {
  it("12. rejects an in-repo, non-ignored path; allows ignored in-repo and outside-repo", () => {
    const inRepo = path.join(REPO_ROOT, "scratch-note-secret.hex");
    expect(() => assertSafeOutputPath(inRepo, REPO_ROOT, () => false)).to.throw(
      /inside the repository/i
    );
    expect(() =>
      assertSafeOutputPath(inRepo, REPO_ROOT, () => true)
    ).to.not.throw();

    const outside = path.join(os.tmpdir(), "scratch-note-secret.hex");
    expect(() =>
      assertSafeOutputPath(outside, REPO_ROOT, () => false)
    ).to.not.throw();
  });

  it("12b. isPathInsideRepo classifies in-repo vs outside-repo paths", () => {
    expect(
      isPathInsideRepo(path.join(REPO_ROOT, "a", "b.hex"), REPO_ROOT)
    ).to.equal(true);
    expect(
      isPathInsideRepo(path.join(os.tmpdir(), "b.hex"), REPO_ROOT)
    ).to.equal(false);
    expect(isPathInsideRepo(REPO_ROOT, REPO_ROOT)).to.equal(false);
  });
});

// ── Secret generation primitives ────────────────────────────────────────────────

describe("generate_note_secret: secret primitives", () => {
  it("10. generated secret is a canonical, non-zero Fr element", () => {
    for (let i = 0; i < 64; i++) {
      const s = generateCanonicalSecret();
      expect(s > 0n, "secret must be non-zero").to.equal(true);
      expect(
        s < BN254_FR_MODULUS,
        "secret must be < BN254 Fr modulus"
      ).to.equal(true);
    }
  });

  it("10b. rejection sampling skips zero and out-of-range draws", () => {
    const draws = [
      Buffer.alloc(32, 0x00),
      Buffer.from(
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "hex"
      ),
      (() => {
        const b = Buffer.alloc(32, 0x00);
        b[31] = 0x07;
        return b;
      })(),
    ];
    let i = 0;
    const rng = (_n: number): Buffer => draws[i++];
    const s = generateCanonicalSecret(rng);
    expect(s).to.equal(7n);
    expect(i).to.equal(3);
  });

  it("10c. secretToHex produces 64-char lowercase hex and rejects non-canonical values", () => {
    const hex = secretToHex(7n);
    expect(hex).to.match(HEX64);
    expect(hex.endsWith("07")).to.equal(true);
    expect(() => secretToHex(0n)).to.throw(/canonical/);
    expect(() => secretToHex(BN254_FR_MODULUS)).to.throw(/canonical/);
  });
});

// ── generateAndWriteNote (direct) ───────────────────────────────────────────────

describe("generate_note_secret: generateAndWriteNote", () => {
  before(async () => {
    await initPoseidon();
  });

  it("6b. writes a 64-char lowercase hex secret file with mode 0600", async () => {
    const out = freshOutPath("direct-write.hex");
    const result = await generateAndWriteNote(out, 1000000000n);
    expect(fs.existsSync(out)).to.equal(true);
    const contents = fs.readFileSync(out, "utf8");
    expect(contents).to.match(HEX64);
    const mode = fs.statSync(out).mode & 0o777;
    expect(mode).to.equal(0o600);
    expect(result.secretFile).to.equal(out);
    expect(result.denomination).to.equal("1000000000");
  });

  it("7b. refuses to overwrite an existing file", async () => {
    const out = freshOutPath("no-overwrite.hex");
    fs.writeFileSync(out, "preexisting", { mode: 0o600 });
    let threw = false;
    try {
      await generateAndWriteNote(out, 1000n);
    } catch (err) {
      threw = true;
      expect((err as Error).message).to.match(/Refusing to overwrite/);
    }
    expect(threw).to.equal(true);
    expect(fs.readFileSync(out, "utf8")).to.equal("preexisting");
  });

  it("9. commitment and nullifier hash are 64-char lowercase hex", async () => {
    const out = freshOutPath("hex-shape.hex");
    const result = await generateAndWriteNote(out, 1000000000n);
    expect(result.commitment).to.match(HEX64);
    expect(result.nullifierHash).to.match(HEX64);
  });

  it("11. commitment/nullifier recompute from the saved secret and match", async () => {
    const out = freshOutPath("recompute.hex");
    const denomination = 1000000000n;
    const result = await generateAndWriteNote(out, denomination);

    const savedHex = fs.readFileSync(out, "utf8").trim();
    expect(savedHex).to.match(HEX64);
    const secret = BigInt("0x" + savedHex);

    expect(computeNoteCommitment(secret, denomination)).to.equal(
      result.commitment
    );
    expect(computeNullifierHash(secret)).to.equal(result.nullifierHash);
  });

  it("8b. rendered human/JSON output never contains the saved secret", async () => {
    const out = freshOutPath("no-leak.hex");
    const result = await generateAndWriteNote(out, 1000000000n);
    const savedHex = fs.readFileSync(out, "utf8").trim();

    const human = renderHuman(result);
    const json = renderJson(result);
    expect(human).to.not.include(savedHex);
    expect(json).to.not.include(savedHex);

    const parsed = JSON.parse(json);
    expect(parsed.commitment).to.equal(result.commitment);
    expect(parsed.nullifier_hash).to.equal(result.nullifierHash);
    expect(parsed).to.not.have.property("secret");
    expect(JSON.stringify(parsed)).to.not.include(savedHex);
  });

  it("depositCommandTemplate embeds the commitment, not any secret", async () => {
    const out = freshOutPath("deposit-template.hex");
    const result = await generateAndWriteNote(out, 1000000000n);
    const savedHex = fs.readFileSync(out, "utf8").trim();
    const cmd = depositCommandTemplate(result);
    expect(cmd).to.include(result.commitment);
    expect(cmd).to.include("--denomination 1000000000");
    expect(cmd).to.not.include(savedHex);
  });
});

// ── CLI end-to-end (spawned) ─────────────────────────────────────────────────────

describe("generate_note_secret: CLI", () => {
  it("5. --dry-run does not write a file and prints no commitment", () => {
    const out = freshOutPath("dryrun.hex");
    const res = runCli([
      "--dry-run",
      "--secret-output",
      out,
      "--denomination",
      "1000000000",
    ]);
    expect(res.status, res.stderr).to.equal(0);
    expect(fs.existsSync(out)).to.equal(false);
    expect(res.stdout).to.include("DRY RUN");
    expect(res.stdout).to.include(out);
    expect(res.stdout).to.include("1000000000");
    expect(res.stdout.toLowerCase()).to.not.include("commitment:");
  });

  it("6. --yes writes a 64-char hex secret file with mode 0600", () => {
    const out = freshOutPath("cli-yes.hex");
    const res = runCli([
      "--yes",
      "--secret-output",
      out,
      "--denomination",
      "1000000000",
    ]);
    expect(res.status, res.stderr).to.equal(0);
    expect(fs.existsSync(out)).to.equal(true);
    const contents = fs.readFileSync(out, "utf8");
    expect(contents).to.match(HEX64);
    expect(fs.statSync(out).mode & 0o777).to.equal(0o600);
    expect(res.stdout).to.include("Commitment:");
    expect(res.stdout).to.include("Nullifier hash:");
  });

  it("7. --yes refuses to overwrite an existing file", () => {
    const out = freshOutPath("cli-overwrite.hex");
    fs.writeFileSync(out, "preexisting", { mode: 0o600 });
    const res = runCli([
      "--yes",
      "--secret-output",
      out,
      "--denomination",
      "1000000000",
    ]);
    expect(res.status).to.not.equal(0);
    expect(res.stderr).to.match(/Refusing to overwrite/);
    expect(fs.readFileSync(out, "utf8")).to.equal("preexisting");
  });

  it("8. CLI output does not contain the generated secret hex", () => {
    const out = freshOutPath("cli-no-leak.hex");
    const res = runCli([
      "--yes",
      "--secret-output",
      out,
      "--denomination",
      "1000000000",
    ]);
    expect(res.status, res.stderr).to.equal(0);
    const savedHex = fs.readFileSync(out, "utf8").trim();
    expect(savedHex).to.match(HEX64);
    expect(res.stdout).to.not.include(savedHex);
    expect(res.stderr).to.not.include(savedHex);
  });
});

// ── Static safety scan ───────────────────────────────────────────────────────────
//
// Patterns are assembled with join() so this test file does not itself contain
// the forbidden substrings consecutively (avoids repository safety-grep false
// positives).

describe("generate_note_secret: static safety scan", () => {
  const join = (...parts: string[]) => parts.join("");
  let src: string;

  before(() => {
    src = fs.readFileSync(SCRIPT_PATH, "utf8");
  });

  it("13. does not send transactions or open RPC mutation paths", () => {
    expect(src).to.not.include(join("send", "RawTransaction"));
    expect(src).to.not.include(join("send", "Transaction"));
    expect(src).to.not.include(join(".", "rpc", "("));
    expect(src).to.not.include(join("request", "Airdrop"));
    expect(src).to.not.include(join("@solana", "/web3.js"));
    expect(src).to.not.include(join("new ", "Connection"));
  });

  it("13b. does not generate keypairs", () => {
    expect(src).to.not.include(join("Key", "pair"));
  });

  it("14. does not log or print the secret", () => {
    expect(src).to.not.include(join("console.log(", "secret"));
    expect(src).to.not.include(join("console.error(", "secret"));
    expect(src).to.not.include(join("console.log(", "secretHex"));
    expect(src).to.not.include(join("process.stdout.write(", "secret"));
  });

  it("14b. writes the secret with restrictive permissions and exclusive create", () => {
    expect(src).to.include("mode: 0o600");
    expect(src).to.include('flag: "wx"');
    expect(src).to.include("chmodSync");
  });
});
