#!/usr/bin/env bash
# Guards against deploying a mock-verifier binary to devnet or mainnet.
#
# Usage:
#   bash scripts/ops/check_deploy_artifact_not_mock.sh <path-to-.so>
#
# Fails if the binary contains any of the following sentinel strings, which are
# embedded only when the program is compiled with --features mock-verifier:
#
#   "MOCK VERIFIER ENABLED"       — withdraw_zk msg! log line
#   "Groth16 proof check skipped" — withdraw_zk msg! log line
#
# Both strings live in the #[cfg(feature = "mock-verifier")] block in
# programs/shielded_pool_anchor/src/instructions/withdraw_zk.rs and are absent
# from every binary produced by a plain `anchor build` (no feature flags).
#
# A mock-verifier binary skips Groth16 proof verification entirely.  Any caller
# who supplies valid-looking instruction arguments can drain the pool without a
# valid ZK proof.  Deployment of such a binary is categorically unsafe.

set -euo pipefail

red()   { printf "\033[1;31m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }

if [ $# -lt 1 ]; then
  red "Usage: $0 <path-to-.so>"
  exit 1
fi

SO="$1"

if [ ! -f "$SO" ]; then
  red "Error: file not found: $SO"
  exit 1
fi

if [ ! -s "$SO" ]; then
  red "Error: file is empty: $SO"
  exit 1
fi

# Scan for mock-verifier sentinels.
# grep -a treats binary data as text so non-printable bytes do not abort the scan.
SENTINELS=(
  "MOCK VERIFIER ENABLED"
  "Groth16 proof check skipped"
)

FOUND=0
for sentinel in "${SENTINELS[@]}"; do
  if grep -Fqa "$sentinel" "$SO" 2>/dev/null; then
    FOUND=1
    red "  ✗ Found mock-verifier sentinel: \"$sentinel\""
  fi
done

if [ "$FOUND" -ne 0 ]; then
  echo ""
  red "════════════════════════════════════════════════════════════════════"
  red "  DEPLOY BLOCKED"
  red ""
  red "  $SO"
  red "  appears to be built with --features mock-verifier."
  red ""
  red "  This artifact must not be deployed to devnet or mainnet."
  red "  The mock-verifier skips Groth16 proof verification entirely."
  red "  Any caller with valid-looking instruction args can drain the pool"
  red "  without a valid ZK proof."
  red ""
  red "  Fix: run  anchor build  (no --features flag) and retry."
  red "════════════════════════════════════════════════════════════════════"
  exit 1
fi

green "  ✓ $SO: no mock-verifier sentinel strings found"
exit 0
