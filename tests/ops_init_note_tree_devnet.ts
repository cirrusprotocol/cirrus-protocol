import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  PROGRAM_ID,
  NoteTreeScriptArgs,
  parseArgs,
  validateIdlAddress,
  deriveNoteTreePda,
} from "../scripts/ops/init_note_tree_devnet";

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "ops",
  "init_note_tree_devnet.ts"
);

// ── Module guard ──────────────────────────────────────────────────────────────

describe("init_note_tree_devnet: module guard", () => {
  it("1. exports are accessible; require.main guard prevents execution on import", () => {
    expect(PROGRAM_ID).to.be.a("string").with.length.greaterThan(0);
    expect(parseArgs).to.be.a("function");
    expect(validateIdlAddress).to.be.a("function");
    expect(deriveNoteTreePda).to.be.a("function");
  });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("init_note_tree_devnet: parseArgs", () => {
  it("2. parseArgs([]) returns dryRun=false, yes=false", () => {
    const args: NoteTreeScriptArgs = parseArgs([]);
    expect(args.dryRun).to.equal(false);
    expect(args.yes).to.equal(false);
  });

  it("3. parseArgs(['--dry-run']) returns dryRun=true, yes=false", () => {
    const args = parseArgs(["--dry-run"]);
    expect(args.dryRun).to.equal(true);
    expect(args.yes).to.equal(false);
  });

  it("4. parseArgs(['--yes']) returns dryRun=false, yes=true", () => {
    const args = parseArgs(["--yes"]);
    expect(args.dryRun).to.equal(false);
    expect(args.yes).to.equal(true);
  });

  it("5. parseArgs(['--dry-run', '--yes']) returns dryRun=true, yes=true", () => {
    const args = parseArgs(["--dry-run", "--yes"]);
    expect(args.dryRun).to.equal(true);
    expect(args.yes).to.equal(true);
  });

  it("6. parseArgs rejects an unknown flag", () => {
    expect(() => parseArgs(["--unknown"])).to.throw(/unknown flag/);
    expect(() => parseArgs(["--rpc-url"])).to.throw(/unknown flag/);
  });
});

// ── validateIdlAddress ────────────────────────────────────────────────────────

describe("init_note_tree_devnet: validateIdlAddress", () => {
  it("7. rejects missing address field", () => {
    expect(() => validateIdlAddress({})).to.throw(/missing/i);
  });

  it("8. rejects an address that is not a valid public key", () => {
    expect(() => validateIdlAddress({ address: "not-a-pubkey" })).to.throw(
      /not a valid public key/i
    );
  });

  it("9. rejects a valid pubkey that does not match PROGRAM_ID", () => {
    expect(() =>
      validateIdlAddress({ address: "11111111111111111111111111111111" })
    ).to.throw(/mismatch/i);
  });

  it("10. accepts PROGRAM_ID and returns a PublicKey equal to PROGRAM_ID", () => {
    const pk = validateIdlAddress({ address: PROGRAM_ID });
    expect(pk).to.be.instanceof(PublicKey);
    expect(pk.toBase58()).to.equal(PROGRAM_ID);
  });
});

// ── deriveNoteTreePda ─────────────────────────────────────────────────────────

describe("init_note_tree_devnet: deriveNoteTreePda", () => {
  it("11. returns a stable PDA for PROGRAM_ID using seed [note_tree]", () => {
    const programId = new PublicKey(PROGRAM_ID);
    const [pda1] = deriveNoteTreePda(programId);
    const [pda2] = deriveNoteTreePda(programId);
    expect(pda1.toBase58()).to.equal(pda2.toBase58());

    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("note_tree")],
      programId
    );
    expect(pda1.toBase58()).to.equal(expected.toBase58());
  });
});

// ── Source scan ───────────────────────────────────────────────────────────────
//
// Strings are built with join() so that this test file itself does not contain
// the forbidden patterns consecutively (which would cause false positives in
// the repository safety grep).

describe("init_note_tree_devnet: source scan", () => {
  const join = (...parts: string[]) => parts.join("");
  let src: string;

  before(() => {
    src = fs.readFileSync(SCRIPT_PATH, "utf8");
  });

  it("12. script does not call the ZK note deposit method", () => {
    expect(src).to.not.include(join(".", "deposit", "Note"));
  });

  it("13. script does not call the root submit method", () => {
    expect(src).to.not.include(join("submit", "Root"));
  });

  it("14. script does not contain the ZK withdraw instruction name", () => {
    expect(src).to.not.include(join("with", "draw_zk"));
  });

  it("15. script does not invoke keypair generation", () => {
    expect(src).to.not.include(join("Keypair", ".", "generate"));
  });

  it("16. script does not invoke airdrop requests", () => {
    expect(src).to.not.include(join("request", "Airdrop"));
  });
});
