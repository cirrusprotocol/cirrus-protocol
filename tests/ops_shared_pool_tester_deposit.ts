import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { expect } from "chai";
import { CIRRUS_DEVNET_ALPHA_PROFILE } from "../scripts/ops/cirrus_devnet_alpha_profile";
import {
  TesterDepositArgs,
  parseArgs,
  resolveWallet,
  assertDevnetRpc,
  assertNoteOutputOutsideRepo,
  buildDepositCommand,
  formatDryRun,
  helpText,
} from "../scripts/ops/shared_pool_tester_deposit";

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "ops",
  "shared_pool_tester_deposit.ts"
);
const REPO_ROOT = path.join(__dirname, "..");
const PROFILE = CIRRUS_DEVNET_ALPHA_PROFILE;

let tmpDir: string;
let counter = 0;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tester-deposit-"));
});
after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function args(overrides: Partial<TesterDepositArgs> = {}): TesterDepositArgs {
  return {
    wallet: "/some/devnet-wallet.json",
    noteOutput: path.join(os.tmpdir(), "note.json"),
    rpc: PROFILE.rpc,
    denomination: PROFILE.defaultDenomination,
    dryRun: false,
    yes: false,
    ...overrides,
  };
}

function runCli(
  cliArgs: string[],
  envOverride: NodeJS.ProcessEnv = {}
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(
    process.execPath,
    ["-r", "ts-node/register/transpile-only", SCRIPT_PATH, ...cliArgs],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1", ...envOverride },
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

describe("tester_deposit: parseArgs", () => {
  it("requires --note-output and applies profile defaults", () => {
    expect(() => parseArgs(["--wallet", "/x"])).to.throw(
      /--note-output is required/
    );
    const a = parseArgs(["--note-output", "/tmp/n.json"]);
    expect(a.rpc).to.equal(PROFILE.rpc);
    expect(a.denomination).to.equal(PROFILE.defaultDenomination);
    expect(a.dryRun).to.equal(false);
    expect(a.yes).to.equal(false);
  });

  it("parses wallet, rpc, denomination, dry-run, yes", () => {
    const a = parseArgs([
      "--wallet",
      "/x/w.json",
      "--note-output",
      "/tmp/n.json",
      "--rpc",
      "https://my-devnet-rpc.example.com",
      "--denomination",
      "100000000000",
      "--yes",
    ]);
    expect(a.wallet).to.equal("/x/w.json");
    expect(a.rpc).to.equal("https://my-devnet-rpc.example.com");
    expect(a.denomination).to.equal(100000000000);
    expect(a.yes).to.equal(true);
  });

  it("rejects --dry-run + --yes together", () => {
    expect(() =>
      parseArgs(["--note-output", "/tmp/n.json", "--dry-run", "--yes"])
    ).to.throw(/mutually exclusive/);
  });

  it("rejects --program-id as an unknown flag (deposit script fixes the program id)", () => {
    expect(() =>
      parseArgs([
        "--note-output",
        "/tmp/n.json",
        "--program-id",
        PROFILE.programId,
      ])
    ).to.throw(/unknown flag/);
  });

  it("rejects malformed / unsafe denomination", () => {
    expect(() =>
      parseArgs(["--note-output", "/tmp/n.json", "--denomination", "abc"])
    ).to.throw(/--denomination/);
    expect(() =>
      parseArgs([
        "--note-output",
        "/tmp/n.json",
        "--denomination",
        "9007199254740992",
      ])
    ).to.throw(/safe integer range/);
  });
});

// ── resolveWallet ────────────────────────────────────────────────────────────

describe("tester_deposit: resolveWallet", () => {
  it("prefers --wallet, falls back to ANCHOR_WALLET", () => {
    expect(resolveWallet(args({ wallet: "/from/arg.json" }), {})).to.equal(
      "/from/arg.json"
    );
    expect(
      resolveWallet(args({ wallet: undefined }), {
        ANCHOR_WALLET: "/from/env.json",
      })
    ).to.equal("/from/env.json");
  });

  it("throws when neither --wallet nor ANCHOR_WALLET is available", () => {
    expect(() => resolveWallet(args({ wallet: undefined }), {})).to.throw(
      /no devnet wallet/
    );
  });
});

// ── assertDevnetRpc (strict devnet-only) ─────────────────────────────────────

describe("tester_deposit: assertDevnetRpc", () => {
  it("accepts the canonical devnet RPC", () => {
    expect(() =>
      assertDevnetRpc("https://api.devnet.solana.com")
    ).to.not.throw();
  });

  it("accepts a clearly-devnet custom RPC", () => {
    expect(() =>
      assertDevnetRpc("https://my-devnet-rpc.example.com")
    ).to.not.throw();
  });

  it("rejects mainnet", () => {
    expect(() =>
      assertDevnetRpc("https://api.mainnet-beta.solana.com")
    ).to.throw(/devnet/i);
  });

  it("rejects testnet", () => {
    expect(() => assertDevnetRpc("https://api.testnet.solana.com")).to.throw(
      /devnet/i
    );
  });

  it("rejects an unknown RPC that does not clearly identify as devnet", () => {
    expect(() => assertDevnetRpc("https://rpc.example.com")).to.throw(
      /does not clearly identify as devnet/i
    );
  });
});

// ── note-output safety ───────────────────────────────────────────────────────

describe("tester_deposit: note-output safety", () => {
  it("rejects a note-output inside the repository (not git-ignored)", () => {
    const inRepo = path.join(REPO_ROOT, "scratch-note.json");
    expect(() =>
      assertNoteOutputOutsideRepo(inRepo, REPO_ROOT, () => false)
    ).to.throw(/inside the repository/i);
  });

  it("accepts a note-output outside the repository", () => {
    expect(() =>
      assertNoteOutputOutsideRepo(
        path.join(os.tmpdir(), "note.json"),
        REPO_ROOT,
        () => false
      )
    ).to.not.throw();
  });
});

// ── buildDepositCommand (reuses the existing deposit script) ─────────────────

describe("tester_deposit: buildDepositCommand", () => {
  it("invokes the existing deposit script with commitment, denomination, and --yes", () => {
    const cmd = buildDepositCommand({
      rpc: PROFILE.rpc,
      walletPath: "/w/wallet.json",
      commitmentHex: "ab".repeat(32),
      denomination: 1000000000,
    });
    const joined = cmd.argv.join(" ");
    expect(joined).to.include("scripts/ops/deposit_note_devnet.ts");
    expect(joined).to.include("--commitment ab" + "ab".repeat(31));
    expect(joined).to.include("--denomination 1000000000");
    expect(cmd.argv).to.include("--yes");
    // No --program-id: the deposit script fixes the program id itself.
    expect(joined).to.not.include("--program-id");
  });

  it("passes the selected RPC and wallet through the deposit env", () => {
    const cmd = buildDepositCommand({
      rpc: "https://my-devnet-rpc.example.com",
      walletPath: "/w/wallet.json",
      commitmentHex: "cd".repeat(32),
      denomination: 1000000000,
    });
    expect(cmd.env.ANCHOR_PROVIDER_URL).to.equal(
      "https://my-devnet-rpc.example.com"
    );
    expect(cmd.env.ANCHOR_WALLET).to.equal("/w/wallet.json");
  });
});

// ── formatDryRun (no path leakage) ───────────────────────────────────────────

describe("tester_deposit: formatDryRun", () => {
  it("does not echo concrete wallet or note paths", () => {
    const walletPath = "<redacted-devnet-wallet-path>";
    const notePath = "<redacted-note-output-path>";
    const a = args({ wallet: walletPath, noteOutput: notePath });
    const text = formatDryRun(a, "--wallet");
    expect(text).to.not.include(walletPath);
    expect(text).to.not.include(notePath);
    expect(text).to.include("path not shown");
    expect(text).to.include("<your-wallet>");
  });

  it("shows the canonical program id and is a preview that sends nothing", () => {
    const text = formatDryRun(args(), "ANCHOR_WALLET");
    expect(text).to.include(PROFILE.programId);
    expect(text).to.include("PREVIEW");
    expect(text).to.include("send any transaction");
    expect(text).to.include("deposit_note_devnet.ts");
  });
});

// ── help ─────────────────────────────────────────────────────────────────────

describe("tester_deposit: help", () => {
  it("says devnet alpha only, dry-run default sends nothing, --yes is required for live", () => {
    const help = helpText();
    expect(help.toLowerCase()).to.include("devnet alpha only");
    expect(help).to.include("PREVIEW");
    expect(help).to.include("sends no transaction");
    expect(help).to.include("requires explicit --yes");
  });

  it("says the raw note secret and wallet secret are never printed", () => {
    const help = helpText();
    expect(help).to.include("note secret is NEVER printed");
    expect(help).to.include("wallet secret key is NEVER printed");
  });

  it("uses placeholders only — no concrete key paths", () => {
    const help = helpText();
    expect(help).to.not.include("keys/");
    expect(help).to.not.include("id.json");
    expect(help).to.not.include(".config/solana");
  });

  it("recommends the silent npm form and not the plain npm form", () => {
    const help = helpText();
    expect(help).to.include("npm run --silent alpha:deposit --");
    expect(help).to.include("Maintainers may also invoke the script directly");
    // The plain form (without --silent) must not be recommended. This substring
    // is absent from the valid "npm run --silent alpha:deposit --" form because
    // "--silent " sits between "npm run " and "alpha:deposit".
    expect(help).to.not.include("npm run alpha:deposit --");
  });
});

// ── CLI (spawn) ──────────────────────────────────────────────────────────────

describe("tester_deposit: CLI", () => {
  it("--help exits 0", () => {
    const res = runCli(["--help"]);
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("shared_pool_tester_deposit");
  });

  it("-h exits 0", () => {
    const res = runCli(["-h"]);
    expect(res.status, res.stderr).to.equal(0);
  });

  it("default run is a preview: exits 0, sends/writes nothing", () => {
    const note = path.join(tmpDir, `note_${counter++}.json`);
    const res = runCli([
      "--wallet",
      "/some/devnet-wallet.json",
      "--note-output",
      note,
    ]);
    expect(res.status, res.stderr).to.equal(0);
    expect(res.stdout).to.include("PREVIEW");
    expect(res.stdout).to.include("send any transaction");
    expect(
      fs.existsSync(note),
      "dry-run must not write the note file"
    ).to.equal(false);
  });

  it("rejects a mainnet RPC", () => {
    const note = path.join(tmpDir, `note_${counter++}.json`);
    const res = runCli([
      "--wallet",
      "/some/devnet-wallet.json",
      "--note-output",
      note,
      "--rpc",
      "https://api.mainnet-beta.solana.com",
    ]);
    expect(res.status).to.not.equal(0);
    expect(fs.existsSync(note)).to.equal(false);
  });

  it("rejects a note-output inside the repository", () => {
    const res = runCli([
      "--wallet",
      "/some/devnet-wallet.json",
      "--note-output",
      path.join(REPO_ROOT, "scratch-note.json"),
    ]);
    expect(res.status).to.not.equal(0);
  });

  it("rejects when no wallet is provided (no --wallet, no ANCHOR_WALLET)", () => {
    const note = path.join(tmpDir, `note_${counter++}.json`);
    const env = { ...process.env };
    delete env.ANCHOR_WALLET;
    const res = spawnSync(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        SCRIPT_PATH,
        "--note-output",
        note,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...env, TS_NODE_TRANSPILE_ONLY: "1" },
        timeout: 55000,
      }
    );
    expect(res.status).to.not.equal(0);
  });
});

// ── source scan + npm wiring ─────────────────────────────────────────────────

describe("tester_deposit: source scan and npm wiring", () => {
  it("source reuses the existing deposit script and performs no withdraw / root-submit / proof / witness", () => {
    const src = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(src).to.include("deposit_note_devnet.ts");
    expect(src).to.not.include("withdraw_zk(");
    expect(src).to.not.include("withdrawZk(");
    expect(src).to.not.include("addAllowedRoot");
    expect(src).to.not.include("submit_root");
    expect(src).to.not.include("snarkjs");
    expect(src).to.not.include("requestAirdrop");
    expect(src).to.not.include("proof.json");
    expect(src).to.not.include("witness.json");
    expect(src).to.not.include(".zkey");
    expect(src).to.not.include(".wasm");
    expect(src).to.not.include(".ptau");
  });

  it("package.json wires alpha:deposit to this guided script", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.["alpha:deposit"];
    expect(script, "expected an alpha:deposit npm script").to.be.a("string");
    expect(script).to.include("shared_pool_tester_deposit.ts");
  });
});
