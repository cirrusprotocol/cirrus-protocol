import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { expect } from "chai";

import { CIRRUS_DEVNET_ALPHA_PROFILE } from "../scripts/ops/cirrus_devnet_alpha_profile";
import {
  parseArgs,
  buildDepositPlan,
  formatPlanHuman,
  formatPlanJson,
  depositPlanHelp,
  DepositPlanArgs,
  DepositPlan,
} from "../scripts/ops/shared_pool_deposit_plan";

const REPO_ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "ops",
  "shared_pool_deposit_plan.ts"
);
const SCRIPT_SRC = fs.readFileSync(SCRIPT_PATH, "utf8");

const P = CIRRUS_DEVNET_ALPHA_PROFILE;
const DEFAULT_DENOM = BigInt(P.defaultDenomination);

// An out-of-repo secret destination (the planner never touches the filesystem,
// so the path need not exist).
const OUT = path.join(os.tmpdir(), "cirrus-deposit-plan-test", "note.hex");

const RECIPIENT = "DiuasKhcjWKHnP5gtDf5cBEVUMqoQhcMMUZCtYb7egdv";
const RELAYER = "3NpDL8TgCvgVqig4REBPDos1YuQarFqh7PEebcq7WGhu";

const mkArgs = (over: Partial<DepositPlanArgs> = {}): DepositPlanArgs => ({
  secretOutput: OUT,
  denomination: DEFAULT_DENOM,
  commitmentLevel: "confirmed",
  json: false,
  ...over,
});

// Tokens that must never appear in planner OUTPUT.
const FORBIDDEN_ARTIFACTS = [
  ".wasm",
  ".zkey",
  ".ptau",
  "proof.json",
  "witness.json",
  "input.json",
  "public.json",
  "snapshot.json",
];
const FORBIDDEN_KEYPATHS = ["keys/", "id.json", ".config/solana"];

function allOutput(plan: DepositPlan): string {
  return (
    formatPlanHuman(plan) +
    "\n" +
    formatPlanJson(plan) +
    "\n" +
    depositPlanHelp()
  );
}

// ── argument parsing ─────────────────────────────────────────────────────────────

describe("shared pool deposit plan: parseArgs", () => {
  it("requires --secret-output", () => {
    expect(() => parseArgs([], DEFAULT_DENOM)).to.throw(/secret-output/);
  });

  it("defaults denomination, confirmed commitment, human output", () => {
    const a = parseArgs(["--secret-output", OUT], DEFAULT_DENOM);
    expect(a.secretOutput).to.equal(OUT);
    expect(a.denomination).to.equal(DEFAULT_DENOM);
    expect(a.commitmentLevel).to.equal("confirmed");
    expect(a.json).to.equal(false);
    expect(a.recipient).to.equal(undefined);
    expect(a.relayer).to.equal(undefined);
  });

  it("parses recipient, relayer, denomination, commitment, and --json", () => {
    const a = parseArgs(
      [
        "--secret-output",
        OUT,
        "--recipient",
        RECIPIENT,
        "--relayer",
        RELAYER,
        "--denomination",
        "100000000",
        "--commitment",
        "finalized",
        "--json",
      ],
      DEFAULT_DENOM
    );
    expect(a.recipient).to.equal(RECIPIENT);
    expect(a.relayer).to.equal(RELAYER);
    expect(a.denomination).to.equal(100000000n);
    expect(a.commitmentLevel).to.equal("finalized");
    expect(a.json).to.equal(true);
  });

  it("rejects an invalid recipient / relayer", () => {
    expect(() =>
      parseArgs(
        ["--secret-output", OUT, "--recipient", "not a key"],
        DEFAULT_DENOM
      )
    ).to.throw(/recipient/);
    expect(() =>
      parseArgs(["--secret-output", OUT, "--relayer", "0OIl"], DEFAULT_DENOM)
    ).to.throw(/relayer/);
  });

  it("rejects a bad commitment, a bad denomination, and unknown flags", () => {
    expect(() =>
      parseArgs(["--secret-output", OUT, "--commitment", "soon"], DEFAULT_DENOM)
    ).to.throw(/commitment/);
    expect(() =>
      parseArgs(["--secret-output", OUT, "--denomination", "0"], DEFAULT_DENOM)
    ).to.throw();
    expect(() => parseArgs(["--nope"], DEFAULT_DENOM)).to.throw(/unknown flag/);
  });
});

// ── secret-output safety (fail-closed: out-of-repo required) ──────────────────────

describe("shared pool deposit plan: secret-output safety", () => {
  it("accepts an out-of-repo secret-output path", () => {
    const plan = buildDepositPlan(P, mkArgs(), REPO_ROOT);
    expect(plan.secretOutput).to.equal(path.resolve(OUT));
  });

  it("rejects an in-repo secret-output path", () => {
    const inRepo = path.join(REPO_ROOT, "note-secret.hex");
    expect(() =>
      buildDepositPlan(P, mkArgs({ secretOutput: inRepo }), REPO_ROOT)
    ).to.throw(/inside the repository/);
  });

  it("rejects an in-repo path even if it looks git-ignored (fail-closed)", () => {
    // node_modules is typically git-ignored, but this planner never shells out to
    // git, so it must still refuse any in-repo destination.
    const ignoredLooking = path.join(REPO_ROOT, "node_modules", "x.hex");
    expect(() =>
      buildDepositPlan(P, mkArgs({ secretOutput: ignoredLooking }), REPO_ROOT)
    ).to.throw(/inside the repository/);
  });
});

// ── devnet-only guard ────────────────────────────────────────────────────────────

describe("shared pool deposit plan: devnet-only guard", () => {
  it("rejects a non-devnet profile", () => {
    const bad = { ...P, rpc: "https://api.mainnet-beta.solana.com" };
    expect(() => buildDepositPlan(bad, mkArgs(), REPO_ROOT)).to.throw(
      /devnet/i
    );
  });
});

// ── plan content ─────────────────────────────────────────────────────────────────

describe("shared pool deposit plan: content", () => {
  let plan: DepositPlan;
  let out: string;
  before(() => {
    plan = buildDepositPlan(
      P,
      mkArgs({ recipient: RECIPIENT, relayer: RELAYER }),
      REPO_ROOT
    );
    out = allOutput(plan);
  });

  it("includes the shared profile constants", () => {
    for (const v of [
      P.name,
      P.rpc,
      P.programId,
      P.poolPda,
      P.configPda,
      P.noteTreePda,
    ]) {
      expect(out).to.include(v);
    }
    expect(out).to.include(String(P.defaultDenomination));
    expect(out).to.include(String(P.defaultFee));
  });

  it("walks generate -> deposit -> status/readiness -> simulate", () => {
    const ids = plan.steps.map((s) => s.id);
    expect(ids).to.deep.equal([
      "generate-note-secret",
      "deposit",
      "status-readiness",
      "simulate",
    ]);
    expect(out).to.include("generate_note_secret.ts");
    expect(out).to.include("deposit_note_devnet.ts");
    expect(out).to.include("devnet_alpha_plan.ts");
  });

  it("includes the read-only status/readiness command with --expected-root", () => {
    expect(out).to.include("shared_pool_status_devnet.ts --expected-root");
  });

  it("states that root submission is operator-managed", () => {
    expect(out.toLowerCase()).to.include("operator-managed");
    expect(plan.rootSubmission).to.equal("operator-managed");
  });

  it("shows a conservative deposit: dry-run plus an OPTIONAL explicit live --yes", () => {
    const deposit = plan.steps.find((s) => s.id === "deposit")!;
    const text = deposit.commands.join("\n") + "\n" + (deposit.note ?? "");
    expect(text).to.include("--dry-run");
    expect(text).to.include("--yes");
    expect(text.toUpperCase()).to.include("OPTIONAL");
  });

  it("never prints a live withdraw --send or a root-submission command", () => {
    expect(out).to.not.include("--" + "send");
    expect(out).to.not.include("submit_root");
  });

  it("prints no concrete keypair-path patterns", () => {
    for (const tok of FORBIDDEN_KEYPATHS) {
      expect(out, `must not contain ${tok}`).to.not.include(tok);
    }
  });

  it("prints no artifact-file tokens", () => {
    for (const tok of FORBIDDEN_ARTIFACTS) {
      expect(out, `must not contain ${tok}`).to.not.include(tok);
    }
  });

  it("uses a safe wallet placeholder (no concrete local wallet path)", () => {
    expect(out).to.include("<devnet-wallet>");
  });

  it("carries recipient/relayer when provided and null otherwise", () => {
    expect(plan.recipient).to.equal(RECIPIENT);
    expect(plan.relayer).to.equal(RELAYER);
    const bare = buildDepositPlan(P, mkArgs(), REPO_ROOT);
    expect(bare.recipient).to.equal(null);
    expect(bare.relayer).to.equal(null);
    // Placeholder shape appears in the simulate command when omitted.
    expect(formatPlanHuman(bare)).to.include("<recipient>");
  });
});

// ── JSON output ──────────────────────────────────────────────────────────────────

describe("shared pool deposit plan: JSON output", () => {
  it("formatPlanJson round-trips with steps and operator-managed flag", () => {
    const plan = buildDepositPlan(P, mkArgs(), REPO_ROOT);
    const parsed = JSON.parse(formatPlanJson(plan));
    expect(parsed.profile.programId).to.equal(P.programId);
    expect(parsed.rootSubmission).to.equal("operator-managed");
    expect(Array.isArray(parsed.steps)).to.equal(true);
    expect(parsed.steps.length).to.equal(4);
    expect(parsed.denomination).to.equal(String(P.defaultDenomination));
  });
});

// ── real CLI: offline --json emits pure JSON (no network, out-of-repo secret) ─────

describe("shared pool deposit plan: CLI JSON purity", () => {
  it("--secret-output <out-of-repo> --json prints parseable JSON and exits 0", function () {
    this.timeout(60000);
    const res = spawnSync(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        SCRIPT_PATH,
        "--secret-output",
        OUT,
        "--json",
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 55000,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1" },
      }
    );
    expect(res.status, res.stderr).to.equal(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.rootSubmission).to.equal("operator-managed");
    expect(parsed.steps.length).to.equal(4);
    expect(res.stderr).to.not.include("    at ");
  });

  it("an in-repo secret-output path is refused at the CLI (exit 1)", function () {
    this.timeout(60000);
    const res = spawnSync(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        SCRIPT_PATH,
        "--secret-output",
        path.join(REPO_ROOT, "note-secret.hex"),
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 55000,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1" },
      }
    );
    expect(res.status).to.equal(1);
    expect(res.stdout + res.stderr).to.include("inside the repository");
  });
});

// ── help text ────────────────────────────────────────────────────────────────────

describe("shared pool deposit plan: help", () => {
  it("is sober and documents the planner-only / operator-managed boundaries", () => {
    const h = depositPlanHelp().toLowerCase();
    expect(h).to.include("devnet only");
    expect(h).to.include("unaudited");
    expect(h).to.include("no privacy guarantee");
    expect(h).to.include("planner, not a runner");
    expect(h).to.include("no rpc connection");
    expect(h).to.include("no wallet");
    expect(h).to.include("never submits roots");
    expect(h).to.include("operator-managed");
  });
});

// ── source-level safety ──────────────────────────────────────────────────────────

describe("shared pool deposit plan: source safety", () => {
  it("uses no subprocess, wallet, keypair, fs, or transaction surface (exact patterns)", () => {
    for (const pat of [
      "child_process",
      "spawnSync",
      "execSync",
      "Keypair",
      'from "fs"',
      "from 'fs'",
      "readFileSync",
      "sendTransaction",
      "sendAndConfirm",
      "requestAirdrop",
      "process.env.ANCHOR_WALLET",
      "Connection",
    ]) {
      expect(SCRIPT_SRC, `must not contain: ${pat}`).to.not.include(pat);
    }
  });

  it("constructs no live withdraw send flag and no root-submission command", () => {
    expect(SCRIPT_SRC).to.not.include("--" + "send");
    expect(SCRIPT_SRC).to.not.include("submit_root");
  });

  it("declares the planner-only / operator-managed posture in-source", () => {
    expect(SCRIPT_SRC).to.include("operator-managed");
    expect(SCRIPT_SRC.toLowerCase()).to.include("planner, not a runner");
  });
});
