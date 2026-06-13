import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";

import {
  CIRRUS_DEVNET_ALPHA_PROFILE,
  CirrusDevnetAlphaProfile,
} from "../scripts/ops/cirrus_devnet_alpha_profile";
import {
  assertDevnetProfile,
  buildStatusReport,
  runStatus,
  resolveProfile,
  formatStatusHuman,
  formatStatusJson,
  statusHelp,
  parseArgs,
  StatusArgs,
  evaluateRootCapacity,
  ROOT_CAPACITY_WARNING_THRESHOLD,
} from "../scripts/ops/shared_pool_status_devnet";
import { InspectDeps } from "../scripts/ops/inspect_allowed_roots_devnet";

const REPO_ROOT = path.join(__dirname, "..");
const STATUS_SRC = path.join(
  REPO_ROOT,
  "scripts",
  "ops",
  "shared_pool_status_devnet.ts"
);
const STATUS_REL = path.join("scripts", "ops", "shared_pool_status_devnet.ts");
const PKG_CLI_SRC = path.join(
  REPO_ROOT,
  "packages",
  "devnet-alpha",
  "src",
  "cli.ts"
);

const P: CirrusDevnetAlphaProfile = CIRRUS_DEVNET_ALPHA_PROFILE;

// Anchor discriminator for VerifierConfig (matches DISC_CFG in the ops scripts).
const DISC_CFG = Buffer.from([176, 103, 248, 36, 138, 167, 176, 220]);
const CONFIG_LEN = 699;
const A_ROOT = "a".repeat(64);
const B_ROOT = "b".repeat(64);

/**
 * Builds a minimal valid 699-byte VerifierConfig account buffer that
 * decodeVerifierConfig() will parse, with one verifier and the given roots.
 * Used only to drive the read-only runInspect path through a fake getAccountInfo.
 */
function makeConfigBuffer(opts: { paused: boolean; roots: string[] }): Buffer {
  const buf = Buffer.alloc(CONFIG_LEN);
  DISC_CFG.copy(buf, 0);
  // admin[32] attester[32] root_submitter[32] left as zero pubkeys — fine to decode.
  buf.writeBigUInt64LE(1n, 104); // chain_id
  buf[112] = opts.paused ? 1 : 0; // paused
  buf[113] = 1; // threshold
  buf.writeUInt32LE(1, 114); // verifiers_len = 1
  // verifier pubkey at [118, 150) left as zeros.
  const verifiersEnd = 118 + 1 * 32; // 150
  buf.writeUInt32LE(opts.roots.length, verifiersEnd);
  opts.roots.forEach((r, i) => {
    Buffer.from(r, "hex").copy(buf, verifiersEnd + 4 + i * 32);
  });
  const rootsEnd = verifiersEnd + 4 + opts.roots.length * 32;
  buf[rootsEnd] = 254; // bump
  return buf;
}

/** A fake InspectDeps backed by a fixed account buffer (read-only, no network). */
function depsReturning(buf: Buffer | null): InspectDeps {
  return {
    getAccountInfo: async () => {
      if (buf === null) return null;
      return { data: buf, owner: new PublicKey(P.programId) };
    },
  };
}

/** Deps that must never be consulted (used to prove offline does no I/O). */
function depsThatThrow(): InspectDeps {
  return {
    getAccountInfo: async () => {
      throw new Error("getAccountInfo must not be called in offline mode");
    },
  };
}

const baseArgs = (over: Partial<StatusArgs> = {}): StatusArgs => ({
  commitment: "confirmed",
  offline: false,
  json: false,
  ...over,
});

// ── canonical profile: public-only, frozen, devnet ───────────────────────────────

describe("shared pool status: canonical profile", () => {
  it("exposes exactly the expected public devnet constants", () => {
    expect(P.name).to.equal("cirrus-devnet-alpha");
    expect(P.rpc).to.equal("https://api.devnet.solana.com");
    expect(P.programId).to.equal(
      "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq"
    );
    expect(P.poolPda).to.equal("HcAkT4obzEEaHyevyVvmU7drEtSUg1m4XxF1VTWGoCdm");
    expect(P.configPda).to.equal(
      "6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu"
    );
    expect(P.noteTreePda).to.equal(
      "F5FBHZGdiVxgm335m9VrqNBvM4Zd4N5QBs9AgYMKNAbb"
    );
    expect(P.defaultDenomination).to.equal(1_000_000_000);
    expect(P.defaultFee).to.equal(1_200_000);
  });

  it("is frozen so the shared profile cannot be mutated at runtime", () => {
    expect(Object.isFrozen(P)).to.equal(true);
  });

  it("targets devnet, never mainnet", () => {
    expect(P.rpc).to.include("devnet");
    expect(P.rpc.toLowerCase()).to.not.include("mainnet");
  });

  it("serializes to public values only — no keypath or key material tokens", () => {
    // Scan the serialized VALUE only (not the source/comments). The profile must
    // carry no filesystem keypaths or key material.
    const serialized = JSON.stringify(P);
    for (const tok of [
      "keys/",
      "id.json",
      ".config/solana",
      "BEGIN OPENSSH",
      "BEGIN RSA",
      "BEGIN EC",
      "PRIVATE KEY",
      "mnemonic",
      "seed phrase",
    ]) {
      expect(serialized).to.not.include(tok);
    }
  });
});

// ── devnet-only guard ────────────────────────────────────────────────────────────

describe("shared pool status: devnet-only guard", () => {
  it("accepts the canonical devnet profile", () => {
    expect(() => assertDevnetProfile(P)).to.not.throw();
  });

  it("rejects a mainnet RPC", () => {
    const bad = { ...P, rpc: "https://api.mainnet-beta.solana.com" };
    expect(() => assertDevnetProfile(bad)).to.throw(/devnet/i);
  });

  it("rejects a non-devnet RPC (e.g. localhost)", () => {
    const bad = { ...P, rpc: "http://localhost:8899" };
    expect(() => assertDevnetProfile(bad)).to.throw(/devnet/i);
  });

  it("runStatus rejects a non-devnet profile before any network use", async () => {
    const bad = { ...P, rpc: "https://api.mainnet-beta.solana.com" };
    let threw = false;
    try {
      await runStatus(bad, baseArgs({ offline: true }), depsThatThrow());
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});

// ── rpc-url override resolution ───────────────────────────────────────────────────

describe("shared pool status: resolveProfile (--rpc-url)", () => {
  it("returns the canonical profile RPC unchanged when no override is given", () => {
    expect(resolveProfile(P).rpc).to.equal(P.rpc);
    expect(resolveProfile(P, undefined).rpc).to.equal(P.rpc);
  });

  it("overrides only the RPC endpoint and keeps every other public constant", () => {
    const url = "https://my-devnet-endpoint.example/rpc";
    const r = resolveProfile(P, url);
    expect(r.rpc).to.equal(url);
    expect(r.name).to.equal(P.name);
    expect(r.programId).to.equal(P.programId);
    expect(r.poolPda).to.equal(P.poolPda);
    expect(r.configPda).to.equal(P.configPda);
    expect(r.noteTreePda).to.equal(P.noteTreePda);
    expect(r.defaultDenomination).to.equal(P.defaultDenomination);
    expect(r.defaultFee).to.equal(P.defaultFee);
  });

  it("a custom devnet override is reflected in the status output (JSON + human)", async () => {
    const url = "https://my-devnet-endpoint.example/rpc";
    const profile = resolveProfile(P, url);
    const deps = depsReturning(
      makeConfigBuffer({ paused: false, roots: [A_ROOT] })
    );
    const s = await runStatus(profile, baseArgs({ rpcUrl: url }), deps);
    expect(s.rpc).to.equal(url);
    expect(JSON.parse(formatStatusJson(s)).rpc).to.equal(url);
    expect(formatStatusHuman(s)).to.include(url);
  });
});

// ── drift guard: package SHARED_PROFILE matches the canonical profile ─────────────

describe("shared pool status: package profile drift guard", () => {
  // The npm package keeps its own self-contained copy of these constants and
  // must not import across the repo boundary. Guard that the two cannot drift.
  const cliSrc = fs.readFileSync(PKG_CLI_SRC, "utf8");

  // 1_000_000_000 -> "1_000_000_000" (the underscore-grouped source form).
  const grouped = (n: number): string =>
    n.toLocaleString("en-US").replace(/,/g, "_");

  it("the package cli.ts contains every canonical string constant", () => {
    for (const v of [
      P.name,
      P.rpc,
      P.programId,
      P.poolPda,
      P.configPda,
      P.noteTreePda,
    ]) {
      expect(cliSrc, `cli.ts should contain ${v}`).to.include(v);
    }
  });

  it("the package cli.ts contains the canonical numeric constants", () => {
    expect(cliSrc).to.include(grouped(P.defaultDenomination));
    expect(cliSrc).to.include(grouped(P.defaultFee));
  });
});

// ── argument parsing ─────────────────────────────────────────────────────────────

describe("shared pool status: parseArgs", () => {
  it("defaults to online, confirmed commitment, human output, no rpc override", () => {
    const a = parseArgs([]);
    expect(a.offline).to.equal(false);
    expect(a.json).to.equal(false);
    expect(a.commitment).to.equal("confirmed");
    expect(a.expectedRoot).to.equal(undefined);
    expect(a.rpcUrl).to.equal(undefined);
  });

  it("parses an optional --rpc-url override verbatim", () => {
    const url = "https://my-devnet-endpoint.example/rpc";
    const a = parseArgs(["--rpc-url", url]);
    expect(a.rpcUrl).to.equal(url);
  });

  it("rejects --rpc-url with no value (end of argv)", () => {
    expect(() => parseArgs(["--rpc-url"])).to.throw(/requires a value/);
  });

  it("rejects --rpc-url with no value (followed by another flag)", () => {
    expect(() => parseArgs(["--rpc-url", "--json"])).to.throw(
      /requires a value/
    );
  });

  it("parses --offline, --json, --commitment and lower-cases --expected-root", () => {
    const a = parseArgs([
      "--offline",
      "--json",
      "--commitment",
      "finalized",
      "--expected-root",
      A_ROOT.toUpperCase(),
    ]);
    expect(a.offline).to.equal(true);
    expect(a.json).to.equal(true);
    expect(a.commitment).to.equal("finalized");
    expect(a.expectedRoot).to.equal(A_ROOT);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--nope"])).to.throw(/unknown flag/);
  });

  it("rejects a malformed --expected-root", () => {
    expect(() => parseArgs(["--expected-root", "xyz"])).to.throw();
  });

  it("rejects a bad --commitment", () => {
    expect(() => parseArgs(["--commitment", "soon"])).to.throw(/commitment/);
  });
});

// ── offline mode: static profile only, no I/O ────────────────────────────────────

describe("shared pool status: offline mode", () => {
  it("buildStatusReport(offline) returns the full static profile and no chain fields", () => {
    const s = buildStatusReport(P, { offline: true });
    expect(s.profile).to.equal(P.name);
    expect(s.rpc).to.equal(P.rpc);
    expect(s.programId).to.equal(P.programId);
    expect(s.poolPda).to.equal(P.poolPda);
    expect(s.configPda).to.equal(P.configPda);
    expect(s.noteTreePda).to.equal(P.noteTreePda);
    expect(s.defaultDenomination).to.equal(P.defaultDenomination);
    expect(s.defaultFee).to.equal(P.defaultFee);
    expect(s.rootSubmission).to.equal("operator-managed");
    expect(s.offline).to.equal(true);
    expect(s.configExists).to.equal(undefined);
    expect(s.allowedRootCount).to.equal(undefined);
    expect(s.ready).to.equal(undefined);
  });

  it("offline + expectedRoot echoes the root but claims no presence/readiness", () => {
    const s = buildStatusReport(P, {
      offline: true,
      expectedRoot: A_ROOT.toUpperCase(),
    });
    expect(s.expectedRoot).to.equal(A_ROOT); // lowercased
    expect(s.expectedRootPresent).to.equal(undefined);
    expect(s.ready).to.equal(undefined);
  });

  it("runStatus(offline) never consults the network", async () => {
    const s = await runStatus(P, baseArgs({ offline: true }), depsThatThrow());
    expect(s.offline).to.equal(true);
    expect(s.configExists).to.equal(undefined);
  });
});

// ── online mode: read-only readiness via a fake getAccountInfo ────────────────────

describe("shared pool status: online readiness (read-only)", () => {
  it("reports allowed-root count and no readiness verdict without an expected root", async () => {
    const deps = depsReturning(
      makeConfigBuffer({ paused: false, roots: [A_ROOT, B_ROOT] })
    );
    const s = await runStatus(P, baseArgs(), deps);
    expect(s.offline).to.equal(false);
    expect(s.configExists).to.equal(true);
    expect(s.paused).to.equal(false);
    expect(s.allowedRootCount).to.equal(2);
    expect(s.maxRoots).to.equal(10);
    expect(s.ready).to.equal(undefined); // no expected root -> no readiness verdict
  });

  it("is READY when the expected root is allow-listed and the pool is live", async () => {
    const deps = depsReturning(
      makeConfigBuffer({ paused: false, roots: [A_ROOT, B_ROOT] })
    );
    const s = await runStatus(P, baseArgs({ expectedRoot: A_ROOT }), deps);
    expect(s.expectedRoot).to.equal(A_ROOT);
    expect(s.expectedRootPresent).to.equal(true);
    expect(s.ready).to.equal(true);
  });

  it("is NOT ready when the expected root is absent (operator must submit it)", async () => {
    const deps = depsReturning(
      makeConfigBuffer({ paused: false, roots: [B_ROOT] })
    );
    const s = await runStatus(P, baseArgs({ expectedRoot: A_ROOT }), deps);
    expect(s.expectedRootPresent).to.equal(false);
    expect(s.ready).to.equal(false);
  });

  it("is NOT ready when the pool is paused even if the root is present", async () => {
    const deps = depsReturning(
      makeConfigBuffer({ paused: true, roots: [A_ROOT] })
    );
    const s = await runStatus(P, baseArgs({ expectedRoot: A_ROOT }), deps);
    expect(s.expectedRootPresent).to.equal(true);
    expect(s.paused).to.equal(true);
    expect(s.ready).to.equal(false);
  });

  it("reports config-missing as not ready and does not throw", async () => {
    const deps = depsReturning(null);
    const s = await runStatus(P, baseArgs({ expectedRoot: A_ROOT }), deps);
    expect(s.configExists).to.equal(false);
    expect(s.ready).to.equal(false);
    expect(s.note).to.match(/not ready|not found/i);
  });
});

// ── human formatting ─────────────────────────────────────────────────────────────

describe("shared pool status: human output", () => {
  it("is sober and names the operator-managed root submission model", () => {
    const out = formatStatusHuman(buildStatusReport(P, { offline: true }));
    const lower = out.toLowerCase();
    expect(lower).to.include("devnet only");
    expect(lower).to.include("unaudited");
    expect(lower).to.include("no privacy guarantee");
    expect(lower).to.include("operator-managed");
    expect(lower).to.include("read-only");
    expect(out).to.include(P.programId);
    expect(out).to.include(P.poolPda);
    expect(out).to.include(P.noteTreePda);
  });

  it("never points at mainnet or names a live-send flag", async () => {
    const deps = depsReturning(
      makeConfigBuffer({ paused: false, roots: [A_ROOT] })
    );
    const online = formatStatusHuman(
      await runStatus(P, baseArgs({ expectedRoot: A_ROOT }), deps)
    );
    const offline = formatStatusHuman(buildStatusReport(P, { offline: true }));
    for (const text of [offline, online]) {
      expect(text.toLowerCase()).to.not.include("mainnet");
      expect(text).to.not.include("--" + "send");
    }
  });
});

// ── JSON output (future CLI/package may consume it) ──────────────────────────────

describe("shared pool status: JSON output", () => {
  it("offline JSON round-trips with the static profile and operator-managed flag", () => {
    const s = buildStatusReport(P, { offline: true });
    const parsed = JSON.parse(formatStatusJson(s));
    expect(parsed.profile).to.equal(P.name);
    expect(parsed.rpc).to.equal(P.rpc);
    expect(parsed.programId).to.equal(P.programId);
    expect(parsed.poolPda).to.equal(P.poolPda);
    expect(parsed.configPda).to.equal(P.configPda);
    expect(parsed.noteTreePda).to.equal(P.noteTreePda);
    expect(parsed.defaultDenomination).to.equal(P.defaultDenomination);
    expect(parsed.defaultFee).to.equal(P.defaultFee);
    expect(parsed.rootSubmission).to.equal("operator-managed");
    expect(parsed.offline).to.equal(true);
  });

  it("online-ready JSON exposes the readiness fields for a consumer", async () => {
    const deps = depsReturning(
      makeConfigBuffer({ paused: false, roots: [A_ROOT] })
    );
    const s = await runStatus(P, baseArgs({ expectedRoot: A_ROOT }), deps);
    const parsed = JSON.parse(formatStatusJson(s));
    expect(parsed.offline).to.equal(false);
    expect(parsed.configExists).to.equal(true);
    expect(parsed.allowedRootCount).to.equal(1);
    expect(parsed.expectedRoot).to.equal(A_ROOT);
    expect(parsed.expectedRootPresent).to.equal(true);
    expect(parsed.ready).to.equal(true);
    expect(parsed.rootSubmission).to.equal("operator-managed");
  });
});

// ── real CLI: offline --json emits pure JSON (no network) ────────────────────────

describe("shared pool status: CLI offline JSON purity", () => {
  it("--offline --json --expected-root prints parseable JSON and exits 0", function () {
    this.timeout(60000);
    const res = spawnSync(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        STATUS_REL,
        "--offline",
        "--json",
        "--expected-root",
        A_ROOT,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 55000,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1" },
      }
    );
    expect(res.status, res.stderr).to.equal(0);

    // stdout must be pure JSON (no leading/trailing noise beyond whitespace).
    const parsed = JSON.parse(res.stdout);
    expect(parsed.expectedRoot).to.equal(A_ROOT);
    expect(parsed.expectedRootPresent).to.equal(undefined);
    expect(parsed.ready).to.equal(undefined);
    expect(parsed.offline).to.equal(true);

    // No stack traces leaked to stderr.
    expect(res.stderr).to.not.include("    at ");
  });
});

// ── help text ────────────────────────────────────────────────────────────────────

describe("shared pool status: help", () => {
  it("is sober and documents the read-only / operator-managed boundaries", () => {
    const h = statusHelp().toLowerCase();
    expect(h).to.include("devnet only");
    expect(h).to.include("unaudited");
    expect(h).to.include("no privacy guarantee");
    expect(h).to.include("read-only");
    expect(h).to.include("no wallet");
    expect(h).to.include("no keypairs");
    expect(h).to.include("no transactions");
    expect(h).to.include("never submits roots");
    expect(h).to.include("operator-managed");
  });

  it("documents the optional --rpc-url override", () => {
    expect(statusHelp()).to.include("--rpc-url");
  });
});

// ── source-level safety: no wallet/keypair/mutation surface ──────────────────────

describe("shared pool status: source safety", () => {
  const src = fs.readFileSync(STATUS_SRC, "utf8");

  it("reads no wallet env, keypairs, or filesystem secrets (exact patterns)", () => {
    for (const pat of [
      "process.env.ANCHOR_WALLET",
      "Keypair",
      'from "fs"',
      "from 'fs'",
      "readFileSync",
      "keys/",
      "id.json",
    ]) {
      expect(src, `must not contain: ${pat}`).to.not.include(pat);
    }
  });

  it("constructs no transaction, subprocess, or live-action command (exact patterns)", () => {
    for (const pat of [
      "sendTransaction",
      "sendAndConfirm",
      "requestAirdrop",
      "child_process",
      "spawnSync",
      "execSync",
      "--" + "send", // constructed live-withdrawal flag
      "submit_root_devnet.ts --yes",
      "withdraw_zk_devnet.ts --" + "send",
    ]) {
      expect(src, `must not contain: ${pat}`).to.not.include(pat);
    }
  });

  it("declares the operator-managed, read-only posture in-source", () => {
    expect(src).to.include("operator-managed");
    expect(src).to.include("read-only");
  });
});

// ── npm wiring ─────────────────────────────────────────────────────────────────

describe("shared pool status: npm wiring", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
  ) as { scripts?: Record<string, string> };

  it("package.json wires alpha:status to this status script", () => {
    const script = pkg.scripts?.["alpha:status"];
    expect(script, "expected an alpha:status npm script").to.be.a("string");
    expect(script).to.include(STATUS_REL);
  });

  it("the alpha:status command embeds no local or private path", () => {
    const script = pkg.scripts?.["alpha:status"] ?? "";
    for (const pat of [
      "/ho" + "me/",
      "/Us" + "ers/",
      "keys" + "/",
      "id" + ".json",
      ".con" + "fig/solana",
    ]) {
      expect(script, `must not contain: ${pat}`).to.not.include(pat);
    }
  });
});

// ── root capacity diagnostics ─────────────────────────────────────────────────────

describe("shared pool status: evaluateRootCapacity (pure)", () => {
  it("0/10 => ok, 10 remaining, 0% used, no warning", () => {
    const c = evaluateRootCapacity({ allowedRootCount: 0, maxRoots: 10 });
    expect(c.rootCapacitySeverity).to.equal("ok");
    expect(c.remainingRootSlots).to.equal(10);
    expect(c.rootCapacityUsedPercent).to.equal(0);
    expect(c.rootCapacityWarning).to.be.undefined;
  });

  it("6/10 => ok (4 remaining is above the warning threshold)", () => {
    const c = evaluateRootCapacity({ allowedRootCount: 6, maxRoots: 10 });
    expect(c.rootCapacitySeverity).to.equal("ok");
    expect(c.remainingRootSlots).to.equal(4);
    expect(c.rootCapacityUsedPercent).to.equal(60);
    expect(c.rootCapacityWarning).to.be.undefined;
  });

  it("7/10 => warning, 3 remaining, concise low-capacity message", () => {
    const c = evaluateRootCapacity({ allowedRootCount: 7, maxRoots: 10 });
    expect(c.rootCapacitySeverity).to.equal("warning");
    expect(c.remainingRootSlots).to.equal(ROOT_CAPACITY_WARNING_THRESHOLD);
    expect(c.rootCapacityUsedPercent).to.equal(70);
    expect(c.rootCapacityWarning).to.include(
      "Root capacity is low: 7/10 allowed roots used; 3 slots remain"
    );
  });

  it("9/10 => warning uses singular grammar: '1 slot remains'", () => {
    const c = evaluateRootCapacity({ allowedRootCount: 9, maxRoots: 10 });
    expect(c.rootCapacitySeverity).to.equal("warning");
    expect(c.remainingRootSlots).to.equal(1);
    expect(c.rootCapacityWarning).to.include("1 slot remains");
    expect(c.rootCapacityWarning).to.not.include("1 slot remain.");
    expect(c.rootCapacityWarning).to.not.include("1 slots");
  });

  it("8/10 => warning uses plural grammar: '2 slots remain'", () => {
    const c = evaluateRootCapacity({ allowedRootCount: 8, maxRoots: 10 });
    expect(c.rootCapacitySeverity).to.equal("warning");
    expect(c.remainingRootSlots).to.equal(2);
    expect(c.rootCapacityWarning).to.include("2 slots remain");
  });

  it("10/10 => critical, 0 remaining, operator rotation message", () => {
    const c = evaluateRootCapacity({ allowedRootCount: 10, maxRoots: 10 });
    expect(c.rootCapacitySeverity).to.equal("critical");
    expect(c.remainingRootSlots).to.equal(0);
    expect(c.rootCapacityUsedPercent).to.equal(100);
    expect(c.rootCapacityWarning).to.include("exhausted");
    expect(c.rootCapacityWarning).to.include(
      "root rotation or capacity policy"
    );
  });

  it("11/10 (over-full) => critical, clamps to 0 remaining and 100% used", () => {
    const c = evaluateRootCapacity({ allowedRootCount: 11, maxRoots: 10 });
    expect(c.rootCapacitySeverity).to.equal("critical");
    expect(c.remainingRootSlots).to.equal(0);
    expect(c.rootCapacityUsedPercent).to.equal(100);
    expect(c.rootCapacityWarning).to.be.a("string");
  });

  it("maxRoots=0 edge => critical safe fallback, no NaN/negative values", () => {
    const c = evaluateRootCapacity({ allowedRootCount: 0, maxRoots: 0 });
    expect(c.rootCapacitySeverity).to.equal("critical");
    expect(c.remainingRootSlots).to.equal(0);
    expect(c.rootCapacityUsedPercent).to.equal(100);
    expect(Number.isNaN(c.rootCapacityUsedPercent)).to.equal(false);
    expect(c.rootCapacityWarning).to.include("unavailable");
  });
});

describe("shared pool status: root capacity in report output", () => {
  it("online report exposes the capacity fields in JSON for 7/10", async () => {
    const buf = makeConfigBuffer({
      paused: false,
      roots: [
        A_ROOT,
        B_ROOT,
        "c".repeat(64),
        "d".repeat(64),
        "e".repeat(64),
        "f".repeat(64),
        "1".repeat(64),
      ],
    });
    const status = await runStatus(P, baseArgs(), depsReturning(buf));
    expect(status.allowedRootCount).to.equal(7);
    expect(status.remainingRootSlots).to.equal(3);
    expect(status.rootCapacityUsedPercent).to.equal(70);
    expect(status.rootCapacitySeverity).to.equal("warning");
    const parsed = JSON.parse(formatStatusJson(status));
    expect(parsed.remainingRootSlots).to.equal(3);
    expect(parsed.rootCapacityUsedPercent).to.equal(70);
    expect(parsed.rootCapacitySeverity).to.equal("warning");
    expect(parsed.rootCapacityWarning).to.include("Root capacity is low");
  });

  it("human output prints the concise 7/10 low-capacity warning", async () => {
    const buf = makeConfigBuffer({
      paused: false,
      roots: [
        A_ROOT,
        B_ROOT,
        "c".repeat(64),
        "d".repeat(64),
        "e".repeat(64),
        "f".repeat(64),
        "1".repeat(64),
      ],
    });
    const status = await runStatus(P, baseArgs(), depsReturning(buf));
    const human = formatStatusHuman(status);
    expect(human).to.include(
      "Root capacity is low: 7/10 allowed roots used; 3 slots remain"
    );
    expect(human).to.include("Root slots left:");
  });

  it("human output prints no capacity warning when severity is ok (2/10)", async () => {
    const buf = makeConfigBuffer({ paused: false, roots: [A_ROOT, B_ROOT] });
    const status = await runStatus(P, baseArgs(), depsReturning(buf));
    expect(status.rootCapacitySeverity).to.equal("ok");
    expect(status.rootCapacityWarning).to.be.undefined;
    const human = formatStatusHuman(status);
    expect(human).to.not.include("Root capacity is low");
    expect(human).to.not.include("exhausted");
  });

  it("offline report computes no capacity fields", () => {
    const s = buildStatusReport(P, { offline: true });
    expect(s.remainingRootSlots).to.be.undefined;
    expect(s.rootCapacitySeverity).to.be.undefined;
  });
});
