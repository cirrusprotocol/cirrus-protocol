import { expect } from "chai";
import * as crypto from "crypto";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  WITHDRAW_ZK_INSTRUCTION_DISCRIMINATOR,
  WithdrawZkInstructionDataInput,
  buildWithdrawZkInstructionData,
  buildWithdrawZkInstruction,
  BuildWithdrawZkInstructionInput,
} from "../lib/zk_prover/withdraw_zk_instruction";

const PROOF_A = Buffer.alloc(64, 0x11);
const PROOF_B = Buffer.alloc(128, 0x22);
const PROOF_C = Buffer.alloc(64, 0x33);
const ROOT_HEX = "aa".repeat(32);
const NULLIFIER_HEX = "bb".repeat(32);
const DENOMINATION = 1_000_000_000n;
const FEE = 10_000_000n;
const EXPIRY_SLOT = 500_000n;
const CIRCUIT_VERSION = 1n;

function validInput(
  overrides: Partial<WithdrawZkInstructionDataInput> = {}
): WithdrawZkInstructionDataInput {
  return {
    proofA: PROOF_A,
    proofB: PROOF_B,
    proofC: PROOF_C,
    rootBeHex: ROOT_HEX,
    nullifierHashBeHex: NULLIFIER_HEX,
    denomination: DENOMINATION,
    fee: FEE,
    expirySlot: EXPIRY_SLOT,
    circuitVersion: CIRCUIT_VERSION,
    ...overrides,
  };
}

describe("zk_withdraw_instruction: instruction data builder", function () {
  describe("WITHDRAW_ZK_INSTRUCTION_DISCRIMINATOR", function () {
    it('equals sha256("global:withdraw_zk")[0..8]', () => {
      const expected = crypto
        .createHash("sha256")
        .update("global:withdraw_zk")
        .digest()
        .subarray(0, 8);
      expect(
        Buffer.compare(WITHDRAW_ZK_INSTRUCTION_DISCRIMINATOR, expected)
      ).to.equal(0);
    });

    it("is exactly c89d25363c6a81cc", () => {
      expect(WITHDRAW_ZK_INSTRUCTION_DISCRIMINATOR.toString("hex")).to.equal(
        "c89d25363c6a81cc"
      );
    });
  });

  describe("buildWithdrawZkInstructionData", function () {
    it("returns a Buffer of exactly 360 bytes", () => {
      expect(buildWithdrawZkInstructionData(validInput()).length).to.equal(360);
    });

    it("[0,8) is the discriminator", () => {
      const data = buildWithdrawZkInstructionData(validInput());
      expect(
        Buffer.compare(
          data.subarray(0, 8),
          WITHDRAW_ZK_INSTRUCTION_DISCRIMINATOR
        )
      ).to.equal(0);
    });

    it("[8,72) is proofA", () => {
      const data = buildWithdrawZkInstructionData(validInput());
      expect(Buffer.compare(data.subarray(8, 72), PROOF_A)).to.equal(0);
    });

    it("[72,200) is proofB", () => {
      const data = buildWithdrawZkInstructionData(validInput());
      expect(Buffer.compare(data.subarray(72, 200), PROOF_B)).to.equal(0);
    });

    it("[200,264) is proofC", () => {
      const data = buildWithdrawZkInstructionData(validInput());
      expect(Buffer.compare(data.subarray(200, 264), PROOF_C)).to.equal(0);
    });

    it("[264,296) is root bytes from rootBeHex", () => {
      const data = buildWithdrawZkInstructionData(validInput());
      expect(
        Buffer.compare(data.subarray(264, 296), Buffer.from(ROOT_HEX, "hex"))
      ).to.equal(0);
    });

    it("[296,328) is nullifier_hash bytes from nullifierHashBeHex", () => {
      const data = buildWithdrawZkInstructionData(validInput());
      expect(
        Buffer.compare(
          data.subarray(296, 328),
          Buffer.from(NULLIFIER_HEX, "hex")
        )
      ).to.equal(0);
    });

    it("[328,336) is denomination as u64 LE", () => {
      const data = buildWithdrawZkInstructionData(validInput());
      expect(data.readBigUInt64LE(328)).to.equal(DENOMINATION);
    });

    it("[336,344) is fee as u64 LE", () => {
      const data = buildWithdrawZkInstructionData(validInput());
      expect(data.readBigUInt64LE(336)).to.equal(FEE);
    });

    it("[344,352) is expiry_slot as u64 LE", () => {
      const data = buildWithdrawZkInstructionData(validInput());
      expect(data.readBigUInt64LE(344)).to.equal(EXPIRY_SLOT);
    });

    it("[352,360) is circuit_version as u64 LE", () => {
      const data = buildWithdrawZkInstructionData(validInput());
      expect(data.readBigUInt64LE(352)).to.equal(CIRCUIT_VERSION);
    });

    it("accepts uppercase rootBeHex and produces same root bytes", () => {
      const lower = buildWithdrawZkInstructionData(validInput());
      const upper = buildWithdrawZkInstructionData(
        validInput({ rootBeHex: ROOT_HEX.toUpperCase() })
      );
      expect(
        Buffer.compare(lower.subarray(264, 296), upper.subarray(264, 296))
      ).to.equal(0);
    });

    it("accepts uppercase nullifierHashBeHex and produces same bytes", () => {
      const lower = buildWithdrawZkInstructionData(validInput());
      const upper = buildWithdrawZkInstructionData(
        validInput({ nullifierHashBeHex: NULLIFIER_HEX.toUpperCase() })
      );
      expect(
        Buffer.compare(lower.subarray(296, 328), upper.subarray(296, 328))
      ).to.equal(0);
    });

    it("rejects proofA with length 63", () => {
      expect(() =>
        buildWithdrawZkInstructionData(validInput({ proofA: Buffer.alloc(63) }))
      ).to.throw(/proofA/);
    });

    it("rejects proofA with length 65", () => {
      expect(() =>
        buildWithdrawZkInstructionData(validInput({ proofA: Buffer.alloc(65) }))
      ).to.throw(/proofA/);
    });

    it("rejects proofB with length 127", () => {
      expect(() =>
        buildWithdrawZkInstructionData(
          validInput({ proofB: Buffer.alloc(127) })
        )
      ).to.throw(/proofB/);
    });

    it("rejects proofC with length 63", () => {
      expect(() =>
        buildWithdrawZkInstructionData(validInput({ proofC: Buffer.alloc(63) }))
      ).to.throw(/proofC/);
    });

    it("rejects short rootBeHex", () => {
      expect(() =>
        buildWithdrawZkInstructionData(
          validInput({ rootBeHex: "aa".repeat(31) })
        )
      ).to.throw(/rootBeHex/);
    });

    it("rejects non-hex rootBeHex", () => {
      expect(() =>
        buildWithdrawZkInstructionData(
          validInput({ rootBeHex: "zz".repeat(32) })
        )
      ).to.throw(/rootBeHex/);
    });

    it("rejects short nullifierHashBeHex", () => {
      expect(() =>
        buildWithdrawZkInstructionData(
          validInput({ nullifierHashBeHex: "bb".repeat(31) })
        )
      ).to.throw(/nullifierHashBeHex/);
    });

    it("rejects non-hex nullifierHashBeHex", () => {
      expect(() =>
        buildWithdrawZkInstructionData(
          validInput({ nullifierHashBeHex: "g".repeat(64) })
        )
      ).to.throw(/nullifierHashBeHex/);
    });

    it("rejects negative denomination", () => {
      expect(() =>
        buildWithdrawZkInstructionData(validInput({ denomination: -1n }))
      ).to.throw(/denomination/);
    });

    it("rejects denomination >= 2^64", () => {
      expect(() =>
        buildWithdrawZkInstructionData(validInput({ denomination: 2n ** 64n }))
      ).to.throw(/denomination/);
    });

    it("rejects negative fee", () => {
      expect(() =>
        buildWithdrawZkInstructionData(validInput({ fee: -1n }))
      ).to.throw(/fee/);
    });

    it("rejects expirySlot >= 2^64", () => {
      expect(() =>
        buildWithdrawZkInstructionData(validInput({ expirySlot: 2n ** 64n }))
      ).to.throw(/expirySlot/);
    });

    it("rejects circuitVersion >= 2^64", () => {
      expect(() =>
        buildWithdrawZkInstructionData(
          validInput({ circuitVersion: 2n ** 64n })
        )
      ).to.throw(/circuitVersion/);
    });

    it("rejects denomination passed as number instead of bigint", () => {
      expect(() =>
        buildWithdrawZkInstructionData(
          validInput({ denomination: 1_000_000_000 as unknown as bigint })
        )
      ).to.throw(/denomination/);
    });

    it("rejects circuitVersion passed as number instead of bigint", () => {
      expect(() =>
        buildWithdrawZkInstructionData(
          validInput({ circuitVersion: 1 as unknown as bigint })
        )
      ).to.throw(/circuitVersion/);
    });
  });

  // ── TransactionInstruction builder tests ───────────────────────────────────

  const PROGRAM_ID = new PublicKey(
    "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq"
  );
  const RELAYER = new PublicKey("7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe");
  const POOL_STATE = new PublicKey(
    "HcAkT4obzEEaHyevyVvmU7drEtSUg1m4XxF1VTWGoCdm"
  );
  const CONFIG = new PublicKey("6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu");
  const NULLIFIER_MARKER = new PublicKey(
    "2GXqoSTg4B5bYKjfuJS2uRCRXRe5EppQigQvYDrbV2ga"
  );
  const RECIPIENT = new PublicKey(
    "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o"
  );

  function validInstructionData(): Buffer {
    return buildWithdrawZkInstructionData(validInput());
  }

  function validIxAccounts(): BuildWithdrawZkInstructionInput {
    return {
      programId: PROGRAM_ID,
      relayer: RELAYER,
      poolState: POOL_STATE,
      config: CONFIG,
      nullifierMarker: NULLIFIER_MARKER,
      recipient: RECIPIENT,
      data: validInstructionData(),
    };
  }

  describe("buildWithdrawZkInstruction", function () {
    it("returns a TransactionInstruction", () => {
      const ix = buildWithdrawZkInstruction(validIxAccounts());
      expect(ix).to.be.instanceOf(TransactionInstruction);
    });

    it("sets programId to PROGRAM_ID", () => {
      const ix = buildWithdrawZkInstruction(validIxAccounts());
      expect(ix.programId.toBase58()).to.equal(PROGRAM_ID.toBase58());
    });

    it("clones data: mutation of source does not affect instruction", () => {
      const data = validInstructionData();
      const originalByte = data[0];
      const ix = buildWithdrawZkInstruction({ ...validIxAccounts(), data });
      data[0] ^= 0xff;
      expect(ix.data[0]).to.equal(originalByte);
    });

    it("preserves data content in instruction", () => {
      const data = validInstructionData();
      const ix = buildWithdrawZkInstruction({ ...validIxAccounts(), data });
      expect(Buffer.compare(ix.data, data)).to.equal(0);
    });

    it("uses SystemProgram.programId when systemProgram is omitted", () => {
      const ix = buildWithdrawZkInstruction(validIxAccounts());
      expect(ix.keys[5].pubkey.toBase58()).to.equal(
        SystemProgram.programId.toBase58()
      );
    });

    it("uses explicit custom systemProgram when provided", () => {
      const custom = new PublicKey(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
      );
      const ix = buildWithdrawZkInstruction({
        ...validIxAccounts(),
        systemProgram: custom,
      });
      expect(ix.keys[5].pubkey.toBase58()).to.equal(custom.toBase58());
    });

    it("key[0] relayer: signer=true, writable=true", () => {
      const ix = buildWithdrawZkInstruction(validIxAccounts());
      expect(ix.keys[0].pubkey.toBase58()).to.equal(RELAYER.toBase58());
      expect(ix.keys[0].isSigner).to.equal(true);
      expect(ix.keys[0].isWritable).to.equal(true);
    });

    it("key[1] poolState: signer=false, writable=true", () => {
      const ix = buildWithdrawZkInstruction(validIxAccounts());
      expect(ix.keys[1].pubkey.toBase58()).to.equal(POOL_STATE.toBase58());
      expect(ix.keys[1].isSigner).to.equal(false);
      expect(ix.keys[1].isWritable).to.equal(true);
    });

    it("key[2] config: signer=false, writable=false", () => {
      const ix = buildWithdrawZkInstruction(validIxAccounts());
      expect(ix.keys[2].pubkey.toBase58()).to.equal(CONFIG.toBase58());
      expect(ix.keys[2].isSigner).to.equal(false);
      expect(ix.keys[2].isWritable).to.equal(false);
    });

    it("key[3] nullifierMarker: signer=false, writable=true", () => {
      const ix = buildWithdrawZkInstruction(validIxAccounts());
      expect(ix.keys[3].pubkey.toBase58()).to.equal(
        NULLIFIER_MARKER.toBase58()
      );
      expect(ix.keys[3].isSigner).to.equal(false);
      expect(ix.keys[3].isWritable).to.equal(true);
    });

    it("key[4] recipient: signer=false, writable=true", () => {
      const ix = buildWithdrawZkInstruction(validIxAccounts());
      expect(ix.keys[4].pubkey.toBase58()).to.equal(RECIPIENT.toBase58());
      expect(ix.keys[4].isSigner).to.equal(false);
      expect(ix.keys[4].isWritable).to.equal(true);
    });

    it("key[5] systemProgram: signer=false, writable=false", () => {
      const ix = buildWithdrawZkInstruction(validIxAccounts());
      expect(ix.keys[5].pubkey.toBase58()).to.equal(
        SystemProgram.programId.toBase58()
      );
      expect(ix.keys[5].isSigner).to.equal(false);
      expect(ix.keys[5].isWritable).to.equal(false);
    });

    it("has exactly 6 keys", () => {
      const ix = buildWithdrawZkInstruction(validIxAccounts());
      expect(ix.keys.length).to.equal(6);
    });

    it("rejects data with 359 bytes", () => {
      expect(() =>
        buildWithdrawZkInstruction({
          ...validIxAccounts(),
          data: Buffer.alloc(359),
        })
      ).to.throw(/data/);
    });

    it("rejects data with 361 bytes", () => {
      expect(() =>
        buildWithdrawZkInstruction({
          ...validIxAccounts(),
          data: Buffer.alloc(361),
        })
      ).to.throw(/data/);
    });

    it("rejects programId passed as string", () => {
      expect(() =>
        buildWithdrawZkInstruction({
          ...validIxAccounts(),
          programId:
            "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq" as unknown as PublicKey,
        })
      ).to.throw(/programId/);
    });

    it("rejects relayer passed as string", () => {
      expect(() =>
        buildWithdrawZkInstruction({
          ...validIxAccounts(),
          relayer:
            "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe" as unknown as PublicKey,
        })
      ).to.throw(/relayer/);
    });

    it("rejects recipient passed as string", () => {
      expect(() =>
        buildWithdrawZkInstruction({
          ...validIxAccounts(),
          recipient:
            "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o" as unknown as PublicKey,
        })
      ).to.throw(/recipient/);
    });

    it("rejects data passed as string", () => {
      expect(() =>
        buildWithdrawZkInstruction({
          ...validIxAccounts(),
          data: "not-a-buffer" as unknown as Buffer,
        })
      ).to.throw(/data/);
    });
  });
});
