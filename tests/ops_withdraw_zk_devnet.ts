import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  parseWithdrawZkDryRunArgs,
  buildWithdrawZkDryRunSummary,
  buildWithdrawZkSimulationSummary,
  buildWithdrawZkSimulationTransaction,
  runWithdrawZkDevnetCli,
  createWithdrawZkSimulationConnection,
  WithdrawZkDryRunArgs,
  WithdrawZkCliDeps,
  WithdrawZkSimulationConnection,
  WithdrawZkSimulationSummary,
  WithdrawZkSimulationTransactionInput,
  WithdrawZkSendConnection,
  DEFAULT_WITHDRAW_ZK_SIMULATE_CU_LIMIT,
  MAX_WITHDRAW_ZK_SIMULATE_CU_LIMIT,
  MIN_SEND_EXPIRY_BUFFER,
} from "../scripts/ops/withdraw_zk_devnet";

// ── Test constants ─────────────────────────────────────────────────────────────

const PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";
const RELAYER = "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe";
const RECIPIENT = "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o";

// Paths outside the fake repo root to avoid triggering path warnings in most tests.
const PROOF_PATH = "/tmp/outside-proofs/proof.json";
const PUBLIC_PATH = "/tmp/outside-proofs/public.json";
const INPUT_PATH = "/tmp/outside-proofs/input.json";
const FAKE_REPO = "/tmp/fake-repo";
const FAKE_CWD = "/tmp/outside-proofs";

// Synthetic valid proof (matches synthetic_snarkjs_proof_shape.json).
const VALID_PROOF_JSON = JSON.stringify({
  pi_a: ["1", "2", "1"],
  pi_b: [
    ["10", "20"],
    ["30", "40"],
    ["1", "0"],
  ],
  pi_c: ["100", "200", "1"],
  protocol: "groth16",
  curve: "bn128",
});

// Synthetic public.json: [root_dec, nullifier_dec, tx_hash_dec].
const VALID_PUBLIC_JSON = JSON.stringify(["1", "2", "3"]);

// Synthetic input.json: scalar fields only, no tx_hash (avoids cross-check against public[2]).
// Fields match CLI args in baseArgs().
const VALID_INPUT_JSON = JSON.stringify({
  denomination: "1000000000",
  fee: "10000000",
  expiry_slot: "500000",
  circuit_version: "1",
});

// Minimal required CLI argv.
const REQUIRED_ARGV = [
  "--program-id",
  PROGRAM_ID,
  "--relayer",
  RELAYER,
  "--recipient",
  RECIPIENT,
  "--proof-json",
  PROOF_PATH,
  "--public-json",
  PUBLIC_PATH,
  "--input-json",
  INPUT_PATH,
  "--denomination",
  "1000000000",
  "--fee",
  "10000000",
  "--expiry-slot",
  "500000",
  "--circuit-version",
  "1",
];

function baseArgs(
  overrides: Partial<WithdrawZkDryRunArgs> = {}
): WithdrawZkDryRunArgs {
  return {
    programId: PROGRAM_ID,
    relayer: RELAYER,
    recipient: RECIPIENT,
    proofJson: PROOF_PATH,
    publicJson: PUBLIC_PATH,
    inputJson: INPUT_PATH,
    denomination: "1000000000",
    fee: "10000000",
    expirySlot: "500000",
    circuitVersion: "1",
    repoRoot: FAKE_REPO,
    ...overrides,
  };
}

function makeReadFileSync(map: Record<string, string>): (p: string) => string {
  return (p: string) => {
    if (p in map) return map[p];
    throw new Error(`fake readFileSync: unexpected path ${JSON.stringify(p)}`);
  };
}

function happyDeps(overrides: Record<string, string> = {}) {
  return {
    readFileSync: makeReadFileSync({
      [PROOF_PATH]: VALID_PROOF_JSON,
      [PUBLIC_PATH]: VALID_PUBLIC_JSON,
      [INPUT_PATH]: VALID_INPUT_JSON,
      ...overrides,
    }),
    cwd: () => FAKE_CWD,
  };
}

// Helpers for simulation transaction tests.
const FAKE_BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const FAKE_CU = 200_000;

function fakeWithdrawZkInstruction(): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(PROGRAM_ID),
    keys: [],
    data: Buffer.alloc(360),
  });
}

function validSimInput(): WithdrawZkSimulationTransactionInput {
  return {
    relayer: new PublicKey(RELAYER),
    recentBlockhash: FAKE_BLOCKHASH,
    computeUnitLimit: FAKE_CU,
    withdrawZkInstruction: fakeWithdrawZkInstruction(),
  };
}

function fakeConnection(opts?: {
  blockhash?: string;
  lastValidBlockHeight?: number;
  err?: unknown;
  logs?: string[] | null;
  unitsConsumed?: number;
}) {
  const calls = {
    getLatestBlockhash: 0,
    simulateTransaction: 0,
    tx: undefined as Transaction | undefined,
  };

  const connection: WithdrawZkSimulationConnection = {
    async getLatestBlockhash() {
      calls.getLatestBlockhash++;
      return {
        blockhash: opts?.blockhash ?? FAKE_BLOCKHASH,
        lastValidBlockHeight: opts?.lastValidBlockHeight ?? 123,
      };
    },
    async simulateTransaction(tx: Transaction) {
      calls.simulateTransaction++;
      calls.tx = tx;
      return {
        value: {
          err: opts?.err ?? null,
          logs:
            opts?.logs !== undefined ? opts.logs : ["Program log: simulated"],
          unitsConsumed: opts?.unitsConsumed ?? 119_664,
        },
      };
    },
  };

  return { connection, calls };
}

function simArgs(
  overrides: Partial<WithdrawZkDryRunArgs> = {}
): WithdrawZkDryRunArgs {
  return baseArgs({
    simulate: true,
    rpc: "https://api.devnet.solana.com",
    computeUnitLimit: DEFAULT_WITHDRAW_ZK_SIMULATE_CU_LIMIT,
    ...overrides,
  });
}

const SIM_ARGV = [
  ...REQUIRED_ARGV,
  "--simulate",
  "--rpc",
  "https://api.devnet.solana.com",
];

function makeCli(opts?: {
  throwOnConnect?: boolean;
  connOpts?: Parameters<typeof fakeConnection>[0];
}) {
  const { connection, calls: connCalls } = fakeConnection(opts?.connOpts);
  const connCreated: string[] = [];
  const out: string[] = [];
  const err: string[] = [];

  // cwd returns FAKE_REPO so that proof paths under /tmp/outside-proofs are
  // treated as outside the repo root, bypassing the in-repo artifact guard.
  const deps: WithdrawZkCliDeps = {
    readFileSync: makeReadFileSync({
      [PROOF_PATH]: VALID_PROOF_JSON,
      [PUBLIC_PATH]: VALID_PUBLIC_JSON,
      [INPUT_PATH]: VALID_INPUT_JSON,
    }),
    cwd: () => FAKE_REPO,
    createConnection(rpc: string): WithdrawZkSimulationConnection {
      if (opts?.throwOnConnect)
        throw new Error("createConnection must not be called");
      connCreated.push(rpc);
      return connection;
    },
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  };

  return { deps, connCreated, connCalls, out, err };
}

// ── Send-mode test helpers ────────────────────────────────────────────────────

const SEND_TEST_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(42));
const SEND_RELAYER = SEND_TEST_KEYPAIR.publicKey.toBase58();
const SEND_KEYPAIR_PATH = "/tmp/outside-proofs/relayer_test.json";
// public.json[0] = "1" (decimal) → bigintToHex32BE(1n) = 64 hex chars
const FAKE_EXPECTED_ROOT =
  "0000000000000000000000000000000000000000000000000000000000000001";
const FAKE_BLOCKHASH_1 = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const FAKE_BLOCKHASH_2 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const FAKE_SEND_SIG =
  "fakeSig1111111111111111111111111111111111111111111111111111111111111111";

function fakeSendConnection(opts?: {
  getSlotResult?: number;
  nullifierExists?: boolean;
  poolLamports?: bigint;
  configRoots?: string[];
  simErr?: unknown;
  sendSig?: string;
  throwSend?: boolean;
  throwConfirm?: boolean;
  confirmResultErr?: unknown;
}): {
  connection: WithdrawZkSendConnection;
  calls: {
    getLatestBlockhash: number;
    confirmCalledWithBlockhash: string | undefined;
    capturedSendRaw: Buffer | undefined;
    capturedSendOpts: { skipPreflight: boolean } | undefined;
  };
} {
  const calls = {
    getLatestBlockhash: 0,
    confirmCalledWithBlockhash: undefined as string | undefined,
    capturedSendRaw: undefined as Buffer | undefined,
    capturedSendOpts: undefined as { skipPreflight: boolean } | undefined,
  };
  // expiry_slot = 500000; default slot = 500000 - 300 → exactly 300 remaining (passes)
  const DEFAULT_SLOT = 500000 - MIN_SEND_EXPIRY_BUFFER;

  const connection: WithdrawZkSendConnection = {
    async getLatestBlockhash() {
      calls.getLatestBlockhash++;
      if (calls.getLatestBlockhash === 1) {
        return { blockhash: FAKE_BLOCKHASH_1, lastValidBlockHeight: 100 };
      }
      return { blockhash: FAKE_BLOCKHASH_2, lastValidBlockHeight: 200 };
    },
    async simulateTransaction(_tx) {
      return {
        value: {
          err: opts?.simErr ?? null,
          logs: ["ok"],
          unitsConsumed: 120_000,
        },
      };
    },
    async getSlot() {
      return opts?.getSlotResult ?? DEFAULT_SLOT;
    },
    async getNullifierMarkerExists(_pk) {
      return opts?.nullifierExists ?? false;
    },
    async getPoolRawLamports(_pk) {
      return opts?.poolLamports ?? 2_000_000_000n;
    },
    async getConfigAllowedRoots(_pk) {
      return opts?.configRoots ?? [FAKE_EXPECTED_ROOT];
    },
    async sendRawTransaction(raw, sendOpts) {
      calls.capturedSendRaw = Buffer.from(raw);
      calls.capturedSendOpts = sendOpts;
      if (opts?.throwSend) throw new Error("sendRawTransaction failed");
      return opts?.sendSig ?? FAKE_SEND_SIG;
    },
    async confirmTransaction(o, _commitment) {
      calls.confirmCalledWithBlockhash = o.blockhash;
      if (opts?.throwConfirm) throw new Error("confirmTransaction timed out");
      return { value: { err: opts?.confirmResultErr ?? null } };
    },
  };

  return { connection, calls };
}

const SEND_ARGV = [
  "--program-id",
  PROGRAM_ID,
  "--relayer",
  SEND_RELAYER,
  "--recipient",
  RECIPIENT,
  "--proof-json",
  PROOF_PATH,
  "--public-json",
  PUBLIC_PATH,
  "--input-json",
  INPUT_PATH,
  "--denomination",
  "1000000000",
  "--fee",
  "10000000",
  "--expiry-slot",
  "500000",
  "--circuit-version",
  "1",
  "--send",
  "--rpc",
  "https://api.devnet.solana.com",
  "--expected-root",
  FAKE_EXPECTED_ROOT,
  "--relayer-keypair",
  SEND_KEYPAIR_PATH,
  "--confirm",
  "SEND WITHDRAW_ZK TO DEVNET",
];

function makeSendCli(opts?: {
  connOpts?: Parameters<typeof fakeSendConnection>[0];
  filesOverride?: Record<string, string>;
}) {
  const { connection, calls: sendCalls } = fakeSendConnection(opts?.connOpts);
  const out: string[] = [];
  const err: string[] = [];

  const deps: WithdrawZkCliDeps = {
    readFileSync: makeReadFileSync({
      [PROOF_PATH]: VALID_PROOF_JSON,
      [PUBLIC_PATH]: VALID_PUBLIC_JSON,
      [INPUT_PATH]: VALID_INPUT_JSON,
      [SEND_KEYPAIR_PATH]: JSON.stringify(
        Array.from(SEND_TEST_KEYPAIR.secretKey)
      ),
      ...(opts?.filesOverride ?? {}),
    }),
    cwd: () => FAKE_REPO,
    createSendConnection: () => connection,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };

  return { deps, sendCalls, out, err };
}

// Static source scan — loaded once at module level
const OPS_SCRIPT_SRC = fs.readFileSync(
  path.join(__dirname, "../scripts/ops/withdraw_zk_devnet.ts"),
  "utf8"
);

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ops_withdraw_zk_devnet: dry-run builder", function () {
  // ── parseWithdrawZkDryRunArgs ──────────────────────────────────────────────

  describe("parseWithdrawZkDryRunArgs", function () {
    it("parses all required args", () => {
      const args = parseWithdrawZkDryRunArgs(REQUIRED_ARGV);
      expect(args.programId).to.equal(PROGRAM_ID);
      expect(args.relayer).to.equal(RELAYER);
      expect(args.recipient).to.equal(RECIPIENT);
      expect(args.proofJson).to.equal(PROOF_PATH);
      expect(args.publicJson).to.equal(PUBLIC_PATH);
      expect(args.inputJson).to.equal(INPUT_PATH);
      expect(args.denomination).to.equal("1000000000");
      expect(args.fee).to.equal("10000000");
      expect(args.expirySlot).to.equal("500000");
      expect(args.circuitVersion).to.equal("1");
    });

    it("parses --json flag", () => {
      const args = parseWithdrawZkDryRunArgs([...REQUIRED_ARGV, "--json"]);
      expect(args.json).to.equal(true);
    });

    it("parses --allow-in-repo-artifacts flag", () => {
      const args = parseWithdrawZkDryRunArgs([
        ...REQUIRED_ARGV,
        "--allow-in-repo-artifacts",
      ]);
      expect(args.allowInRepoArtifacts).to.equal(true);
    });

    it("parses optional --repo-root", () => {
      const args = parseWithdrawZkDryRunArgs([
        ...REQUIRED_ARGV,
        "--repo-root",
        "/my/repo",
      ]);
      expect(args.repoRoot).to.equal("/my/repo");
    });

    it("json and allowInRepoArtifacts are undefined when omitted", () => {
      const args = parseWithdrawZkDryRunArgs(REQUIRED_ARGV);
      expect(args.json).to.be.undefined;
      expect(args.allowInRepoArtifacts).to.be.undefined;
    });

    it("rejects missing --program-id", () => {
      expect(() => parseWithdrawZkDryRunArgs([])).to.throw(/--program-id/);
    });

    it("rejects missing --denomination", () => {
      const without: string[] = [];
      for (let i = 0; i < REQUIRED_ARGV.length; i++) {
        if (REQUIRED_ARGV[i] === "--denomination") {
          i++;
        } else {
          without.push(REQUIRED_ARGV[i]);
        }
      }
      expect(() => parseWithdrawZkDryRunArgs(without)).to.throw(
        /--denomination/
      );
    });

    it("rejects unknown flag", () => {
      expect(() =>
        parseWithdrawZkDryRunArgs([...REQUIRED_ARGV, "--unknown"])
      ).to.throw(/unknown flag/);
    });

    it("parses --simulate with --rpc and defaults computeUnitLimit to 200000", () => {
      const args = parseWithdrawZkDryRunArgs([
        ...REQUIRED_ARGV,
        "--simulate",
        "--rpc",
        "https://api.devnet.solana.com",
      ]);
      expect(args.simulate).to.equal(true);
      expect(args.rpc).to.equal("https://api.devnet.solana.com");
      expect(args.computeUnitLimit).to.equal(
        DEFAULT_WITHDRAW_ZK_SIMULATE_CU_LIMIT
      );
    });

    it("parses explicit --compute-unit-limit 250000", () => {
      const args = parseWithdrawZkDryRunArgs([
        ...REQUIRED_ARGV,
        "--simulate",
        "--rpc",
        "https://api.devnet.solana.com",
        "--compute-unit-limit",
        "250000",
      ]);
      expect(args.computeUnitLimit).to.equal(250000);
    });

    it("rejects --simulate without --rpc", () => {
      expect(() =>
        parseWithdrawZkDryRunArgs([...REQUIRED_ARGV, "--simulate"])
      ).to.throw(/--rpc/);
    });

    it("rejects --rpc without --simulate", () => {
      expect(() =>
        parseWithdrawZkDryRunArgs([
          ...REQUIRED_ARGV,
          "--rpc",
          "https://api.devnet.solana.com",
        ])
      ).to.throw(/--simulate/);
    });

    it("rejects --compute-unit-limit without --simulate", () => {
      expect(() =>
        parseWithdrawZkDryRunArgs([
          ...REQUIRED_ARGV,
          "--compute-unit-limit",
          "200000",
        ])
      ).to.throw(/--simulate/);
    });

    it("rejects --send", () => {
      expect(() =>
        parseWithdrawZkDryRunArgs([...REQUIRED_ARGV, "--send"])
      ).to.throw(/--send/);
    });

    it("rejects mainnet RPC", () => {
      expect(() =>
        parseWithdrawZkDryRunArgs([
          ...REQUIRED_ARGV,
          "--simulate",
          "--rpc",
          "https://api.mainnet-beta.solana.com",
        ])
      ).to.throw(/mainnet/);
    });

    it("rejects --compute-unit-limit 0", () => {
      expect(() =>
        parseWithdrawZkDryRunArgs([
          ...REQUIRED_ARGV,
          "--simulate",
          "--rpc",
          "https://api.devnet.solana.com",
          "--compute-unit-limit",
          "0",
        ])
      ).to.throw(/--compute-unit-limit/);
    });

    it("rejects --compute-unit-limit -1", () => {
      expect(() =>
        parseWithdrawZkDryRunArgs([
          ...REQUIRED_ARGV,
          "--simulate",
          "--rpc",
          "https://api.devnet.solana.com",
          "--compute-unit-limit",
          "-1",
        ])
      ).to.throw(/--compute-unit-limit/);
    });

    it("rejects --compute-unit-limit 1.5", () => {
      expect(() =>
        parseWithdrawZkDryRunArgs([
          ...REQUIRED_ARGV,
          "--simulate",
          "--rpc",
          "https://api.devnet.solana.com",
          "--compute-unit-limit",
          "1.5",
        ])
      ).to.throw(/--compute-unit-limit/);
    });

    it("rejects --compute-unit-limit 0x10", () => {
      expect(() =>
        parseWithdrawZkDryRunArgs([
          ...REQUIRED_ARGV,
          "--simulate",
          "--rpc",
          "https://api.devnet.solana.com",
          "--compute-unit-limit",
          "0x10",
        ])
      ).to.throw(/--compute-unit-limit/);
    });

    it("rejects --compute-unit-limit 1400001", () => {
      expect(() =>
        parseWithdrawZkDryRunArgs([
          ...REQUIRED_ARGV,
          "--simulate",
          "--rpc",
          "https://api.devnet.solana.com",
          "--compute-unit-limit",
          "1400001",
        ])
      ).to.throw(/--compute-unit-limit/);
    });

    it("accepts --compute-unit-limit 1400000", () => {
      const args = parseWithdrawZkDryRunArgs([
        ...REQUIRED_ARGV,
        "--simulate",
        "--rpc",
        "https://api.devnet.solana.com",
        "--compute-unit-limit",
        "1400000",
      ]);
      expect(args.computeUnitLimit).to.equal(1400000);
    });

    it("dry-run without --simulate has simulate/rpc/computeUnitLimit all undefined", () => {
      const args = parseWithdrawZkDryRunArgs(REQUIRED_ARGV);
      expect(args.simulate).to.be.undefined;
      expect(args.rpc).to.be.undefined;
      expect(args.computeUnitLimit).to.be.undefined;
    });

    it("parses one --known-operator", () => {
      const args = parseWithdrawZkDryRunArgs([
        ...REQUIRED_ARGV,
        "--known-operator",
        RELAYER,
      ]);
      expect(args.knownOperators).to.deep.equal([RELAYER]);
    });

    it("parses repeated --known-operator into an array", () => {
      const args = parseWithdrawZkDryRunArgs([
        ...REQUIRED_ARGV,
        "--known-operator",
        RELAYER,
        "--known-operator",
        RECIPIENT,
      ]);
      expect(args.knownOperators).to.deep.equal([RELAYER, RECIPIENT]);
    });

    it("rejects invalid --known-operator pubkey", () => {
      expect(() =>
        parseWithdrawZkDryRunArgs([
          ...REQUIRED_ARGV,
          "--known-operator",
          "not-a-valid-pubkey",
        ])
      ).to.throw(/--known-operator/);
    });
  });

  // ── buildWithdrawZkDryRunSummary: happy path ───────────────────────────────

  describe("buildWithdrawZkDryRunSummary: happy path", function () {
    let summary: ReturnType<typeof buildWithdrawZkDryRunSummary>;

    before(() => {
      summary = buildWithdrawZkDryRunSummary(baseArgs(), happyDeps());
    });

    it("returns correct programId", () => {
      expect(summary.programId).to.equal(PROGRAM_ID);
    });

    it("returns correct relayer", () => {
      expect(summary.relayer).to.equal(RELAYER);
    });

    it("returns correct recipient", () => {
      expect(summary.recipient).to.equal(RECIPIENT);
    });

    it("returns poolState as a non-empty base58 string", () => {
      expect(summary.poolState).to.be.a("string").with.length.greaterThan(30);
    });

    it("returns config as a non-empty base58 string", () => {
      expect(summary.config).to.be.a("string").with.length.greaterThan(30);
    });

    it("returns nullifierMarker as a non-empty base58 string", () => {
      expect(summary.nullifierMarker)
        .to.be.a("string")
        .with.length.greaterThan(30);
    });

    it("returns rootBeHex as 64-char lowercase hex", () => {
      expect(/^[0-9a-f]{64}$/.test(summary.rootBeHex)).to.be.true;
    });

    it("returns nullifierHashBeHex as 64-char lowercase hex", () => {
      expect(/^[0-9a-f]{64}$/.test(summary.nullifierHashBeHex)).to.be.true;
    });

    it("returns txHashBeHex as 64-char lowercase hex", () => {
      expect(/^[0-9a-f]{64}$/.test(summary.txHashBeHex)).to.be.true;
    });

    it("instructionDataLength is 360", () => {
      expect(summary.instructionDataLength).to.equal(360);
    });

    it("keyCount is 6", () => {
      expect(summary.keyCount).to.equal(6);
    });

    it("warnings is empty for outside-repo paths", () => {
      expect(summary.warnings).to.deep.equal([]);
    });
  });

  // ── hygiene warnings ───────────────────────────────────────────────────────

  describe("buildWithdrawZkDryRunSummary: hygiene warnings", function () {
    it("emits RECIPIENT_EQUALS_RELAYER when recipient === relayer", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({ recipient: RELAYER }),
        happyDeps()
      );
      expect(
        summary.warnings.some((w) => w.includes("[RECIPIENT_EQUALS_RELAYER]"))
      ).to.be.true;
    });

    it("does not emit RECIPIENT_EQUALS_RELAYER when recipient !== relayer", () => {
      const summary = buildWithdrawZkDryRunSummary(baseArgs(), happyDeps());
      expect(
        summary.warnings.some((w) => w.includes("[RECIPIENT_EQUALS_RELAYER]"))
      ).to.be.false;
    });

    it("does not emit NON_STANDARD_DENOMINATION_BUCKET for 1_000_000_000 lamports", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({ denomination: "1000000000" }),
        happyDeps()
      );
      expect(
        summary.warnings.some((w) =>
          w.includes("[NON_STANDARD_DENOMINATION_BUCKET]")
        )
      ).to.be.false;
    });

    it("emits NON_STANDARD_DENOMINATION_BUCKET for 500_000_000 lamports", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({ denomination: "500000000" }),
        happyDeps({
          [INPUT_PATH]: JSON.stringify({
            denomination: "500000000",
            fee: "10000000",
            expiry_slot: "500000",
            circuit_version: "1",
          }),
        })
      );
      expect(
        summary.warnings.some((w) =>
          w.includes("[NON_STANDARD_DENOMINATION_BUCKET]")
        )
      ).to.be.true;
    });

    it("emits NON_STANDARD_DENOMINATION_BUCKET for 2_000_000_000 lamports", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({ denomination: "2000000000" }),
        happyDeps({
          [INPUT_PATH]: JSON.stringify({
            denomination: "2000000000",
            fee: "10000000",
            expiry_slot: "500000",
            circuit_version: "1",
          }),
        })
      );
      expect(
        summary.warnings.some((w) =>
          w.includes("[NON_STANDARD_DENOMINATION_BUCKET]")
        )
      ).to.be.true;
    });

    it("emits NON_STANDARD_DENOMINATION_BUCKET for 1 lamport", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({ denomination: "1" }),
        happyDeps({
          [INPUT_PATH]: JSON.stringify({
            denomination: "1",
            fee: "10000000",
            expiry_slot: "500000",
            circuit_version: "1",
          }),
        })
      );
      expect(
        summary.warnings.some((w) =>
          w.includes("[NON_STANDARD_DENOMINATION_BUCKET]")
        )
      ).to.be.true;
    });

    it("emits both RECIPIENT_EQUALS_RELAYER and NON_STANDARD_DENOMINATION_BUCKET when both conditions hold", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({ recipient: RELAYER, denomination: "500000000" }),
        happyDeps({
          [INPUT_PATH]: JSON.stringify({
            denomination: "500000000",
            fee: "10000000",
            expiry_slot: "500000",
            circuit_version: "1",
          }),
        })
      );
      expect(
        summary.warnings.some((w) => w.includes("[RECIPIENT_EQUALS_RELAYER]"))
      ).to.be.true;
      expect(
        summary.warnings.some((w) =>
          w.includes("[NON_STANDARD_DENOMINATION_BUCKET]")
        )
      ).to.be.true;
    });

    it("emits RECIPIENT_MATCHES_KNOWN_OPERATOR when recipient matches a known operator", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({ knownOperators: [RECIPIENT] }),
        happyDeps()
      );
      expect(
        summary.warnings.some((w) =>
          w.includes("[RECIPIENT_MATCHES_KNOWN_OPERATOR]")
        )
      ).to.be.true;
    });

    it("emits RELAYER_MATCHES_KNOWN_OPERATOR when relayer matches a known operator", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({ knownOperators: [RELAYER] }),
        happyDeps()
      );
      expect(
        summary.warnings.some((w) =>
          w.includes("[RELAYER_MATCHES_KNOWN_OPERATOR]")
        )
      ).to.be.true;
    });

    it("emits both known-operator warnings when recipient and relayer both match", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({ knownOperators: [RECIPIENT, RELAYER] }),
        happyDeps()
      );
      expect(
        summary.warnings.some((w) =>
          w.includes("[RECIPIENT_MATCHES_KNOWN_OPERATOR]")
        )
      ).to.be.true;
      expect(
        summary.warnings.some((w) =>
          w.includes("[RELAYER_MATCHES_KNOWN_OPERATOR]")
        )
      ).to.be.true;
    });

    it("emits no known-operator warnings when known operator does not match recipient or relayer", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({ knownOperators: [PROGRAM_ID] }),
        happyDeps()
      );
      expect(
        summary.warnings.some((w) =>
          w.includes("[RECIPIENT_MATCHES_KNOWN_OPERATOR]")
        )
      ).to.be.false;
      expect(
        summary.warnings.some((w) =>
          w.includes("[RELAYER_MATCHES_KNOWN_OPERATOR]")
        )
      ).to.be.false;
    });

    it("does not emit duplicate warnings for duplicate known-operator values", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({ knownOperators: [RECIPIENT, RECIPIENT] }),
        happyDeps()
      );
      const count = summary.warnings.filter((w) =>
        w.includes("[RECIPIENT_MATCHES_KNOWN_OPERATOR]")
      ).length;
      expect(count).to.equal(1);
    });

    it("RECIPIENT_EQUALS_RELAYER still fires alongside RECIPIENT_MATCHES_KNOWN_OPERATOR", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({ recipient: RELAYER, knownOperators: [RELAYER] }),
        happyDeps()
      );
      expect(
        summary.warnings.some((w) => w.includes("[RECIPIENT_EQUALS_RELAYER]"))
      ).to.be.true;
      expect(
        summary.warnings.some((w) =>
          w.includes("[RECIPIENT_MATCHES_KNOWN_OPERATOR]")
        )
      ).to.be.true;
    });

    it("happy path without --known-operator has no known-operator warnings", () => {
      const summary = buildWithdrawZkDryRunSummary(baseArgs(), happyDeps());
      expect(
        summary.warnings.some((w) =>
          w.includes("[RECIPIENT_MATCHES_KNOWN_OPERATOR]")
        )
      ).to.be.false;
      expect(
        summary.warnings.some((w) =>
          w.includes("[RELAYER_MATCHES_KNOWN_OPERATOR]")
        )
      ).to.be.false;
    });
  });

  // ── path guard ─────────────────────────────────────────────────────────────

  describe("path guard", function () {
    const IN_REPO_PROOF = "/tmp/fake-repo/proof.json";
    const SAFE_PUBLIC = "/tmp/outside-proofs/my_public.json";
    const SAFE_INPUT = "/tmp/outside-proofs/my_input.json";

    it("throws mentioning --allow-in-repo-artifacts when proof is inside repo and flag is false", () => {
      expect(() =>
        buildWithdrawZkDryRunSummary(
          baseArgs({
            proofJson: IN_REPO_PROOF,
            publicJson: SAFE_PUBLIC,
            inputJson: SAFE_INPUT,
            allowInRepoArtifacts: false,
          }),
          { cwd: () => FAKE_CWD }
        )
      ).to.throw(/--allow-in-repo-artifacts/);
    });

    it("succeeds and includes warnings when --allow-in-repo-artifacts is true", () => {
      const deps = {
        readFileSync: makeReadFileSync({
          [IN_REPO_PROOF]: VALID_PROOF_JSON,
          [SAFE_PUBLIC]: VALID_PUBLIC_JSON,
          [SAFE_INPUT]: VALID_INPUT_JSON,
        }),
        cwd: () => FAKE_CWD,
      };
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({
          proofJson: IN_REPO_PROOF,
          publicJson: SAFE_PUBLIC,
          inputJson: SAFE_INPUT,
          allowInRepoArtifacts: true,
        }),
        deps
      );
      expect(summary.warnings.length).to.be.greaterThan(0);
      expect(summary.instructionDataLength).to.equal(360);
    });
  });

  // ── JSON parse errors ──────────────────────────────────────────────────────

  describe("JSON parse errors", function () {
    it("throws mentioning proof-json on invalid proof JSON", () => {
      const deps = happyDeps({ [PROOF_PATH]: "{ not valid json" });
      expect(() => buildWithdrawZkDryRunSummary(baseArgs(), deps)).to.throw(
        /proof-json/
      );
    });

    it("throws mentioning public-json on invalid public JSON", () => {
      const deps = happyDeps({ [PUBLIC_PATH]: "{ bad" });
      expect(() => buildWithdrawZkDryRunSummary(baseArgs(), deps)).to.throw(
        /public-json/
      );
    });

    it("throws mentioning input-json on invalid input JSON", () => {
      const deps = happyDeps({ [INPUT_PATH]: "{ bad" });
      expect(() => buildWithdrawZkDryRunSummary(baseArgs(), deps)).to.throw(
        /input-json/
      );
    });
  });

  // ── tx_hash mismatch ───────────────────────────────────────────────────────

  describe("tx_hash mismatch", function () {
    it("throws mentioning tx_hash when input.json tx_hash differs from public[2]", () => {
      // VALID_PUBLIC_JSON has tx_hash = decimal "3"; input has "4"
      const deps = happyDeps({
        [INPUT_PATH]: JSON.stringify({ tx_hash: "4" }),
      });
      expect(() => buildWithdrawZkDryRunSummary(baseArgs(), deps)).to.throw(
        /tx_hash/
      );
    });
  });

  // ── scalar mismatch ────────────────────────────────────────────────────────

  describe("scalar mismatch", function () {
    it("throws mentioning denomination when input.json denomination differs from CLI", () => {
      const deps = happyDeps({
        [INPUT_PATH]: JSON.stringify({ denomination: "999999999" }),
      });
      expect(() => buildWithdrawZkDryRunSummary(baseArgs(), deps)).to.throw(
        /denomination/
      );
    });

    it("throws mentioning circuit_version when input.json circuit_version differs from CLI", () => {
      const deps = happyDeps({
        [INPUT_PATH]: JSON.stringify({ circuit_version: "2" }),
      });
      expect(() =>
        buildWithdrawZkDryRunSummary(baseArgs({ circuitVersion: "1" }), deps)
      ).to.throw(/circuit_version/);
    });
  });

  // ── invalid public key ─────────────────────────────────────────────────────

  describe("invalid public key", function () {
    it("throws mentioning program-id on invalid programId", () => {
      expect(() =>
        buildWithdrawZkDryRunSummary(
          baseArgs({ programId: "not-a-pubkey" }),
          happyDeps()
        )
      ).to.throw(/program-id/);
    });

    it("throws mentioning recipient on invalid recipient", () => {
      expect(() =>
        buildWithdrawZkDryRunSummary(
          baseArgs({ recipient: "not-a-pubkey" }),
          happyDeps()
        )
      ).to.throw(/recipient/);
    });

    it("throws mentioning relayer on invalid relayer", () => {
      expect(() =>
        buildWithdrawZkDryRunSummary(
          baseArgs({ relayer: "not-a-pubkey" }),
          happyDeps()
        )
      ).to.throw(/relayer/);
    });
  });

  // ── no RPC ─────────────────────────────────────────────────────────────────

  describe("safety: callable without RPC", function () {
    it("summary builder completes without any network call", () => {
      const summary = buildWithdrawZkDryRunSummary(baseArgs(), happyDeps());
      expect(summary.instructionDataLength).to.equal(360);
      expect(summary.keyCount).to.equal(6);
    });
  });

  // ── simulate args: no-RPC behavior ─────────────────────────────────────────

  describe("simulate args: no-RPC behavior", function () {
    it("buildWithdrawZkDryRunSummary succeeds for normal dry-run args", () => {
      const summary = buildWithdrawZkDryRunSummary(baseArgs(), happyDeps());
      expect(summary.instructionDataLength).to.equal(360);
    });

    it("buildWithdrawZkDryRunSummary succeeds when simulate/rpc/computeUnitLimit are present (no network in this commit)", () => {
      const summary = buildWithdrawZkDryRunSummary(
        baseArgs({
          simulate: true,
          rpc: "https://api.devnet.solana.com",
          computeUnitLimit: 200000,
        }),
        happyDeps()
      );
      expect(summary.instructionDataLength).to.equal(360);
      expect(summary.keyCount).to.equal(6);
    });
  });

  // ── buildWithdrawZkSimulationTransaction ──────────────────────────────────

  describe("buildWithdrawZkSimulationTransaction", function () {
    it("returns a Transaction", () => {
      const tx = buildWithdrawZkSimulationTransaction(validSimInput());
      expect(tx).to.be.instanceOf(Transaction);
    });

    it("sets feePayer to relayer", () => {
      const relayer = new PublicKey(RELAYER);
      const tx = buildWithdrawZkSimulationTransaction({
        ...validSimInput(),
        relayer,
      });
      expect(tx.feePayer?.toBase58()).to.equal(relayer.toBase58());
    });

    it("sets recentBlockhash to the provided blockhash", () => {
      const tx = buildWithdrawZkSimulationTransaction(validSimInput());
      expect(tx.recentBlockhash).to.equal(FAKE_BLOCKHASH);
    });

    it("has exactly 2 instructions", () => {
      const tx = buildWithdrawZkSimulationTransaction(validSimInput());
      expect(tx.instructions).to.have.length(2);
    });

    it("first instruction programId is ComputeBudgetProgram.programId", () => {
      const tx = buildWithdrawZkSimulationTransaction(validSimInput());
      expect(tx.instructions[0].programId.toBase58()).to.equal(
        ComputeBudgetProgram.programId.toBase58()
      );
    });

    it("first instruction encodes the requested compute unit limit", () => {
      const tx = buildWithdrawZkSimulationTransaction({
        ...validSimInput(),
        computeUnitLimit: 250_000,
      });
      const decoded = ComputeBudgetInstruction.decodeSetComputeUnitLimit(
        tx.instructions[0]
      );
      expect(decoded.units).to.equal(250_000);
    });

    it("different computeUnitLimit values produce different instruction 0 data", () => {
      const tx1 = buildWithdrawZkSimulationTransaction({
        ...validSimInput(),
        computeUnitLimit: 200_000,
      });
      const tx2 = buildWithdrawZkSimulationTransaction({
        ...validSimInput(),
        computeUnitLimit: 300_000,
      });
      expect(
        Buffer.from(tx1.instructions[0].data).equals(
          Buffer.from(tx2.instructions[0].data)
        )
      ).to.be.false;
    });

    it("second instruction matches the provided withdrawZkInstruction", () => {
      const ix = fakeWithdrawZkInstruction();
      const tx = buildWithdrawZkSimulationTransaction({
        ...validSimInput(),
        withdrawZkInstruction: ix,
      });
      expect(tx.instructions[1].programId.toBase58()).to.equal(
        ix.programId.toBase58()
      );
      expect(Buffer.from(tx.instructions[1].data).equals(Buffer.from(ix.data)))
        .to.be.true;
    });

    it("has no signatures before signing", () => {
      const tx = buildWithdrawZkSimulationTransaction(validSimInput());
      expect(tx.signatures).to.deep.equal([]);
    });

    it("rejects non-PublicKey relayer", () => {
      expect(() =>
        buildWithdrawZkSimulationTransaction({
          ...validSimInput(),
          relayer: "not-a-pubkey" as unknown as PublicKey,
        })
      ).to.throw(/relayer/);
    });

    it("rejects empty recentBlockhash", () => {
      expect(() =>
        buildWithdrawZkSimulationTransaction({
          ...validSimInput(),
          recentBlockhash: "",
        })
      ).to.throw(/recentBlockhash/);
    });

    it("rejects non-string recentBlockhash", () => {
      expect(() =>
        buildWithdrawZkSimulationTransaction({
          ...validSimInput(),
          recentBlockhash: 123 as unknown as string,
        })
      ).to.throw(/recentBlockhash/);
    });

    it("rejects computeUnitLimit 0", () => {
      expect(() =>
        buildWithdrawZkSimulationTransaction({
          ...validSimInput(),
          computeUnitLimit: 0,
        })
      ).to.throw(/computeUnitLimit/);
    });

    it("rejects computeUnitLimit -1", () => {
      expect(() =>
        buildWithdrawZkSimulationTransaction({
          ...validSimInput(),
          computeUnitLimit: -1,
        })
      ).to.throw(/computeUnitLimit/);
    });

    it("rejects computeUnitLimit 1.5", () => {
      expect(() =>
        buildWithdrawZkSimulationTransaction({
          ...validSimInput(),
          computeUnitLimit: 1.5,
        })
      ).to.throw(/computeUnitLimit/);
    });

    it("rejects computeUnitLimit above MAX_WITHDRAW_ZK_SIMULATE_CU_LIMIT", () => {
      expect(() =>
        buildWithdrawZkSimulationTransaction({
          ...validSimInput(),
          computeUnitLimit: MAX_WITHDRAW_ZK_SIMULATE_CU_LIMIT + 1,
        })
      ).to.throw(/computeUnitLimit/);
    });

    it("accepts computeUnitLimit at MAX_WITHDRAW_ZK_SIMULATE_CU_LIMIT", () => {
      const tx = buildWithdrawZkSimulationTransaction({
        ...validSimInput(),
        computeUnitLimit: MAX_WITHDRAW_ZK_SIMULATE_CU_LIMIT,
      });
      expect(tx.instructions).to.have.length(2);
    });

    it("rejects non-TransactionInstruction withdrawZkInstruction", () => {
      expect(() =>
        buildWithdrawZkSimulationTransaction({
          ...validSimInput(),
          withdrawZkInstruction:
            "not-an-instruction" as unknown as TransactionInstruction,
        })
      ).to.throw(/withdrawZkInstruction/);
    });
  });

  // ── buildWithdrawZkSimulationSummary ──────────────────────────────────────

  describe("buildWithdrawZkSimulationSummary", function () {
    // Guard tests
    it("rejects when simulate is not true", async () => {
      let thrown: unknown;
      try {
        await buildWithdrawZkSimulationSummary(baseArgs(), {
          ...happyDeps(),
          connection: fakeConnection().connection,
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.be.instanceOf(Error);
      expect((thrown as Error).message).to.match(/simulate/);
    });

    it("rejects when rpc is not set", async () => {
      let thrown: unknown;
      try {
        await buildWithdrawZkSimulationSummary(baseArgs({ simulate: true }), {
          ...happyDeps(),
          connection: fakeConnection().connection,
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.be.instanceOf(Error);
      expect((thrown as Error).message).to.match(/rpc/);
    });

    // Happy path
    describe("happy path", function () {
      let summary: WithdrawZkSimulationSummary;
      let calls: ReturnType<typeof fakeConnection>["calls"];

      before(async () => {
        const fc = fakeConnection();
        calls = fc.calls;
        summary = await buildWithdrawZkSimulationSummary(simArgs(), {
          ...happyDeps(),
          connection: fc.connection,
        });
      });

      it("calls getLatestBlockhash exactly once", () => {
        expect(calls.getLatestBlockhash).to.equal(1);
      });

      it("calls simulateTransaction exactly once", () => {
        expect(calls.simulateTransaction).to.equal(1);
      });

      it("simulate === true", () => {
        expect(summary.simulate).to.equal(true);
      });

      it("rpc matches args.rpc", () => {
        expect(summary.rpc).to.equal("https://api.devnet.solana.com");
      });

      it("computeUnitLimit matches", () => {
        expect(summary.computeUnitLimit).to.equal(
          DEFAULT_WITHDRAW_ZK_SIMULATE_CU_LIMIT
        );
      });

      it("recentBlockhash equals fake blockhash", () => {
        expect(summary.recentBlockhash).to.equal(FAKE_BLOCKHASH);
      });

      it("lastValidBlockHeight === 123", () => {
        expect(summary.lastValidBlockHeight).to.equal(123);
      });

      it("simulationOk === true", () => {
        expect(summary.simulationOk).to.equal(true);
      });

      it("simulationError === null", () => {
        expect(summary.simulationError).to.equal(null);
      });

      it("unitsConsumed === 119664", () => {
        expect(summary.unitsConsumed).to.equal(119_664);
      });

      it("logs is a non-empty array", () => {
        expect(summary.logs).to.be.an("array").with.length.greaterThan(0);
      });

      it("instructionDataLength === 360", () => {
        expect(summary.instructionDataLength).to.equal(360);
      });

      it("keyCount === 6", () => {
        expect(summary.keyCount).to.equal(6);
      });
    });

    // Transaction inspection
    describe("transaction passed to simulateTransaction", function () {
      let capturedTx: Transaction;

      before(async () => {
        const fc = fakeConnection();
        await buildWithdrawZkSimulationSummary(simArgs(), {
          ...happyDeps(),
          connection: fc.connection,
        });
        capturedTx = fc.calls.tx!;
      });

      it("feePayer equals relayer", () => {
        expect(capturedTx.feePayer?.toBase58()).to.equal(RELAYER);
      });

      it("recentBlockhash equals fake blockhash", () => {
        expect(capturedTx.recentBlockhash).to.equal(FAKE_BLOCKHASH);
      });

      it("has exactly 2 instructions", () => {
        expect(capturedTx.instructions).to.have.length(2);
      });

      it("instruction[0] programId is ComputeBudgetProgram.programId", () => {
        expect(capturedTx.instructions[0].programId.toBase58()).to.equal(
          ComputeBudgetProgram.programId.toBase58()
        );
      });

      it("instruction[1] data length is 360", () => {
        expect(capturedTx.instructions[1].data.length).to.equal(360);
      });

      it("instruction[1] key count is 6", () => {
        expect(capturedTx.instructions[1].keys).to.have.length(6);
      });
    });

    // Compute unit limit selection
    it("uses default CU limit when computeUnitLimit is undefined in args", async () => {
      const fc = fakeConnection();
      const s = await buildWithdrawZkSimulationSummary(
        baseArgs({ simulate: true, rpc: "https://api.devnet.solana.com" }),
        { ...happyDeps(), connection: fc.connection }
      );
      expect(s.computeUnitLimit).to.equal(
        DEFAULT_WITHDRAW_ZK_SIMULATE_CU_LIMIT
      );
    });

    it("uses explicit CU limit when computeUnitLimit is provided", async () => {
      const fc = fakeConnection();
      const s = await buildWithdrawZkSimulationSummary(
        simArgs({ computeUnitLimit: 250_000 }),
        { ...happyDeps(), connection: fc.connection }
      );
      expect(s.computeUnitLimit).to.equal(250_000);
    });

    // Simulation error: does not throw, preserves error and logs
    describe("simulation error", function () {
      const SIM_ERR = { InstructionError: [1, "Custom"] };
      let summary: WithdrawZkSimulationSummary;

      before(async () => {
        const fc = fakeConnection({
          err: SIM_ERR,
          logs: ["Program log: error path"],
        });
        summary = await buildWithdrawZkSimulationSummary(simArgs(), {
          ...happyDeps(),
          connection: fc.connection,
        });
      });

      it("simulationOk === false", () => {
        expect(summary.simulationOk).to.equal(false);
      });

      it("simulationError deep equals the returned err", () => {
        expect(summary.simulationError).to.deep.equal(SIM_ERR);
      });

      it("logs are preserved", () => {
        expect(summary.logs).to.deep.equal(["Program log: error path"]);
      });
    });

    // Low CU warning
    it("adds low-CU warning when unitsConsumed < 50000", async () => {
      const fc = fakeConnection({ unitsConsumed: 10_000 });
      const s = await buildWithdrawZkSimulationSummary(simArgs(), {
        ...happyDeps(),
        connection: fc.connection,
      });
      const hasWarning = s.warnings.some((w) =>
        /low|mock|verifier|CU/i.test(w)
      );
      expect(hasWarning).to.equal(true);
    });

    // Null logs
    it("logs default to empty array when fake returns logs: null", async () => {
      const fc = fakeConnection({ logs: null });
      const s = await buildWithdrawZkSimulationSummary(simArgs(), {
        ...happyDeps(),
        connection: fc.connection,
      });
      expect(s.logs).to.deep.equal([]);
    });
  });

  // ── runWithdrawZkDevnetCli ─────────────────────────────────────────────────

  describe("runWithdrawZkDevnetCli", function () {
    it("dry-run path: does not call createConnection", async () => {
      const { deps } = makeCli({ throwOnConnect: true });
      const code = await runWithdrawZkDevnetCli(REQUIRED_ARGV, deps);
      expect(code).to.equal(0);
    });

    it("dry-run path: stdout includes dry-run summary header and mode", async () => {
      const { deps, out } = makeCli({ throwOnConnect: true });
      await runWithdrawZkDevnetCli(REQUIRED_ARGV, deps);
      const text = out.join("\n");
      expect(text).to.include("withdraw_zk dry-run summary");
      expect(text).to.include("dry-run — no RPC, simulation, signing, or send");
    });

    it("--simulate: creates connection exactly once with provided rpc", async () => {
      const { deps, connCreated } = makeCli();
      const code = await runWithdrawZkDevnetCli(SIM_ARGV, deps);
      expect(code).to.equal(0);
      expect(connCreated).to.deep.equal(["https://api.devnet.solana.com"]);
    });

    it("--simulate: calls getLatestBlockhash exactly once", async () => {
      const { deps, connCalls } = makeCli();
      await runWithdrawZkDevnetCli(SIM_ARGV, deps);
      expect(connCalls.getLatestBlockhash).to.equal(1);
    });

    it("--simulate: calls simulateTransaction exactly once", async () => {
      const { deps, connCalls } = makeCli();
      await runWithdrawZkDevnetCli(SIM_ARGV, deps);
      expect(connCalls.simulateTransaction).to.equal(1);
    });

    it("--simulate success returns code 0", async () => {
      const { deps } = makeCli();
      const code = await runWithdrawZkDevnetCli(SIM_ARGV, deps);
      expect(code).to.equal(0);
    });

    it("--simulate failure returns code 1 without throwing", async () => {
      const { deps, out } = makeCli({
        connOpts: { err: { InstructionError: [1, "Custom"] } },
      });
      const code = await runWithdrawZkDevnetCli(SIM_ARGV, deps);
      expect(code).to.equal(1);
      const text = out.join("\n");
      expect(text).to.match(/simulationOk.*false|"simulationOk".*false/i);
    });

    it("--simulate --json prints valid JSON with expected fields", async () => {
      const { deps, out } = makeCli();
      const argv = [...SIM_ARGV, "--json"];
      const code = await runWithdrawZkDevnetCli(argv, deps);
      expect(code).to.equal(0);
      const parsed = JSON.parse(out.join(""));
      expect(parsed.simulate).to.equal(true);
      expect(parsed.simulationOk).to.equal(true);
      expect(parsed.rpc).to.equal("https://api.devnet.solana.com");
      expect(parsed.instructionDataLength).to.equal(360);
      expect(parsed.keyCount).to.equal(6);
    });

    it("parser error (--simulate without --rpc) returns code 1 and stderr mentions --rpc", async () => {
      const { deps, err } = makeCli({ throwOnConnect: true });
      const code = await runWithdrawZkDevnetCli(
        [...REQUIRED_ARGV, "--simulate"],
        deps
      );
      expect(code).to.equal(1);
      expect(err.join(" ")).to.match(/--rpc/);
    });

    it("--send returns code 1 and stderr mentions --send", async () => {
      const { deps, err } = makeCli({ throwOnConnect: true });
      const code = await runWithdrawZkDevnetCli(
        [...REQUIRED_ARGV, "--send"],
        deps
      );
      expect(code).to.equal(1);
      expect(err.join(" ")).to.match(/--send/);
    });

    it("human simulation output includes expected fields", async () => {
      const { deps, out } = makeCli();
      await runWithdrawZkDevnetCli(SIM_ARGV, deps);
      const text = out.join("\n");
      expect(text).to.include("withdraw_zk simulation summary");
      expect(text).to.include("devnet simulation — no signing or send");
      expect(text).to.match(/computeUnitLimit/i);
      expect(text).to.match(/unitsConsumed/i);
      expect(text).to.include("no transaction was signed or sent");
    });

    describe("createWithdrawZkSimulationConnection", function () {
      it("returns an object with getLatestBlockhash function", () => {
        const conn = createWithdrawZkSimulationConnection(
          "https://api.devnet.solana.com"
        );
        expect(typeof conn.getLatestBlockhash).to.equal("function");
      });

      it("returns an object with simulateTransaction function", () => {
        const conn = createWithdrawZkSimulationConnection(
          "https://api.devnet.solana.com"
        );
        expect(typeof conn.simulateTransaction).to.equal("function");
      });
    });
  });
});

// ── Send-mode parser ──────────────────────────────────────────────────────────

describe("ops_withdraw_zk_devnet: send-mode parser", function () {
  const SEND_REQUIRED = [
    "--program-id",
    PROGRAM_ID,
    "--relayer",
    SEND_RELAYER,
    "--recipient",
    RECIPIENT,
    "--proof-json",
    PROOF_PATH,
    "--public-json",
    PUBLIC_PATH,
    "--input-json",
    INPUT_PATH,
    "--denomination",
    "1000000000",
    "--fee",
    "10000000",
    "--expiry-slot",
    "500000",
    "--circuit-version",
    "1",
    "--send",
    "--expected-root",
    FAKE_EXPECTED_ROOT,
    "--relayer-keypair",
    SEND_KEYPAIR_PATH,
    "--confirm",
    "SEND WITHDRAW_ZK TO DEVNET",
  ];

  it("--send --rpc https://api.devnet.solana.com is accepted", () => {
    expect(() =>
      parseWithdrawZkDryRunArgs([
        ...SEND_REQUIRED,
        "--rpc",
        "https://api.devnet.solana.com",
      ])
    ).to.not.throw();
  });

  it("--send --rpc devnet moniker is accepted", () => {
    expect(() =>
      parseWithdrawZkDryRunArgs([...SEND_REQUIRED, "--rpc", "devnet"])
    ).to.not.throw();
  });

  it("--send --rpc d moniker is accepted", () => {
    expect(() =>
      parseWithdrawZkDryRunArgs([...SEND_REQUIRED, "--rpc", "d"])
    ).to.not.throw();
  });

  it("--send --rpc custom URL is rejected", () => {
    expect(() =>
      parseWithdrawZkDryRunArgs([
        ...SEND_REQUIRED,
        "--rpc",
        "https://my-rpc.example.com",
      ])
    ).to.throw(/devnet/i);
  });

  it("--send --rpc mainnet URL is rejected", () => {
    expect(() =>
      parseWithdrawZkDryRunArgs([
        ...SEND_REQUIRED,
        "--rpc",
        "https://api.mainnet-beta.solana.com",
      ])
    ).to.throw(/devnet/i);
  });

  it("--simulate --rpc custom URL is still accepted (simulate not restricted)", () => {
    expect(() =>
      parseWithdrawZkDryRunArgs([
        ...REQUIRED_ARGV,
        "--simulate",
        "--rpc",
        "https://my-custom-rpc.example.com",
      ])
    ).to.not.throw();
  });

  it("--simulate --send mutual exclusion error mentions both flags", () => {
    expect(() =>
      parseWithdrawZkDryRunArgs([
        ...SEND_REQUIRED,
        "--rpc",
        "https://api.devnet.solana.com",
        "--simulate",
      ])
    ).to.throw(/--simulate.*--send/);
  });

  it("--compute-unit-limit in dry-run mode error says --simulate or --send", () => {
    expect(() =>
      parseWithdrawZkDryRunArgs([
        ...REQUIRED_ARGV,
        "--compute-unit-limit",
        "200000",
      ])
    ).to.throw(/--simulate or --send/);
  });

  it("--send --compute-unit-limit 250000 is accepted", () => {
    const args = parseWithdrawZkDryRunArgs([
      ...SEND_REQUIRED,
      "--rpc",
      "https://api.devnet.solana.com",
      "--compute-unit-limit",
      "250000",
    ]);
    expect(args.computeUnitLimit).to.equal(250000);
  });
});

// ── Send-mode public input consistency ───────────────────────────────────────

describe("ops_withdraw_zk_devnet: send-mode public input consistency", function () {
  it("input.json with matching root passes", () => {
    const deps = happyDeps({
      [INPUT_PATH]: JSON.stringify({
        denomination: "1000000000",
        fee: "10000000",
        expiry_slot: "500000",
        circuit_version: "1",
        root: "1",
      }),
    });
    expect(() => buildWithdrawZkDryRunSummary(baseArgs(), deps)).to.not.throw();
  });

  it("input.json with mismatching root fails mentioning root", () => {
    const deps = happyDeps({
      [INPUT_PATH]: JSON.stringify({ root: "2" }),
    });
    expect(() => buildWithdrawZkDryRunSummary(baseArgs(), deps)).to.throw(
      /root/
    );
  });

  it("input.json with matching nullifier_hash passes", () => {
    // public.json[1] = "2" (decimal)
    const deps = happyDeps({
      [INPUT_PATH]: JSON.stringify({
        denomination: "1000000000",
        fee: "10000000",
        expiry_slot: "500000",
        circuit_version: "1",
        nullifier_hash: "2",
      }),
    });
    expect(() => buildWithdrawZkDryRunSummary(baseArgs(), deps)).to.not.throw();
  });

  it("input.json with mismatching nullifier_hash fails mentioning nullifier_hash", () => {
    const deps = happyDeps({
      [INPUT_PATH]: JSON.stringify({ nullifier_hash: "99" }),
    });
    expect(() => buildWithdrawZkDryRunSummary(baseArgs(), deps)).to.throw(
      /nullifier_hash/
    );
  });
});

// ── Send-mode guards ──────────────────────────────────────────────────────────

describe("ops_withdraw_zk_devnet: send-mode guards", function () {
  it("invalid proof json fails before reading keypair (reorder validation)", async () => {
    const { deps, err } = makeSendCli({
      filesOverride: {
        [PROOF_PATH]: "{ not json",
        [SEND_KEYPAIR_PATH]: "[1,2,3]",
      },
    });
    const code = await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(code).to.equal(1);
    expect(err.join(" ")).to.match(/proof-json|invalid JSON/i);
  });

  it("299 slots remaining fails (< MIN_SEND_EXPIRY_BUFFER)", async () => {
    const { deps } = makeSendCli({
      connOpts: { getSlotResult: 500000 - 299 },
    });
    const code = await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(code).to.equal(1);
  });

  it("300 slots remaining passes (= MIN_SEND_EXPIRY_BUFFER)", async () => {
    const { deps } = makeSendCli({
      connOpts: { getSlotResult: 500000 - 300 },
    });
    const code = await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(code).to.equal(0);
  });

  it("expiry buffer failure message mentions slot counts", async () => {
    const { deps, err } = makeSendCli({
      connOpts: { getSlotResult: 500000 - 1 },
    });
    await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(err.join(" ")).to.match(/expiry|slot/i);
  });

  it("root not in allowed_roots returns code 1", async () => {
    const { deps } = makeSendCli({
      connOpts: { configRoots: ["deadbeef" + "00".repeat(28)] },
    });
    const code = await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(code).to.equal(1);
  });

  it("nullifier already exists returns code 1", async () => {
    const { deps } = makeSendCli({ connOpts: { nullifierExists: true } });
    const code = await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(code).to.equal(1);
  });

  it("pool lamports < denomination returns code 1", async () => {
    const { deps } = makeSendCli({
      connOpts: { poolLamports: 999_999_999n },
    });
    const code = await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(code).to.equal(1);
  });

  it("pre-send simulation error returns code 1", async () => {
    const { deps } = makeSendCli({
      connOpts: { simErr: { InstructionError: [0, "Custom"] } },
    });
    const code = await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(code).to.equal(1);
  });

  it("sendRawTransaction throws returns code 1", async () => {
    const { deps } = makeSendCli({ connOpts: { throwSend: true } });
    const code = await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(code).to.equal(1);
  });
});

// ── Send-mode blockhash and confirm ──────────────────────────────────────────

describe("ops_withdraw_zk_devnet: send-mode blockhash and confirm", function () {
  it("getLatestBlockhash is called exactly twice on happy path", async () => {
    const { deps, sendCalls } = makeSendCli();
    await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(sendCalls.getLatestBlockhash).to.equal(2);
  });

  it("confirmTransaction is called with the second blockhash", async () => {
    const { deps, sendCalls } = makeSendCli();
    await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(sendCalls.confirmCalledWithBlockhash).to.equal(FAKE_BLOCKHASH_2);
  });

  it("confirmTransaction throws: code 1, signature in stderr, retry warning in stderr", async () => {
    const { deps, err } = makeSendCli({ connOpts: { throwConfirm: true } });
    const code = await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(code).to.equal(1);
    const errText = err.join("\n");
    expect(errText).to.include(FAKE_SEND_SIG);
    expect(errText).to.match(/Do not blindly retry/i);
  });

  it("confirmTransaction on-chain error: code 1, signature in stderr, retry warning in stderr", async () => {
    const { deps, err } = makeSendCli({
      connOpts: {
        confirmResultErr: { InstructionError: [0, "NullifierAlreadyUsed"] },
      },
    });
    const code = await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(code).to.equal(1);
    const errText = err.join("\n");
    expect(errText).to.include(FAKE_SEND_SIG);
    expect(errText).to.match(/Do not blindly retry/i);
  });

  it("happy path returns code 0", async () => {
    const { deps } = makeSendCli();
    const code = await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(code).to.equal(0);
  });
});

// ── Send-mode output ──────────────────────────────────────────────────────────

describe("ops_withdraw_zk_devnet: send-mode output", function () {
  it("non-JSON mode: stdout is empty", async () => {
    const { deps, out } = makeSendCli();
    await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(out).to.deep.equal([]);
  });

  it("human summary goes to stderr", async () => {
    const { deps, err } = makeSendCli();
    await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(err.join("\n")).to.include("LIVE SEND");
  });

  it("signature goes to stderr", async () => {
    const { deps, err } = makeSendCli();
    await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(err.join("\n")).to.include(FAKE_SEND_SIG);
  });

  it("--json stdout is parseable as a single JSON object", async () => {
    const { deps, out } = makeSendCli();
    await runWithdrawZkDevnetCli([...SEND_ARGV, "--json"], deps);
    expect(() => JSON.parse(out.join(""))).to.not.throw();
  });

  it("--json result has mode=send and correct signature", async () => {
    const { deps, out } = makeSendCli();
    await runWithdrawZkDevnetCli([...SEND_ARGV, "--json"], deps);
    const result = JSON.parse(out.join(""));
    expect(result.mode).to.equal("send");
    expect(result.signature).to.equal(FAKE_SEND_SIG);
  });

  it("--json stdout has exactly one entry (no extra lines)", async () => {
    const { deps, out } = makeSendCli();
    await runWithdrawZkDevnetCli([...SEND_ARGV, "--json"], deps);
    expect(out).to.have.length(1);
  });
});

// ── Send-mode transaction structure ──────────────────────────────────────────

describe("ops_withdraw_zk_devnet: send transaction structure", function () {
  let capturedRaw: Buffer;
  let capturedOpts: { skipPreflight: boolean };
  let sendTx: Transaction;

  before(async () => {
    const { deps, sendCalls } = makeSendCli();
    const code = await runWithdrawZkDevnetCli(SEND_ARGV, deps);
    expect(code).to.equal(0);
    capturedRaw = sendCalls.capturedSendRaw!;
    capturedOpts = sendCalls.capturedSendOpts!;
    sendTx = Transaction.from(capturedRaw);
  });

  it("sendRawTransaction is called with skipPreflight: true", () => {
    expect(capturedOpts.skipPreflight).to.equal(true);
  });

  it("send transaction feePayer equals relayer", () => {
    expect(sendTx.feePayer?.toBase58()).to.equal(SEND_RELAYER);
  });

  it("send transaction has exactly 2 instructions", () => {
    expect(sendTx.instructions).to.have.length(2);
  });

  it("send transaction instruction[0] is ComputeBudgetProgram.setComputeUnitLimit", () => {
    expect(sendTx.instructions[0].programId.toBase58()).to.equal(
      ComputeBudgetProgram.programId.toBase58()
    );
    const decoded = ComputeBudgetInstruction.decodeSetComputeUnitLimit(
      sendTx.instructions[0]
    );
    expect(decoded.units).to.equal(DEFAULT_WITHDRAW_ZK_SIMULATE_CU_LIMIT);
  });

  it("send transaction instruction[1] data is 360 bytes", () => {
    expect(sendTx.instructions[1].data.length).to.equal(360);
  });

  it("send transaction instruction[1] has 6 account keys", () => {
    expect(sendTx.instructions[1].keys).to.have.length(6);
  });
});

// ── Static source scans ────────────────────────────────────────────────────────

describe("ops_withdraw_zk_devnet: static source scans", function () {
  it("source does not contain --skip-simulation flag", () => {
    expect(OPS_SCRIPT_SRC).to.not.include("--skip-simulation");
  });

  it("source does not contain --skip-root-check flag", () => {
    expect(OPS_SCRIPT_SRC).to.not.include("--skip-root-check");
  });

  it("source does not contain --skip-nullifier-check flag", () => {
    expect(OPS_SCRIPT_SRC).to.not.include("--skip-nullifier-check");
  });

  it("source does not contain Keypair.generate()", () => {
    expect(OPS_SCRIPT_SRC).to.not.include("Keypair.generate()");
  });
});
