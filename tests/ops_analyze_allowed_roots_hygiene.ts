import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import {
  parseHygieneArgs,
  buildAllowedRootsHygieneReport,
  formatHumanHygieneReport,
  runAllowedRootsHygieneMain,
  HygieneArgs,
  DecodedAllowedRootsConfig,
} from "../scripts/ops/analyze_allowed_roots_hygiene";

// ── Constants ──────────────────────────────────────────────────────────────────

const KNOWN_PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";
const KNOWN_CONFIG_PDA = "6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu";
const KNOWN_ROOT =
  "2a065f5ccc90a22c2d5789d4ec9c65dc0189c18c43c785d3ac54fd00e93f8dd3";
const ADMIN_PUBKEY = "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o";
const ROOT_SUBMITTER_PUBKEY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const VERIFIER_PUBKEY_1 = "So11111111111111111111111111111111111111112";
const ATTESTER_PUBKEY = VERIFIER_PUBKEY_1; // in verifier set → no [ATTESTER_NOT_IN_VERIFIER_SET]

const BASE_ARGS = [
  "--rpc-url",
  "https://api.devnet.solana.com",
  "--program-id",
  KNOWN_PROGRAM_ID,
];

// ── Fixtures ───────────────────────────────────────────────────────────────────

function baseArgs(overrides: Partial<HygieneArgs> = {}): HygieneArgs {
  return {
    rpcUrl: "https://api.devnet.solana.com",
    programId: KNOWN_PROGRAM_ID,
    nearCapacityThreshold: 8,
    commitment: "confirmed",
    json: false,
    ...overrides,
  };
}

function baseDecoded(
  overrides: Partial<DecodedAllowedRootsConfig> = {}
): DecodedAllowedRootsConfig {
  return {
    programId: KNOWN_PROGRAM_ID,
    configPda: KNOWN_CONFIG_PDA,
    exists: true,
    paused: false,
    adminAuthority: ADMIN_PUBKEY,
    rootSubmitterAuthority: ROOT_SUBMITTER_PUBKEY,
    attesterPubkey: ATTESTER_PUBKEY,
    verifierPubkeys: [VERIFIER_PUBKEY_1],
    threshold: 2,
    verifierCount: 3,
    allowedRoots: [KNOWN_ROOT],
    maxRoots: 10,
    ...overrides,
  };
}

// ── Parser tests ───────────────────────────────────────────────────────────────

describe("ops_analyze_allowed_roots_hygiene: parseHygieneArgs", function () {
  // 1
  it("requires --rpc-url", () => {
    expect(() => parseHygieneArgs(["--program-id", KNOWN_PROGRAM_ID])).to.throw(
      /--rpc-url is required/
    );
  });

  // 2
  it("requires --program-id", () => {
    expect(() =>
      parseHygieneArgs(["--rpc-url", "https://api.devnet.solana.com"])
    ).to.throw(/--program-id is required/);
  });

  // 3
  it("parses valid required args and applies defaults", () => {
    const args = parseHygieneArgs([...BASE_ARGS]);
    expect(args.rpcUrl).to.equal("https://api.devnet.solana.com");
    expect(args.programId).to.equal(KNOWN_PROGRAM_ID);
    expect(args.commitment).to.equal("confirmed");
    expect(args.nearCapacityThreshold).to.equal(8);
    expect(args.json).to.equal(false);
    expect(args.expectedRoot).to.be.undefined;
  });

  // 4
  it("rejects invalid program id", () => {
    expect(() =>
      parseHygieneArgs([
        "--rpc-url",
        "https://api.devnet.solana.com",
        "--program-id",
        "not-a-pubkey",
      ])
    ).to.throw(/not a valid public key/);
  });

  // 5
  it("parses --expected-root and lowercases it", () => {
    const args = parseHygieneArgs([
      ...BASE_ARGS,
      "--expected-root",
      KNOWN_ROOT.toUpperCase(),
    ]);
    expect(args.expectedRoot).to.equal(KNOWN_ROOT.toLowerCase());
  });

  // 6
  it("rejects --expected-root with wrong length", () => {
    expect(() =>
      parseHygieneArgs([...BASE_ARGS, "--expected-root", "deadbeef"])
    ).to.throw(/64 hex/);
  });

  // 7
  it("rejects --expected-root with non-hex characters", () => {
    expect(() =>
      parseHygieneArgs([...BASE_ARGS, "--expected-root", "z".repeat(64)])
    ).to.throw(/64 hex/);
  });

  // 8
  it("parses --near-capacity-threshold", () => {
    const args = parseHygieneArgs([
      ...BASE_ARGS,
      "--near-capacity-threshold",
      "5",
    ]);
    expect(args.nearCapacityThreshold).to.equal(5);
  });

  // 9
  it("rejects --near-capacity-threshold of zero", () => {
    expect(() =>
      parseHygieneArgs([...BASE_ARGS, "--near-capacity-threshold", "0"])
    ).to.throw(/positive integer/);
  });

  // 10
  it("parses all valid --commitment values", () => {
    for (const c of ["processed", "confirmed", "finalized"] as const) {
      const args = parseHygieneArgs([...BASE_ARGS, "--commitment", c]);
      expect(args.commitment).to.equal(c);
    }
  });

  // 11
  it("rejects invalid --commitment value", () => {
    expect(() =>
      parseHygieneArgs([...BASE_ARGS, "--commitment", "instant"])
    ).to.throw(/--commitment/);
  });

  // 12
  it("rejects unknown flag", () => {
    expect(() => parseHygieneArgs([...BASE_ARGS, "--unknown-flag"])).to.throw(
      /unknown flag/
    );
  });

  // 13
  it("parses --json flag", () => {
    const args = parseHygieneArgs([...BASE_ARGS, "--json"]);
    expect(args.json).to.equal(true);
  });
});

// ── Report builder tests ───────────────────────────────────────────────────────

describe("ops_analyze_allowed_roots_hygiene: buildAllowedRootsHygieneReport", function () {
  // 14
  it("happy path emits ok true and no warnings", () => {
    const report = buildAllowedRootsHygieneReport(baseArgs(), baseDecoded());
    expect(report.ok).to.be.true;
    expect(report.warnings).to.deep.equal([]);
  });

  // 15
  it("paused config emits [CONFIG_PAUSED]", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs(),
      baseDecoded({ paused: true })
    );
    expect(report.warnings.some((w) => w.includes("[CONFIG_PAUSED]"))).to.be
      .true;
  });

  // 16
  it("allowedRootCount at near-capacity threshold emits [ALLOWED_ROOTS_NEAR_CAPACITY]", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs({ nearCapacityThreshold: 8 }),
      baseDecoded({ allowedRoots: Array(8).fill(KNOWN_ROOT), maxRoots: 10 })
    );
    expect(
      report.warnings.some((w) => w.includes("[ALLOWED_ROOTS_NEAR_CAPACITY]"))
    ).to.be.true;
    expect(report.warnings.some((w) => w.includes("[ALLOWED_ROOTS_FULL]"))).to
      .be.false;
  });

  // 17
  it("allowedRootCount at max emits [ALLOWED_ROOTS_FULL] not [ALLOWED_ROOTS_NEAR_CAPACITY]", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs({ nearCapacityThreshold: 8 }),
      baseDecoded({ allowedRoots: Array(10).fill(KNOWN_ROOT), maxRoots: 10 })
    );
    expect(report.warnings.some((w) => w.includes("[ALLOWED_ROOTS_FULL]"))).to
      .be.true;
    expect(
      report.warnings.some((w) => w.includes("[ALLOWED_ROOTS_NEAR_CAPACITY]"))
    ).to.be.false;
  });

  // 18
  it("count below near-capacity threshold does not emit [ALLOWED_ROOTS_NEAR_CAPACITY]", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs({ nearCapacityThreshold: 8 }),
      baseDecoded({ allowedRoots: Array(7).fill(KNOWN_ROOT), maxRoots: 10 })
    );
    expect(
      report.warnings.some((w) => w.includes("[ALLOWED_ROOTS_NEAR_CAPACITY]"))
    ).to.be.false;
    expect(report.warnings.some((w) => w.includes("[ALLOWED_ROOTS_FULL]"))).to
      .be.false;
  });

  // 19
  it("expected root present produces expectedRootPresent true and no [EXPECTED_ROOT_MISSING]", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs({ expectedRoot: KNOWN_ROOT }),
      baseDecoded({ allowedRoots: [KNOWN_ROOT] })
    );
    expect(report.expectedRootPresent).to.be.true;
    expect(report.warnings.some((w) => w.includes("[EXPECTED_ROOT_MISSING]")))
      .to.be.false;
  });

  // 20
  it("expected root missing emits [EXPECTED_ROOT_MISSING]", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs({ expectedRoot: KNOWN_ROOT }),
      baseDecoded({ allowedRoots: [] })
    );
    expect(report.expectedRootPresent).to.be.false;
    expect(report.warnings.some((w) => w.includes("[EXPECTED_ROOT_MISSING]")))
      .to.be.true;
  });

  // 21
  it("admin equals root submitter emits [ADMIN_EQUALS_ROOT_SUBMITTER]", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs(),
      baseDecoded({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
      })
    );
    expect(
      report.warnings.some((w) => w.includes("[ADMIN_EQUALS_ROOT_SUBMITTER]"))
    ).to.be.true;
    expect(report.adminEqualsRootSubmitter).to.be.true;
  });

  // 22
  it("threshold 1 emits [LOW_VERIFIER_THRESHOLD]", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs(),
      baseDecoded({ threshold: 1 })
    );
    expect(report.warnings.some((w) => w.includes("[LOW_VERIFIER_THRESHOLD]")))
      .to.be.true;
  });

  // 23
  it("threshold 2 does not emit [LOW_VERIFIER_THRESHOLD]", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs(),
      baseDecoded({ threshold: 2 })
    );
    expect(report.warnings.some((w) => w.includes("[LOW_VERIFIER_THRESHOLD]")))
      .to.be.false;
  });

  // 24
  it("verifierCount 0 emits [NO_VERIFIERS_CONFIGURED]", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs(),
      baseDecoded({ verifierCount: 0 })
    );
    expect(report.warnings.some((w) => w.includes("[NO_VERIFIERS_CONFIGURED]")))
      .to.be.true;
  });

  // 25
  it("capacityRemaining is computed correctly", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs(),
      baseDecoded({ allowedRoots: Array(3).fill(KNOWN_ROOT), maxRoots: 10 })
    );
    expect(report.capacityRemaining).to.equal(7);
    expect(report.allowedRootCount).to.equal(3);
    expect(report.maxRoots).to.equal(10);
  });

  // 26
  it("warnings are non-blocking; ok remains true with multiple warnings", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs({ nearCapacityThreshold: 8 }),
      baseDecoded({
        paused: true,
        allowedRoots: Array(8).fill(KNOWN_ROOT),
        maxRoots: 10,
        threshold: 1,
        verifierCount: 0,
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
      })
    );
    expect(report.warnings.length).to.be.greaterThan(0);
    expect(report.ok).to.be.true;
  });

  // 27
  it("roots are normalized for comparison (uppercase in allowedRoots, lowercase expectedRoot)", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs({ expectedRoot: KNOWN_ROOT }),
      baseDecoded({ allowedRoots: [KNOWN_ROOT.toUpperCase()] })
    );
    expect(report.expectedRootPresent).to.be.true;
    expect(report.warnings.some((w) => w.includes("[EXPECTED_ROOT_MISSING]")))
      .to.be.false;
  });

  it("happy path has attesterInVerifierSet true and no [ATTESTER_NOT_IN_VERIFIER_SET]", () => {
    const report = buildAllowedRootsHygieneReport(baseArgs(), baseDecoded());
    expect(report.attesterInVerifierSet).to.be.true;
    expect(
      report.warnings.some((w) => w.includes("[ATTESTER_NOT_IN_VERIFIER_SET]"))
    ).to.be.false;
  });

  it("attester not in verifier set emits [ATTESTER_NOT_IN_VERIFIER_SET]", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs(),
      baseDecoded({ attesterPubkey: ADMIN_PUBKEY })
    );
    expect(report.attesterInVerifierSet).to.be.false;
    expect(
      report.warnings.some((w) => w.includes("[ATTESTER_NOT_IN_VERIFIER_SET]"))
    ).to.be.true;
  });

  it("[ATTESTER_NOT_IN_VERIFIER_SET] is non-blocking; ok remains true", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs(),
      baseDecoded({ attesterPubkey: ADMIN_PUBKEY })
    );
    expect(report.ok).to.be.true;
  });

  it("report includes attesterPubkey and attesterInVerifierSet fields", () => {
    const report = buildAllowedRootsHygieneReport(baseArgs(), baseDecoded());
    expect(report).to.have.property("attesterPubkey", ATTESTER_PUBKEY);
    expect(report).to.have.property("attesterInVerifierSet", true);
  });
});

// ── Formatter / output tests ───────────────────────────────────────────────────

describe("ops_analyze_allowed_roots_hygiene: formatHumanHygieneReport", function () {
  // 28
  it("human output includes warnings and not a privacy guarantee", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs(),
      baseDecoded({ paused: true, threshold: 1 })
    );
    const lines: string[] = [];
    formatHumanHygieneReport(report, (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).to.include("Allowed roots hygiene report");
    expect(out).to.include("[CONFIG_PAUSED]");
    expect(out).to.include("[LOW_VERIFIER_THRESHOLD]");
    expect(out).to.include("not a privacy guarantee");
  });

  it("human output includes attester_pubkey line", () => {
    const report = buildAllowedRootsHygieneReport(baseArgs(), baseDecoded());
    const lines: string[] = [];
    formatHumanHygieneReport(report, (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).to.include("attester_pubkey:");
    expect(out).to.include(ATTESTER_PUBKEY);
  });

  it("human output includes attester_in_verifier_set line", () => {
    const report = buildAllowedRootsHygieneReport(baseArgs(), baseDecoded());
    const lines: string[] = [];
    formatHumanHygieneReport(report, (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).to.include("attester_in_verifier_set:");
  });

  // 29
  it("JSON output is parseable and includes all expected fields", () => {
    const report = buildAllowedRootsHygieneReport(
      baseArgs({ expectedRoot: KNOWN_ROOT }),
      baseDecoded()
    );
    const parsed = JSON.parse(JSON.stringify(report, null, 2));
    const expectedFields = [
      "ok",
      "mode",
      "rpcUrl",
      "programId",
      "configPda",
      "commitment",
      "exists",
      "paused",
      "adminAuthority",
      "rootSubmitterAuthority",
      "adminEqualsRootSubmitter",
      "attesterPubkey",
      "attesterInVerifierSet",
      "threshold",
      "verifierCount",
      "allowedRootCount",
      "maxRoots",
      "nearCapacityThreshold",
      "capacityRemaining",
      "allowedRoots",
      "expectedRoot",
      "expectedRootPresent",
      "warnings",
      "notes",
    ];
    for (const field of expectedFields) {
      expect(parsed, "missing field: " + field).to.have.property(field);
    }
    expect(parsed.mode).to.equal("allowed_roots_hygiene_report");
    expect(parsed.ok).to.be.true;
  });
});

// ── Runner tests ───────────────────────────────────────────────────────────────

describe("ops_analyze_allowed_roots_hygiene: runAllowedRootsHygieneMain", function () {
  // 30
  it("returns 1 on invalid args", async () => {
    const errs: string[] = [];
    const code = await runAllowedRootsHygieneMain(["--unknown-flag"], {
      log: () => {},
      warn: (l) => errs.push(l),
    });
    expect(code).to.equal(1);
    expect(errs.join(" ")).to.include("unknown flag");
  });

  // 31
  it("returns 1 when config account is missing", async () => {
    const errs: string[] = [];
    const code = await runAllowedRootsHygieneMain([...BASE_ARGS], {
      getAccountInfo: async () => null,
      log: () => {},
      warn: (l) => errs.push(l),
    });
    expect(code).to.equal(1);
    expect(errs.join(" ")).to.include("error:");
  });
});

// ── Static source scan ─────────────────────────────────────────────────────────

const SCRIPT_SRC = fs.readFileSync(
  path.join(__dirname, "../scripts/ops/analyze_allowed_roots_hygiene.ts"),
  "utf8"
);

describe("ops_analyze_allowed_roots_hygiene: static source scan", function () {
  // j() builds strings at runtime so this test file does not self-flag.
  const j = (...parts: string[]) => parts.join("");

  // 34
  it("script source does not call sendRawTransaction", () => {
    expect(SCRIPT_SRC).to.not.include(j("send", "RawTransaction("));
  });

  // 35
  it("script source does not call sendTransaction", () => {
    expect(SCRIPT_SRC).to.not.include(j("send", "Transaction("));
  });

  // 36
  it("script source has no .rpc(, no Keypair, no --send string, no readFileSync", () => {
    expect(SCRIPT_SRC).to.not.include(j(".", "rpc("));
    expect(SCRIPT_SRC).to.not.include("Keypair");
    expect(SCRIPT_SRC).to.not.include(j('"', "--send", '"'));
    expect(SCRIPT_SRC).to.not.include(j("read", "FileSync"));
  });
});
