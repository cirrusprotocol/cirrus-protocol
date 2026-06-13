#!/usr/bin/env bash
# Integration test lifecycle manager.
# Each of the 8 validator-backed integration suites runs in its own isolated validator session
# (start validator → deploy → test → teardown) to prevent verifier config state
# from bleeding between suites.
#
# Usage:
#   bash scripts/run_all_tests.sh              # build + test
#   bash scripts/run_all_tests.sh --skip-build # skip anchor build (reuse existing .so)

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n"    "$*"; }

SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    *) red "Unknown argument: $arg"; echo "Usage: $0 [--skip-build]"; exit 1 ;;
  esac
done

SO_PATH="target/deploy/shielded_pool_anchor.so"
KEYPAIR_PATH="target/deploy/shielded_pool_anchor-keypair.json"
LOCALNET_URL="http://127.0.0.1:8899"
# solana-test-validator pre-funds ~/.config/solana/id.json with SOL
TEST_WALLET="${HOME}/.config/solana/id.json"

export ANCHOR_PROVIDER_URL="$LOCALNET_URL"
export ANCHOR_WALLET="$TEST_WALLET"

PASS_COUNT=0
FAIL_COUNT=0
SUITE_RESULTS=()
VALIDATOR_PID=""

cleanup() {
  if [ -n "$VALIDATOR_PID" ]; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── Build ──────────────────────────────────────────────────────────────────────
# --features mock-verifier is required for the withdraw_zk integration suite.
# The resulting binary is LOCAL-TEST-ONLY.  It skips Groth16 proof verification
# entirely — any caller with valid-looking args can drain the pool.
# scripts/deploy_devnet.sh always rebuilds without this flag before any deploy,
# but do not manually deploy target/deploy/shielded_pool_anchor.so after this script.
MOCK_MARKER="target/deploy/.shielded_pool_anchor_mock_verifier_local_test_only"

if [ "$SKIP_BUILD" = false ]; then
  bold "▸ Building program with --features mock-verifier (local test binary)..."
  anchor build -- --features mock-verifier

  # Write a marker so deploy_devnet.sh can detect a stale mock artifact.
  # The marker is advisory; deploy_devnet.sh scans the .so itself regardless.
  mkdir -p target/deploy
  touch "$MOCK_MARKER"

  echo ""
  red "════════════════════════════════════════════════════════════════════"
  red "  WARNING: LOCAL-TEST-ONLY MOCK-VERIFIER BINARY"
  red ""
  red "  target/deploy/shielded_pool_anchor.so was built with"
  red "  --features mock-verifier and must NOT be deployed."
  red ""
  red "  Run  anchor build  (no feature flags) before any devnet deploy."
  red "  scripts/deploy_devnet.sh does this automatically."
  red "════════════════════════════════════════════════════════════════════"
  echo ""
else
  bold "▸ Skipping build (--skip-build)"
fi

if [ ! -f "$SO_PATH" ]; then
  red "Binary not found: $SO_PATH"
  red "Run 'anchor build' first, or drop --skip-build to build automatically."
  exit 1
fi
if [ ! -f "$KEYPAIR_PATH" ]; then
  red "Program keypair not found: $KEYPAIR_PATH — run 'anchor build' first"
  exit 1
fi
if [ ! -f "$TEST_WALLET" ]; then
  red "Default Solana keypair not found: $TEST_WALLET"
  red "Run: solana-keygen new --outfile '$TEST_WALLET'"
  exit 1
fi

# ── run_suite: isolated validator per suite ────────────────────────────────────
# Each suite gets a fresh validator because test suites modify shared PDAs
# (verifier config, pool state). Running them sequentially on one validator
# causes state bleed — attestation_threshold checks for a specific fresh config.
run_suite() {
  local name="$1" file="$2"

  bold "▸ Suite: $name"
  bold "  Starting fresh validator..."

  solana-test-validator --reset --quiet &
  VALIDATOR_PID=$!

  local ready=false
  for i in $(seq 1 30); do
    if solana --url "$LOCALNET_URL" slot &>/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done

  if [ "$ready" = false ]; then
    red "Validator did not respond within 30 seconds."
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
    VALIDATOR_PID=""
    FAIL_COUNT=$((FAIL_COUNT + 1))
    SUITE_RESULTS+=("  ✗ $name  (validator timeout)")
    return
  fi

  solana program deploy "$SO_PATH" \
    --url "$LOCALNET_URL" \
    --keypair "$TEST_WALLET" \
    --program-id "$KEYPAIR_PATH"

  if npx mocha -r ts-node/register --extensions ts -t 1000000 "$file"; then
    PASS_COUNT=$((PASS_COUNT + 1))
    SUITE_RESULTS+=("  ✓ $name")
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    SUITE_RESULTS+=("  ✗ $name")
  fi

  kill "$VALIDATOR_PID" 2>/dev/null || true
  wait "$VALIDATOR_PID" 2>/dev/null || true
  VALIDATOR_PID=""
  sleep 1  # allow port 8899 to free up before next suite
}

# ── Run suites ─────────────────────────────────────────────────────────────────
run_suite "withdraw"               "tests/withdraw.ts"
run_suite "admin_hardening"        "tests/admin_hardening.ts"
run_suite "attestation_threshold"  "tests/attestation_threshold.ts"
run_suite "migration"              "tests/migration.ts"
run_suite "deposit"                "tests/deposit.ts"
run_suite "init_note_tree"         "tests/init_note_tree.ts"
run_suite "deposit_note"           "tests/deposit_note.ts"
run_suite "withdraw_zk"            "tests/withdraw_zk.ts"

# ── Report ─────────────────────────────────────────────────────────────────────
echo ""
bold "════════════════════════════════════════════════════════════════════"
bold "  Integration test results  (8 suites)"
bold "════════════════════════════════════════════════════════════════════"
for result in "${SUITE_RESULTS[@]}"; do
  if [[ "$result" == *"✓"* ]]; then
    green "$result"
  else
    red "$result"
  fi
done
echo ""

if [ "$FAIL_COUNT" -eq 0 ]; then
  green "  All 8 suites passed."
  echo ""
  red "════════════════════════════════════════════════════════════════════"
  red "  REMINDER: target/deploy/shielded_pool_anchor.so is a"
  red "  LOCAL-TEST-ONLY mock-verifier build.  Do not deploy it."
  red "  Run  anchor build  (no feature flags) before any devnet deploy."
  red "════════════════════════════════════════════════════════════════════"
  exit 0
else
  red "  $FAIL_COUNT of 8 suite(s) FAILED."
  exit 1
fi
