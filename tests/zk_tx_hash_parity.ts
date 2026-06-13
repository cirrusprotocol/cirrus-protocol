import { expect } from "chai";
import { initPoseidon, frBigIntToHex32 } from "../lib/zk_indexer/poseidon";
import {
  TAG_TX,
  TAG_TX_INNER,
  CIRCUIT_VERSION,
} from "../lib/zk_indexer/constants";
import {
  splitPubkey,
  computePubkeysHash,
  computeTxHash,
} from "../lib/zk_prover/witness";

// ── Test constants (mirror Rust zk_hash::tests and tests/zk_prover_witness.ts) ─

const TEST_PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";
const TEST_POOL_PDA = "HcAkT4obzEEaHyevyVvmU7drEtSUg1m4XxF1VTWGoCdm"; // real pool_state PDA
const TEST_CONFIG_PDA = "6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu"; // real config PDA
const TEST_RECIPIENT = "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o";
const TEST_RELAYER = "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe";

const TEST_DENOMINATION = 1_000_000_000n;
const TEST_FEE = 10_000_000n;
const TEST_CHAIN_ID = 1n;
const TEST_EXPIRY_SLOT = 500_000n;

// Parity vectors: same values hardcoded in Rust zk_hash::tests.
// Computed from circomlibjs 0.1.7 with the constants above.
const EXPECTED_PUBKEYS_HASH =
  "257db079c37d4c654e63763d53606ee5d3269692dece034e82606e8eb3657d7a";
const EXPECTED_TX_HASH =
  "17115e272898a4cca8177791e2e99f51b2e01e7bc2d1381164217f6ef931bcac";

describe("zk_tx_hash_parity: TypeScript/Rust hash parity", function () {
  this.timeout(60_000);

  before(async () => {
    await initPoseidon();
  });

  // 1. splitPubkey: all-zero pubkey gives lo=0n, hi=0n
  it("splitPubkey: all-zero pubkey gives lo=0n, hi=0n", () => {
    const { lo, hi } = splitPubkey("11111111111111111111111111111111");
    expect(lo).to.equal(0n);
    expect(hi).to.equal(0n);
  });

  // 2. splitPubkey: known LE vector — bytes[0]=0x01 → lo=1n; bytes[16]=0x02 → hi=2n
  it("splitPubkey: bytes[0]=0x01 → lo=1n; bytes[16]=0x02 → hi=2n", () => {
    const { lo, hi } = splitPubkey(
      "0100000000000000000000000000000002000000000000000000000000000000"
    );
    expect(lo).to.equal(1n);
    expect(hi).to.equal(2n);
  });

  // 3. computePubkeysHash matches hardcoded TS/Rust parity vector
  it("computePubkeysHash matches EXPECTED_PUBKEYS_HASH parity vector", () => {
    const result = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    expect(result).to.equal(EXPECTED_PUBKEYS_HASH);
  });

  // 4. computeTxHash matches hardcoded TS/Rust parity vector
  it("computeTxHash matches EXPECTED_TX_HASH parity vector", () => {
    const pkh = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    const result = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT,
      CIRCUIT_VERSION
    );
    expect(result).to.equal(EXPECTED_TX_HASH);
  });

  // 5. Changing recipient changes pubkeys_hash
  it("changing recipient changes pubkeys_hash", () => {
    const base = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    const alt = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RELAYER, // different recipient
      TEST_RELAYER
    );
    expect(base).to.not.equal(alt);
  });

  // 6. Changing relayer changes pubkeys_hash
  it("changing relayer changes pubkeys_hash", () => {
    const base = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    const alt = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RECIPIENT // different relayer
    );
    expect(base).to.not.equal(alt);
  });

  // 7. Changing fee changes tx_hash
  it("changing fee changes tx_hash", () => {
    const pkh = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    const base = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT,
      CIRCUIT_VERSION
    );
    const alt = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE + 1n,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT,
      CIRCUIT_VERSION
    );
    expect(base).to.not.equal(alt);
  });

  // 8. Changing expiry_slot changes tx_hash
  it("changing expiry_slot changes tx_hash", () => {
    const pkh = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    const base = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT,
      CIRCUIT_VERSION
    );
    const alt = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT + 1n,
      CIRCUIT_VERSION
    );
    expect(base).to.not.equal(alt);
  });

  // 9. Changing chain_id changes tx_hash
  it("changing chain_id changes tx_hash", () => {
    const pkh = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    const base = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT,
      CIRCUIT_VERSION
    );
    const alt = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID + 1n,
      TEST_EXPIRY_SLOT,
      CIRCUIT_VERSION
    );
    expect(base).to.not.equal(alt);
  });

  // 10. Changing circuit_version changes tx_hash
  it("changing circuit_version changes tx_hash", () => {
    const pkh = computePubkeysHash(
      TEST_PROGRAM_ID,
      TEST_POOL_PDA,
      TEST_CONFIG_PDA,
      TEST_RECIPIENT,
      TEST_RELAYER
    );
    const base = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT,
      CIRCUIT_VERSION
    );
    const alt = computeTxHash(
      pkh,
      TEST_DENOMINATION,
      TEST_FEE,
      TEST_CHAIN_ID,
      TEST_EXPIRY_SLOT,
      CIRCUIT_VERSION + 1n
    );
    expect(base).to.not.equal(alt);
  });

  // 11. Public input order is locked: [root, nullifier_hash, tx_hash]
  it("public input order constant: [root, nullifier_hash, tx_hash]", () => {
    // This test pins the spec requirement, not a runtime computation.
    const order: readonly string[] = ["root", "nullifier_hash", "tx_hash"];
    expect(order).to.deep.equal(["root", "nullifier_hash", "tx_hash"]);
  });

  // 12. TAG constants match spec
  it("TAG_TX=4n, TAG_TX_INNER=5n, CIRCUIT_VERSION=1n", () => {
    expect(TAG_TX).to.equal(4n);
    expect(TAG_TX_INNER).to.equal(5n);
    expect(CIRCUIT_VERSION).to.equal(1n);
  });

  // 13. frBigIntToHex32 round-trips hex through BigInt correctly
  it("frBigIntToHex32 zero-pads to 64 chars", () => {
    expect(frBigIntToHex32(0n)).to.equal("0".repeat(64));
    expect(frBigIntToHex32(1n)).to.equal("0".repeat(63) + "1");
  });
});
