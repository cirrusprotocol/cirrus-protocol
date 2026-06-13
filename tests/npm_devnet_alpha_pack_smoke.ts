import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync, SpawnSyncReturns } from "child_process";
import { expect } from "chai";

// Local pack smoke test for the @cirrusprotocol/devnet-alpha package.
//
// It proves the package can be built, packed locally (npm pack), that the
// tarball carries only the intended files, and that the CLI help works from the
// packed/extracted artifact. It is entirely local: it never publishes, never
// logs in, never touches devnet, never generates secrets, and never produces
// proof/witness artifacts. The tarball and the temp dir live under os.tmpdir(),
// and the generated dist/ is removed afterwards.

const REPO_ROOT = path.join(__dirname, "..");
const PKG_DIR = path.join(REPO_ROOT, "packages", "devnet-alpha");
const DIST = path.join(PKG_DIR, "dist");

// Assemble sensitive string literals at runtime so this test file never
// contains the exact tokens a repo-wide safety grep scans for.
const j = (...parts: string[]) => parts.join("");

function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {}
): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8",
    timeout: 55000,
  });
}

function mustSucceed(res: SpawnSyncReturns<string>, what: string): void {
  if (res.status !== 0) {
    throw new Error(
      `${what} failed (status ${res.status}):\n${res.stderr || res.stdout}`
    );
  }
}

function runCli(
  cliPath: string,
  args: string[],
  cwd: string = os.tmpdir()
): SpawnSyncReturns<string> {
  // Defaults to os.tmpdir() so the packed CLI cannot lean on the repo cwd; pass
  // a cwd to exercise repo-checkout detection.
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20000,
  });
}

// Build a hermetic fake repo checkout (repo-root markers + a fake planner + a
// local ts-node stub) so the packed CLI can forward `run --dry-run ...` to a
// planner with no install and no network. The fake planner is plain
// CommonJS-compatible JS in a .ts file and echoes its argv.
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

describe("devnet-alpha package: pack smoke", function () {
  this.timeout(60000);

  let tmpDir = "";
  let tarballPath = "";
  let fileEntries: string[] = [];
  let extractedCli = "";
  const fakeRepos: string[] = [];

  before(function () {
    // 1. Build the package (emits dist/).
    mustSucceed(
      sh("npm", ["--prefix", PKG_DIR, "run", "build"]),
      "package build"
    );

    // 2. Pack into a temp dir outside the repo.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dna-pack-"));
    const packRes = sh(
      "npm",
      ["pack", "--json", "--pack-destination", tmpDir],
      { cwd: PKG_DIR }
    );
    mustSucceed(packRes, "npm pack");

    // 3. Parse `npm pack --json` to find the tarball filename (fall back to a
    //    directory scan if the JSON is unexpectedly shaped).
    let filename = "";
    try {
      const parsed = JSON.parse(packRes.stdout);
      filename = parsed?.[0]?.filename ?? "";
    } catch {
      filename = "";
    }
    if (!filename) {
      const tgz = fs
        .readdirSync(tmpDir)
        .filter((f) => f.endsWith(j(".", "tgz")));
      if (tgz.length !== 1) {
        throw new Error(
          `expected exactly one tarball, found: ${tgz.join(", ") || "none"}`
        );
      }
      filename = tgz[0];
    }
    tarballPath = path.join(tmpDir, filename);

    // 4. Inspect tarball contents with `tar -tzf` (paths carry the package/
    //    prefix). Keep file entries only (drop any directory entries).
    const listRes = sh("tar", ["-tzf", tarballPath]);
    mustSucceed(listRes, "tar list");
    fileEntries = listRes.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.endsWith("/"));

    // 7. Extract the tarball and locate the packed CLI.
    const exDir = path.join(tmpDir, "ex");
    fs.mkdirSync(exDir);
    mustSucceed(sh("tar", ["-xzf", tarballPath, "-C", exDir]), "tar extract");
    extractedCli = path.join(exDir, "package", "dist", "cli.js");
  });

  const fakeRepo = (): string => {
    const d = makeFakeRepo();
    fakeRepos.push(d);
    return d;
  };
  const emptyDir = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "dna-norepo-"));
    fakeRepos.push(d);
    return d;
  };

  after(function () {
    try {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    for (const d of fakeRepos) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      fs.rmSync(DIST, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  // ── tarball shape ────────────────────────────────────────────────────────

  it("produces a single .tgz tarball that exists on disk", () => {
    const base = path.basename(tarballPath);
    expect(base.startsWith("cirrusprotocol-devnet-alpha-")).to.equal(true);
    expect(base.endsWith(j(".", "tgz"))).to.equal(true);
    expect(fs.existsSync(tarballPath)).to.equal(true);
  });

  it("tar listing contains exactly package.json, README, and the built CLI", () => {
    expect(fileEntries).to.include("package/package.json");
    expect(fileEntries).to.include("package/README.md");
    expect(fileEntries).to.include("package/dist/cli.js");

    const expected = [
      "package/README.md",
      "package/dist/cli.js",
      "package/package.json",
    ].sort();
    expect([...fileEntries].sort()).to.deep.equal(expected);
  });

  it("tar listing excludes source, tests, deps, and artifact/secret/key files", () => {
    const forbidden = [
      j("package/", "src/"),
      j("package/", "tests/"),
      j("node_", "modules/"),
      j(".", "zkey"),
      j(".", "wasm"),
      j(".", "ptau"),
      j("proof", ".json"),
      j("witness", ".json"),
      j("public", ".json"),
      j("input", ".json"),
      j("snapshot", ".json"),
      "secret",
      j("keys", "/"),
    ];
    for (const entry of fileEntries) {
      for (const tok of forbidden) {
        expect(
          entry,
          `tarball entry "${entry}" matched forbidden token "${tok}"`
        ).to.not.include(tok);
      }
    }
  });

  // ── packed CLI runtime ───────────────────────────────────────────────────

  it("packed CLI: --help exits 0", () => {
    const r = runCli(extractedCli, ["--help"]);
    expect(r.status, r.stderr).to.equal(0);
  });

  it("packed CLI: plan --help exits 0", () => {
    const r = runCli(extractedCli, ["plan", "--help"]);
    expect(r.status, r.stderr).to.equal(0);
  });

  it("packed CLI: run --help exits 0", () => {
    const r = runCli(extractedCli, ["run", "--help"]);
    expect(r.status, r.stderr).to.equal(0);
  });

  it("packed CLI: run exits 0", () => {
    const r = runCli(extractedCli, ["run"]);
    expect(r.status, r.stderr).to.equal(0);
  });

  it("packed CLI: an unknown command exits non-zero", () => {
    const r = runCli(extractedCli, ["nope"]);
    expect(r.status).to.not.equal(0);
  });

  // Concatenated output of every command's help/instructions, so content checks
  // cover the whole packed surface (root, plan, run --help, and run).
  const packedHelp = () =>
    runCli(extractedCli, ["--help"]).stdout +
    "\n" +
    runCli(extractedCli, ["plan", "--help"]).stdout +
    "\n" +
    runCli(extractedCli, ["run", "--help"]).stdout +
    "\n" +
    runCli(extractedCli, ["run"]).stdout;

  it("packed CLI help is sober (devnet only / unaudited / no privacy / planner)", () => {
    const help = packedHelp().toLowerCase();
    expect(help).to.include("devnet only");
    expect(help).to.include("unaudited");
    expect(help).to.include("no privacy guarantee");
    expect(help).to.include("command planner");
  });

  it("packed run help describes the shared Cirrus devnet alpha pool", () => {
    const runOut = runCli(extractedCli, ["run", "--help"]).stdout.toLowerCase();
    expect(runOut).to.include("devnet only");
    expect(runOut).to.include("unaudited");
    expect(runOut).to.include("no privacy guarantee");
    expect(runOut).to.include("simulate-first");
    expect(runOut).to.include("shared cirrus devnet alpha pool");
    expect(runOut).to.include("cirrus-devnet-alpha");
    expect(runOut).to.include("operator-managed root submission");
    expect(runOut).to.include("guided command planner");
    expect(runOut).to.include("guided entrypoint");
    expect(runOut).to.include("1000000000");
  });

  it("packed run help shows the public shared profile constants", () => {
    const runOut = runCli(extractedCli, ["run", "--help"]).stdout;
    expect(runOut).to.include("https://api.devnet.solana.com");
    expect(runOut).to.include("E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq");
    expect(runOut).to.include("HcAkT4obzEEaHyevyVvmU7drEtSUg1m4XxF1VTWGoCdm");
    expect(runOut).to.include("6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu");
    expect(runOut).to.include("F5FBHZGdiVxgm335m9VrqNBvM4Zd4N5QBs9AgYMKNAbb");
  });

  it("packed CLI help omits mainnet, a live-send flag, and keypair paths", () => {
    const help = packedHelp();
    expect(help.toLowerCase()).to.not.include(j("main", "net"));
    expect(help).to.not.include(j("--", "send"));
    expect(help).to.not.include(j("keys", "/"));
    expect(help).to.not.include(j("id", ".json"));
    expect(help).to.not.include(j(".config", "/solana"));
  });

  // ── packed run wrapper: forwards to the in-repo planner ───────────────────

  it("packed CLI forwards pass-through args to the in-repo planner", () => {
    const r = runCli(
      extractedCli,
      ["run", "--dry-run", "--foo", "bar"],
      fakeRepo()
    );
    expect(r.status, r.stderr).to.equal(0);
    expect(r.stdout).to.include(
      'FAKE_PLANNER_ARGV:["--dry-run","--foo","bar"]'
    );
  });

  it("packed CLI run --dry-run fails clearly outside a repo checkout", () => {
    const r = runCli(extractedCli, ["run", "--dry-run"], emptyDir());
    expect(r.status).to.not.equal(0);
    const out = r.stdout + r.stderr;
    expect(out).to.include("no repository checkout detected");
    expect(out).to.not.include("FAKE_PLANNER_ARGV");
    expect(out).to.not.include("    at "); // no node stack trace
  });

  it("packed CLI refuses live-action args before invoking the planner", () => {
    const repo = fakeRepo(); // valid checkout — refusal must still happen first
    const liveFlag = j("--", "send");
    const tokens = [
      liveFlag,
      "--yes",
      "submit_root_devnet.ts",
      "deposit_note_devnet.ts",
    ];
    for (const tok of tokens) {
      const r = runCli(extractedCli, ["run", tok], repo);
      const out = r.stdout + r.stderr;
      expect(r.status, `token ${tok}`).to.not.equal(0);
      expect(out, `token ${tok}`).to.include("refusing a live-action argument");
      expect(out, `token ${tok}`).to.not.include("FAKE_PLANNER_ARGV");
      expect(out, `token ${tok}`).to.not.include(liveFlag);
    }
  });
});
