/**
 * scripts/ops/cirrus_devnet_alpha_profile.ts
 *
 * Canonical shared devnet-alpha pool profile. PUBLIC devnet constants only —
 * no keypairs, no operator material, no secrets. This is the single in-repo
 * source of truth for tooling that talks about the shared Cirrus devnet alpha
 * pool, so the program / pool / config / note-tree addresses are not re-typed
 * across many scripts.
 *
 * The npm package (packages/devnet-alpha/src/cli.ts) keeps its OWN self-contained
 * copy of these same constants on purpose: it builds in isolation (its own
 * tsconfig, rootDir, and published file list) and must not import across the repo
 * boundary. A drift-guard test asserts the two copies stay identical.
 *
 * Devnet only. Unaudited. Not for real funds. No privacy guarantee.
 */

export interface CirrusDevnetAlphaProfile {
  readonly name: string;
  readonly rpc: string;
  readonly programId: string;
  readonly poolPda: string;
  readonly configPda: string;
  readonly noteTreePda: string;
  readonly defaultDenomination: number; // lamports
  readonly defaultFee: number; // lamports
}

/**
 * The shared Cirrus devnet alpha pool. These are exactly the public addresses
 * and constants printed by `devnet-alpha run --help`. Frozen so callers cannot
 * mutate the shared profile at runtime.
 */
export const CIRRUS_DEVNET_ALPHA_PROFILE: CirrusDevnetAlphaProfile =
  Object.freeze({
    name: "cirrus-devnet-alpha",
    rpc: "https://api.devnet.solana.com",
    programId: "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq",
    poolPda: "HcAkT4obzEEaHyevyVvmU7drEtSUg1m4XxF1VTWGoCdm",
    configPda: "6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu",
    noteTreePda: "F5FBHZGdiVxgm335m9VrqNBvM4Zd4N5QBs9AgYMKNAbb",
    defaultDenomination: 1_000_000_000, // 1 SOL (lamports) — recommended alpha bucket
    defaultFee: 1_200_000, // lamports
  });
