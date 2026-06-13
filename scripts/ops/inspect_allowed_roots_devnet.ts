#!/usr/bin/env ts-node
/**
 * scripts/ops/inspect_allowed_roots_devnet.ts
 *
 * Read-only inspection script for the on-chain verifier_config / allowed_roots state.
 *
 * Reads the on-chain verifier_config PDA and prints a clear operator summary:
 * admin authority, paused state, threshold, verifier count, allowed root list,
 * and whether a supplied --expected-root is present.
 *
 * Does not require a wallet.
 * Does not send transactions.
 * Does not submit roots.
 * Does not call the note-deposit instruction.
 * Does not call the ZK withdraw instruction.
 * Does not generate keypairs.
 * Does not request airdrops.
 *
 * Root presence confirmation is not ZK proof verification. It only confirms the
 * root is registered in the on-chain allowed_roots list.
 *
 * Usage:
 *   npx ts-node scripts/ops/inspect_allowed_roots_devnet.ts \
 *     --rpc-url https://api.devnet.solana.com \
 *     --program-id E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq \
 *     --expected-root <64-hex-root> \
 *     --commitment confirmed
 *
 * Exit codes:
 *   0  Config exists and no expected root was provided
 *   0  Config exists and expected root was provided and found
 *   1  Config account missing
 *   1  Expected root provided but not found
 *   1  Malformed arguments
 *   1  Decode failure
 */

import { Connection, PublicKey } from "@solana/web3.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";

// Must match MAX_ROOTS in programs/shielded_pool_anchor/src/state.rs.
export const MAX_ROOTS = 10;

// Anchor account discriminator for VerifierConfig.
// Matches DISC_CFG in scripts/ops/devnet_doctor.ts.
const DISC_CFG = Buffer.from([176, 103, 248, 36, 138, 167, 176, 220]);

// Current layout size, matching VerifierConfig::LEN in state.rs.
const CURRENT_CONFIG_LEN = 699;

const ALL_ZERO_ROOT = "0".repeat(64);

// ── Types ──────────────────────────────────────────────────────────────────────

export interface InspectArgs {
  rpcUrl: string;
  programId: string;
  configPda?: string;
  expectedRoot?: string;
  commitment: "processed" | "confirmed" | "finalized";
  json: boolean;
}

export interface VerifierConfigSummary {
  programId: string;
  configPda: string;
  exists: boolean;
  adminAuthority?: string;
  rootSubmitterAuthority?: string;
  paused?: boolean;
  threshold?: number;
  verifierCount?: number;
  allowedRootCount?: number;
  maxRoots?: number;
  allowedRoots?: string[];
  expectedRoot?: string;
  expectedRootPresent?: boolean;
  full?: boolean;
}

export interface DecodedVerifierConfig {
  adminAuthority: PublicKey;
  attesterPubkey: PublicKey;
  rootSubmitterAuthority: PublicKey;
  chainId: bigint;
  paused: boolean;
  threshold: number;
  verifierPubkeys: PublicKey[];
  allowedRoots: Buffer[];
  bump: number;
}

export interface InspectDeps {
  getAccountInfo: (
    pda: PublicKey,
    commitment: string
  ) => Promise<{ data: Buffer; owner?: PublicKey } | null>;
}

// ── Root validation ────────────────────────────────────────────────────────────

export function validateRootHex(hex: string, label = "root"): void {
  if (typeof hex !== "string") {
    throw new Error(`${label}: expected string, got ${typeof hex}`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `${label}: must be exactly 64 hex characters; got ${JSON.stringify(hex)}`
    );
  }
  if (hex.toLowerCase() === ALL_ZERO_ROOT) {
    throw new Error(`${label}: must not be the all-zero root`);
  }
}

// ── PDA derivation ─────────────────────────────────────────────────────────────

export function deriveConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_config")],
    programId
  );
}

// ── Borsh decode ──────────────────────────────────────────────────────────────

function discMatches(data: Buffer, disc: Buffer): boolean {
  if (data.length < 8) return false;
  return disc.every((b, i) => data[i] === b);
}

function readU64LE(buf: Buffer, offset: number): bigint {
  return (buf as any).readBigUInt64LE(offset);
}

/**
 * Decodes a VerifierConfig from raw account bytes.
 *
 * Layout (current, 699 bytes):
 *   disc[8]  admin[32]  attester[32]  root_submitter[32]  chain_id[8]
 *   paused[1]  threshold[1]  verifiers_len[4]  verifiers[n*32]
 *   roots_len[4]  roots[m*32]  bump[1]
 *
 * Returns null if discriminator mismatch, unrecognized size, or field overflow.
 */
export function decodeVerifierConfig(
  data: Buffer
): DecodedVerifierConfig | null {
  if (!discMatches(data, DISC_CFG)) return null;
  if (data.length !== CURRENT_CONFIG_LEN) return null;
  if (data.length < 118) return null;

  const adminAuthority = new PublicKey(data.slice(8, 40));
  const attesterPubkey = new PublicKey(data.slice(40, 72));
  const rootSubmitterAuthority = new PublicKey(data.slice(72, 104));
  const chainId = readU64LE(data, 104);
  const paused = data[112] !== 0;
  const threshold = data[113];
  const verifiersLen = data.readUInt32LE(114);

  const verifiersEnd = 118 + verifiersLen * 32;
  if (data.length < verifiersEnd + 4) return null;

  const verifierPubkeys: PublicKey[] = [];
  for (let i = 0; i < verifiersLen; i++) {
    verifierPubkeys.push(
      new PublicKey(data.slice(118 + i * 32, 118 + (i + 1) * 32))
    );
  }

  const rootsLen = data.readUInt32LE(verifiersEnd);
  const rootsEnd = verifiersEnd + 4 + rootsLen * 32;
  if (data.length < rootsEnd + 1) return null;

  const allowedRoots: Buffer[] = [];
  for (let i = 0; i < rootsLen; i++) {
    allowedRoots.push(
      data.slice(verifiersEnd + 4 + i * 32, verifiersEnd + 4 + (i + 1) * 32)
    );
  }

  const bump = data[rootsEnd];

  return {
    adminAuthority,
    attesterPubkey,
    rootSubmitterAuthority,
    chainId,
    paused,
    threshold,
    verifierPubkeys,
    allowedRoots,
    bump,
  };
}

// ── Summary helpers ────────────────────────────────────────────────────────────

export function allowedRootsToHex(roots: Buffer[]): string[] {
  return roots.map((r) => r.toString("hex").toLowerCase());
}

export function isExpectedRootPresent(
  rootsHex: string[],
  expectedRoot: string
): boolean {
  return rootsHex.some((r) => r === expectedRoot.toLowerCase());
}

export function buildSummary(
  programId: string,
  configPdaStr: string,
  decoded: DecodedVerifierConfig | null,
  exists: boolean,
  expectedRoot?: string
): VerifierConfigSummary {
  if (!exists || decoded === null) {
    const summary: VerifierConfigSummary = {
      programId,
      configPda: configPdaStr,
      exists: false,
    };
    if (expectedRoot !== undefined) {
      summary.expectedRoot = expectedRoot.toLowerCase();
      summary.expectedRootPresent = false;
    }
    return summary;
  }

  const allowedRootsHex = allowedRootsToHex(decoded.allowedRoots);
  let expectedRootPresent: boolean | undefined;
  if (expectedRoot !== undefined) {
    expectedRootPresent = isExpectedRootPresent(allowedRootsHex, expectedRoot);
  }

  return {
    programId,
    configPda: configPdaStr,
    exists: true,
    adminAuthority: decoded.adminAuthority.toBase58(),
    rootSubmitterAuthority: decoded.rootSubmitterAuthority.toBase58(),
    paused: decoded.paused,
    threshold: decoded.threshold,
    verifierCount: decoded.verifierPubkeys.length,
    allowedRootCount: decoded.allowedRoots.length,
    maxRoots: MAX_ROOTS,
    allowedRoots: allowedRootsHex,
    expectedRoot:
      expectedRoot !== undefined ? expectedRoot.toLowerCase() : undefined,
    expectedRootPresent,
    full: decoded.allowedRoots.length >= MAX_ROOTS,
  };
}

// ── Core runner ────────────────────────────────────────────────────────────────

export async function runInspect(
  args: InspectArgs,
  deps: InspectDeps
): Promise<VerifierConfigSummary> {
  let programPubkey: PublicKey;
  try {
    programPubkey = new PublicKey(args.programId);
  } catch {
    throw new Error(`runInspect: invalid program ID: ${args.programId}`);
  }

  let configPdaKey: PublicKey;
  if (args.configPda !== undefined) {
    try {
      configPdaKey = new PublicKey(args.configPda);
    } catch {
      throw new Error(`runInspect: invalid config PDA: ${args.configPda}`);
    }
  } else {
    [configPdaKey] = deriveConfigPda(programPubkey);
  }

  const configPdaStr = configPdaKey.toBase58();
  const accountInfo = await deps.getAccountInfo(configPdaKey, args.commitment);

  if (accountInfo === null) {
    return buildSummary(
      args.programId,
      configPdaStr,
      null,
      false,
      args.expectedRoot
    );
  }

  if (
    accountInfo.owner !== undefined &&
    !accountInfo.owner.equals(programPubkey)
  ) {
    throw new Error(
      `verifier_config owner mismatch: expected ${programPubkey.toBase58()}, ` +
        `got ${accountInfo.owner.toBase58()}`
    );
  }

  const decoded = decodeVerifierConfig(accountInfo.data);
  if (decoded === null) {
    throw new Error(
      `Failed to decode verifier_config at ${configPdaStr}: ` +
        `discriminator mismatch or unrecognized account size ` +
        `(${accountInfo.data.length} bytes, expected ${CURRENT_CONFIG_LEN}). ` +
        `Verify the program ID and config PDA are correct.`
    );
  }

  return buildSummary(
    args.programId,
    configPdaStr,
    decoded,
    true,
    args.expectedRoot
  );
}

// ── Argument parsing ───────────────────────────────────────────────────────────

const VALUED_FLAGS = new Set([
  "--rpc-url",
  "--program-id",
  "--config-pda",
  "--expected-root",
  "--commitment",
]);

const BOOL_FLAGS = new Set(["--json"]);

export function parseArgs(argv: string[]): InspectArgs {
  let rpcUrl: string | undefined;
  let programId: string = PROGRAM_ID;
  let configPda: string | undefined;
  let expectedRoot: string | undefined;
  let commitment: "processed" | "confirmed" | "finalized" = "confirmed";
  let json = false;

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (VALUED_FLAGS.has(flag)) {
      const next = argv[i + 1];
      if (
        next === undefined ||
        BOOL_FLAGS.has(next) ||
        VALUED_FLAGS.has(next)
      ) {
        throw new Error(
          `parseArgs: ${flag} requires a value but none was provided`
        );
      }
      switch (flag) {
        case "--rpc-url":
          rpcUrl = next;
          break;
        case "--program-id":
          try {
            new PublicKey(next);
          } catch {
            throw new Error(
              `parseArgs: --program-id is not a valid public key: ${next}`
            );
          }
          programId = next;
          break;
        case "--config-pda":
          try {
            new PublicKey(next);
          } catch {
            throw new Error(
              `parseArgs: --config-pda is not a valid public key: ${next}`
            );
          }
          configPda = next;
          break;
        case "--expected-root":
          validateRootHex(next, "--expected-root");
          expectedRoot = next.toLowerCase();
          break;
        case "--commitment":
          if (
            next !== "processed" &&
            next !== "confirmed" &&
            next !== "finalized"
          ) {
            throw new Error(
              `parseArgs: --commitment must be processed, confirmed, or finalized; got: ${next}`
            );
          }
          commitment = next;
          break;
      }
      i += 2;
    } else if (BOOL_FLAGS.has(flag)) {
      switch (flag) {
        case "--json":
          json = true;
          break;
      }
      i++;
    } else {
      throw new Error(`parseArgs: unknown flag: ${flag}`);
    }
  }

  if (rpcUrl === undefined) {
    throw new Error("parseArgs: --rpc-url is required");
  }

  return { rpcUrl, programId, configPda, expectedRoot, commitment, json };
}

// ── Output formatting ──────────────────────────────────────────────────────────

export function formatHuman(summary: VerifierConfigSummary): string {
  const lines: string[] = [];
  const W = 22;
  const row = (k: string, v: string): void => {
    lines.push(`${k.padEnd(W)} ${v}`);
  };

  row("Program ID:", summary.programId);
  row("Config PDA:", summary.configPda);
  row("Exists:", String(summary.exists));

  if (!summary.exists) {
    if (summary.expectedRoot !== undefined) {
      lines.push("");
      row("Expected root:", summary.expectedRoot);
      row("Root present:", "false");
    }
    lines.push(
      "\nConfig account not found. Verify the program ID and RPC URL."
    );
    return lines.join("\n");
  }

  if (summary.adminAuthority !== undefined)
    row("Admin authority:", summary.adminAuthority);
  if (summary.rootSubmitterAuthority !== undefined)
    row("Root submitter:", summary.rootSubmitterAuthority);
  if (summary.paused !== undefined) row("Paused:", String(summary.paused));
  if (summary.threshold !== undefined)
    row("Threshold:", String(summary.threshold));
  if (summary.verifierCount !== undefined)
    row("Verifier count:", String(summary.verifierCount));
  if (
    summary.allowedRootCount !== undefined &&
    summary.maxRoots !== undefined
  ) {
    row("Allowed roots:", `${summary.allowedRootCount}/${summary.maxRoots}`);
  }
  if (summary.full !== undefined) row("Full:", String(summary.full));
  if (summary.expectedRoot !== undefined) {
    lines.push("");
    row("Expected root:", summary.expectedRoot);
    row("Root present:", String(summary.expectedRootPresent));
  }

  if (summary.allowedRoots !== undefined && summary.allowedRoots.length > 0) {
    lines.push("\nAllowed roots:");
    summary.allowedRoots.forEach((r, idx) => lines.push(`  [${idx}] ${r}`));
  } else if (summary.allowedRoots !== undefined) {
    lines.push("\nAllowed roots: (none)");
  }

  return lines.join("\n");
}

export function formatJson(summary: VerifierConfigSummary): string {
  return JSON.stringify(summary, null, 2);
}

// ── CLI entry point ────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);

    let args: InspectArgs;
    try {
      args = parseArgs(argv);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    if (args.rpcUrl.includes("mainnet")) {
      console.error(
        "error: --rpc-url appears to point to mainnet. " +
          "This script is for devnet alpha only."
      );
      process.exit(1);
    }

    const connection = new Connection(args.rpcUrl, args.commitment);

    const deps: InspectDeps = {
      getAccountInfo: async (pda, commitment) => {
        const info = await connection.getAccountInfo(pda, commitment as any);
        if (info === null) return null;
        return { data: info.data as Buffer, owner: info.owner };
      },
    };

    let summary: VerifierConfigSummary;
    try {
      summary = await runInspect(args, deps);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }

    if (args.json) {
      console.log(formatJson(summary));
    } else {
      console.log(formatHuman(summary));
    }

    if (!summary.exists) {
      process.exit(1);
    }
    if (summary.expectedRootPresent === false) {
      process.exit(1);
    }
    process.exit(0);
  })();
}
