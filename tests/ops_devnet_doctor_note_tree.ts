import * as fs from "fs";
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  analyzeNoteTreeState,
  NoteTreeStateAnalysis,
} from "../scripts/ops/devnet_doctor";

// ── Constants ──────────────────────────────────────────────────────────────────

const PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";
const OTHER_PROGRAM = "11111111111111111111111111111111";

// NoteTreeState::LEN = disc(8) + leaf_count(8) + tree_depth(1) + bump(1) + padding(6)
const NOTE_TREE_STATE_LEN = 24;
// Anchor discriminator sha256("account:NoteTreeState")[0..8]
const DISC_NOTE_TREE = Buffer.from([37, 238, 107, 83, 189, 18, 107, 116]);
const EXPECTED_TREE_DEPTH = 20;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeData(leafCount: bigint, treeDepth = EXPECTED_TREE_DEPTH): Buffer {
  const buf = Buffer.alloc(NOTE_TREE_STATE_LEN, 0);
  DISC_NOTE_TREE.copy(buf, 0);
  buf.writeBigUInt64LE(leafCount, 8);
  buf[16] = treeDepth;
  // buf[17] = bump (leave 0); buf[18..23] = padding (leave 0)
  return buf;
}

function fakeAccount(
  data: Buffer,
  ownerStr = PROGRAM_ID
): { owner: PublicKey; data: Buffer } {
  return { owner: new PublicKey(ownerStr), data };
}

// ── analyzeNoteTreeState ───────────────────────────────────────────────────────

describe("analyzeNoteTreeState — missing account", () => {
  let result: NoteTreeStateAnalysis;

  before(() => {
    result = analyzeNoteTreeState({
      programIdStr: PROGRAM_ID,
      accountInfo: null,
    });
  });

  it("exists is false", () => {
    expect(result.exists).to.equal(false);
  });

  it("ownerMatchesProgram is null", () => {
    expect(result.ownerMatchesProgram).to.equal(null);
  });

  it("decoded is false", () => {
    expect(result.decoded).to.equal(false);
  });

  it("leafCount is null", () => {
    expect(result.leafCount).to.equal(null);
  });

  it("isEmpty is null", () => {
    expect(result.isEmpty).to.equal(null);
  });

  it("emits [NOTE_TREE_MISSING] warning", () => {
    const has = result.warnings.some((w) => w.includes("[NOTE_TREE_MISSING]"));
    expect(has).to.equal(true);
  });
});

describe("analyzeNoteTreeState — owner mismatch", () => {
  let result: NoteTreeStateAnalysis;

  before(() => {
    result = analyzeNoteTreeState({
      programIdStr: PROGRAM_ID,
      accountInfo: fakeAccount(makeData(5n), OTHER_PROGRAM),
    });
  });

  it("exists is true", () => {
    expect(result.exists).to.equal(true);
  });

  it("ownerMatchesProgram is false", () => {
    expect(result.ownerMatchesProgram).to.equal(false);
  });

  it("emits [NOTE_TREE_OWNER_MISMATCH] warning", () => {
    const has = result.warnings.some((w) =>
      w.includes("[NOTE_TREE_OWNER_MISMATCH]")
    );
    expect(has).to.equal(true);
  });
});

describe("analyzeNoteTreeState — wrong data length", () => {
  let result: NoteTreeStateAnalysis;

  before(() => {
    result = analyzeNoteTreeState({
      programIdStr: PROGRAM_ID,
      accountInfo: fakeAccount(Buffer.alloc(16, 0)),
    });
  });

  it("decoded is false", () => {
    expect(result.decoded).to.equal(false);
  });

  it("emits [NOTE_TREE_UNEXPECTED_DATA_LENGTH] warning", () => {
    const has = result.warnings.some((w) =>
      w.includes("[NOTE_TREE_UNEXPECTED_DATA_LENGTH]")
    );
    expect(has).to.equal(true);
  });

  it("leafCount is null", () => {
    expect(result.leafCount).to.equal(null);
  });
});

describe("analyzeNoteTreeState — discriminator mismatch", () => {
  let result: NoteTreeStateAnalysis;

  before(() => {
    // Correct length but wrong discriminator
    const bad = Buffer.alloc(NOTE_TREE_STATE_LEN, 0xab);
    result = analyzeNoteTreeState({
      programIdStr: PROGRAM_ID,
      accountInfo: fakeAccount(bad),
    });
  });

  it("decoded is false", () => {
    expect(result.decoded).to.equal(false);
  });

  it("emits [NOTE_TREE_DISCRIMINATOR_MISMATCH] warning", () => {
    const has = result.warnings.some((w) =>
      w.includes("[NOTE_TREE_DISCRIMINATOR_MISMATCH]")
    );
    expect(has).to.equal(true);
  });
});

describe("analyzeNoteTreeState — zero leaf count", () => {
  let result: NoteTreeStateAnalysis;

  before(() => {
    result = analyzeNoteTreeState({
      programIdStr: PROGRAM_ID,
      accountInfo: fakeAccount(makeData(0n)),
    });
  });

  it("decoded is true", () => {
    expect(result.decoded).to.equal(true);
  });

  it("leafCount is 0", () => {
    expect(result.leafCount).to.equal(0);
  });

  it("isEmpty is true", () => {
    expect(result.isEmpty).to.equal(true);
  });

  it("emits [NOTE_TREE_EMPTY] warning", () => {
    const has = result.warnings.some((w) => w.includes("[NOTE_TREE_EMPTY]"));
    expect(has).to.equal(true);
  });
});

describe("analyzeNoteTreeState — nonzero leaf count", () => {
  let result: NoteTreeStateAnalysis;

  before(() => {
    result = analyzeNoteTreeState({
      programIdStr: PROGRAM_ID,
      accountInfo: fakeAccount(makeData(7n)),
    });
  });

  it("decoded is true", () => {
    expect(result.decoded).to.equal(true);
  });

  it("leafCount is 7", () => {
    expect(result.leafCount).to.equal(7);
  });

  it("isEmpty is false", () => {
    expect(result.isEmpty).to.equal(false);
  });

  it("does not emit [NOTE_TREE_EMPTY]", () => {
    const has = result.warnings.some((w) => w.includes("[NOTE_TREE_EMPTY]"));
    expect(has).to.equal(false);
  });

  it("leafCount is a stable number", () => {
    const r2 = analyzeNoteTreeState({
      programIdStr: PROGRAM_ID,
      accountInfo: fakeAccount(makeData(7n)),
    });
    expect(r2.leafCount).to.equal(result.leafCount);
  });
});

describe("analyzeNoteTreeState — unexpected tree depth", () => {
  let result: NoteTreeStateAnalysis;

  before(() => {
    result = analyzeNoteTreeState({
      programIdStr: PROGRAM_ID,
      accountInfo: fakeAccount(makeData(3n, 16)),
    });
  });

  it("decoded is true", () => {
    expect(result.decoded).to.equal(true);
  });

  it("treeDepth reflects on-chain value", () => {
    expect(result.treeDepth).to.equal(16);
  });

  it("emits [NOTE_TREE_UNEXPECTED_DEPTH] warning", () => {
    const has = result.warnings.some((w) =>
      w.includes("[NOTE_TREE_UNEXPECTED_DEPTH]")
    );
    expect(has).to.equal(true);
  });
});

describe("analyzeNoteTreeState — correct depth does not warn", () => {
  it("no [NOTE_TREE_UNEXPECTED_DEPTH] when depth matches expected", () => {
    const result = analyzeNoteTreeState({
      programIdStr: PROGRAM_ID,
      accountInfo: fakeAccount(makeData(1n, EXPECTED_TREE_DEPTH)),
    });
    const has = result.warnings.some((w) =>
      w.includes("[NOTE_TREE_UNEXPECTED_DEPTH]")
    );
    expect(has).to.equal(false);
  });
});

// ── Derived PDA / decoded shape ────────────────────────────────────────────────

describe("analyzeNoteTreeState — derived PDA and decoded shape", () => {
  it("note tree PDA is derivable from program ID with seed [note_tree]", () => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("note_tree")],
      new PublicKey(PROGRAM_ID)
    );
    expect(pda.toBase58()).to.be.a("string").with.length.greaterThan(0);
  });

  it("decoded report contains expected fields", () => {
    const result = analyzeNoteTreeState({
      programIdStr: PROGRAM_ID,
      accountInfo: fakeAccount(makeData(4n)),
    });
    expect(result).to.have.property("exists", true);
    expect(result).to.have.property("ownerMatchesProgram", true);
    expect(result).to.have.property("decoded", true);
    expect(result).to.have.property("leafCount", 4);
    expect(result).to.have.property("treeDepth", EXPECTED_TREE_DEPTH);
    expect(result).to.have.property("isEmpty", false);
    expect(result.warnings).to.be.an("array");
  });

  it("warnings array does not mention anonymity or privacy set", () => {
    for (const leafCount of [0n, 1n, 100n]) {
      const result = analyzeNoteTreeState({
        programIdStr: PROGRAM_ID,
        accountInfo: fakeAccount(makeData(leafCount)),
      });
      for (const w of result.warnings) {
        expect(w.toLowerCase()).to.not.include("anon");
        expect(w.toLowerCase()).to.not.include("privacy set");
        expect(w.toLowerCase()).to.not.include("anonymity");
      }
    }
  });
});

// ── Static safety scan ─────────────────────────────────────────────────────────

describe("devnet_doctor.ts static safety scan — note tree additions", () => {
  const src = fs.readFileSync("scripts/ops/devnet_doctor.ts", "utf8");

  it("does not call sendRawTransaction", () => {
    expect(src).to.not.include("sendRawTransaction");
  });

  it("does not call sendTransaction", () => {
    expect(src).to.not.include("sendTransaction");
  });

  it("does not call .rpc()", () => {
    expect(src).to.not.include(".rpc(");
  });

  it("does not import or instantiate Keypair", () => {
    expect(src).to.not.include("Keypair");
  });

  it("does not handle a --send flag", () => {
    expect(src).to.not.include('"--send"');
  });

  it("does not reference proof or witness artifact extensions", () => {
    expect(src).to.not.include(".wasm");
    expect(src).to.not.include(".zkey");
    expect(src).to.not.include("proof.json");
    expect(src).to.not.include("witness.json");
  });

  it('renderHuman emits "Note tree PDA" row', () => {
    expect(src).to.include('row("Note tree PDA"');
  });

  it('renderHuman emits "Note tree leaves" row', () => {
    expect(src).to.include('row("Note tree leaves"');
  });
});
