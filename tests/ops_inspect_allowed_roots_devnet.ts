import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  PROGRAM_ID,
  MAX_ROOTS,
  InspectArgs,
  InspectDeps,
  VerifierConfigSummary,
  parseArgs,
  validateRootHex,
  deriveConfigPda,
  decodeVerifierConfig,
  allowedRootsToHex,
  isExpectedRootPresent,
  buildSummary,
  runInspect,
  formatHuman,
  formatJson,
} from "../scripts/ops/inspect_allowed_roots_devnet";

// ── Test constants ────────────────────────────────────────────────────────────

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "ops",
  "inspect_allowed_roots_devnet.ts"
);

const KNOWN_PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";
const KNOWN_CONFIG_PDA = "6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu";
const KNOWN_ROOT =
  "2a065f5ccc90a22c2d5789d4ec9c65dc0189c18c43c785d3ac54fd00e93f8dd3";
const ADMIN_PUBKEY_STR = "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o";
const OTHER_PUBKEY_STR = "11111111111111111111111111111111";
// Distinct pubkey used as root_submitter_authority in tests that check separation.
const ROOT_SUBMITTER_PUBKEY_STR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const BASE_ARGS = ["--rpc-url", "https://api.devnet.solana.com"];
const DISC_CFG = Buffer.from([176, 103, 248, 36, 138, 167, 176, 220]);
const CURRENT_CONFIG_LEN = 699;

// ── Buffer builder ────────────────────────────────────────────────────────────

// Build a minimal valid VerifierConfig account buffer for testing.
// adminBytes: 32-byte admin pubkey. verifierBytes: 32-byte pubkey array.
// roots: array of 32-byte root hex strings.
function buildConfigBuffer(opts: {
  admin?: Buffer;
  attester?: Buffer;
  rootSubmitter?: Buffer;
  chainId?: bigint;
  paused?: boolean;
  threshold?: number;
  verifiers?: Buffer[];
  roots?: Buffer[];
  bump?: number;
  overrideDisc?: Buffer;
  overrideLen?: number;
}): Buffer {
  const admin =
    opts.admin ?? Buffer.from(new PublicKey(ADMIN_PUBKEY_STR).toBytes());
  const attester = opts.attester ?? Buffer.alloc(32);
  // Default mirrors initialize_config: root_submitter_authority = admin_authority.
  const rootSubmitter =
    opts.rootSubmitter ??
    Buffer.from(new PublicKey(ADMIN_PUBKEY_STR).toBytes());
  const chainId = opts.chainId ?? 1n;
  const paused = opts.paused ?? false;
  const threshold = opts.threshold ?? 1;
  const verifiers = opts.verifiers ?? [];
  const roots = opts.roots ?? [];
  const bump = opts.bump ?? 255;

  const disc = opts.overrideDisc ?? DISC_CFG;
  const buf = Buffer.alloc(opts.overrideLen ?? CURRENT_CONFIG_LEN, 0);

  let off = 0;

  // [0..8] discriminator
  disc.copy(buf, off);
  off += 8;

  // [8..40] admin_authority
  admin.copy(buf, off);
  off += 32;

  // [40..72] attester_pubkey
  attester.copy(buf, off);
  off += 32;

  // [72..104] root_submitter_authority
  rootSubmitter.copy(buf, off);
  off += 32;

  // [104..112] chain_id (u64 LE)
  buf.writeBigUInt64LE(chainId, off);
  off += 8;

  // [112] paused
  buf[off++] = paused ? 1 : 0;

  // [113] threshold
  buf[off++] = threshold;

  // [114..118] verifiers vec len, then verifier pubkeys starting at [118]
  buf.writeUInt32LE(verifiers.length, off);
  off += 4;
  for (const v of verifiers) {
    v.copy(buf, off);
    off += 32;
  }

  // allowed_roots vec: len immediately after verifier data (dynamic offset)
  buf.writeUInt32LE(roots.length, off);
  off += 4;
  for (const r of roots) {
    r.copy(buf, off);
    off += 32;
  }

  // bump immediately after roots
  buf[off] = bump;

  return buf;
}

function rootHexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

// ── Module guard ──────────────────────────────────────────────────────────────

describe("inspect_allowed_roots_devnet: module guard", () => {
  it("1. exports are accessible; require.main guard prevents execution on import", () => {
    expect(PROGRAM_ID).to.be.a("string").with.length.greaterThan(0);
    expect(MAX_ROOTS).to.equal(10);
    expect(parseArgs).to.be.a("function");
    expect(validateRootHex).to.be.a("function");
    expect(deriveConfigPda).to.be.a("function");
    expect(decodeVerifierConfig).to.be.a("function");
    expect(allowedRootsToHex).to.be.a("function");
    expect(isExpectedRootPresent).to.be.a("function");
    expect(buildSummary).to.be.a("function");
    expect(runInspect).to.be.a("function");
    expect(formatHuman).to.be.a("function");
    expect(formatJson).to.be.a("function");
  });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("inspect_allowed_roots_devnet: parseArgs", () => {
  it("2. rejects missing --rpc-url", () => {
    expect(() => parseArgs([])).to.throw(/--rpc-url is required/);
  });

  it("3. accepts --rpc-url and sets rpcUrl", () => {
    const args = parseArgs([...BASE_ARGS]);
    expect(args.rpcUrl).to.equal("https://api.devnet.solana.com");
  });

  it("4. default commitment is confirmed", () => {
    const args = parseArgs([...BASE_ARGS]);
    expect(args.commitment).to.equal("confirmed");
  });

  it("5. accepts --commitment confirmed", () => {
    const args = parseArgs([...BASE_ARGS, "--commitment", "confirmed"]);
    expect(args.commitment).to.equal("confirmed");
  });

  it("6. accepts --commitment finalized", () => {
    const args = parseArgs([...BASE_ARGS, "--commitment", "finalized"]);
    expect(args.commitment).to.equal("finalized");
  });

  it("7. accepts --commitment processed", () => {
    const args = parseArgs([...BASE_ARGS, "--commitment", "processed"]);
    expect(args.commitment).to.equal("processed");
  });

  it("8. rejects invalid --commitment value", () => {
    expect(() => parseArgs([...BASE_ARGS, "--commitment", "instant"])).to.throw(
      /--commitment must be/
    );
  });

  it("9. --commitment missing value rejects", () => {
    expect(() => parseArgs([...BASE_ARGS, "--commitment"])).to.throw(
      /requires a value/
    );
  });

  it("10. accepts --expected-root with valid root", () => {
    const args = parseArgs([...BASE_ARGS, "--expected-root", KNOWN_ROOT]);
    expect(args.expectedRoot).to.equal(KNOWN_ROOT.toLowerCase());
  });

  it("11. normalizes uppercase --expected-root to lowercase", () => {
    const upper = KNOWN_ROOT.toUpperCase();
    const args = parseArgs([...BASE_ARGS, "--expected-root", upper]);
    expect(args.expectedRoot).to.equal(KNOWN_ROOT.toLowerCase());
  });

  it("12. rejects malformed --expected-root (not 64 hex chars)", () => {
    expect(() =>
      parseArgs([...BASE_ARGS, "--expected-root", "deadbeef"])
    ).to.throw(/64 hex/);
  });

  it("13. rejects all-zero --expected-root", () => {
    expect(() =>
      parseArgs([...BASE_ARGS, "--expected-root", "0".repeat(64)])
    ).to.throw(/all-zero/);
  });

  it("14. --expected-root missing value rejects", () => {
    expect(() => parseArgs([...BASE_ARGS, "--expected-root"])).to.throw(
      /requires a value/
    );
  });

  it("15. default --program-id is the known program ID", () => {
    const args = parseArgs([...BASE_ARGS]);
    expect(args.programId).to.equal(KNOWN_PROGRAM_ID);
  });

  it("16. accepts --program-id with valid pubkey", () => {
    const args = parseArgs([...BASE_ARGS, "--program-id", KNOWN_PROGRAM_ID]);
    expect(args.programId).to.equal(KNOWN_PROGRAM_ID);
  });

  it("17. rejects malformed --program-id", () => {
    expect(() =>
      parseArgs([...BASE_ARGS, "--program-id", "not-a-pubkey"])
    ).to.throw(/not a valid public key/);
  });

  it("18. --program-id missing value rejects", () => {
    expect(() => parseArgs([...BASE_ARGS, "--program-id"])).to.throw(
      /requires a value/
    );
  });

  it("19. accepts --config-pda with valid pubkey", () => {
    const args = parseArgs([...BASE_ARGS, "--config-pda", KNOWN_CONFIG_PDA]);
    expect(args.configPda).to.equal(KNOWN_CONFIG_PDA);
  });

  it("20. rejects malformed --config-pda", () => {
    expect(() => parseArgs([...BASE_ARGS, "--config-pda", "bad-pda"])).to.throw(
      /not a valid public key/
    );
  });

  it("21. --config-pda missing value rejects", () => {
    expect(() => parseArgs([...BASE_ARGS, "--config-pda"])).to.throw(
      /requires a value/
    );
  });

  it("22. --rpc-url missing value rejects", () => {
    expect(() => parseArgs(["--rpc-url"])).to.throw(/requires a value/);
  });

  it("23. accepts --json flag", () => {
    const args = parseArgs([...BASE_ARGS, "--json"]);
    expect(args.json).to.equal(true);
  });

  it("24. json defaults to false", () => {
    const args = parseArgs([...BASE_ARGS]);
    expect(args.json).to.equal(false);
  });

  it("25. rejects unknown flag", () => {
    expect(() => parseArgs([...BASE_ARGS, "--unknown"])).to.throw(
      /unknown flag/
    );
  });

  it("26. configPda is undefined by default", () => {
    const args = parseArgs([...BASE_ARGS]);
    expect(args.configPda).to.be.undefined;
  });

  it("27. expectedRoot is undefined by default", () => {
    const args = parseArgs([...BASE_ARGS]);
    expect(args.expectedRoot).to.be.undefined;
  });
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("inspect_allowed_roots_devnet: pure helpers", () => {
  it("28. allowedRootsToHex converts Buffer array to lowercase hex strings", () => {
    const root = rootHexToBuffer(KNOWN_ROOT);
    const result = allowedRootsToHex([root]);
    expect(result).to.deep.equal([KNOWN_ROOT.toLowerCase()]);
  });

  it("29. allowedRootsToHex normalizes uppercase bytes to lowercase", () => {
    const root = rootHexToBuffer("AABB".padEnd(64, "0").toLowerCase());
    const result = allowedRootsToHex([root]);
    expect(result[0]).to.match(/^[0-9a-f]{64}$/);
  });

  it("30. isExpectedRootPresent returns true when root is present", () => {
    const roots = [KNOWN_ROOT.toLowerCase()];
    expect(isExpectedRootPresent(roots, KNOWN_ROOT)).to.equal(true);
  });

  it("31. isExpectedRootPresent returns true for uppercase input (case-insensitive)", () => {
    const roots = [KNOWN_ROOT.toLowerCase()];
    expect(isExpectedRootPresent(roots, KNOWN_ROOT.toUpperCase())).to.equal(
      true
    );
  });

  it("32. isExpectedRootPresent returns false when root is absent", () => {
    const roots = ["a".repeat(64)];
    expect(isExpectedRootPresent(roots, KNOWN_ROOT)).to.equal(false);
  });

  it("33. isExpectedRootPresent returns false on empty list", () => {
    expect(isExpectedRootPresent([], KNOWN_ROOT)).to.equal(false);
  });

  it("34. full capacity is true when allowedRoots.length >= MAX_ROOTS", () => {
    const roots = Array.from({ length: MAX_ROOTS }, (_, i) =>
      Buffer.alloc(32, i + 1)
    );
    const buf = buildConfigBuffer({ roots });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    const summary = buildSummary(
      KNOWN_PROGRAM_ID,
      KNOWN_CONFIG_PDA,
      decoded!,
      true
    );
    expect(summary.full).to.equal(true);
  });

  it("35. full capacity is false when allowedRoots.length < MAX_ROOTS", () => {
    const roots = [rootHexToBuffer(KNOWN_ROOT)];
    const buf = buildConfigBuffer({ roots });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    const summary = buildSummary(
      KNOWN_PROGRAM_ID,
      KNOWN_CONFIG_PDA,
      decoded!,
      true
    );
    expect(summary.full).to.equal(false);
  });

  it("36. deriveConfigPda returns the known config PDA for the known program ID", () => {
    const programPubkey = new PublicKey(KNOWN_PROGRAM_ID);
    const [pda] = deriveConfigPda(programPubkey);
    expect(pda.toBase58()).to.equal(KNOWN_CONFIG_PDA);
  });
});

// ── decodeVerifierConfig ──────────────────────────────────────────────────────

describe("inspect_allowed_roots_devnet: decodeVerifierConfig", () => {
  it("37. returns null for wrong discriminator", () => {
    const buf = buildConfigBuffer({
      overrideDisc: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
    });
    expect(decodeVerifierConfig(buf)).to.be.null;
  });

  it("38. returns null for wrong buffer length", () => {
    const shortBuf = Buffer.alloc(100, 0);
    DISC_CFG.copy(shortBuf, 0);
    expect(decodeVerifierConfig(shortBuf)).to.be.null;
  });

  it("39. decodes admin authority correctly", () => {
    const adminBytes = Buffer.from(new PublicKey(ADMIN_PUBKEY_STR).toBytes());
    const buf = buildConfigBuffer({ admin: adminBytes });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    expect(decoded!.adminAuthority.toBase58()).to.equal(ADMIN_PUBKEY_STR);
  });

  it("40. decodes paused=true correctly", () => {
    const buf = buildConfigBuffer({ paused: true });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    expect(decoded!.paused).to.equal(true);
  });

  it("41. decodes paused=false correctly", () => {
    const buf = buildConfigBuffer({ paused: false });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    expect(decoded!.paused).to.equal(false);
  });

  it("42. decodes threshold correctly", () => {
    const buf = buildConfigBuffer({ threshold: 2 });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    expect(decoded!.threshold).to.equal(2);
  });

  it("43. decodes allowed root correctly", () => {
    const root = rootHexToBuffer(KNOWN_ROOT);
    const buf = buildConfigBuffer({ roots: [root] });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    expect(decoded!.allowedRoots).to.have.length(1);
    expect(decoded!.allowedRoots[0].toString("hex")).to.equal(KNOWN_ROOT);
  });

  it("44. decodes zero roots correctly", () => {
    const buf = buildConfigBuffer({ roots: [] });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    expect(decoded!.allowedRoots).to.have.length(0);
  });

  it("45. decodes rootSubmitterAuthority correctly from bytes [72..104]", () => {
    const rootSubmitterBytes = Buffer.from(
      new PublicKey(ROOT_SUBMITTER_PUBKEY_STR).toBytes()
    );
    const buf = buildConfigBuffer({ rootSubmitter: rootSubmitterBytes });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    expect(decoded!.rootSubmitterAuthority.toBase58()).to.equal(
      ROOT_SUBMITTER_PUBKEY_STR
    );
  });

  it("46. decodeVerifierConfig returns null for 667-byte buffer (previous layout)", () => {
    // 667 bytes was PREV_CONFIG_LEN; the decode function requires CURRENT_CONFIG_LEN (699).
    const prevBuf = Buffer.alloc(667, 0);
    DISC_CFG.copy(prevBuf, 0);
    expect(decodeVerifierConfig(prevBuf)).to.be.null;
  });
});

// ── buildSummary ──────────────────────────────────────────────────────────────

describe("inspect_allowed_roots_devnet: buildSummary", () => {
  it("47. returns exists=false when decoded=null", () => {
    const summary = buildSummary(
      KNOWN_PROGRAM_ID,
      KNOWN_CONFIG_PDA,
      null,
      false
    );
    expect(summary.exists).to.equal(false);
    expect(summary.programId).to.equal(KNOWN_PROGRAM_ID);
    expect(summary.configPda).to.equal(KNOWN_CONFIG_PDA);
  });

  it("48. missing account with expected root sets expectedRootPresent=false", () => {
    const summary = buildSummary(
      KNOWN_PROGRAM_ID,
      KNOWN_CONFIG_PDA,
      null,
      false,
      KNOWN_ROOT
    );
    expect(summary.exists).to.equal(false);
    expect(summary.expectedRoot).to.equal(KNOWN_ROOT.toLowerCase());
    expect(summary.expectedRootPresent).to.equal(false);
  });

  it("49. existing account sets correct summary fields", () => {
    const adminBytes = Buffer.from(new PublicKey(ADMIN_PUBKEY_STR).toBytes());
    const root = rootHexToBuffer(KNOWN_ROOT);
    const buf = buildConfigBuffer({
      admin: adminBytes,
      threshold: 1,
      paused: false,
      roots: [root],
    });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    const summary = buildSummary(
      KNOWN_PROGRAM_ID,
      KNOWN_CONFIG_PDA,
      decoded!,
      true
    );
    expect(summary.exists).to.equal(true);
    expect(summary.adminAuthority).to.equal(ADMIN_PUBKEY_STR);
    expect(summary.paused).to.equal(false);
    expect(summary.threshold).to.equal(1);
    expect(summary.allowedRootCount).to.equal(1);
    expect(summary.maxRoots).to.equal(MAX_ROOTS);
    expect(summary.allowedRoots).to.deep.equal([KNOWN_ROOT.toLowerCase()]);
    expect(summary.full).to.equal(false);
  });

  it("50. expectedRootPresent=true when root is in allowed list", () => {
    const root = rootHexToBuffer(KNOWN_ROOT);
    const buf = buildConfigBuffer({ roots: [root] });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    const summary = buildSummary(
      KNOWN_PROGRAM_ID,
      KNOWN_CONFIG_PDA,
      decoded!,
      true,
      KNOWN_ROOT
    );
    expect(summary.expectedRootPresent).to.equal(true);
  });

  it("51. expectedRootPresent=false when root is not in allowed list", () => {
    const root = rootHexToBuffer("a".repeat(64));
    const buf = buildConfigBuffer({ roots: [root] });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    const summary = buildSummary(
      KNOWN_PROGRAM_ID,
      KNOWN_CONFIG_PDA,
      decoded!,
      true,
      KNOWN_ROOT
    );
    expect(summary.expectedRootPresent).to.equal(false);
  });

  it("52. buildSummary includes rootSubmitterAuthority from decoded config", () => {
    const rootSubmitterBytes = Buffer.from(
      new PublicKey(ROOT_SUBMITTER_PUBKEY_STR).toBytes()
    );
    const buf = buildConfigBuffer({ rootSubmitter: rootSubmitterBytes });
    const decoded = decodeVerifierConfig(buf);
    expect(decoded).to.not.be.null;
    const summary = buildSummary(
      KNOWN_PROGRAM_ID,
      KNOWN_CONFIG_PDA,
      decoded!,
      true
    );
    expect(summary.rootSubmitterAuthority).to.equal(ROOT_SUBMITTER_PUBKEY_STR);
  });
});

// ── formatHuman / formatJson ──────────────────────────────────────────────────

describe("inspect_allowed_roots_devnet: output formatting", () => {
  const root = rootHexToBuffer(KNOWN_ROOT);
  const adminBytes = Buffer.from(new PublicKey(ADMIN_PUBKEY_STR).toBytes());

  function buildTestSummary(
    overrides: Partial<VerifierConfigSummary> = {}
  ): VerifierConfigSummary {
    const buf = buildConfigBuffer({
      admin: adminBytes,
      roots: [root],
      threshold: 1,
      paused: false,
    });
    const decoded = decodeVerifierConfig(buf)!;
    const base = buildSummary(
      KNOWN_PROGRAM_ID,
      KNOWN_CONFIG_PDA,
      decoded,
      true,
      KNOWN_ROOT
    );
    return { ...base, ...overrides };
  }

  it("53. formatHuman includes program ID", () => {
    const out = formatHuman(buildTestSummary());
    expect(out).to.include(KNOWN_PROGRAM_ID);
  });

  it("54. formatHuman includes config PDA", () => {
    const out = formatHuman(buildTestSummary());
    expect(out).to.include(KNOWN_CONFIG_PDA);
  });

  it("55. formatHuman includes expected root", () => {
    const out = formatHuman(buildTestSummary());
    expect(out).to.include(KNOWN_ROOT.toLowerCase());
  });

  it("56. formatHuman includes Root present: true when root is found", () => {
    const out = formatHuman(buildTestSummary());
    expect(out).to.include("Root present:");
    expect(out).to.include("true");
  });

  it("57. formatHuman includes Full:", () => {
    const out = formatHuman(buildTestSummary());
    expect(out).to.include("Full:");
  });

  it("58. formatHuman includes Allowed roots: for existing account", () => {
    const out = formatHuman(buildTestSummary());
    expect(out).to.include("Allowed roots:");
  });

  it("59. formatHuman shows account-not-found message when exists=false", () => {
    const summary = buildSummary(
      KNOWN_PROGRAM_ID,
      KNOWN_CONFIG_PDA,
      null,
      false
    );
    const out = formatHuman(summary);
    expect(out).to.include("not found");
  });

  it("60. formatJson returns valid JSON containing programId", () => {
    const summary = buildTestSummary();
    const json = formatJson(summary);
    const parsed = JSON.parse(json);
    expect(parsed.programId).to.equal(KNOWN_PROGRAM_ID);
  });

  it("61. formatJson output contains configPda, exists, allowedRoots, full", () => {
    const summary = buildTestSummary();
    const parsed = JSON.parse(formatJson(summary));
    expect(parsed).to.have.property("configPda");
    expect(parsed).to.have.property("exists");
    expect(parsed).to.have.property("allowedRoots");
    expect(parsed).to.have.property("full");
  });

  it("62. formatJson output contains expectedRootPresent=true", () => {
    const summary = buildTestSummary();
    const parsed = JSON.parse(formatJson(summary));
    expect(parsed.expectedRootPresent).to.equal(true);
  });

  it("63. formatHuman includes root_submitter_authority pubkey", () => {
    const rootSubmitterBytes = Buffer.from(
      new PublicKey(ROOT_SUBMITTER_PUBKEY_STR).toBytes()
    );
    const buf = buildConfigBuffer({ rootSubmitter: rootSubmitterBytes });
    const decoded = decodeVerifierConfig(buf)!;
    const summary = buildSummary(
      KNOWN_PROGRAM_ID,
      KNOWN_CONFIG_PDA,
      decoded,
      true
    );
    const out = formatHuman(summary);
    expect(out).to.include(ROOT_SUBMITTER_PUBKEY_STR);
  });
});

// ── runInspect ────────────────────────────────────────────────────────────────

describe("inspect_allowed_roots_devnet: runInspect", () => {
  const programPubkey = new PublicKey(KNOWN_PROGRAM_ID);

  const baseArgs: InspectArgs = {
    rpcUrl: "https://api.devnet.solana.com",
    programId: KNOWN_PROGRAM_ID,
    commitment: "confirmed",
    json: false,
  };

  function makeExistsDeps(buf: Buffer, ownerOverride?: PublicKey): InspectDeps {
    return {
      getAccountInfo: async () => ({
        data: buf,
        owner: ownerOverride ?? programPubkey,
      }),
    };
  }

  it("64. missing account returns exists=false summary", async () => {
    const deps: InspectDeps = { getAccountInfo: async () => null };
    const summary = await runInspect(baseArgs, deps);
    expect(summary.exists).to.equal(false);
  });

  it("65. missing account with expectedRoot sets expectedRootPresent=false", async () => {
    const deps: InspectDeps = { getAccountInfo: async () => null };
    const summary = await runInspect(
      { ...baseArgs, expectedRoot: KNOWN_ROOT },
      deps
    );
    expect(summary.exists).to.equal(false);
    expect(summary.expectedRootPresent).to.equal(false);
  });

  it("66. existing account decodes and summary has correct fields", async () => {
    const adminBytes = Buffer.from(new PublicKey(ADMIN_PUBKEY_STR).toBytes());
    const root = rootHexToBuffer(KNOWN_ROOT);
    const buf = buildConfigBuffer({ admin: adminBytes, roots: [root] });
    const deps = makeExistsDeps(buf);
    const summary = await runInspect(baseArgs, deps);
    expect(summary.exists).to.equal(true);
    expect(summary.adminAuthority).to.equal(ADMIN_PUBKEY_STR);
    expect(summary.allowedRootCount).to.equal(1);
  });

  it("67. expected root present sets expectedRootPresent=true", async () => {
    const root = rootHexToBuffer(KNOWN_ROOT);
    const buf = buildConfigBuffer({ roots: [root] });
    const deps = makeExistsDeps(buf);
    const summary = await runInspect(
      { ...baseArgs, expectedRoot: KNOWN_ROOT },
      deps
    );
    expect(summary.expectedRootPresent).to.equal(true);
  });

  it("68. expected root absent sets expectedRootPresent=false", async () => {
    const root = rootHexToBuffer("a".repeat(64));
    const buf = buildConfigBuffer({ roots: [root] });
    const deps = makeExistsDeps(buf);
    const summary = await runInspect(
      { ...baseArgs, expectedRoot: KNOWN_ROOT },
      deps
    );
    expect(summary.expectedRootPresent).to.equal(false);
  });

  it("69. owner mismatch throws clear error", async () => {
    const buf = buildConfigBuffer({});
    const wrongOwner = new PublicKey(OTHER_PUBKEY_STR);
    const deps = makeExistsDeps(buf, wrongOwner);
    let err: Error | undefined;
    try {
      await runInspect(baseArgs, deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("owner mismatch");
    expect(err!.message).to.include(OTHER_PUBKEY_STR);
  });

  it("70. owner matches program ID succeeds", async () => {
    const buf = buildConfigBuffer({});
    const deps = makeExistsDeps(buf, programPubkey);
    const summary = await runInspect(baseArgs, deps);
    expect(summary.exists).to.equal(true);
  });

  it("71. decode failure on bad discriminator throws clear error", async () => {
    const badBuf = Buffer.alloc(699, 0); // correct size, all-zero discriminator = wrong disc
    const deps: InspectDeps = {
      getAccountInfo: async () => ({
        data: badBuf,
        owner: programPubkey,
      }),
    };
    let err: Error | undefined;
    try {
      await runInspect(baseArgs, deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("Failed to decode");
  });

  it("72. --config-pda is used when supplied instead of derived PDA", async () => {
    let capturedPda: PublicKey | undefined;
    const buf = buildConfigBuffer({});
    const deps: InspectDeps = {
      getAccountInfo: async (pda, _c) => {
        capturedPda = pda;
        return { data: buf, owner: programPubkey };
      },
    };
    await runInspect({ ...baseArgs, configPda: KNOWN_CONFIG_PDA }, deps);
    expect(capturedPda!.toBase58()).to.equal(KNOWN_CONFIG_PDA);
  });

  it("73. commitment is forwarded to getAccountInfo", async () => {
    let capturedCommitment: string | undefined;
    const buf = buildConfigBuffer({});
    const deps: InspectDeps = {
      getAccountInfo: async (_pda, commitment) => {
        capturedCommitment = commitment;
        return { data: buf, owner: programPubkey };
      },
    };
    await runInspect({ ...baseArgs, commitment: "finalized" }, deps);
    expect(capturedCommitment).to.equal("finalized");
  });
});

// ── Source scan ───────────────────────────────────────────────────────────────
//
// Strings built with join() so this test file itself does not contain the
// forbidden call patterns consecutively and does not self-flag.

describe("inspect_allowed_roots_devnet: source scan", () => {
  const join = (...parts: string[]) => parts.join("");
  let src: string;

  before(() => {
    src = fs.readFileSync(SCRIPT_PATH, "utf8");
  });

  it("74. script does not contain .rpc( call pattern", () => {
    expect(src).to.not.include(join(".", "rpc("));
  });

  it("75. script does not contain sendAndConfirmTransaction", () => {
    expect(src).to.not.include(join("send", "And", "Confirm", "Transaction"));
  });

  it("76. script does not contain Keypair.generate", () => {
    expect(src).to.not.include(join("Keypair", ".", "generate"));
  });

  it("77. script does not contain requestAirdrop", () => {
    expect(src).to.not.include(join("request", "Airdrop"));
  });

  it("78. script does not contain deposit-note call patterns", () => {
    expect(src).to.not.include(join("deposit", "_note("));
    expect(src).to.not.include(join("deposit", "Note("));
  });

  it("79. script does not contain ZK withdraw call patterns", () => {
    expect(src).to.not.include(join("withdraw", "_zk("));
    expect(src).to.not.include(join("withdraw", "Zk("));
  });

  it("80. script does not reference ANCHOR_WALLET", () => {
    expect(src).to.not.include(join("ANCHOR", "_WALLET"));
  });
});
