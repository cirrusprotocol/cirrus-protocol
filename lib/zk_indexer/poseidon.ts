// Poseidon wrapper using circomlibjs 0.1.7 buildPoseidon().
//
// All public API uses BigInt internally. 32-byte big-endian Buffer/hex is used
// only at the boundary (import from events, export to proof consumers).
//
// Endian contract:
//   - NoteDeposited.commitment arrives as a 32-byte big-endian Buffer (Solana wire format).
//   - All hashing is done as BigInt over the BN254 Fr field.
//   - Outputs exported to callers (proof path_elements, roots) are 32-byte BE hex strings.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildPoseidon } = require("circomlibjs");

export type FrBigInt = bigint;

// ── Conversion helpers ───────────────────────────────────────────────────────

/** Interpret a 32-byte big-endian hex string (no 0x prefix) as a BN254 Fr BigInt. */
export function hexToFrBigInt(hex: string): FrBigInt {
  if (hex.startsWith("0x") || hex.startsWith("0X"))
    throw new Error("hexToFrBigInt: input must not have 0x prefix");
  if (hex.length !== 64)
    throw new Error(`hexToFrBigInt: expected 64 hex chars, got ${hex.length}`);
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error("hexToFrBigInt: input contains non-hex characters");
  return BigInt("0x" + hex);
}

/** Serialize a BN254 Fr BigInt to a 64-char lowercase hex string (32-byte BE, no 0x prefix). */
export function frBigIntToHex32(n: FrBigInt): string {
  if (n < 0n) throw new Error("frBigIntToHex32: negative value");
  const raw = n.toString(16);
  if (raw.length > 64)
    throw new Error("frBigIntToHex32: value exceeds 32 bytes");
  return raw.padStart(64, "0");
}

/** Interpret a 32-byte big-endian Buffer as a BN254 Fr BigInt. */
export function bufferToFrBigInt(buf: Buffer): FrBigInt {
  if (buf.length !== 32)
    throw new Error(`bufferToFrBigInt: expected 32 bytes, got ${buf.length}`);
  return BigInt("0x" + buf.toString("hex"));
}

/** Serialize a BN254 Fr BigInt to a 32-byte big-endian Buffer. Overflow/negative rejected via frBigIntToHex32. */
export function frBigIntToBuffer32(n: FrBigInt): Buffer {
  return Buffer.from(frBigIntToHex32(n), "hex");
}

// ── Poseidon singleton ───────────────────────────────────────────────────────

let _poseidon: any = null;
let _F: any = null;

/** Initialise the Poseidon instance. Must be called once before any hash call. */
export async function initPoseidon(): Promise<void> {
  if (_poseidon !== null) return;
  _poseidon = await buildPoseidon();
  _F = _poseidon.F;
}

/**
 * Hash an array of BN254 Fr BigInt inputs with Poseidon.
 * Returns the result as a BN254 Fr BigInt.
 *
 * Inputs must already be valid Fr elements (< BN254 modulus).
 * Always pass BigInt — never pass Buffer directly (endian is unsafe).
 */
export function poseidonHash(inputs: FrBigInt[]): FrBigInt {
  if (_poseidon === null)
    throw new Error("poseidonHash: call initPoseidon() first");
  const raw = _poseidon(inputs);
  return _F.toObject(raw) as FrBigInt;
}
