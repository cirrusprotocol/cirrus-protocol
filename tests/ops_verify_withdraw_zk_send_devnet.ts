import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  parseVerifyArgs,
  runVerifyWithdrawZkSend,
  runVerifyWithdrawZkSendCli,
  EXPECTED_NULLIFIER_MARKER_LEN,
  VerifyWithdrawZkArgs,
  VerifyWithdrawZkConnection,
} from "../scripts/ops/verify_withdraw_zk_send_devnet";
import { deriveWithdrawZkNullifierMarkerPda } from "../lib/zk_prover/withdraw_zk_artifacts";

// ── Test constants ─────────────────────────────────────────────────────────────

const PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";
const RELAYER = "3NpDL8TgCvgVqig4REBPDos1YuQarFqh7PEebcq7WGhu";
const RECIPIENT = "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o";
const SIGNATURE =
  "eX6V1KGii3UHn3w61eAJHXLCnSmEzsUgp41RopsxFe3FzuU9d7Z5hqQair8T6GHq7VFyeftsY17WtAbTYttDkFV";
const NULLIFIER_HASH =
  "14c5eb23d6fde3badb953fdb1bed38957afc8d28ae81ebaa155e24d52a481ba9";
const REGRESSION_NULLIFIER_HASH =
  "27cb78d0541f3912c8645bd60acbe7a7205225e0e6f55a17f4843ac719e3eafe";

// Derive the expected nullifier marker PDA so tests don't hardcode it.
const programIdPk = new PublicKey(PROGRAM_ID);
const [derivedMarkerPk] = deriveWithdrawZkNullifierMarkerPda(
  programIdPk,
  NULLIFIER_HASH
);
const NULLIFIER_MARKER = derivedMarkerPk.toBase58();

const SEND_RESULT_PATH = "/tmp/test-verify/send_result.json";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// ── Helpers ────────────────────────────────────────────────────────────────────

type FakeAccount = {
  owner: PublicKey;
  data: Buffer;
  lamports: number;
};

function fakeSendResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: "send",
    signature: SIGNATURE,
    programId: PROGRAM_ID,
    relayer: RELAYER,
    recipient: RECIPIENT,
    denomination: "1000000000",
    fee: "10000000",
    recipientGets: "990000000",
    root: "0c66fb95e53cb75f38c4e78cf7bfafc9f2f3bd2909b18985ac6462b9a038424a",
    nullifierHash: NULLIFIER_HASH,
    nullifierMarker: NULLIFIER_MARKER,
    txHash: "00383bcd68e7547e3b75cc42c8eb2e41b73401bf6a578677dc14de7064ff9aab",
    poolLamports: "10001288600",
    ...overrides,
  });
}

function makeReadFileSync(content: string): (p: string) => string {
  return (p: string) => {
    if (p === SEND_RESULT_PATH) return content;
    throw Object.assign(
      new Error(`ENOENT: no such file or directory, open '${p}'`),
      { code: "ENOENT" }
    );
  };
}

function fakeConnection(opts: {
  sigStatus?: { confirmationStatus?: string | null; err?: unknown } | null;
  accounts?: Map<string, FakeAccount | null>;
}): VerifyWithdrawZkConnection {
  return {
    async getSignatureStatus(_sig) {
      return opts.sigStatus !== undefined ? opts.sigStatus : null;
    },
    async getAccountInfo(pubkey) {
      const key = pubkey.toBase58();
      if (opts.accounts && opts.accounts.has(key)) {
        return opts.accounts.get(key) ?? null;
      }
      return null;
    },
  };
}

function nullifierMarkerAccount(
  owner: PublicKey = programIdPk,
  dataLen = EXPECTED_NULLIFIER_MARKER_LEN
): FakeAccount {
  return { owner, data: Buffer.alloc(dataLen), lamports: 953520 };
}

function accountMap(
  entries: Array<[string, FakeAccount | null]>
): Map<string, FakeAccount | null> {
  return new Map(entries);
}

function happyAccounts(): Map<string, FakeAccount | null> {
  return accountMap([[NULLIFIER_MARKER, nullifierMarkerAccount()]]);
}

function baseArgs(
  overrides: Partial<VerifyWithdrawZkArgs> = {}
): VerifyWithdrawZkArgs {
  return {
    rpc: "https://api.devnet.solana.com",
    sendResultJson: SEND_RESULT_PATH,
    commitment: "confirmed",
    json: false,
    ...overrides,
  };
}

function happyDeps(sendResultOverrides: Record<string, unknown> = {}) {
  return {
    readFileSync: makeReadFileSync(fakeSendResult(sendResultOverrides)),
    connection: fakeConnection({
      sigStatus: { confirmationStatus: "finalized", err: null },
      accounts: happyAccounts(),
    }),
  };
}

// ── Static source read ─────────────────────────────────────────────────────────

const VERIFY_SCRIPT_SRC = fs.readFileSync(
  path.join(__dirname, "../scripts/ops/verify_withdraw_zk_send_devnet.ts"),
  "utf8"
);

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ops_verify_withdraw_zk_send_devnet: parseVerifyArgs", function () {
  it("parses --rpc and --send-result-json", () => {
    const args = parseVerifyArgs([
      "--rpc",
      "https://api.devnet.solana.com",
      "--send-result-json",
      "/tmp/result.json",
    ]);
    expect(args.rpc).to.equal("https://api.devnet.solana.com");
    expect(args.sendResultJson).to.equal("/tmp/result.json");
  });

  it("defaults commitment to confirmed and json to false", () => {
    const args = parseVerifyArgs([
      "--rpc",
      "https://api.devnet.solana.com",
      "--send-result-json",
      "/tmp/r.json",
    ]);
    expect(args.commitment).to.equal("confirmed");
    expect(args.json).to.equal(false);
  });

  it("parses --commitment finalized", () => {
    const args = parseVerifyArgs([
      "--rpc",
      "https://api.devnet.solana.com",
      "--send-result-json",
      "/tmp/r.json",
      "--commitment",
      "finalized",
    ]);
    expect(args.commitment).to.equal("finalized");
  });

  it("parses --json flag", () => {
    const args = parseVerifyArgs([
      "--rpc",
      "https://api.devnet.solana.com",
      "--send-result-json",
      "/tmp/r.json",
      "--json",
    ]);
    expect(args.json).to.equal(true);
  });

  it("parses optional --program-id", () => {
    const args = parseVerifyArgs([
      "--rpc",
      "https://api.devnet.solana.com",
      "--send-result-json",
      "/tmp/r.json",
      "--program-id",
      PROGRAM_ID,
    ]);
    expect(args.programId).to.equal(PROGRAM_ID);
  });

  it("parses --check-regression-nullifier", () => {
    const args = parseVerifyArgs([
      "--rpc",
      "https://api.devnet.solana.com",
      "--send-result-json",
      "/tmp/r.json",
      "--check-regression-nullifier",
      REGRESSION_NULLIFIER_HASH,
    ]);
    expect(args.checkRegressionNullifier).to.equal(REGRESSION_NULLIFIER_HASH);
  });

  it("rejects missing --rpc", () => {
    expect(() =>
      parseVerifyArgs(["--send-result-json", "/tmp/r.json"])
    ).to.throw(/--rpc is required/);
  });

  it("rejects missing --send-result-json", () => {
    expect(() =>
      parseVerifyArgs(["--rpc", "https://api.devnet.solana.com"])
    ).to.throw(/--send-result-json is required/);
  });

  it("rejects mainnet RPC", () => {
    expect(() =>
      parseVerifyArgs([
        "--rpc",
        "https://api.mainnet-beta.solana.com",
        "--send-result-json",
        "/tmp/r.json",
      ])
    ).to.throw(/mainnet/);
  });

  it("rejects invalid --commitment value", () => {
    expect(() =>
      parseVerifyArgs([
        "--rpc",
        "https://api.devnet.solana.com",
        "--send-result-json",
        "/tmp/r.json",
        "--commitment",
        "processed",
      ])
    ).to.throw(/commitment/);
  });

  it("rejects unknown flag", () => {
    expect(() =>
      parseVerifyArgs([
        "--rpc",
        "https://api.devnet.solana.com",
        "--send-result-json",
        "/tmp/r.json",
        "--unknown",
      ])
    ).to.throw(/unknown flag/);
  });
});

describe("ops_verify_withdraw_zk_send_devnet: runVerifyWithdrawZkSend", function () {
  // ── Happy path ───────────────────────────────────────────────────────────────

  it("happy path: valid send_result, finalized, correct account → ok=true", async () => {
    const { result, exitCode } = await runVerifyWithdrawZkSend(
      baseArgs(),
      happyDeps()
    );
    expect(result.ok).to.be.true;
    expect(exitCode).to.equal(0);
    expect(result.signatureFound).to.be.true;
    expect(result.confirmationStatus).to.equal("finalized");
    expect(result.transactionError).to.be.null;
    expect(result.nullifierMarkerMatches).to.be.true;
    expect(result.nullifierAccountExists).to.be.true;
    expect(result.nullifierAccountOwnerMatches).to.be.true;
    expect(result.nullifierAccountDataLength).to.equal(
      EXPECTED_NULLIFIER_MARKER_LEN
    );
    expect(result.nullifierAccountLengthMatches).to.be.true;
    expect(result.mode).to.equal("verify");
  });

  it("preSendPoolLamportsFromSendResult is populated from send result field", async () => {
    const { result } = await runVerifyWithdrawZkSend(baseArgs(), happyDeps());
    expect(result.preSendPoolLamportsFromSendResult).to.equal("10001288600");
  });

  it("result has all expected output keys", async () => {
    const { result } = await runVerifyWithdrawZkSend(baseArgs(), happyDeps());
    const expectedKeys = [
      "ok",
      "mode",
      "rpc",
      "programId",
      "signature",
      "signatureFound",
      "confirmationStatus",
      "transactionError",
      "nullifierMarker",
      "nullifierMarkerDerived",
      "nullifierMarkerMatches",
      "nullifierAccountExists",
      "nullifierAccountOwner",
      "nullifierAccountOwnerMatches",
      "nullifierAccountDataLength",
      "nullifierAccountLengthMatches",
      "recipientLamports",
      "relayerLamports",
      "poolLamports",
      "preSendPoolLamportsFromSendResult",
      "regressionNullifierChecked",
      "regressionNullifierPda",
      "regressionNullifierExists",
      "warnings",
    ];
    for (const key of expectedKeys) {
      expect(result, `missing key: ${key}`).to.have.property(key);
    }
  });

  // ── Input validation errors ──────────────────────────────────────────────────

  it("throws when send_result file does not exist", async () => {
    const deps = {
      readFileSync: (_p: string) => {
        throw Object.assign(new Error("ENOENT: no such file"), {
          code: "ENOENT",
        });
      },
      connection: fakeConnection({ sigStatus: null }),
    };
    let threw = false;
    try {
      await runVerifyWithdrawZkSend(baseArgs(), deps);
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.include("cannot read");
    }
    expect(threw).to.be.true;
  });

  it("throws on malformed JSON", async () => {
    const deps = {
      readFileSync: (_p: string) => "not json {{{",
      connection: fakeConnection({ sigStatus: null }),
    };
    let threw = false;
    try {
      await runVerifyWithdrawZkSend(baseArgs(), deps);
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.include("malformed JSON");
    }
    expect(threw).to.be.true;
  });

  it("throws when mode is not send", async () => {
    const deps = {
      readFileSync: makeReadFileSync(fakeSendResult({ mode: "verify" })),
      connection: fakeConnection({ sigStatus: null }),
    };
    let threw = false;
    try {
      await runVerifyWithdrawZkSend(baseArgs(), deps);
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.include(`expected mode "send"`);
    }
    expect(threw).to.be.true;
  });

  it("throws when signature field is missing", async () => {
    const deps = {
      readFileSync: makeReadFileSync(fakeSendResult({ signature: "" })),
      connection: fakeConnection({ sigStatus: null }),
    };
    let threw = false;
    try {
      await runVerifyWithdrawZkSend(baseArgs(), deps);
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.include(`"signature"`);
    }
    expect(threw).to.be.true;
  });

  // ── Verification failures ────────────────────────────────────────────────────

  it("ok=false when derived nullifier marker does not match send result", async () => {
    const deps = {
      readFileSync: makeReadFileSync(
        fakeSendResult({ nullifierMarker: RELAYER })
      ),
      connection: fakeConnection({
        sigStatus: { confirmationStatus: "finalized", err: null },
        accounts: happyAccounts(),
      }),
    };
    const { result, exitCode } = await runVerifyWithdrawZkSend(
      baseArgs(),
      deps
    );
    expect(result.ok).to.be.false;
    expect(exitCode).to.equal(1);
    expect(result.nullifierMarkerMatches).to.be.false;
    expect(result.nullifierMarkerDerived).to.equal(NULLIFIER_MARKER);
    expect(result.nullifierMarker).to.equal(RELAYER);
  });

  it("ok=false when nullifier account does not exist", async () => {
    const deps = {
      readFileSync: makeReadFileSync(fakeSendResult()),
      connection: fakeConnection({
        sigStatus: { confirmationStatus: "finalized", err: null },
        accounts: accountMap([]),
      }),
    };
    const { result } = await runVerifyWithdrawZkSend(baseArgs(), deps);
    expect(result.ok).to.be.false;
    expect(result.nullifierAccountExists).to.be.false;
  });

  it("ok=false when nullifier account owner does not match program", async () => {
    const wrongOwner = new PublicKey(SYSTEM_PROGRAM_ID);
    const deps = {
      readFileSync: makeReadFileSync(fakeSendResult()),
      connection: fakeConnection({
        sigStatus: { confirmationStatus: "finalized", err: null },
        accounts: accountMap([
          [NULLIFIER_MARKER, nullifierMarkerAccount(wrongOwner)],
        ]),
      }),
    };
    const { result } = await runVerifyWithdrawZkSend(baseArgs(), deps);
    expect(result.ok).to.be.false;
    expect(result.nullifierAccountOwnerMatches).to.be.false;
    expect(result.nullifierAccountOwner).to.equal(SYSTEM_PROGRAM_ID);
  });

  it("ok=false when nullifier account data length does not match", async () => {
    const deps = {
      readFileSync: makeReadFileSync(fakeSendResult()),
      connection: fakeConnection({
        sigStatus: { confirmationStatus: "finalized", err: null },
        accounts: accountMap([
          [NULLIFIER_MARKER, nullifierMarkerAccount(programIdPk, 8)],
        ]),
      }),
    };
    const { result } = await runVerifyWithdrawZkSend(baseArgs(), deps);
    expect(result.ok).to.be.false;
    expect(result.nullifierAccountLengthMatches).to.be.false;
    expect(result.nullifierAccountDataLength).to.equal(8);
  });

  it("ok=false when signature not found", async () => {
    const deps = {
      readFileSync: makeReadFileSync(fakeSendResult()),
      connection: fakeConnection({
        sigStatus: null,
        accounts: happyAccounts(),
      }),
    };
    const { result } = await runVerifyWithdrawZkSend(baseArgs(), deps);
    expect(result.ok).to.be.false;
    expect(result.signatureFound).to.be.false;
  });

  it("ok=false when transaction error is present", async () => {
    const txErr = { InstructionError: [0, "InvalidProof"] };
    const deps = {
      readFileSync: makeReadFileSync(fakeSendResult()),
      connection: fakeConnection({
        sigStatus: { confirmationStatus: "finalized", err: txErr },
        accounts: happyAccounts(),
      }),
    };
    const { result } = await runVerifyWithdrawZkSend(baseArgs(), deps);
    expect(result.ok).to.be.false;
    expect(result.transactionError).to.deep.equal(txErr);
  });

  // ── Regression nullifier ─────────────────────────────────────────────────────

  it("regression nullifier check: account absent → checked=true, exists=false, no warning", async () => {
    const args = baseArgs({
      checkRegressionNullifier: REGRESSION_NULLIFIER_HASH,
    });
    const { result } = await runVerifyWithdrawZkSend(args, happyDeps());
    expect(result.regressionNullifierChecked).to.be.true;
    expect(result.regressionNullifierExists).to.be.false;
    expect(result.regressionNullifierPda)
      .to.be.a("string")
      .with.length.greaterThan(30);
    expect(
      result.warnings.some((w) => w.includes("[REGRESSION_NULLIFIER_EXISTS]"))
    ).to.be.false;
  });

  it("regression nullifier check: account present → warning emitted", async () => {
    const [regPk] = deriveWithdrawZkNullifierMarkerPda(
      programIdPk,
      REGRESSION_NULLIFIER_HASH
    );
    const regAccounts = accountMap([
      [NULLIFIER_MARKER, nullifierMarkerAccount()],
      [regPk.toBase58(), nullifierMarkerAccount()],
    ]);
    const args = baseArgs({
      checkRegressionNullifier: REGRESSION_NULLIFIER_HASH,
    });
    const deps = {
      readFileSync: makeReadFileSync(fakeSendResult()),
      connection: fakeConnection({
        sigStatus: { confirmationStatus: "finalized", err: null },
        accounts: regAccounts,
      }),
    };
    const { result } = await runVerifyWithdrawZkSend(args, deps);
    expect(result.regressionNullifierChecked).to.be.true;
    expect(result.regressionNullifierExists).to.be.true;
    expect(
      result.warnings.some((w) => w.includes("[REGRESSION_NULLIFIER_EXISTS]"))
    ).to.be.true;
  });

  // ── Balance reads ────────────────────────────────────────────────────────────

  it("reads recipient and relayer lamports when accounts exist", async () => {
    const recipientAcc = {
      owner: new PublicKey(SYSTEM_PROGRAM_ID),
      data: Buffer.alloc(0),
      lamports: 2481912560,
    };
    const relayerAcc = {
      owner: new PublicKey(SYSTEM_PROGRAM_ID),
      data: Buffer.alloc(0),
      lamports: 5009041480,
    };
    const accounts = accountMap([
      [NULLIFIER_MARKER, nullifierMarkerAccount()],
      [RECIPIENT, recipientAcc],
      [RELAYER, relayerAcc],
    ]);
    const deps = {
      readFileSync: makeReadFileSync(fakeSendResult()),
      connection: fakeConnection({
        sigStatus: { confirmationStatus: "finalized", err: null },
        accounts,
      }),
    };
    const { result } = await runVerifyWithdrawZkSend(baseArgs(), deps);
    expect(result.recipientLamports).to.equal("2481912560");
    expect(result.relayerLamports).to.equal("5009041480");
  });

  it("reports null balances when accounts are not in RPC response", async () => {
    const { result } = await runVerifyWithdrawZkSend(baseArgs(), happyDeps());
    expect(result.recipientLamports).to.be.null;
    expect(result.relayerLamports).to.be.null;
    expect(result.poolLamports).to.be.null;
  });
});

// ── CLI runner ────────────────────────────────────────────────────────────────

describe("ops_verify_withdraw_zk_send_devnet: runVerifyWithdrawZkSendCli", function () {
  it("happy path through CLI returns exit code 0", async () => {
    const lines: string[] = [];
    const code = await runVerifyWithdrawZkSendCli(
      [
        "--rpc",
        "https://api.devnet.solana.com",
        "--send-result-json",
        SEND_RESULT_PATH,
      ],
      {
        readFileSync: makeReadFileSync(fakeSendResult()),
        connection: fakeConnection({
          sigStatus: { confirmationStatus: "finalized", err: null },
          accounts: happyAccounts(),
        }),
        stdout: (l) => lines.push(l),
        stderr: (_l) => {},
      }
    );
    expect(code).to.equal(0);
  });

  it("parse error returns exit code 1", async () => {
    const errs: string[] = [];
    const code = await runVerifyWithdrawZkSendCli([], {
      stderr: (l) => errs.push(l),
      stdout: (_l) => {},
    });
    expect(code).to.equal(1);
    expect(errs.join(" ")).to.include("--rpc");
  });

  it("file read error returns exit code 1", async () => {
    const errs: string[] = [];
    const code = await runVerifyWithdrawZkSendCli(
      [
        "--rpc",
        "https://api.devnet.solana.com",
        "--send-result-json",
        "/nonexistent/path.json",
      ],
      {
        readFileSync: (_p: string) => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        connection: fakeConnection({ sigStatus: null }),
        stderr: (l) => errs.push(l),
        stdout: (_l) => {},
      }
    );
    expect(code).to.equal(1);
    expect(errs.join(" ")).to.include("error:");
  });

  it("--json mode emits valid JSON to stdout", async () => {
    const lines: string[] = [];
    const code = await runVerifyWithdrawZkSendCli(
      [
        "--rpc",
        "https://api.devnet.solana.com",
        "--send-result-json",
        SEND_RESULT_PATH,
        "--json",
      ],
      {
        readFileSync: makeReadFileSync(fakeSendResult()),
        connection: fakeConnection({
          sigStatus: { confirmationStatus: "finalized", err: null },
          accounts: happyAccounts(),
        }),
        stdout: (l) => lines.push(l),
        stderr: (_l) => {},
      }
    );
    expect(code).to.equal(0);
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).to.have.property("ok", true);
    expect(parsed).to.have.property("mode", "verify");
    expect(parsed).to.have.property("signatureFound", true);
    expect(parsed).to.have.property("nullifierMarkerMatches", true);
  });
});

// ── Static source scan ────────────────────────────────────────────────────────

describe("ops_verify_withdraw_zk_send_devnet: static source scan", function () {
  it("source does not contain Keypair.generate()", () => {
    expect(VERIFY_SCRIPT_SRC).to.not.include("Keypair.generate()");
  });

  it("source does not contain --send flag handling", () => {
    expect(VERIFY_SCRIPT_SRC).to.not.include('"--send"');
  });

  it("source does not call sendRawTransaction", () => {
    expect(VERIFY_SCRIPT_SRC).to.not.include("sendRawTransaction");
  });
});
