import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { expect } from "chai";

const REPO_ROOT = path.join(__dirname, "..");
const PKG_DIR = path.join(REPO_ROOT, "packages", "devnet-alpha");
const DIST = path.join(PKG_DIR, "dist");
const CLI_JS = path.join(DIST, "cli.js");
const CLI_TS = path.join(PKG_DIR, "src", "cli.ts");

const join = (...p: string[]) => p.join("");

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function runNodeIn(
  cwd: string,
  args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_JS, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20000,
  });
  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function runNode(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  return runNodeIn(REPO_ROOT, args);
}

// Build a hermetic fake repo checkout: the repo-root markers plus a fake planner
// and a local ts-node stub, so `devnet-alpha run --dry-run ...` can forward to a
// planner with no install and no network. The fake planner is plain
// CommonJS-compatible JS in a .ts file (Node loads unknown extensions with the
// .js handler), and it echoes its argv so pass-through can be asserted.
function makeFakeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dna-fakerepo-"));
  fs.mkdirSync(path.join(dir, "scripts", "ops"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "ts-node", "register"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fake-repo", private: true })
  );
  fs.writeFileSync(
    path.join(dir, "scripts", "ops", "devnet_alpha_plan.ts"),
    [
      "const args = process.argv.slice(2);",
      'console.log("FAKE_PLANNER_ARGV:" + JSON.stringify(args));',
      "process.exit(0);",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(dir, "node_modules", "ts-node", "package.json"),
    JSON.stringify({ name: "ts-node", version: "0.0.0-stub" })
  );
  fs.writeFileSync(
    path.join(dir, "node_modules", "ts-node", "register", "transpile-only.js"),
    "// hermetic ts-node stub for tests; intentionally empty\n"
  );
  return dir;
}

// Build the package once (emits dist/), and clean it up afterwards so the
// generated JS never pollutes the working tree or lint.
before(function () {
  this.timeout(60000);
  const res = spawnSync("npm", ["--prefix", PKG_DIR, "run", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 55000,
  });
  if (res.status !== 0) {
    throw new Error(`package build failed:\n${res.stderr || res.stdout}`);
  }
});
after(() => {
  try {
    fs.rmSync(DIST, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ── package.json ─────────────────────────────────────────────────────────────────

describe("devnet-alpha package: package.json", () => {
  const pkg = readJson(path.join(PKG_DIR, "package.json"));

  it("has the expected name, version, and private flag", () => {
    expect(pkg.name).to.equal("@cirrusprotocol/devnet-alpha");
    expect(pkg.version).to.equal("0.1.0-alpha.0");
    expect(pkg.private).to.equal(true);
  });

  it("exposes the devnet-alpha bin pointing at the built CLI", () => {
    expect(pkg.bin).to.deep.equal({ "devnet-alpha": "./dist/cli.js" });
  });

  it("has no publish/login scripts", () => {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    for (const [name, cmd] of Object.entries(scripts)) {
      expect(name.toLowerCase()).to.not.match(/publish|login/);
      expect(String(cmd)).to.not.include(join("npm ", "publish"));
      expect(String(cmd)).to.not.include(join("npm ", "login"));
    }
  });
});

// ── tsconfig.json ────────────────────────────────────────────────────────────────

describe("devnet-alpha package: tsconfig.json", () => {
  const ts = readJson(path.join(PKG_DIR, "tsconfig.json"));
  const co = (ts.compilerOptions ?? {}) as Record<string, unknown>;

  it("emits CommonJS from src to dist", () => {
    expect(String(co.module).toLowerCase()).to.equal("commonjs");
    expect(co.rootDir).to.equal("src");
    expect(co.outDir).to.equal("dist");
  });
});

// ── build + runtime ──────────────────────────────────────────────────────────────

describe("devnet-alpha package: built CLI runtime", () => {
  it("dist/cli.js exists after build", () => {
    expect(fs.existsSync(CLI_JS)).to.equal(true);
  });

  it("--help exits 0", () => {
    const r = runNode(["--help"]);
    expect(r.status, r.stderr).to.equal(0);
  });

  it("plan --help exits 0", () => {
    const r = runNode(["plan", "--help"]);
    expect(r.status, r.stderr).to.equal(0);
  });

  it("run --help exits 0", () => {
    const r = runNode(["run", "--help"]);
    expect(r.status, r.stderr).to.equal(0);
  });

  it("run exits 0", () => {
    const r = runNode(["run"]);
    expect(r.status, r.stderr).to.equal(0);
  });

  it("an unknown command exits non-zero", () => {
    const r = runNode(["nope"]);
    expect(r.status).to.not.equal(0);
  });

  it("root help lists the run and plan commands", () => {
    const out = runNode(["--help"]).stdout;
    expect(out).to.include("run");
    expect(out).to.include("plan");
  });

  it("help text is sober: devnet-only, unaudited, no privacy, planner-not-runner", () => {
    const out = (
      runNode(["--help"]).stdout +
      "\n" +
      runNode(["plan", "--help"]).stdout
    ).toLowerCase();
    expect(out).to.include("devnet only");
    expect(out).to.include("unaudited");
    expect(out).to.include("no privacy guarantee");
    expect(out).to.include("planner, not a live runner");
    expect(out).to.include("does not submit roots");
    expect(out).to.include("does not run live withdrawals");
  });
});

// ── run command: shared devnet-alpha pool ────────────────────────────────────────

describe("devnet-alpha package: run command", () => {
  let runOut = "";

  before(() => {
    runOut = runNode(["run", "--help"]).stdout;
  });

  it("run help is sober and describes the shared Cirrus devnet alpha pool", () => {
    const out = runOut.toLowerCase();
    expect(out).to.include("devnet only");
    expect(out).to.include("unaudited");
    expect(out).to.include("no privacy guarantee");
    expect(out).to.include("simulate-first");
    expect(out).to.include("shared cirrus devnet alpha pool");
    expect(out).to.include("cirrus-devnet-alpha");
    expect(out).to.include("operator-managed root submission");
    expect(out).to.include("guided command planner");
    expect(out).to.include("guided entrypoint");
    expect(out).to.include("1000000000");
  });

  it("run help shows the public shared profile constants", () => {
    expect(runOut).to.include("https://api.devnet.solana.com");
    expect(runOut).to.include("E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq");
    expect(runOut).to.include("HcAkT4obzEEaHyevyVvmU7drEtSUg1m4XxF1VTWGoCdm");
    expect(runOut).to.include("6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu");
    expect(runOut).to.include("F5FBHZGdiVxgm335m9VrqNBvM4Zd4N5QBs9AgYMKNAbb");
  });
});

// ── run command: in-repo planner wrapper ─────────────────────────────────────────

describe("devnet-alpha package: run planner wrapper", () => {
  const tmpDirs: string[] = [];
  const fakeRepo = () => {
    const d = makeFakeRepo();
    tmpDirs.push(d);
    return d;
  };
  const emptyDir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "dna-norepo-"));
    tmpDirs.push(d);
    return d;
  };

  after(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it("run --help still exits 0", () => {
    expect(runNode(["run", "--help"]).status).to.equal(0);
  });

  it("run with no planner flags prints safe instructions (no forwarding)", () => {
    const r = runNode(["run"]);
    expect(r.status, r.stderr).to.equal(0);
    expect(r.stdout.toLowerCase()).to.include("guided");
    expect(r.stdout).to.not.include("FAKE_PLANNER_ARGV");
  });

  it("run --dry-run forwards pass-through args to the in-repo planner", () => {
    const r = runNodeIn(fakeRepo(), ["run", "--dry-run", "--foo", "bar"]);
    expect(r.status, r.stderr).to.equal(0);
    expect(r.stdout).to.include(
      'FAKE_PLANNER_ARGV:["--dry-run","--foo","bar"]'
    );
  });

  it("run --dry-run without a checkout fails clearly (no unhandled throw)", () => {
    const r = runNodeIn(emptyDir(), ["run", "--dry-run"]);
    expect(r.status).to.not.equal(0);
    const out = r.stdout + r.stderr;
    expect(out).to.include("no repository checkout detected");
    expect(out).to.not.include("FAKE_PLANNER_ARGV");
    expect(out).to.not.include("    at "); // no node stack trace
  });

  it("refuses every live-action arg before invoking the planner", () => {
    const repo = fakeRepo(); // valid checkout — refusal must still happen first
    const liveFlag = join("--", "send");
    const tokens = [
      liveFlag,
      "--yes",
      "submit_root_devnet.ts",
      "deposit_note_devnet.ts",
    ];
    for (const tok of tokens) {
      const r = runNodeIn(repo, ["run", tok]);
      const out = r.stdout + r.stderr;
      expect(r.status, `token ${tok}`).to.not.equal(0);
      expect(out, `token ${tok}`).to.include("refusing a live-action argument");
      expect(out, `token ${tok}`).to.not.include("FAKE_PLANNER_ARGV");
      // The refusal must never echo the literal live-withdrawal flag.
      expect(out, `token ${tok}`).to.not.include(liveFlag);
    }
  });
});

// ── forbidden content ────────────────────────────────────────────────────────────

describe("devnet-alpha package: forbidden content", () => {
  const cliSrc = fs.readFileSync(CLI_TS, "utf8");
  const readme = fs.readFileSync(path.join(PKG_DIR, "README.md"), "utf8");
  const pkgRaw = fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8");
  const tsRaw = fs.readFileSync(path.join(PKG_DIR, "tsconfig.json"), "utf8");

  // Every command's help output, so forbidden tokens are checked everywhere.
  const allHelp = () =>
    runNode(["--help"]).stdout +
    runNode(["run", "--help"]).stdout +
    runNode(["run"]).stdout +
    runNode(["plan", "--help"]).stdout;

  it("help, source, and README do not mention mainnet or a live-send flag", () => {
    const help = allHelp();
    for (const text of [help, cliSrc, readme]) {
      expect(text.toLowerCase()).to.not.include(join("main", "net"));
      expect(text).to.not.include(join("--", "send"));
    }
  });

  it("source and README do not contain local keypair paths", () => {
    for (const text of [cliSrc, readme]) {
      expect(text).to.not.include(join("keys", "/"));
      expect(text).to.not.include(join("id", ".json"));
      expect(text).to.not.include(join(".config", "/solana"));
    }
  });

  it("no package file references artifact/secret/proof/witness paths", () => {
    const forbidden = [
      join(".", "zkey"),
      join(".", "wasm"),
      join(".", "ptau"),
      join("witness", ".json"),
      join("proof", ".json"),
      join("public", ".json"),
      join("fresh", "_secret"),
    ];
    for (const text of [cliSrc, readme, pkgRaw, tsRaw]) {
      for (const tok of forbidden) {
        expect(text).to.not.include(tok);
      }
    }
  });
});
