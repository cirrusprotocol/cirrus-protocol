import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import { EMPTY_SUBTREES, TREE_DEPTH } from "../lib/zk_indexer/constants";
import { runFixtureIndexer, parseArgs } from "../scripts/zk_indexer_fixture";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DEPOSITOR = "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe";
const C0 = "0101010101010101010101010101010101010101010101010101010101010101";
const C1 = "0202020202020202020202020202020202020202020202020202020202020202";

function tmpPath(): string {
  return path.join(
    os.tmpdir(),
    `zk_fixture_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
  );
}

function bareEvent(
  commitmentHex: string,
  leafIndex: number
): Record<string, unknown> {
  return {
    commitment: commitmentHex,
    denomination: "100000000",
    leafIndex,
    depositor: DEPOSITOR,
    slot: "100",
  };
}

// ── runFixtureIndexer ─────────────────────────────────────────────────────────

describe("zk_indexer_fixture: runFixtureIndexer", function () {
  this.timeout(60_000);

  before(async () => {
    await initPoseidon();
  });

  it("1. reads bare-array input, writes snapshot, returns inserted=2 leaf_count=2", async () => {
    const inp = tmpPath();
    const out = tmpPath();
    fs.writeFileSync(
      inp,
      JSON.stringify([bareEvent(C0, 0), bareEvent(C1, 1)]),
      "utf-8"
    );

    const result = await runFixtureIndexer({ inputPath: inp, outputPath: out });

    expect(result.inserted).to.equal(2);
    expect(result.leaf_count).to.equal(2);
    expect(result.root_be_hex).to.have.length(64);
    expect(result.root_be_hex).to.not.equal(EMPTY_SUBTREES[TREE_DEPTH]);
    expect(result.outputPath).to.equal(out);

    const written = JSON.parse(fs.readFileSync(out, "utf-8"));
    expect(written.version).to.equal(1);
    expect(written.leaf_count).to.equal(2);
    expect(written.last_root_be_hex).to.equal(result.root_be_hex);

    fs.unlinkSync(inp);
    fs.unlinkSync(out);
  });

  it("2. reads object-wrapper { events: [...] } input, writes snapshot", async () => {
    const inp = tmpPath();
    const out = tmpPath();
    fs.writeFileSync(
      inp,
      JSON.stringify({ events: [bareEvent(C0, 0), bareEvent(C1, 1)] }),
      "utf-8"
    );

    const result = await runFixtureIndexer({ inputPath: inp, outputPath: out });

    expect(result.inserted).to.equal(2);
    expect(result.leaf_count).to.equal(2);

    fs.unlinkSync(inp);
    fs.unlinkSync(out);
  });

  it("3. default sort: leaf_index=1 before leaf_index=0 input succeeds after sort", async () => {
    const inp = tmpPath();
    const out = tmpPath();
    // Deliberately wrong order — sort should correct it
    fs.writeFileSync(
      inp,
      JSON.stringify([bareEvent(C1, 1), bareEvent(C0, 0)]),
      "utf-8"
    );

    const result = await runFixtureIndexer({
      inputPath: inp,
      outputPath: out,
      sort: true,
    });

    expect(result.inserted).to.equal(2);
    expect(result.leaf_count).to.equal(2);

    fs.unlinkSync(inp);
    fs.unlinkSync(out);
  });

  it("4. sort=false rejects out-of-order events with expectedLeafIndex error", async () => {
    const inp = tmpPath();
    const out = tmpPath();
    fs.writeFileSync(
      inp,
      JSON.stringify([bareEvent(C1, 1), bareEvent(C0, 0)]),
      "utf-8"
    );

    let error: Error | undefined;
    try {
      await runFixtureIndexer({ inputPath: inp, outputPath: out, sort: false });
    } catch (err) {
      error = err as Error;
    }
    expect(error, "expected to throw").to.exist;
    expect(error!.message).to.include("expectedLeafIndex");

    fs.unlinkSync(inp);
    if (fs.existsSync(out)) fs.unlinkSync(out);
  });

  it("5. empty events array: leaf_count=0 and root equals empty tree root", async () => {
    const inp = tmpPath();
    const out = tmpPath();
    fs.writeFileSync(inp, JSON.stringify([]), "utf-8");

    const result = await runFixtureIndexer({ inputPath: inp, outputPath: out });

    expect(result.inserted).to.equal(0);
    expect(result.leaf_count).to.equal(0);
    expect(result.root_be_hex).to.equal(EMPTY_SUBTREES[TREE_DEPTH]);

    fs.unlinkSync(inp);
    fs.unlinkSync(out);
  });

  it("6. rejects missing input file", async () => {
    let error: Error | undefined;
    try {
      await runFixtureIndexer({
        inputPath: "/tmp/zk_fixture_does_not_exist_xyz.json",
        outputPath: tmpPath(),
      });
    } catch (err) {
      error = err as Error;
    }
    expect(error, "expected to throw").to.exist;
    expect(error!.message).to.include("cannot read input file");
  });

  it("7. rejects invalid JSON", async () => {
    const inp = tmpPath();
    fs.writeFileSync(inp, "{ not valid json }", "utf-8");

    let error: Error | undefined;
    try {
      await runFixtureIndexer({ inputPath: inp, outputPath: tmpPath() });
    } catch (err) {
      error = err as Error;
    }
    expect(error, "expected to throw").to.exist;
    expect(error!.message).to.include("invalid JSON");

    fs.unlinkSync(inp);
  });

  it("8. rejects object without events array", async () => {
    const inp = tmpPath();
    fs.writeFileSync(inp, JSON.stringify({ notEvents: [] }), "utf-8");

    let error: Error | undefined;
    try {
      await runFixtureIndexer({ inputPath: inp, outputPath: tmpPath() });
    } catch (err) {
      error = err as Error;
    }
    expect(error, "expected to throw").to.exist;
    expect(error!.message).to.include("events");

    fs.unlinkSync(inp);
  });

  it("9. rejects malformed event (missing commitment field)", async () => {
    const inp = tmpPath();
    const events = [
      {
        denomination: "100000000",
        leafIndex: 0,
        depositor: DEPOSITOR,
        slot: "100",
      },
    ];
    fs.writeFileSync(inp, JSON.stringify(events), "utf-8");

    let error: Error | undefined;
    try {
      await runFixtureIndexer({ inputPath: inp, outputPath: tmpPath() });
    } catch (err) {
      error = err as Error;
    }
    expect(error, "expected to throw").to.exist;
    expect(error!.message).to.include("event at index 0");

    fs.unlinkSync(inp);
  });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("zk_indexer_fixture: parseArgs", function () {
  it("10a. rejects missing --input", () => {
    expect(() => parseArgs(["--output", "/tmp/out.json"])).to.throw("--input");
  });

  it("10b. rejects missing --output", () => {
    expect(() => parseArgs(["--input", "/tmp/in.json"])).to.throw("--output");
  });

  it("parses --input, --output, and --no-sort correctly", () => {
    const args = parseArgs([
      "--input",
      "/tmp/in.json",
      "--output",
      "/tmp/out.json",
      "--no-sort",
    ]);
    expect(args.inputPath).to.equal("/tmp/in.json");
    expect(args.outputPath).to.equal("/tmp/out.json");
    expect(args.sort).to.equal(false);
  });

  it("defaults sort to true when --no-sort is absent", () => {
    const args = parseArgs([
      "--input",
      "/tmp/in.json",
      "--output",
      "/tmp/out.json",
    ]);
    expect(args.sort).to.equal(true);
  });
});
