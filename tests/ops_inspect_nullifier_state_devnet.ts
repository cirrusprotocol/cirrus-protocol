import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  parseNullifierStateArgs,
  buildNullifierStateReport,
  runInspectNullifierState,
  deriveNullifierMarkerPda,
  NullifierStateArgs,
  NullifierStateReport,
} from "../scripts/ops/inspect_nullifier_state_devnet";

// ── Constants ──────────────────────────────────────────────────────────────────

const PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";
const NULLIFIER_HASH =
  "14c5eb23d6fde3badb953fdb1bed38957afc8d28ae81ebaa155e24d52a481ba9";
const OTHER_NULLIFIER_HASH =
  "27cb78d0541f3912c8645bd60acbe7a7205225e0e6f55a17f4843ac719e3eafe";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const EXPECTED_DATA_LEN = 9;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeArgs(
  overrides: Partial<NullifierStateArgs> = {}
): NullifierStateArgs {
  return {
    rpcUrl: "https://api.devnet.solana.com",
    programId: PROGRAM_ID,
    nullifierHash: NULLIFIER_HASH,
    commitment: "confirmed",
    json: false,
    ...overrides,
  };
}

type FakeAccountInfo = {
  owner: PublicKey;
  data: Buffer;
  lamports: number;
};

function fakeAccount(
  owner: PublicKey = new PublicKey(PROGRAM_ID),
  dataLen = EXPECTED_DATA_LEN,
  lamports = 1461600
): FakeAccountInfo {
  return { owner, data: Buffer.alloc(dataLen), lamports };
}

function fakeGetAccountInfo(
  account: FakeAccountInfo | null
): (pubkey: PublicKey) => Promise<FakeAccountInfo | null> {
  return async (_pubkey: PublicKey) => account;
}

function captureOutput(): {
  lines: string[];
  log: (line: string) => void;
  warn: (line: string) => void;
  warnLines: string[];
} {
  const lines: string[] = [];
  const warnLines: string[] = [];
  return {
    lines,
    warnLines,
    log: (line: string) => lines.push(line),
    warn: (line: string) => warnLines.push(line),
  };
}

// ── Parser tests ───────────────────────────────────────────────────────────────

describe("parseNullifierStateArgs", () => {
  it("requires --rpc-url", () => {
    expect(() =>
      parseNullifierStateArgs([
        "--program-id",
        PROGRAM_ID,
        "--nullifier-hash",
        NULLIFIER_HASH,
      ])
    ).to.throw("--rpc-url is required");
  });

  it("requires --program-id", () => {
    expect(() =>
      parseNullifierStateArgs([
        "--rpc-url",
        "https://api.devnet.solana.com",
        "--nullifier-hash",
        NULLIFIER_HASH,
      ])
    ).to.throw("--program-id is required");
  });

  it("requires --nullifier-hash", () => {
    expect(() =>
      parseNullifierStateArgs([
        "--rpc-url",
        "https://api.devnet.solana.com",
        "--program-id",
        PROGRAM_ID,
      ])
    ).to.throw("--nullifier-hash is required");
  });

  it("rejects a nullifier hash shorter than 64 hex chars", () => {
    expect(() =>
      parseNullifierStateArgs([
        "--rpc-url",
        "https://api.devnet.solana.com",
        "--program-id",
        PROGRAM_ID,
        "--nullifier-hash",
        "deadbeef",
      ])
    ).to.throw("exactly 64 hex characters");
  });

  it("rejects a non-hex nullifier hash", () => {
    expect(() =>
      parseNullifierStateArgs([
        "--rpc-url",
        "https://api.devnet.solana.com",
        "--program-id",
        PROGRAM_ID,
        "--nullifier-hash",
        "z".repeat(64),
      ])
    ).to.throw("exactly 64 hex characters");
  });

  it("normalizes uppercase nullifier hash to lowercase", () => {
    const upper = NULLIFIER_HASH.toUpperCase();
    const args = parseNullifierStateArgs([
      "--rpc-url",
      "https://api.devnet.solana.com",
      "--program-id",
      PROGRAM_ID,
      "--nullifier-hash",
      upper,
    ]);
    expect(args.nullifierHash).to.equal(NULLIFIER_HASH.toLowerCase());
  });

  it("accepts processed, confirmed, and finalized commitment", () => {
    for (const c of ["processed", "confirmed", "finalized"] as const) {
      const args = parseNullifierStateArgs([
        "--rpc-url",
        "https://api.devnet.solana.com",
        "--program-id",
        PROGRAM_ID,
        "--nullifier-hash",
        NULLIFIER_HASH,
        "--commitment",
        c,
      ]);
      expect(args.commitment).to.equal(c);
    }
  });

  it("rejects an invalid commitment value", () => {
    expect(() =>
      parseNullifierStateArgs([
        "--rpc-url",
        "https://api.devnet.solana.com",
        "--program-id",
        PROGRAM_ID,
        "--nullifier-hash",
        NULLIFIER_HASH,
        "--commitment",
        "recent",
      ])
    ).to.throw("--commitment must be processed, confirmed, or finalized");
  });

  it("parses --json flag", () => {
    const args = parseNullifierStateArgs([
      "--rpc-url",
      "https://api.devnet.solana.com",
      "--program-id",
      PROGRAM_ID,
      "--nullifier-hash",
      NULLIFIER_HASH,
      "--json",
    ]);
    expect(args.json).to.equal(true);
  });

  it("rejects an unknown flag", () => {
    expect(() =>
      parseNullifierStateArgs([
        "--rpc-url",
        "https://api.devnet.solana.com",
        "--program-id",
        PROGRAM_ID,
        "--nullifier-hash",
        NULLIFIER_HASH,
        "--send",
      ])
    ).to.throw("unknown flag");
  });
});

// ── PDA / report builder tests ─────────────────────────────────────────────────

describe("deriveNullifierMarkerPda", () => {
  it("derives a deterministic PDA for the same nullifier hash and program ID", () => {
    const pk = new PublicKey(PROGRAM_ID);
    const [pda1] = deriveNullifierMarkerPda(pk, NULLIFIER_HASH);
    const [pda2] = deriveNullifierMarkerPda(pk, NULLIFIER_HASH);
    expect(pda1.toBase58()).to.equal(pda2.toBase58());
  });

  it("derives a different PDA for a different nullifier hash", () => {
    const pk = new PublicKey(PROGRAM_ID);
    const [pda1] = deriveNullifierMarkerPda(pk, NULLIFIER_HASH);
    const [pda2] = deriveNullifierMarkerPda(pk, OTHER_NULLIFIER_HASH);
    expect(pda1.toBase58()).to.not.equal(pda2.toBase58());
  });
});

describe("buildNullifierStateReport", () => {
  it("reports exists=false and empty warnings when account is missing", () => {
    const report = buildNullifierStateReport(makeArgs(), null);
    expect(report.exists).to.equal(false);
    expect(report.warnings).to.deep.equal([]);
    expect(report.owner).to.equal(null);
    expect(report.lamports).to.equal(null);
    expect(report.dataLength).to.equal(null);
    expect(report.ownerMatchesProgram).to.equal(null);
  });

  it("reports exists=true when account is present", () => {
    const report = buildNullifierStateReport(
      makeArgs(),
      fakeAccount(new PublicKey(PROGRAM_ID))
    );
    expect(report.exists).to.equal(true);
    expect(report.lamports).to.be.a("number");
    expect(report.dataLength).to.equal(EXPECTED_DATA_LEN);
  });

  it("sets ownerMatchesProgram=true when owner matches program ID", () => {
    const report = buildNullifierStateReport(
      makeArgs(),
      fakeAccount(new PublicKey(PROGRAM_ID))
    );
    expect(report.ownerMatchesProgram).to.equal(true);
  });

  it("emits NULLIFIER_MARKER_OWNER_MISMATCH when owner differs", () => {
    const report = buildNullifierStateReport(
      makeArgs(),
      fakeAccount(new PublicKey(SYSTEM_PROGRAM))
    );
    expect(report.ownerMatchesProgram).to.equal(false);
    const has = report.warnings.some((w) =>
      w.includes("[NULLIFIER_MARKER_OWNER_MISMATCH]")
    );
    expect(has).to.equal(true);
  });

  it("emits NULLIFIER_MARKER_UNEXPECTED_DATA_LENGTH for wrong data length", () => {
    const report = buildNullifierStateReport(
      makeArgs(),
      fakeAccount(new PublicKey(PROGRAM_ID), 42)
    );
    const has = report.warnings.some((w) =>
      w.includes("[NULLIFIER_MARKER_UNEXPECTED_DATA_LENGTH]")
    );
    expect(has).to.equal(true);
  });

  it("emits NULLIFIER_MARKER_EXISTS when account exists", () => {
    const report = buildNullifierStateReport(
      makeArgs(),
      fakeAccount(new PublicKey(PROGRAM_ID))
    );
    const has = report.warnings.some((w) =>
      w.includes("[NULLIFIER_MARKER_EXISTS]")
    );
    expect(has).to.equal(true);
  });

  it("does not emit NULLIFIER_MARKER_EXISTS when account is missing", () => {
    const report = buildNullifierStateReport(makeArgs(), null);
    const has = report.warnings.some((w) =>
      w.includes("[NULLIFIER_MARKER_EXISTS]")
    );
    expect(has).to.equal(false);
  });

  it("notes mention that exists:false is not a privacy guarantee", () => {
    const report = buildNullifierStateReport(makeArgs(), null);
    const hasNote = report.notes.some((n) =>
      n.toLowerCase().includes("not a privacy guarantee")
    );
    expect(hasNote).to.equal(true);
  });

  it("JSON report contains all expected top-level fields", () => {
    const report = buildNullifierStateReport(makeArgs(), null);
    const expected: Array<keyof NullifierStateReport> = [
      "mode",
      "rpcUrl",
      "programId",
      "commitment",
      "nullifierHash",
      "nullifierPda",
      "exists",
      "owner",
      "lamports",
      "dataLength",
      "ownerMatchesProgram",
      "expectedDataLength",
      "warnings",
      "notes",
    ];
    for (const field of expected) {
      expect(report).to.have.property(field);
    }
    expect(report.mode).to.equal("nullifier_state_diagnostic");
  });

  it("nullifierPda matches the derived PDA", () => {
    const args = makeArgs();
    const [expected] = deriveNullifierMarkerPda(
      new PublicKey(args.programId),
      args.nullifierHash
    );
    const report = buildNullifierStateReport(args, null);
    expect(report.nullifierPda).to.equal(expected.toBase58());
  });
});

// ── Runner / output tests ──────────────────────────────────────────────────────

describe("runInspectNullifierState", () => {
  const baseArgv = [
    "--rpc-url",
    "https://api.devnet.solana.com",
    "--program-id",
    PROGRAM_ID,
    "--nullifier-hash",
    NULLIFIER_HASH,
  ];

  it("human output contains the nullifier PDA", async () => {
    const out = captureOutput();
    const args = makeArgs();
    const [pda] = deriveNullifierMarkerPda(
      new PublicKey(args.programId),
      args.nullifierHash
    );
    await runInspectNullifierState(baseArgv, {
      getAccountInfo: fakeGetAccountInfo(null),
      log: out.log,
      warn: out.warn,
    });
    const combined = out.lines.join("\n");
    expect(combined).to.include(pda.toBase58());
  });

  it("human output reports exists: true when account is found", async () => {
    const out = captureOutput();
    await runInspectNullifierState(baseArgv, {
      getAccountInfo: fakeGetAccountInfo(
        fakeAccount(new PublicKey(PROGRAM_ID))
      ),
      log: out.log,
      warn: out.warn,
    });
    const combined = out.lines.join("\n");
    expect(combined).to.include("exists:                true");
  });

  it("human output reports exists: false when account is missing", async () => {
    const out = captureOutput();
    await runInspectNullifierState(baseArgv, {
      getAccountInfo: fakeGetAccountInfo(null),
      log: out.log,
      warn: out.warn,
    });
    const combined = out.lines.join("\n");
    expect(combined).to.include("exists:                false");
  });

  it("returns 1 when required args are missing", async () => {
    const out = captureOutput();
    const code = await runInspectNullifierState(["--rpc-url", "https://x"], {
      getAccountInfo: fakeGetAccountInfo(null),
      log: out.log,
      warn: out.warn,
    });
    expect(code).to.equal(1);
    expect(out.warnLines.length).to.be.greaterThan(0);
  });

  it("returns 0 when account is missing", async () => {
    const out = captureOutput();
    const code = await runInspectNullifierState(baseArgv, {
      getAccountInfo: fakeGetAccountInfo(null),
      log: out.log,
      warn: out.warn,
    });
    expect(code).to.equal(0);
  });

  it("returns 0 when account exists (with warnings)", async () => {
    const out = captureOutput();
    const code = await runInspectNullifierState(baseArgv, {
      getAccountInfo: fakeGetAccountInfo(
        fakeAccount(new PublicKey(PROGRAM_ID))
      ),
      log: out.log,
      warn: out.warn,
    });
    expect(code).to.equal(0);
    const combined = out.lines.join("\n");
    expect(combined).to.include("[NULLIFIER_MARKER_EXISTS]");
  });
});

// ── Static safety scan ─────────────────────────────────────────────────────────

describe("inspect_nullifier_state_devnet.ts static safety scan", () => {
  const SOURCE = fs.readFileSync(
    path.join(__dirname, "../scripts/ops/inspect_nullifier_state_devnet.ts"),
    "utf8"
  );

  it("does not contain sendRawTransaction", () => {
    expect(SOURCE).to.not.include("sendRawTransaction");
  });

  it("does not contain sendTransaction", () => {
    expect(SOURCE).to.not.include("sendTransaction");
  });

  it("does not contain .rpc(", () => {
    expect(SOURCE).to.not.include(".rpc(");
  });

  it("does not contain Keypair", () => {
    expect(SOURCE).to.not.include("Keypair");
  });

  it("does not contain --send flag", () => {
    expect(SOURCE).to.not.include('"--send"');
  });

  it("does not reference proof or witness artifact file extensions", () => {
    expect(SOURCE).to.not.include(".wasm");
    expect(SOURCE).to.not.include(".zkey");
    expect(SOURCE).to.not.include(".ptau");
    expect(SOURCE).to.not.include("proof.json");
    expect(SOURCE).to.not.include("witness.json");
  });
});
