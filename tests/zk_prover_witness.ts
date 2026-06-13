import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  initPoseidon,
  poseidonHash,
  hexToFrBigInt,
  frBigIntToHex32,
} from "../lib/zk_indexer/poseidon";
import {
  TAG_LEAF,
  TAG_NODE,
  TAG_NULLIFIER,
  TAG_TX,
  TAG_TX_INNER,
  CIRCUIT_VERSION,
  TREE_DEPTH,
} from "../lib/zk_indexer/constants";
import {
  splitPubkey,
  computeNoteCommitment,
  computeNullifierHash,
  computePubkeysHash,
  computeTxHash,
  buildWitnessFromSnapshot,
  buildWithdrawSolV1CircomInputJson,
  WitnessJson,
} from "../lib/zk_prover/witness";
import {
  parseArgs,
  runExportWitness,
  CliArgs,
} from "../scripts/zk_prover_export_witness";
import {
  collectWitnessSnapshotHygieneWarnings,
  SMALL_SNAPSHOT_LEAF_COUNT_THRESHOLD,
} from "../lib/zk_hygiene/snapshot";
import { buildSnapshot } from "../lib/zk_indexer/persistence";
import { normalizeNoteDepositedEvent } from "../lib/zk_indexer/event_log";

// ── Test constants ─────────────────────────────────────────────────────────────

// Fake deterministic test values only — no real secrets.
const TEST_SECRET = 12345n;
const TEST_DENOMINATION = 1_000_000_000n;
const TEST_FEE = 10_000_000n;
const TEST_CHAIN_ID = 1n;
const TEST_EXPIRY_SLOT = 500_000n;
const DEPOSITOR = "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe";
const TEST_PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";
const TEST_POOL_PDA = "HcAkT4obzEEaHyevyVvmU7drEtSUg1m4XxF1VTWGoCdm";
const TEST_CONFIG_PDA = "6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu";
const TEST_RECIPIENT = "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o";
const TEST_RELAYER = "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe";

const BASE_PARAMS = {
  programId: TEST_PROGRAM_ID,
  poolPda: TEST_POOL_PDA,
  configPda: TEST_CONFIG_PDA,
  recipient: TEST_RECIPIENT,
  relayer: TEST_RELAYER,
  denomination: TEST_DENOMINATION,
  fee: TEST_FEE,
  chainId: TEST_CHAIN_ID,
  expirySlot: TEST_EXPIRY_SLOT,
};

// frBigIntToHex32 is pure (no poseidon), safe to call at module load time.
const TEST_SECRET_HEX = frBigIntToHex32(TEST_SECRET);

let TEST_COMMITMENT_HEX: string;
let SNAP_PATH: string;
let DUP_SNAP_PATH: string;

function tmpPath(tag: string): string {
  return path.join(
    os.tmpdir(),
    `zk_prover_test_${tag}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}.json`
  );
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

// ── witness library ───────────────────────────────────────────────────────────

describe("zk_prover: witness library", function () {
  this.timeout(60_000);

  before(async () => {
    await initPoseidon();

    // Derive commitment using locked spec formula: Poseidon(TAG_LEAF, secret, denomination)
    TEST_COMMITMENT_HEX = computeNoteCommitment(TEST_SECRET, TEST_DENOMINATION);

    const event0 = normalizeNoteDepositedEvent({
      commitment: TEST_COMMITMENT_HEX,
      denomination: TEST_DENOMINATION.toString(),
      leaf_index: 0,
      depositor: DEPOSITOR,
      slot: "100",
    });
    SNAP_PATH = tmpPath("single");
    fs.writeFileSync(
      SNAP_PATH,
      JSON.stringify(buildSnapshot([event0]), null, 2),
      "utf-8"
    );

    // Duplicate-commitment snapshot: leaf 0 and leaf 1 share the same commitment.
    const event1 = normalizeNoteDepositedEvent({
      commitment: TEST_COMMITMENT_HEX,
      denomination: TEST_DENOMINATION.toString(),
      leaf_index: 1,
      depositor: DEPOSITOR,
      slot: "101",
    });
    DUP_SNAP_PATH = tmpPath("dup");
    fs.writeFileSync(
      DUP_SNAP_PATH,
      JSON.stringify(buildSnapshot([event0, event1]), null, 2),
      "utf-8"
    );
  });

  after(() => {
    cleanup(SNAP_PATH, DUP_SNAP_PATH);
  });

  // 1
  it("constants: TAG_NULLIFIER=1n, TAG_TX=4n, TAG_TX_INNER=5n, CIRCUIT_VERSION=1n, TREE_DEPTH=20", () => {
    expect(TAG_NULLIFIER).to.equal(1n);
    expect(TAG_TX).to.equal(4n);
    expect(TAG_TX_INNER).to.equal(5n);
    expect(CIRCUIT_VERSION).to.equal(1n);
    expect(TREE_DEPTH).to.equal(20);
  });

  // 2
  it("splitPubkey: all-zero 64-char hex gives lo=0n, hi=0n", () => {
    const { lo, hi } = splitPubkey("0".repeat(64));
    expect(lo).to.equal(0n);
    expect(hi).to.equal(0n);
  });

  // 3
  it("splitPubkey: known 32-byte hex pins little-endian lo/hi", () => {
    // bytes[0]=0x01 → lo=1n; bytes[16]=0x02 → hi=2n
    const { lo, hi } = splitPubkey(
      "0100000000000000000000000000000002000000000000000000000000000000"
    );
    expect(lo).to.equal(1n);
    expect(hi).to.equal(2n);

    // bytes[0]=0x01, bytes[1]=0x02 → lo = 1 + 2*256 = 513n
    // bytes[16]=0x03, bytes[17]=0x04 → hi = 3 + 4*256 = 1027n
    const r2 = splitPubkey(
      "0102000000000000000000000000000003040000000000000000000000000000"
    );
    expect(r2.lo).to.equal(513n);
    expect(r2.hi).to.equal(1027n);
  });

  // 4
  it("splitPubkey: accepts valid base58 Solana pubkey (system program = all-zero bytes)", () => {
    const { lo, hi } = splitPubkey("11111111111111111111111111111111");
    expect(lo).to.equal(0n);
    expect(hi).to.equal(0n);
  });

  // 5
  it("computeNullifierHash: deterministic and matches Poseidon(TAG_NULLIFIER, secret)", () => {
    const h1 = computeNullifierHash(TEST_SECRET);
    const h2 = computeNullifierHash(TEST_SECRET);
    expect(h1).to.equal(h2);
    expect(h1).to.match(/^[0-9a-f]{64}$/);
    const expected = frBigIntToHex32(
      poseidonHash([TAG_NULLIFIER, TEST_SECRET])
    );
    expect(h1).to.equal(expected);
  });

  // 6
  it("computeNullifierHash: rejects non-canonical BN254 Fr secret", () => {
    const BN254_P = BigInt(
      "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001"
    );
    expect(() => computeNullifierHash(BN254_P)).to.throw(/canonical/i);
    expect(() => computeNullifierHash(-1n)).to.throw(/canonical/i);
  });

  // 7
  it("computePubkeysHash: returns lowercase 64-char hex and is deterministic", () => {
    const h1 = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    const h2 = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    expect(h1).to.equal(h2);
    expect(h1).to.match(/^[0-9a-f]{64}$/);
  });

  // 8
  it("computeTxHash: returns lowercase 64-char hex and is deterministic", () => {
    const pkh = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    const h1 = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT
    );
    const h2 = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT
    );
    expect(h1).to.equal(h2);
    expect(h1).to.match(/^[0-9a-f]{64}$/);
  });

  // 9
  it("computeTxHash: changing fee changes tx_hash", () => {
    const pkh = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    const h1 = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT
    );
    const h2 = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE + 1n,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT
    );
    expect(h1).to.not.equal(h2);
  });

  // 10
  it("computeTxHash: changing expiry_slot changes tx_hash", () => {
    const pkh = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    const h1 = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT
    );
    const h2 = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT + 1n
    );
    expect(h1).to.not.equal(h2);
  });

  // 11
  it("buildWitnessFromSnapshot: by leaf-index returns path length 20 and public input order [root, nullifier_hash, tx_hash]", () => {
    const { witness, publicInputs } = buildWitnessFromSnapshot(
      SNAP_PATH,
      { leafIndex: 0 },
      TEST_SECRET,
      BASE_PARAMS
    );
    expect(witness.path_elements_be_hex).to.have.length(20);
    expect(witness.path_indices).to.have.length(20);
    expect(publicInputs.public_inputs_order).to.deep.equal([
      "root",
      "nullifier_hash",
      "tx_hash",
    ]);
    expect(publicInputs.root_be_hex).to.equal(witness.root_be_hex);
    expect(publicInputs.nullifier_hash_be_hex).to.equal(
      witness.nullifier_hash_be_hex
    );
    expect(publicInputs.tx_hash_be_hex).to.equal(witness.tx_hash_be_hex);
  });

  // 12
  it("buildWitnessFromSnapshot: by commitment returns same root and leaf_index as by leaf-index", () => {
    const byIndex = buildWitnessFromSnapshot(
      SNAP_PATH,
      { leafIndex: 0 },
      TEST_SECRET,
      BASE_PARAMS
    );
    const byCommitment = buildWitnessFromSnapshot(
      SNAP_PATH,
      { commitmentHex: TEST_COMMITMENT_HEX },
      TEST_SECRET,
      BASE_PARAMS
    );
    expect(byIndex.witness.root_be_hex).to.equal(
      byCommitment.witness.root_be_hex
    );
    expect(byIndex.witness.leaf_index).to.equal(
      byCommitment.witness.leaf_index
    );
  });

  // 13
  it("recompute Merkle root from witness path equals root_be_hex", () => {
    const { witness } = buildWitnessFromSnapshot(
      SNAP_PATH,
      { leafIndex: 0 },
      TEST_SECRET,
      BASE_PARAMS
    );
    let cur = hexToFrBigInt(witness.commitment_be_hex);
    for (let i = 0; i < witness.path_elements_be_hex.length; i++) {
      const sib = hexToFrBigInt(witness.path_elements_be_hex[i]);
      if (witness.path_indices[i] === 0) {
        cur = poseidonHash([TAG_NODE, cur, sib]);
      } else {
        cur = poseidonHash([TAG_NODE, sib, cur]);
      }
    }
    expect(frBigIntToHex32(cur)).to.equal(witness.root_be_hex);
  });

  // 14
  it("wrong secret throws commitment mismatch", () => {
    expect(() =>
      buildWitnessFromSnapshot(
        SNAP_PATH,
        { leafIndex: 0 },
        TEST_SECRET + 1n,
        BASE_PARAMS
      )
    ).to.throw(/commitment/i);
  });

  // 15
  it("wrong denomination throws commitment mismatch", () => {
    expect(() =>
      buildWitnessFromSnapshot(SNAP_PATH, { leafIndex: 0 }, TEST_SECRET, {
        ...BASE_PARAMS,
        denomination: TEST_DENOMINATION + 1n,
      })
    ).to.throw(/commitment/i);
  });

  // 16
  it("duplicate commitment: leaf-index selects specific occurrence; commitment selector uses first and emits warning", () => {
    const byIndex0 = buildWitnessFromSnapshot(
      DUP_SNAP_PATH,
      { leafIndex: 0 },
      TEST_SECRET,
      BASE_PARAMS
    );
    const byIndex1 = buildWitnessFromSnapshot(
      DUP_SNAP_PATH,
      { leafIndex: 1 },
      TEST_SECRET,
      BASE_PARAMS
    );
    expect(byIndex0.witness.leaf_index).to.equal(0);
    expect(byIndex1.witness.leaf_index).to.equal(1);
    // path_indices[0] differs: leaf 0 is left child (0), leaf 1 is right child (1)
    expect(byIndex0.witness.path_indices[0]).to.equal(0);
    expect(byIndex1.witness.path_indices[0]).to.equal(1);

    const byCommitment = buildWitnessFromSnapshot(
      DUP_SNAP_PATH,
      { commitmentHex: TEST_COMMITMENT_HEX },
      TEST_SECRET,
      BASE_PARAMS
    );
    expect(byCommitment.witness.leaf_index).to.equal(0);
    expect(byCommitment.warnings.length).to.be.greaterThan(0);
    expect(byCommitment.warnings[0]).to.include("leaf indices");
  });
});

// ── CLI runExportWitness ──────────────────────────────────────────────────────

describe("zk_prover: CLI runExportWitness", function () {
  this.timeout(60_000);

  let cliSnapPath: string;
  let cliCommitment: string;

  before(async () => {
    await initPoseidon();
    cliCommitment = computeNoteCommitment(TEST_SECRET, TEST_DENOMINATION);
    const event = normalizeNoteDepositedEvent({
      commitment: cliCommitment,
      denomination: TEST_DENOMINATION.toString(),
      leaf_index: 0,
      depositor: DEPOSITOR,
      slot: "200",
    });
    cliSnapPath = tmpPath("cli");
    fs.writeFileSync(
      cliSnapPath,
      JSON.stringify(buildSnapshot([event]), null, 2),
      "utf-8"
    );
  });

  after(() => {
    cleanup(cliSnapPath);
  });

  function baseArgs(overrides: Partial<CliArgs> = {}): CliArgs {
    return {
      snapshotPath: cliSnapPath,
      leafIndex: 0,
      commitmentHex: undefined,
      secret: TEST_SECRET,
      denomination: TEST_DENOMINATION,
      fee: TEST_FEE,
      chainId: TEST_CHAIN_ID,
      expirySlot: TEST_EXPIRY_SLOT,
      programId: TEST_PROGRAM_ID,
      poolPda: TEST_POOL_PDA,
      configPda: TEST_CONFIG_PDA,
      recipient: TEST_RECIPIENT,
      relayer: TEST_RELAYER,
      witnessOutput: undefined,
      publicOutput: undefined,
      dryRun: false,
      yes: false,
      ...overrides,
    };
  }

  // 17
  it("dry-run writes no files", async () => {
    const written: string[] = [];
    await runExportWitness(baseArgs({ dryRun: true }), {
      writeFile: (p) => written.push(p),
      log: () => {},
      warn: () => {},
    });
    expect(written).to.be.empty;
  });

  it("dry-run output does not contain raw secret", async () => {
    const lines: string[] = [];
    await runExportWitness(baseArgs({ dryRun: true }), {
      writeFile: () => {},
      log: (msg) => lines.push(msg),
      warn: () => {},
    });
    const output = lines.join("\n");
    expect(output).to.not.include(TEST_SECRET_HEX);
    // Also check the decimal representation
    expect(output).to.not.include(`"${TEST_SECRET.toString()}"`);
  });

  it("dry-run output does not contain secret when loaded via --secret-file", async () => {
    const secretFilePath = path.join(
      os.tmpdir(),
      `zk_cli_sf_${Date.now()}_${Math.random().toString(36).slice(2)}.hex`
    );
    fs.writeFileSync(secretFilePath, TEST_SECRET_HEX, "utf-8");
    try {
      const argv = [
        "--snapshot",
        cliSnapPath,
        "--leaf-index",
        "0",
        "--secret-file",
        secretFilePath,
        "--denomination",
        TEST_DENOMINATION.toString(),
        "--fee",
        TEST_FEE.toString(),
        "--expiry-slot",
        TEST_EXPIRY_SLOT.toString(),
        "--program-id",
        TEST_PROGRAM_ID,
        "--pool-pda",
        TEST_POOL_PDA,
        "--config-pda",
        TEST_CONFIG_PDA,
        "--recipient",
        TEST_RECIPIENT,
        "--relayer",
        TEST_RELAYER,
        "--dry-run",
      ];
      const parsedArgs = parseArgs(argv);
      const lines: string[] = [];
      await runExportWitness(parsedArgs, {
        writeFile: () => {},
        log: (msg) => lines.push(msg),
        warn: () => {},
      });
      const output = lines.join("\n");
      expect(output).to.not.include(TEST_SECRET_HEX);
      expect(output).to.not.include(`"${TEST_SECRET.toString()}"`);
    } finally {
      try {
        fs.unlinkSync(secretFilePath);
      } catch {}
    }
  });

  // 18
  it("write mode without --yes rejects with message referencing --yes", async () => {
    let threw = false;
    try {
      await runExportWitness(baseArgs({ dryRun: false, yes: false }), {
        writeFile: () => {},
        log: () => {},
        warn: () => {},
      });
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.match(/--yes/i);
    }
    expect(threw, "expected throw").to.be.true;
  });

  // 19
  it("write mode with --yes writes both witness and public output files", async () => {
    const written = new Map<string, string>();
    await runExportWitness(
      baseArgs({
        dryRun: false,
        yes: true,
        witnessOutput: "/tmp/zk_w_test.json",
        publicOutput: "/tmp/zk_p_test.json",
      }),
      {
        writeFile: (p, content) => written.set(p, content),
        log: () => {},
        warn: () => {},
      }
    );
    expect(written.has("/tmp/zk_w_test.json")).to.be.true;
    expect(written.has("/tmp/zk_p_test.json")).to.be.true;
  });

  it("witness output does not contain raw secret field", async () => {
    const written = new Map<string, string>();
    await runExportWitness(
      baseArgs({
        dryRun: false,
        yes: true,
        witnessOutput: "/tmp/zk_w_sec.json",
        publicOutput: "/tmp/zk_p_sec.json",
      }),
      {
        writeFile: (p, content) => written.set(p, content),
        log: () => {},
        warn: () => {},
      }
    );
    const witnessJson = written.get("/tmp/zk_w_sec.json")!;
    expect(witnessJson).to.not.include(TEST_SECRET_HEX);
    const parsed = JSON.parse(witnessJson);
    expect(parsed).to.not.have.property("secret");
  });

  // 20
  it("public output does not contain raw secret and pins public_inputs_order", async () => {
    const written = new Map<string, string>();
    await runExportWitness(
      baseArgs({
        dryRun: false,
        yes: true,
        witnessOutput: "/tmp/zk_w_pub.json",
        publicOutput: "/tmp/zk_p_pub.json",
      }),
      {
        writeFile: (p, content) => written.set(p, content),
        log: () => {},
        warn: () => {},
      }
    );
    const pubJson = written.get("/tmp/zk_p_pub.json")!;
    expect(pubJson).to.not.include(TEST_SECRET_HEX);
    const parsed = JSON.parse(pubJson);
    expect(parsed).to.not.have.property("secret");
    expect(parsed.public_inputs_order).to.deep.equal([
      "root",
      "nullifier_hash",
      "tx_hash",
    ]);
  });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("zk_prover: parseArgs", function () {
  // BN254 Fr modulus as 64-char hex — not a valid Fr element (≥ p).
  const BN254_P_HEX =
    "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";

  // Minimal valid argv that exercises the dry-run path with leaf-index.
  function validArgv(overrides: string[] = []): string[] {
    return [
      "--snapshot",
      "/tmp/snap.json",
      "--leaf-index",
      "0",
      "--secret",
      TEST_SECRET_HEX,
      "--denomination",
      TEST_DENOMINATION.toString(),
      "--fee",
      TEST_FEE.toString(),
      "--expiry-slot",
      TEST_EXPIRY_SLOT.toString(),
      "--program-id",
      TEST_PROGRAM_ID,
      "--pool-pda",
      TEST_POOL_PDA,
      "--config-pda",
      TEST_CONFIG_PDA,
      "--recipient",
      TEST_RECIPIENT,
      "--relayer",
      TEST_RELAYER,
      "--dry-run",
      ...overrides,
    ];
  }

  it("parses valid dry-run argv and returns correct CliArgs", () => {
    const args = parseArgs(validArgv());
    expect(args.snapshotPath).to.equal("/tmp/snap.json");
    expect(args.leafIndex).to.equal(0);
    expect(args.commitmentHex).to.be.undefined;
    expect(args.secret).to.equal(TEST_SECRET);
    expect(args.denomination).to.equal(TEST_DENOMINATION);
    expect(args.fee).to.equal(TEST_FEE);
    expect(args.chainId).to.equal(1n);
    expect(args.expirySlot).to.equal(TEST_EXPIRY_SLOT);
    expect(args.dryRun).to.be.true;
    expect(args.yes).to.be.false;
  });

  it("stores secret as bigint, not as the original hex string", () => {
    const args = parseArgs(validArgv());
    // secret field must be a bigint — not a string containing the hex
    expect(typeof args.secret).to.equal("bigint");
  });

  it("defaults --chain-id to 1n when not provided", () => {
    const args = parseArgs(validArgv());
    expect(args.chainId).to.equal(1n);
  });

  it("parses explicit --chain-id", () => {
    const args = parseArgs(validArgv(["--chain-id", "42"]));
    expect(args.chainId).to.equal(42n);
  });

  it("parses --commitment selector and sets commitmentHex", () => {
    const argv = validArgv()
      .filter((v) => v !== "--leaf-index" && v !== "0")
      .concat(["--commitment", TEST_COMMITMENT_HEX]);
    const args = parseArgs(argv);
    expect(args.commitmentHex).to.equal(TEST_COMMITMENT_HEX);
    expect(args.leafIndex).to.be.undefined;
  });

  it("rejects missing --snapshot", () => {
    const argv = validArgv().filter(
      (v) => v !== "--snapshot" && v !== "/tmp/snap.json"
    );
    expect(() => parseArgs(argv)).to.throw(/snapshot/i);
  });

  it("rejects missing --secret", () => {
    const argv = validArgv().filter(
      (v) => v !== "--secret" && v !== TEST_SECRET_HEX
    );
    expect(() => parseArgs(argv)).to.throw(/secret/i);
  });

  it("rejects --secret that is not 64-char hex", () => {
    const argv = validArgv().map((v) =>
      v === TEST_SECRET_HEX ? "not-a-hex-string" : v
    );
    expect(() => parseArgs(argv)).to.throw(/secret/i);
  });

  it("rejects non-canonical --secret (≥ BN254 Fr modulus)", () => {
    const argv = validArgv().map((v) =>
      v === TEST_SECRET_HEX ? BN254_P_HEX : v
    );
    expect(() => parseArgs(argv)).to.throw(/canonical/i);
  });

  it("rejects both --leaf-index and --commitment", () => {
    const argv = validArgv(["--commitment", TEST_COMMITMENT_HEX]);
    expect(() => parseArgs(argv)).to.throw(/mutually exclusive/i);
  });

  it("rejects neither --leaf-index nor --commitment", () => {
    const argv = validArgv().filter((v) => v !== "--leaf-index" && v !== "0");
    expect(() => parseArgs(argv)).to.throw(/leaf-index|commitment/i);
  });

  it("rejects --dry-run and --yes together", () => {
    const argv = validArgv(["--yes"]);
    expect(() => parseArgs(argv)).to.throw(/mutually exclusive/i);
  });

  it("rejects --yes without --witness-output", () => {
    const argv = validArgv()
      .filter((v) => v !== "--dry-run")
      .concat(["--yes", "--public-output", "/tmp/p.json"]);
    expect(() => parseArgs(argv)).to.throw(/witness-output/i);
  });

  it("rejects --yes without --public-output", () => {
    const argv = validArgv()
      .filter((v) => v !== "--dry-run")
      .concat(["--yes", "--witness-output", "/tmp/w.json"]);
    expect(() => parseArgs(argv)).to.throw(/public-output/i);
  });

  it("parses --yes write mode with both output paths", () => {
    const argv = validArgv()
      .filter((v) => v !== "--dry-run")
      .concat([
        "--yes",
        "--witness-output",
        "/tmp/w.json",
        "--public-output",
        "/tmp/p.json",
      ]);
    const args = parseArgs(argv);
    expect(args.yes).to.be.true;
    expect(args.dryRun).to.be.false;
    expect(args.witnessOutput).to.equal("/tmp/w.json");
    expect(args.publicOutput).to.equal("/tmp/p.json");
  });

  it("parses --circuit-input-output and sets circuitInputOutput", () => {
    const argv = validArgv(["--circuit-input-output", "/tmp/input.json"]);
    const args = parseArgs(argv);
    expect(args.circuitInputOutput).to.equal("/tmp/input.json");
  });

  it("circuitInputOutput is undefined when --circuit-input-output is not provided", () => {
    const args = parseArgs(validArgv());
    expect(args.circuitInputOutput).to.be.undefined;
  });
});

// ── parseArgs --secret-file ───────────────────────────────────────────────────

describe("zk_prover: parseArgs --secret-file", function () {
  const tmpPaths: string[] = [];

  function tmpSecretFile(tag: string, content: string): string {
    const p = path.join(
      os.tmpdir(),
      `zk_secret_test_${tag}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}.hex`
    );
    fs.writeFileSync(p, content, "utf-8");
    tmpPaths.push(p);
    return p;
  }

  after(() => {
    for (const p of tmpPaths) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  });

  function baseArgvWithSecretFile(filePath: string): string[] {
    return [
      "--snapshot",
      "/tmp/snap.json",
      "--leaf-index",
      "0",
      "--secret-file",
      filePath,
      "--denomination",
      TEST_DENOMINATION.toString(),
      "--fee",
      TEST_FEE.toString(),
      "--expiry-slot",
      TEST_EXPIRY_SLOT.toString(),
      "--program-id",
      TEST_PROGRAM_ID,
      "--pool-pda",
      TEST_POOL_PDA,
      "--config-pda",
      TEST_CONFIG_PDA,
      "--recipient",
      TEST_RECIPIENT,
      "--relayer",
      TEST_RELAYER,
      "--dry-run",
    ];
  }

  it("--secret-file happy path: reads 64-char hex and returns correct bigint", () => {
    const p = tmpSecretFile("happy", TEST_SECRET_HEX);
    const args = parseArgs(baseArgvWithSecretFile(p));
    expect(args.secret).to.equal(TEST_SECRET);
    expect(typeof args.secret).to.equal("bigint");
  });

  it("--secret-file with trailing newline: trims and parses correctly", () => {
    const p = tmpSecretFile("newline", TEST_SECRET_HEX + "\n");
    const args = parseArgs(baseArgvWithSecretFile(p));
    expect(args.secret).to.equal(TEST_SECRET);
  });

  it("--secret-file with trailing \\r\\n: trims and parses correctly", () => {
    const p = tmpSecretFile("crlf", TEST_SECRET_HEX + "\r\n");
    const args = parseArgs(baseArgvWithSecretFile(p));
    expect(args.secret).to.equal(TEST_SECRET);
  });

  it("--secret-file missing file: throws with clear error referencing secret-file", () => {
    const missing =
      "/tmp/this_file_does_not_exist_zk_test_" + Date.now() + ".hex";
    expect(() => parseArgs(baseArgvWithSecretFile(missing))).to.throw(
      /secret-file/i
    );
  });

  it("--secret-file empty file: throws referencing empty", () => {
    const p = tmpSecretFile("empty", "");
    expect(() => parseArgs(baseArgvWithSecretFile(p))).to.throw(/empty/i);
  });

  it("--secret-file non-hex content (64 non-hex chars): throws with clear error", () => {
    const p = tmpSecretFile("nonhex", "z".repeat(64));
    expect(() => parseArgs(baseArgvWithSecretFile(p))).to.throw(/secret-file/i);
  });

  it("--secret-file wrong length (too short, 32 chars): throws with clear error", () => {
    const p = tmpSecretFile("short", TEST_SECRET_HEX.slice(0, 32));
    expect(() => parseArgs(baseArgvWithSecretFile(p))).to.throw(/secret-file/i);
  });

  it("--secret-file wrong length (too long, 66 chars): throws with clear error", () => {
    const p = tmpSecretFile("long", TEST_SECRET_HEX + "00");
    expect(() => parseArgs(baseArgvWithSecretFile(p))).to.throw(/secret-file/i);
  });

  it("--secret and --secret-file together: throws mutually exclusive error", () => {
    const p = tmpSecretFile("both", TEST_SECRET_HEX);
    const argv = [
      "--snapshot",
      "/tmp/snap.json",
      "--leaf-index",
      "0",
      "--secret",
      TEST_SECRET_HEX,
      "--secret-file",
      p,
      "--denomination",
      TEST_DENOMINATION.toString(),
      "--fee",
      TEST_FEE.toString(),
      "--expiry-slot",
      TEST_EXPIRY_SLOT.toString(),
      "--program-id",
      TEST_PROGRAM_ID,
      "--pool-pda",
      TEST_POOL_PDA,
      "--config-pda",
      TEST_CONFIG_PDA,
      "--recipient",
      TEST_RECIPIENT,
      "--relayer",
      TEST_RELAYER,
      "--dry-run",
    ];
    expect(() => parseArgs(argv)).to.throw(/mutually exclusive/i);
  });

  it("neither --secret nor --secret-file: throws error referencing secret", () => {
    const argv = [
      "--snapshot",
      "/tmp/snap.json",
      "--leaf-index",
      "0",
      "--denomination",
      TEST_DENOMINATION.toString(),
      "--fee",
      TEST_FEE.toString(),
      "--expiry-slot",
      TEST_EXPIRY_SLOT.toString(),
      "--program-id",
      TEST_PROGRAM_ID,
      "--pool-pda",
      TEST_POOL_PDA,
      "--config-pda",
      TEST_CONFIG_PDA,
      "--recipient",
      TEST_RECIPIENT,
      "--relayer",
      TEST_RELAYER,
      "--dry-run",
    ];
    expect(() => parseArgs(argv)).to.throw(/secret/i);
  });

  it("existing --secret path still works after refactor", () => {
    const argv = [
      "--snapshot",
      "/tmp/snap.json",
      "--leaf-index",
      "0",
      "--secret",
      TEST_SECRET_HEX,
      "--denomination",
      TEST_DENOMINATION.toString(),
      "--fee",
      TEST_FEE.toString(),
      "--expiry-slot",
      TEST_EXPIRY_SLOT.toString(),
      "--program-id",
      TEST_PROGRAM_ID,
      "--pool-pda",
      TEST_POOL_PDA,
      "--config-pda",
      TEST_CONFIG_PDA,
      "--recipient",
      TEST_RECIPIENT,
      "--relayer",
      TEST_RELAYER,
      "--dry-run",
    ];
    const args = parseArgs(argv);
    expect(args.secret).to.equal(TEST_SECRET);
    expect(typeof args.secret).to.equal("bigint");
  });
});

// ── buildWithdrawSolV1CircomInputJson ─────────────────────────────────────────

describe("zk_prover: buildWithdrawSolV1CircomInputJson", function () {
  this.timeout(60_000);

  const BN254_P = BigInt(
    "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001"
  );

  const CIRCOM_ACCOUNTS = {
    programId: TEST_PROGRAM_ID,
    poolPda: TEST_POOL_PDA,
    configPda: TEST_CONFIG_PDA,
    recipient: TEST_RECIPIENT,
    relayer: TEST_RELAYER,
  };

  let circomSnapPath: string;
  let baseWitness: WitnessJson;

  before(async () => {
    await initPoseidon();
    const commitment = computeNoteCommitment(TEST_SECRET, TEST_DENOMINATION);
    const event = normalizeNoteDepositedEvent({
      commitment,
      denomination: TEST_DENOMINATION.toString(),
      leaf_index: 0,
      depositor: DEPOSITOR,
      slot: "300",
    });
    circomSnapPath = tmpPath("circom");
    fs.writeFileSync(
      circomSnapPath,
      JSON.stringify(buildSnapshot([event]), null, 2),
      "utf-8"
    );
    baseWitness = buildWitnessFromSnapshot(
      circomSnapPath,
      { leafIndex: 0 },
      TEST_SECRET,
      BASE_PARAMS
    ).witness;
  });

  after(() => {
    cleanup(circomSnapPath);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("shape: sorted keys exactly match the 21 WITHDRAW_SOL_V1 signal names", () => {
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    const expected = [
      "chain_id",
      "circuit_version",
      "config_pda_hi",
      "config_pda_lo",
      "denomination",
      "expiry_slot",
      "fee",
      "nullifier_hash",
      "path_elements",
      "path_indices",
      "pool_pda_hi",
      "pool_pda_lo",
      "program_id_hi",
      "program_id_lo",
      "recipient_hi",
      "recipient_lo",
      "relayer_hi",
      "relayer_lo",
      "root",
      "secret",
      "tx_hash",
    ];
    expect(Object.keys(input).sort()).to.deep.equal(expected);
    expect(Object.keys(input)).to.have.length(21);
  });

  it("path_elements has length 20 and path_indices has length 20", () => {
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    expect(input.path_elements).to.have.length(20);
    expect(input.path_indices).to.have.length(20);
  });

  it("path_indices values are all '0' or '1'", () => {
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    for (const v of input.path_indices) {
      expect(v).to.be.oneOf(["0", "1"]);
    }
  });

  it("all scalar and array-element values are strict decimal strings", () => {
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
    const scalars = [
      "root",
      "nullifier_hash",
      "tx_hash",
      "secret",
      "denomination",
      "program_id_lo",
      "program_id_hi",
      "pool_pda_lo",
      "pool_pda_hi",
      "config_pda_lo",
      "config_pda_hi",
      "recipient_lo",
      "recipient_hi",
      "relayer_lo",
      "relayer_hi",
      "fee",
      "chain_id",
      "expiry_slot",
      "circuit_version",
    ] as const;
    for (const k of scalars) {
      expect(input[k], k).to.match(DECIMAL_RE);
    }
    for (let i = 0; i < input.path_elements.length; i++) {
      expect(input.path_elements[i], `path_elements[${i}]`).to.match(
        DECIMAL_RE
      );
    }
  });

  it("circuit_version is '1'", () => {
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    expect(input.circuit_version).to.equal("1");
  });

  it("secret field equals TEST_SECRET as decimal string", () => {
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    expect(input.secret).to.equal(TEST_SECRET.toString());
    expect(typeof input.secret).to.equal("string");
  });

  it("denomination, fee, chain_id, expiry_slot match BASE_PARAMS", () => {
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    expect(input.denomination).to.equal(TEST_DENOMINATION.toString());
    expect(input.fee).to.equal(TEST_FEE.toString());
    expect(input.chain_id).to.equal(TEST_CHAIN_ID.toString());
    expect(input.expiry_slot).to.equal(TEST_EXPIRY_SLOT.toString());
  });

  it("tx_hash parity: decimal round-trips to the locked parity vector hex", () => {
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    const hex = BigInt(input.tx_hash).toString(16).padStart(64, "0");
    expect(hex).to.equal(
      "17115e272898a4cca8177791e2e99f51b2e01e7bc2d1381164217f6ef931bcac"
    );
  });

  it("pubkey lo/hi: program_id split matches splitPubkey", () => {
    const { lo, hi } = splitPubkey(TEST_PROGRAM_ID);
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    expect(input.program_id_lo).to.equal(lo.toString());
    expect(input.program_id_hi).to.equal(hi.toString());
  });

  it("pubkey lo/hi: all five accounts split correctly", () => {
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    for (const [key, pubkey] of [
      ["program_id", TEST_PROGRAM_ID],
      ["pool_pda", TEST_POOL_PDA],
      ["config_pda", TEST_CONFIG_PDA],
      ["recipient", TEST_RECIPIENT],
      ["relayer", TEST_RELAYER],
    ] as [string, string][]) {
      const { lo, hi } = splitPubkey(pubkey);
      const rec = input as unknown as Record<string, string>;
      expect(rec[`${key}_lo`], `${key}_lo`).to.equal(lo.toString());
      expect(rec[`${key}_hi`], `${key}_hi`).to.equal(hi.toString());
    }
  });

  it("root decimal round-trips to witness.root_be_hex", () => {
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    const roundTrip = BigInt(input.root).toString(16).padStart(64, "0");
    expect(roundTrip).to.equal(baseWitness.root_be_hex);
  });

  it("nullifier_hash decimal round-trips to witness.nullifier_hash_be_hex", () => {
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    const roundTrip = BigInt(input.nullifier_hash)
      .toString(16)
      .padStart(64, "0");
    expect(roundTrip).to.equal(baseWitness.nullifier_hash_be_hex);
  });

  it("path_elements decimal values round-trip to path_elements_be_hex", () => {
    const input = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    for (let i = 0; i < 20; i++) {
      const roundTrip = BigInt(input.path_elements[i])
        .toString(16)
        .padStart(64, "0");
      expect(roundTrip, `path_elements[${i}]`).to.equal(
        baseWitness.path_elements_be_hex[i]
      );
    }
  });

  it("is deterministic: two calls with same inputs produce identical output", () => {
    const a = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    const b = buildWithdrawSolV1CircomInputJson(
      baseWitness,
      TEST_SECRET,
      CIRCOM_ACCOUNTS
    );
    expect(JSON.stringify(a)).to.equal(JSON.stringify(b));
  });

  // ── Validation rejection tests ────────────────────────────────────────────

  it("rejects negative secret", () => {
    expect(() =>
      buildWithdrawSolV1CircomInputJson(baseWitness, -1n, CIRCOM_ACCOUNTS)
    ).to.throw(/canonical/i);
  });

  it("rejects non-canonical secret (>= BN254 Fr modulus)", () => {
    expect(() =>
      buildWithdrawSolV1CircomInputJson(baseWitness, BN254_P, CIRCOM_ACCOUNTS)
    ).to.throw(/canonical/i);
  });

  it("rejects path_indices value other than 0 or 1", () => {
    const badIndices = [...baseWitness.path_indices];
    badIndices[5] = 2;
    const badWitness: WitnessJson = {
      ...baseWitness,
      path_indices: badIndices,
    };
    expect(() =>
      buildWithdrawSolV1CircomInputJson(
        badWitness,
        TEST_SECRET,
        CIRCOM_ACCOUNTS
      )
    ).to.throw(/path_indices\[5\]/i);
  });

  it("rejects malformed root hex (not 64-char)", () => {
    const badWitness: WitnessJson = {
      ...baseWitness,
      root_be_hex: baseWitness.root_be_hex.slice(0, 32),
    };
    expect(() =>
      buildWithdrawSolV1CircomInputJson(
        badWitness,
        TEST_SECRET,
        CIRCOM_ACCOUNTS
      )
    ).to.throw(/64-char/i);
  });

  it("rejects malformed path_elements_be_hex entry (non-hex chars)", () => {
    const badElements = [...baseWitness.path_elements_be_hex];
    badElements[3] = "z".repeat(64);
    const badWitness: WitnessJson = {
      ...baseWitness,
      path_elements_be_hex: badElements,
    };
    expect(() =>
      buildWithdrawSolV1CircomInputJson(
        badWitness,
        TEST_SECRET,
        CIRCOM_ACCOUNTS
      )
    ).to.throw(/path_elements_be_hex\[3\]/i);
  });

  it("rejects tampered commitment_be_hex (commitment mismatch)", () => {
    const badWitness: WitnessJson = {
      ...baseWitness,
      commitment_be_hex: "1".repeat(64),
    };
    expect(() =>
      buildWithdrawSolV1CircomInputJson(
        badWitness,
        TEST_SECRET,
        CIRCOM_ACCOUNTS
      )
    ).to.throw(/commitment/i);
  });

  it("rejects denomination with hex prefix ('0x10')", () => {
    const badWitness: WitnessJson = {
      ...baseWitness,
      denomination: "0x10",
    };
    expect(() =>
      buildWithdrawSolV1CircomInputJson(
        badWitness,
        TEST_SECRET,
        CIRCOM_ACCOUNTS
      )
    ).to.throw(/decimal/i);
  });

  it("rejects fee with negative sign ('-1')", () => {
    const badWitness: WitnessJson = {
      ...baseWitness,
      fee: "-1",
    };
    expect(() =>
      buildWithdrawSolV1CircomInputJson(
        badWitness,
        TEST_SECRET,
        CIRCOM_ACCOUNTS
      )
    ).to.throw(/decimal/i);
  });

  it("rejects circuit_version with leading zero ('01')", () => {
    const badWitness: WitnessJson = {
      ...baseWitness,
      circuit_version: "01",
    };
    expect(() =>
      buildWithdrawSolV1CircomInputJson(
        badWitness,
        TEST_SECRET,
        CIRCOM_ACCOUNTS
      )
    ).to.throw(/decimal/i);
  });

  it("rejects circuit_version other than '1' ('2')", () => {
    const badWitness: WitnessJson = {
      ...baseWitness,
      circuit_version: "2",
    };
    expect(() =>
      buildWithdrawSolV1CircomInputJson(
        badWitness,
        TEST_SECRET,
        CIRCOM_ACCOUNTS
      )
    ).to.throw(/circuit_version/i);
  });

  it("rejects wrong secret (nullifier_hash mismatch)", () => {
    expect(() =>
      buildWithdrawSolV1CircomInputJson(
        baseWitness,
        TEST_SECRET + 1n,
        CIRCOM_ACCOUNTS
      )
    ).to.throw(/nullifier_hash/i);
  });

  it("rejects accounts pubkeys_hash mismatch", () => {
    const wrongAccounts = {
      ...CIRCOM_ACCOUNTS,
      recipient: TEST_RELAYER,
    };
    expect(() =>
      buildWithdrawSolV1CircomInputJson(baseWitness, TEST_SECRET, wrongAccounts)
    ).to.throw(/pubkeys_hash/i);
  });

  it("rejects tx_hash mismatch when fee is tampered in witness", () => {
    const badWitness: WitnessJson = {
      ...baseWitness,
      fee: (TEST_FEE + 1n).toString(),
    };
    expect(() =>
      buildWithdrawSolV1CircomInputJson(
        badWitness,
        TEST_SECRET,
        CIRCOM_ACCOUNTS
      )
    ).to.throw(/tx_hash/i);
  });

  it("rejects tx_hash mismatch when expiry_slot is tampered in witness", () => {
    const badWitness: WitnessJson = {
      ...baseWitness,
      expiry_slot: (TEST_EXPIRY_SLOT + 1n).toString(),
    };
    expect(() =>
      buildWithdrawSolV1CircomInputJson(
        badWitness,
        TEST_SECRET,
        CIRCOM_ACCOUNTS
      )
    ).to.throw(/tx_hash/i);
  });
});

// ── runExportWitness --circuit-input-output ───────────────────────────────────

describe("zk_prover: runExportWitness --circuit-input-output", function () {
  this.timeout(60_000);

  let cioSnapPath: string;

  before(async () => {
    await initPoseidon();
    const commitment = computeNoteCommitment(TEST_SECRET, TEST_DENOMINATION);
    const event = normalizeNoteDepositedEvent({
      commitment,
      denomination: TEST_DENOMINATION.toString(),
      leaf_index: 0,
      depositor: DEPOSITOR,
      slot: "400",
    });
    cioSnapPath = tmpPath("cio");
    fs.writeFileSync(
      cioSnapPath,
      JSON.stringify(buildSnapshot([event]), null, 2),
      "utf-8"
    );
  });

  after(() => {
    cleanup(cioSnapPath);
  });

  function cioArgs(overrides: Partial<CliArgs> = {}): CliArgs {
    return {
      snapshotPath: cioSnapPath,
      leafIndex: 0,
      commitmentHex: undefined,
      secret: TEST_SECRET,
      denomination: TEST_DENOMINATION,
      fee: TEST_FEE,
      chainId: TEST_CHAIN_ID,
      expirySlot: TEST_EXPIRY_SLOT,
      programId: TEST_PROGRAM_ID,
      poolPda: TEST_POOL_PDA,
      configPda: TEST_CONFIG_PDA,
      recipient: TEST_RECIPIENT,
      relayer: TEST_RELAYER,
      witnessOutput: undefined,
      publicOutput: undefined,
      circuitInputOutput: undefined,
      dryRun: false,
      yes: false,
      ...overrides,
    };
  }

  it("circuit input JSON is written when --circuit-input-output is provided with --yes", async () => {
    const written = new Map<string, string>();
    await runExportWitness(
      cioArgs({
        yes: true,
        witnessOutput: "/tmp/cio_w1.json",
        publicOutput: "/tmp/cio_p1.json",
        circuitInputOutput: "/tmp/cio_c1.json",
      }),
      {
        writeFile: (p, content) => written.set(p, content),
        log: () => {},
        warn: () => {},
      }
    );
    expect(written.has("/tmp/cio_c1.json")).to.be.true;
  });

  it("circuit input JSON includes all 21 circom signal fields", async () => {
    const written = new Map<string, string>();
    await runExportWitness(
      cioArgs({
        yes: true,
        witnessOutput: "/tmp/cio_w2.json",
        publicOutput: "/tmp/cio_p2.json",
        circuitInputOutput: "/tmp/cio_c2.json",
      }),
      {
        writeFile: (p, content) => written.set(p, content),
        log: () => {},
        warn: () => {},
      }
    );
    const parsed = JSON.parse(written.get("/tmp/cio_c2.json")!);
    expect(Object.keys(parsed).sort()).to.deep.equal([
      "chain_id",
      "circuit_version",
      "config_pda_hi",
      "config_pda_lo",
      "denomination",
      "expiry_slot",
      "fee",
      "nullifier_hash",
      "path_elements",
      "path_indices",
      "pool_pda_hi",
      "pool_pda_lo",
      "program_id_hi",
      "program_id_lo",
      "recipient_hi",
      "recipient_lo",
      "relayer_hi",
      "relayer_lo",
      "root",
      "secret",
      "tx_hash",
    ]);
  });

  it("circuit input JSON secret field is the decimal secret (not hex)", async () => {
    const written = new Map<string, string>();
    await runExportWitness(
      cioArgs({
        yes: true,
        witnessOutput: "/tmp/cio_w3.json",
        publicOutput: "/tmp/cio_p3.json",
        circuitInputOutput: "/tmp/cio_c3.json",
      }),
      {
        writeFile: (p, content) => written.set(p, content),
        log: () => {},
        warn: () => {},
      }
    );
    const parsed = JSON.parse(written.get("/tmp/cio_c3.json")!);
    expect(parsed.secret).to.equal(TEST_SECRET.toString());
    expect(typeof parsed.secret).to.equal("string");
  });

  it("log output does not expose secret when --circuit-input-output is provided", async () => {
    const lines: string[] = [];
    await runExportWitness(
      cioArgs({
        yes: true,
        witnessOutput: "/tmp/cio_w4.json",
        publicOutput: "/tmp/cio_p4.json",
        circuitInputOutput: "/tmp/cio_c4.json",
      }),
      {
        writeFile: () => {},
        log: (msg) => lines.push(msg),
        warn: (msg) => lines.push(msg),
      }
    );
    const output = lines.join("\n");
    expect(output).to.not.include(TEST_SECRET_HEX);
    expect(output).to.not.include(`"${TEST_SECRET.toString()}"`);
  });

  it("circuit input JSON is not written in --dry-run mode", async () => {
    const written: string[] = [];
    await runExportWitness(
      cioArgs({
        dryRun: true,
        circuitInputOutput: "/tmp/cio_dry.json",
      }),
      {
        writeFile: (p) => written.push(p),
        log: () => {},
        warn: () => {},
      }
    );
    expect(written).to.be.empty;
  });

  it("witness and public output files are still written when --circuit-input-output is present", async () => {
    const written = new Map<string, string>();
    await runExportWitness(
      cioArgs({
        yes: true,
        witnessOutput: "/tmp/cio_w5.json",
        publicOutput: "/tmp/cio_p5.json",
        circuitInputOutput: "/tmp/cio_c5.json",
      }),
      {
        writeFile: (p, content) => written.set(p, content),
        log: () => {},
        warn: () => {},
      }
    );
    expect(written.has("/tmp/cio_w5.json")).to.be.true;
    expect(written.has("/tmp/cio_p5.json")).to.be.true;
    expect(written.has("/tmp/cio_c5.json")).to.be.true;
  });

  it("existing --yes behavior is unchanged when --circuit-input-output is absent", async () => {
    const written = new Map<string, string>();
    await runExportWitness(
      cioArgs({
        yes: true,
        witnessOutput: "/tmp/cio_w6.json",
        publicOutput: "/tmp/cio_p6.json",
      }),
      {
        writeFile: (p, content) => written.set(p, content),
        log: () => {},
        warn: () => {},
      }
    );
    expect(written.has("/tmp/cio_w6.json")).to.be.true;
    expect(written.has("/tmp/cio_p6.json")).to.be.true;
    expect(written.size).to.equal(2);
  });
});

// ── collectWitnessSnapshotHygieneWarnings unit tests ─────────────────────────

describe("zk_prover: collectWitnessSnapshotHygieneWarnings", function () {
  it("emits [SMALL_SNAPSHOT_LEAF_COUNT] when leafCount = 3", () => {
    const warnings = collectWitnessSnapshotHygieneWarnings({
      leafIndex: 0,
      leafCount: 3,
    });
    expect(warnings.some((w) => w.includes("[SMALL_SNAPSHOT_LEAF_COUNT]"))).to
      .be.true;
  });

  it("does not emit [SMALL_SNAPSHOT_LEAF_COUNT] when leafCount = SMALL_SNAPSHOT_LEAF_COUNT_THRESHOLD (10)", () => {
    const warnings = collectWitnessSnapshotHygieneWarnings({
      leafIndex: 0,
      leafCount: SMALL_SNAPSHOT_LEAF_COUNT_THRESHOLD,
    });
    expect(warnings.some((w) => w.includes("[SMALL_SNAPSHOT_LEAF_COUNT]"))).to
      .be.false;
  });

  it("does not emit [SMALL_SNAPSHOT_LEAF_COUNT] when leafCount = 11", () => {
    const warnings = collectWitnessSnapshotHygieneWarnings({
      leafIndex: 0,
      leafCount: 11,
    });
    expect(warnings.some((w) => w.includes("[SMALL_SNAPSHOT_LEAF_COUNT]"))).to
      .be.false;
  });

  it("emits [SELECTED_LEAF_IS_LATEST] when leafIndex = leafCount - 1", () => {
    const warnings = collectWitnessSnapshotHygieneWarnings({
      leafIndex: 4,
      leafCount: 5,
    });
    expect(warnings.some((w) => w.includes("[SELECTED_LEAF_IS_LATEST]"))).to.be
      .true;
  });

  it("does not emit [SELECTED_LEAF_IS_LATEST] when selected leaf is not latest", () => {
    const warnings = collectWitnessSnapshotHygieneWarnings({
      leafIndex: 3,
      leafCount: 5,
    });
    expect(warnings.some((w) => w.includes("[SELECTED_LEAF_IS_LATEST]"))).to.be
      .false;
  });

  it("emits both warnings when leafCount = 3 and leafIndex = 2 (latest)", () => {
    const warnings = collectWitnessSnapshotHygieneWarnings({
      leafIndex: 2,
      leafCount: 3,
    });
    expect(warnings.some((w) => w.includes("[SMALL_SNAPSHOT_LEAF_COUNT]"))).to
      .be.true;
    expect(warnings.some((w) => w.includes("[SELECTED_LEAF_IS_LATEST]"))).to.be
      .true;
  });
});

// ── Snapshot hygiene warnings integration ────────────────────────────────────

describe("zk_prover: CLI runExportWitness -- snapshot hygiene warnings", function () {
  this.timeout(60_000);

  let smallSnapPath: string;
  let smallCommitment: string;

  before(async () => {
    await initPoseidon();
    smallCommitment = computeNoteCommitment(TEST_SECRET, TEST_DENOMINATION);
    const events = [0, 1, 2].map((i) =>
      normalizeNoteDepositedEvent({
        commitment: smallCommitment,
        denomination: TEST_DENOMINATION.toString(),
        leaf_index: i,
        depositor: DEPOSITOR,
        slot: String(700 + i),
      })
    );
    smallSnapPath = tmpPath("small_hyg");
    fs.writeFileSync(
      smallSnapPath,
      JSON.stringify(buildSnapshot(events), null, 2),
      "utf-8"
    );
  });

  after(() => {
    cleanup(smallSnapPath);
  });

  function hygieneArgs(overrides: Partial<CliArgs> = {}): CliArgs {
    return {
      snapshotPath: smallSnapPath,
      leafIndex: 2,
      commitmentHex: undefined,
      secret: TEST_SECRET,
      denomination: TEST_DENOMINATION,
      fee: TEST_FEE,
      chainId: TEST_CHAIN_ID,
      expirySlot: TEST_EXPIRY_SLOT,
      programId: TEST_PROGRAM_ID,
      poolPda: TEST_POOL_PDA,
      configPda: TEST_CONFIG_PDA,
      recipient: TEST_RECIPIENT,
      relayer: TEST_RELAYER,
      witnessOutput: undefined,
      publicOutput: undefined,
      dryRun: true,
      yes: false,
      ...overrides,
    };
  }

  it("dry-run emits [SMALL_SNAPSHOT_LEAF_COUNT] and [SELECTED_LEAF_IS_LATEST] for small snapshot at latest leaf", async () => {
    const warnLines: string[] = [];
    await runExportWitness(hygieneArgs(), {
      writeFile: () => {},
      log: () => {},
      warn: (msg) => warnLines.push(msg),
    });
    expect(warnLines.some((w) => w.includes("[SMALL_SNAPSHOT_LEAF_COUNT]"))).to
      .be.true;
    expect(warnLines.some((w) => w.includes("[SELECTED_LEAF_IS_LATEST]"))).to.be
      .true;
  });

  it("dry-run output does not include the secret hex", async () => {
    const allOutput: string[] = [];
    await runExportWitness(hygieneArgs(), {
      writeFile: () => {},
      log: (msg) => allOutput.push(msg),
      warn: (msg) => allOutput.push(msg),
    });
    const text = allOutput.join("\n");
    expect(text).to.not.include(TEST_SECRET_HEX);
  });
});
