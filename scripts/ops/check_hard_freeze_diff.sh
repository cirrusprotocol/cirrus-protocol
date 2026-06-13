#!/usr/bin/env bash
# Hard-freeze diff guard.
# Fails if any file under hard-freeze paths was modified between BASE and HEAD.
# Hard-freeze paths protect on-chain program code, canonical hash implementation,
# and parity vectors from accidental modification.
#
# Usage:
#   bash scripts/ops/check_hard_freeze_diff.sh [base-ref]
#
# Override (intentional on-chain milestone commits only):
#   ALLOW_HARD_FREEZE_DIFF=true bash scripts/ops/check_hard_freeze_diff.sh [base-ref]
#   When set, prints the violation list but exits 0 with:
#     "Hard-freeze changes allowed by explicit override."
#
# Base resolution:
#   1. If a base-ref argument is provided, that commit is used.
#   2. If no argument is provided and origin/main is reachable, origin/main is used.
#   3. If neither is available the script exits non-zero (fail-closed).
#
# The null SHA (000...0) is treated as SKIP — not failure — because it indicates
# an initial push to a new branch with no prior history to compare.

set -euo pipefail

# ── Color helpers ──────────────────────────────────────────────────────────────
red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
dim()    { printf "\033[2m%s\033[0m\n" "$*"; }

# ── Guards ─────────────────────────────────────────────────────────────────────
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  red "Not inside a git repository. Run from the repo root."
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

# ── Hard-freeze paths ──────────────────────────────────────────────────────────
# Any change to these paths must be deliberate and reviewed separately.
# Directory entries end with / and match any file under that prefix.
FREEZE_PATHS=(
  "programs/"
  "crates/"
  "Anchor.toml"
  "Cargo.toml"
  "Cargo.lock"
  "lib/crypto.ts"
  "tests/fixtures/parity_vectors.json"
  "programs/shielded_pool_anchor/src/instructions/attestation.rs"
)

# ── Determine base commit ──────────────────────────────────────────────────────
NULL_SHA="0000000000000000000000000000000000000000"

if [[ $# -ge 1 && -n "${1:-}" ]]; then
  BASE_ARG="$1"
  if [[ "$BASE_ARG" == "$NULL_SHA" ]]; then
    yellow "Base SHA is the null commit (initial push to new branch — no prior history)."
    yellow "Hard-freeze diff guard: SKIPPED."
    exit 0
  fi
  if ! git cat-file -e "${BASE_ARG}^{commit}" 2>/dev/null; then
    red "Base ref '${BASE_ARG}' is not reachable in this repository."
    red "Ensure the checkout fetches enough history (fetch-depth: 0 or explicit base fetch)."
    exit 1
  fi
  BASE="$BASE_ARG"
else
  if git rev-parse --verify "origin/main" &>/dev/null; then
    BASE="origin/main"
  else
    red "No base ref provided and 'origin/main' is not reachable."
    red "Provide a base commit explicitly:"
    red "  bash scripts/ops/check_hard_freeze_diff.sh <base-ref>"
    exit 1
  fi
fi

HEAD_SHA="$(git rev-parse HEAD)"
BASE_SHA="$(git rev-parse "${BASE}")"

echo ""
yellow "── Hard-freeze diff guard ──────────────────────────────────────────────────"
dim    "   Base : ${BASE} (${BASE_SHA})"
dim    "   HEAD : ${HEAD_SHA}"
dim    "   Range: ${BASE_SHA}...${HEAD_SHA} (merge-base form)"
echo ""

# ── Collect changed files (merge-base form: BASE...HEAD) ──────────────────────
# Three-dot diff finds the merge base of BASE and HEAD, then diffs from there
# to HEAD. This correctly captures only the changes introduced by the branch,
# regardless of how far the base branch has advanced since the fork point.
CHANGED_FILES="$(git diff --name-only "${BASE_SHA}...${HEAD_SHA}" 2>/dev/null || true)"

if [[ -z "$CHANGED_FILES" ]]; then
  dim "   No files changed between ${BASE_SHA}...${HEAD_SHA}."
  echo ""
  green "Hard-freeze diff guard PASSED — no freeze-path changes."
  printf '%0.s─' {1..64}
  echo
  exit 0
fi

dim "Changed files:"
while IFS= read -r f; do
  dim "  ${f}"
done <<<"$CHANGED_FILES"
echo ""

# ── Check each changed file against freeze paths ───────────────────────────────
VIOLATIONS=()

while IFS= read -r changed_file; do
  [[ -z "$changed_file" ]] && continue
  for freeze_path in "${FREEZE_PATHS[@]}"; do
    if [[ "$freeze_path" == */ ]]; then
      if [[ "$changed_file" == "${freeze_path}"* ]]; then
        VIOLATIONS+=("${changed_file}  (freeze path: ${freeze_path})")
        break
      fi
    else
      if [[ "$changed_file" == "$freeze_path" ]]; then
        VIOLATIONS+=("${changed_file}  (freeze path: ${freeze_path})")
        break
      fi
    fi
  done
done <<<"$CHANGED_FILES"

# ── Result ─────────────────────────────────────────────────────────────────────
printf '%0.s─' {1..64}
echo
if [[ "${#VIOLATIONS[@]}" -eq 0 ]]; then
  green "Hard-freeze diff guard PASSED — no freeze-path changes detected."
else
  red   "Hard-freeze diff guard FAILED — ${#VIOLATIONS[@]} frozen file(s) modified:"
  echo ""
  for v in "${VIOLATIONS[@]}"; do
    red "  FREEZE  ${v}"
  done
  echo ""
  if [[ "${ALLOW_HARD_FREEZE_DIFF:-false}" == "true" ]]; then
    yellow "Hard-freeze changes allowed by explicit override."
    printf '%0.s─' {1..64}
    echo
    exit 0
  fi
  red "Changes to on-chain program code, canonical hash implementation, or"
  red "parity vectors require explicit review. Resolve before merging."
  printf '%0.s─' {1..64}
  echo
  exit 1
fi
printf '%0.s─' {1..64}
echo
