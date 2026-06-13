// Shared snapshot hygiene helpers.
//
// Used by scripts/zk_prover_export_witness.ts and
// scripts/ops/analyze_snapshot_hygiene.ts. Pure, no I/O, no RPC, no Poseidon.
//
// This is not a privacy guarantee. No warning does not mean private.
// Leaf count is not an anonymity set.

export const SMALL_SNAPSHOT_LEAF_COUNT_THRESHOLD = 10;
export const LOW_BUCKET_POPULATION_THRESHOLD = 5;

export function collectWitnessSnapshotHygieneWarnings(params: {
  leafIndex: number;
  leafCount: number;
  smallLeafThreshold?: number;
}): string[] {
  const {
    leafIndex,
    leafCount,
    smallLeafThreshold = SMALL_SNAPSHOT_LEAF_COUNT_THRESHOLD,
  } = params;
  const warnings: string[] = [];
  if (leafCount > 0 && leafCount < smallLeafThreshold) {
    warnings.push(
      "[SMALL_SNAPSHOT_LEAF_COUNT] Snapshot contains only " +
        leafCount +
        " leaves. Leaf count is not an anonymity set, but very small snapshots are weak privacy hygiene for privacy-mode testing."
    );
  }
  if (leafCount > 0 && leafIndex === leafCount - 1) {
    warnings.push(
      "[SELECTED_LEAF_IS_LATEST] Selected leaf is the latest known snapshot leaf. " +
        "Withdrawing the newest note can increase timing linkability in small devnet-alpha sets."
    );
  }
  return warnings;
}
