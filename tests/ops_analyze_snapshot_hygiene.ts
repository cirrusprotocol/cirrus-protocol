import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import {
  parseAnalyzeArgs,
  buildHygieneReport,
  runAnalyzeSnapshotHygiene,
  AnalyzeArgs,
} from "../scripts/ops/analyze_snapshot_hygiene";

// ── Helpers ────────────────────────────────────────────────────────────────────

const SNAP_PATH = "/test/snapshot.json";
const DEN_1SOL = "1000000000";
const DEN_SMALL = "1000";

interface FakeEvent {
  commitment_be_hex?: string;
  denomination?: string | number;
  leaf_index?: number | string;
  depositor?: string;
  slot?: string;
}

function makeSnapshotRaw(opts: {
  leaf_count?: number;
  events?: FakeEvent[];
  leaves?: FakeEvent[];
  arrayField?: "events" | "leaves";
}): string {
  const base: Record<string, unknown> = {
    version: 1,
    tree_depth: 20,
    last_root_be_hex: "0".repeat(64),
  };
  if (opts.leaf_count !== undefined) base["leaf_count"] = opts.leaf_count;
  const arr = opts.events ?? opts.leaves ?? [];
  if (opts.arrayField === "leaves") {
    base["leaves"] = arr;
  } else {
    base["events"] = arr;
  }
  return JSON.stringify(base);
}

function makeEvents(
  count: number,
  denomination: string = DEN_1SOL
): FakeEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    commitment_be_hex: "a".repeat(64),
    denomination,
    leaf_index: i,
    depositor: "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe",
    slot: String(700 + i),
  }));
}

function baseArgs(overrides: Partial<AnalyzeArgs> = {}): AnalyzeArgs {
  return {
    snapshotPath: SNAP_PATH,
    smallLeafThreshold: 10,
    lowBucketThreshold: 5,
    json: false,
    ...overrides,
  };
}

// ── Parser tests ───────────────────────────────────────────────────────────────

describe("ops_analyze_snapshot_hygiene: parseAnalyzeArgs", function () {
  it("requires --snapshot", () => {
    expect(() => parseAnalyzeArgs([])).to.throw(/--snapshot is required/);
  });

  it("parses --snapshot", () => {
    const args = parseAnalyzeArgs(["--snapshot", "/path/to/snap.json"]);
    expect(args.snapshotPath).to.equal("/path/to/snap.json");
    expect(args.leafIndex).to.be.undefined;
    expect(args.denomination).to.be.undefined;
    expect(args.smallLeafThreshold).to.equal(10);
    expect(args.lowBucketThreshold).to.equal(5);
    expect(args.json).to.equal(false);
  });

  it("parses --leaf-index", () => {
    const args = parseAnalyzeArgs([
      "--snapshot",
      SNAP_PATH,
      "--leaf-index",
      "3",
    ]);
    expect(args.leafIndex).to.equal(3);
  });

  it("rejects negative --leaf-index", () => {
    expect(() =>
      parseAnalyzeArgs(["--snapshot", SNAP_PATH, "--leaf-index", "-1"])
    ).to.throw(/--leaf-index/);
  });

  it("rejects non-integer --leaf-index", () => {
    expect(() =>
      parseAnalyzeArgs(["--snapshot", SNAP_PATH, "--leaf-index", "1.5"])
    ).to.throw(/--leaf-index/);
  });

  it("rejects non-numeric --leaf-index", () => {
    expect(() =>
      parseAnalyzeArgs(["--snapshot", SNAP_PATH, "--leaf-index", "abc"])
    ).to.throw(/--leaf-index/);
  });

  it("parses --denomination", () => {
    const args = parseAnalyzeArgs([
      "--snapshot",
      SNAP_PATH,
      "--denomination",
      DEN_1SOL,
    ]);
    expect(args.denomination).to.equal(BigInt(DEN_1SOL));
  });

  it("rejects zero denomination", () => {
    expect(() =>
      parseAnalyzeArgs(["--snapshot", SNAP_PATH, "--denomination", "0"])
    ).to.throw(/--denomination/);
  });

  it("rejects negative denomination", () => {
    expect(() =>
      parseAnalyzeArgs(["--snapshot", SNAP_PATH, "--denomination", "-100"])
    ).to.throw(/--denomination/);
  });

  it("rejects non-integer denomination", () => {
    expect(() =>
      parseAnalyzeArgs(["--snapshot", SNAP_PATH, "--denomination", "1.5"])
    ).to.throw(/--denomination/);
  });

  it("parses --small-leaf-threshold and --low-bucket-threshold", () => {
    const args = parseAnalyzeArgs([
      "--snapshot",
      SNAP_PATH,
      "--small-leaf-threshold",
      "20",
      "--low-bucket-threshold",
      "3",
    ]);
    expect(args.smallLeafThreshold).to.equal(20);
    expect(args.lowBucketThreshold).to.equal(3);
  });

  it("rejects zero --small-leaf-threshold", () => {
    expect(() =>
      parseAnalyzeArgs(["--snapshot", SNAP_PATH, "--small-leaf-threshold", "0"])
    ).to.throw(/--small-leaf-threshold/);
  });

  it("rejects zero --low-bucket-threshold", () => {
    expect(() =>
      parseAnalyzeArgs(["--snapshot", SNAP_PATH, "--low-bucket-threshold", "0"])
    ).to.throw(/--low-bucket-threshold/);
  });

  it("rejects unknown flag", () => {
    expect(() =>
      parseAnalyzeArgs(["--snapshot", SNAP_PATH, "--unknown"])
    ).to.throw(/unknown flag/);
  });

  it("parses --json flag", () => {
    const args = parseAnalyzeArgs(["--snapshot", SNAP_PATH, "--json"]);
    expect(args.json).to.equal(true);
  });
});

// ── Report builder tests ───────────────────────────────────────────────────────

describe("ops_analyze_snapshot_hygiene: buildHygieneReport", function () {
  // Test 11: small snapshot emits [SMALL_SNAPSHOT_LEAF_COUNT]
  it("small snapshot (leafCount=3 < threshold=10) emits [SMALL_SNAPSHOT_LEAF_COUNT]", () => {
    const raw = makeSnapshotRaw({
      leaf_count: 3,
      events: makeEvents(3),
    });
    const report = buildHygieneReport(baseArgs(), raw);
    expect(
      report.warnings.some((w) => w.includes("[SMALL_SNAPSHOT_LEAF_COUNT]"))
    ).to.be.true;
  });

  // Test 12: leaf count equal threshold does not emit
  it("leafCount equal threshold (10) does not emit [SMALL_SNAPSHOT_LEAF_COUNT]", () => {
    const raw = makeSnapshotRaw({
      leaf_count: 10,
      events: makeEvents(10),
    });
    const report = buildHygieneReport(baseArgs(), raw);
    expect(
      report.warnings.some((w) => w.includes("[SMALL_SNAPSHOT_LEAF_COUNT]"))
    ).to.be.false;
  });

  // Test 13: selected latest leaf emits [SELECTED_LEAF_IS_LATEST]
  it("selected latest leaf (leafIndex=2, leafCount=3) emits [SELECTED_LEAF_IS_LATEST]", () => {
    const raw = makeSnapshotRaw({ leaf_count: 3, events: makeEvents(3) });
    const report = buildHygieneReport(baseArgs({ leafIndex: 2 }), raw);
    expect(report.warnings.some((w) => w.includes("[SELECTED_LEAF_IS_LATEST]")))
      .to.be.true;
    expect(report.selectedLeafIsLatest).to.be.true;
  });

  // Test 14: selected non-latest leaf does not emit [SELECTED_LEAF_IS_LATEST]
  it("selected non-latest leaf (leafIndex=1, leafCount=3) does not emit [SELECTED_LEAF_IS_LATEST]", () => {
    const raw = makeSnapshotRaw({ leaf_count: 3, events: makeEvents(3) });
    const report = buildHygieneReport(baseArgs({ leafIndex: 1 }), raw);
    expect(report.warnings.some((w) => w.includes("[SELECTED_LEAF_IS_LATEST]")))
      .to.be.false;
    expect(report.selectedLeafIsLatest).to.be.false;
  });

  // Test 15: low selected bucket population emits [LOW_BUCKET_POPULATION]
  it("low bucket population (pop=2, threshold=5) emits [LOW_BUCKET_POPULATION]", () => {
    const events = makeEvents(2, DEN_1SOL);
    const raw = makeSnapshotRaw({ leaf_count: 2, events });
    const report = buildHygieneReport(
      baseArgs({ denomination: BigInt(DEN_1SOL) }),
      raw
    );
    expect(report.warnings.some((w) => w.includes("[LOW_BUCKET_POPULATION]")))
      .to.be.true;
    expect(report.selectedBucketPopulation).to.equal(2);
  });

  // Test 16: bucket population equal threshold does not emit
  it("bucket population equal threshold (pop=5, threshold=5) does not emit [LOW_BUCKET_POPULATION]", () => {
    const raw = makeSnapshotRaw({
      leaf_count: 5,
      events: makeEvents(5, DEN_1SOL),
    });
    const report = buildHygieneReport(
      baseArgs({ denomination: BigInt(DEN_1SOL), lowBucketThreshold: 5 }),
      raw
    );
    expect(report.warnings.some((w) => w.includes("[LOW_BUCKET_POPULATION]")))
      .to.be.false;
  });

  // Test 17: selected denomination from --denomination
  it("selected denomination from --denomination is used for bucket lookup", () => {
    const events = [
      ...makeEvents(2, DEN_1SOL),
      ...makeEvents(3, DEN_SMALL).map((e, i) => ({
        ...e,
        leaf_index: 2 + i,
      })),
    ];
    const raw = makeSnapshotRaw({ leaf_count: 5, events });
    const report = buildHygieneReport(
      baseArgs({ denomination: BigInt(DEN_SMALL), lowBucketThreshold: 10 }),
      raw
    );
    expect(report.selectedDenomination).to.equal(DEN_SMALL);
    expect(report.selectedBucketPopulation).to.equal(3);
  });

  // Test 18: selected denomination from selected leaf
  it("selected denomination from selected leaf via --leaf-index", () => {
    const events: FakeEvent[] = [
      { denomination: DEN_1SOL, leaf_index: 0 },
      { denomination: DEN_SMALL, leaf_index: 1 },
      { denomination: DEN_1SOL, leaf_index: 2 },
    ];
    const raw = makeSnapshotRaw({ leaf_count: 3, events });
    const report = buildHygieneReport(baseArgs({ leafIndex: 1 }), raw);
    expect(report.selectedDenomination).to.equal(DEN_SMALL);
  });

  // Test 19: warnings are non-blocking — report ok: true even with warnings
  it("report ok is true even when warnings are emitted", () => {
    const raw = makeSnapshotRaw({
      leaf_count: 2,
      events: makeEvents(2, DEN_1SOL),
    });
    const report = buildHygieneReport(
      baseArgs({ leafIndex: 1, denomination: BigInt(DEN_1SOL) }),
      raw
    );
    expect(report.warnings.length).to.be.greaterThan(0);
    expect(report.ok).to.be.true;
  });

  // Test 20: JSON output is parseable and includes expected fields
  it("JSON output is parseable and includes all expected fields", () => {
    const raw = makeSnapshotRaw({ leaf_count: 3, events: makeEvents(3) });
    const lines: string[] = [];
    const code = runAnalyzeSnapshotHygiene(
      ["--snapshot", SNAP_PATH, "--json"],
      {
        readFileSync: () => raw,
        log: (l) => lines.push(l),
        warn: () => {},
      }
    );
    expect(code).to.equal(0);
    const parsed = JSON.parse(lines.join(""));
    for (const key of [
      "ok",
      "mode",
      "snapshotPath",
      "leafCount",
      "smallLeafThreshold",
      "lowBucketThreshold",
      "selectedLeafIndex",
      "selectedLeafIsLatest",
      "selectedDenomination",
      "bucketPopulation",
      "selectedBucketPopulation",
      "warnings",
      "notes",
    ]) {
      expect(parsed, "missing key: " + key).to.have.property(key);
    }
    expect(parsed.mode).to.equal("snapshot_hygiene_report");
    expect(parsed.ok).to.be.true;
  });

  // Test 21: human output includes warnings and "not a privacy guarantee"
  it("human output includes warnings and privacy disclaimer", () => {
    const raw = makeSnapshotRaw({ leaf_count: 3, events: makeEvents(3) });
    const lines: string[] = [];
    const code = runAnalyzeSnapshotHygiene(["--snapshot", SNAP_PATH], {
      readFileSync: () => raw,
      log: (l) => lines.push(l),
      warn: () => {},
    });
    expect(code).to.equal(0);
    const out = lines.join("\n");
    expect(out).to.include("Snapshot hygiene report");
    expect(out).to.include("[SMALL_SNAPSHOT_LEAF_COUNT]");
    expect(out).to.include("not a privacy guarantee");
  });

  // Test 22: no secret/proof/witness fields in output
  it("JSON output does not include secret, proof, or witness fields", () => {
    const raw = makeSnapshotRaw({ leaf_count: 3, events: makeEvents(3) });
    const lines: string[] = [];
    runAnalyzeSnapshotHygiene(["--snapshot", SNAP_PATH, "--json"], {
      readFileSync: () => raw,
      log: (l) => lines.push(l),
      warn: () => {},
    });
    const out = lines.join("");
    for (const forbidden of [
      "secret",
      "proof",
      "witness",
      "keypair",
      "private_key",
      "nullifier",
    ]) {
      expect(out.toLowerCase()).to.not.include(forbidden);
    }
  });

  // Additional: leaves array field is also supported
  it("snapshot with 'leaves' array field is accepted", () => {
    const raw = makeSnapshotRaw({
      leaf_count: 3,
      arrayField: "leaves",
      leaves: makeEvents(3),
    });
    const report = buildHygieneReport(baseArgs(), raw);
    expect(report.leafCount).to.equal(3);
    expect(report.ok).to.be.true;
  });

  // Additional: leaf_count absent — derives from events length
  it("derives leafCount from events array length when leaf_count is absent", () => {
    const raw = JSON.stringify({
      version: 1,
      tree_depth: 20,
      last_root_be_hex: "0".repeat(64),
      events: makeEvents(4),
    });
    const report = buildHygieneReport(baseArgs(), raw);
    expect(report.leafCount).to.equal(4);
  });

  // Additional: leaf_index stored as string in snapshot (tolerates both types)
  it("tolerates leaf_index stored as string in snapshot events", () => {
    const events: FakeEvent[] = [
      { denomination: DEN_1SOL, leaf_index: "0" },
      { denomination: DEN_SMALL, leaf_index: "1" },
    ];
    const raw = makeSnapshotRaw({ leaf_count: 2, events });
    const report = buildHygieneReport(baseArgs({ leafIndex: 1 }), raw);
    expect(report.selectedDenomination).to.equal(DEN_SMALL);
  });

  // normalizeDenomination: "001000" normalizes to canonical "1000"
  it("denomination string '001000' normalizes to '1000' in bucket population", () => {
    const events: FakeEvent[] = [
      { denomination: "001000", leaf_index: 0 },
      { denomination: "1000", leaf_index: 1 },
    ];
    const raw = makeSnapshotRaw({ leaf_count: 2, events });
    const report = buildHygieneReport(baseArgs(), raw);
    expect(report.bucketPopulation["1000"]).to.equal(2);
    expect(Object.keys(report.bucketPopulation)).to.deep.equal(["1000"]);
  });

  // normalizeDenomination: non-numeric denomination is ignored
  it("non-numeric denomination in snapshot events is ignored", () => {
    const events: FakeEvent[] = [
      { denomination: "abc" as unknown as string, leaf_index: 0 },
      { denomination: DEN_1SOL, leaf_index: 1 },
    ];
    const raw = makeSnapshotRaw({ leaf_count: 2, events });
    const report = buildHygieneReport(baseArgs(), raw);
    expect(report.bucketPopulation[DEN_1SOL]).to.equal(1);
    expect(Object.keys(report.bucketPopulation)).to.deep.equal([DEN_1SOL]);
  });

  // normalizeDenomination: zero/negative denomination in snapshot is ignored
  it("zero and negative denomination in snapshot events are ignored", () => {
    const events: FakeEvent[] = [
      { denomination: "0", leaf_index: 0 },
      { denomination: "-500", leaf_index: 1 },
      { denomination: DEN_1SOL, leaf_index: 2 },
    ];
    const raw = makeSnapshotRaw({ leaf_count: 3, events });
    const report = buildHygieneReport(baseArgs(), raw);
    expect(Object.keys(report.bucketPopulation)).to.deep.equal([DEN_1SOL]);
  });

  // buildHygieneReport throws for leafIndex >= leafCount
  it("throws for --leaf-index equal to leaf_count (out of range)", () => {
    const raw = makeSnapshotRaw({ leaf_count: 3, events: makeEvents(3) });
    expect(() => buildHygieneReport(baseArgs({ leafIndex: 3 }), raw)).to.throw(
      /out of range/
    );
  });

  it("throws for --leaf-index beyond leaf_count", () => {
    const raw = makeSnapshotRaw({ leaf_count: 3, events: makeEvents(3) });
    expect(() => buildHygieneReport(baseArgs({ leafIndex: 10 }), raw)).to.throw(
      /out of range/
    );
  });
});

// ── Runner exit-code tests ─────────────────────────────────────────────────────

describe("ops_analyze_snapshot_hygiene: runAnalyzeSnapshotHygiene", function () {
  it("returns 0 on valid snapshot", () => {
    const raw = makeSnapshotRaw({ leaf_count: 0, events: [] });
    const code = runAnalyzeSnapshotHygiene(["--snapshot", SNAP_PATH], {
      readFileSync: () => raw,
      log: () => {},
      warn: () => {},
    });
    expect(code).to.equal(0);
  });

  it("returns 1 on missing --snapshot", () => {
    const errs: string[] = [];
    const code = runAnalyzeSnapshotHygiene([], {
      log: () => {},
      warn: (l) => errs.push(l),
    });
    expect(code).to.equal(1);
    expect(errs.join(" ")).to.include("--snapshot");
  });

  it("returns 1 when snapshot file cannot be read", () => {
    const errs: string[] = [];
    const code = runAnalyzeSnapshotHygiene(
      ["--snapshot", "/missing/snap.json"],
      {
        readFileSync: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        log: () => {},
        warn: (l) => errs.push(l),
      }
    );
    expect(code).to.equal(1);
    expect(errs.join(" ")).to.include("Error:");
  });

  it("returns 1 on malformed JSON", () => {
    const errs: string[] = [];
    const code = runAnalyzeSnapshotHygiene(["--snapshot", SNAP_PATH], {
      readFileSync: () => "not json {{{",
      log: () => {},
      warn: (l) => errs.push(l),
    });
    expect(code).to.equal(1);
    expect(errs.join(" ")).to.include("invalid JSON");
  });

  it("returns 1 when --leaf-index is out of range", () => {
    const errs: string[] = [];
    const raw = makeSnapshotRaw({ leaf_count: 3, events: makeEvents(3) });
    const code = runAnalyzeSnapshotHygiene(
      ["--snapshot", SNAP_PATH, "--leaf-index", "5"],
      {
        readFileSync: () => raw,
        log: () => {},
        warn: (l) => errs.push(l),
      }
    );
    expect(code).to.equal(1);
    expect(errs.join(" ")).to.include("out of range");
  });

  it("returns 1 when snapshot has no events or leaves array", () => {
    const errs: string[] = [];
    const raw = JSON.stringify({ version: 1, tree_depth: 20, leaf_count: 0 });
    const code = runAnalyzeSnapshotHygiene(["--snapshot", SNAP_PATH], {
      readFileSync: () => raw,
      log: () => {},
      warn: (l) => errs.push(l),
    });
    expect(code).to.equal(1);
    expect(errs.join(" ")).to.include("events or leaves");
  });
});

// ── Static source scan ─────────────────────────────────────────────────────────

const SCRIPT_SRC = fs.readFileSync(
  path.join(__dirname, "../scripts/ops/analyze_snapshot_hygiene.ts"),
  "utf8"
);

describe("ops_analyze_snapshot_hygiene: static source scan", function () {
  it("does not import Connection", () => {
    expect(SCRIPT_SRC).to.not.include("Connection");
  });

  it("does not call sendRawTransaction", () => {
    expect(SCRIPT_SRC).to.not.include("sendRawTransaction");
  });

  it("does not contain Keypair.generate()", () => {
    expect(SCRIPT_SRC).to.not.include("Keypair.generate()");
  });

  it("does not handle --send flag", () => {
    expect(SCRIPT_SRC).to.not.include('"--send"');
  });

  it("does not import from @solana/web3.js", () => {
    expect(SCRIPT_SRC).to.not.include("@solana/web3.js");
  });
});
