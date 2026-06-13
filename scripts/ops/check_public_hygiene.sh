#!/usr/bin/env bash
# Public repository hygiene check.
# Scans git-tracked files only (git ls-files / git grep). Requires no network and no private keys.
#
# Checks:
#   1. Tracked private workspace artifacts  (keys/, snapshots/, etc.)
#   2. Hardcoded personal / local absolute paths
#   3. Common secret / token leak patterns
#   4. Unsafe devnet operator examples (anchor run admin/demo)
#
# Usage:
#   bash scripts/ops/check_public_hygiene.sh

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

FAILURES=0

# Report a violation: file, optional line number, reason, and fix.
report_violation() {
  local file="$1" lineno="$2" reason="$3" fix="$4"
  if [[ -n "$lineno" ]]; then
    red "  FAIL  ${file}:${lineno}"
  else
    red "  FAIL  ${file}"
  fi
  red "        Reason : ${reason}"
  red "        Fix    : ${fix}"
  echo ""
  FAILURES=$((FAILURES + 1))
}

# Content grep helpers — skip binary files (-I) and exclude the hygiene script itself
# to prevent self-flagging on its own literal patterns and example strings.
tracked_grep_e() {
  git grep -I -InE "$1" -- . ':(exclude)scripts/ops/check_public_hygiene.sh' 2>/dev/null || true
}
tracked_grep_p() {
  git grep -I -InP "$1" -- . ':(exclude)scripts/ops/check_public_hygiene.sh' 2>/dev/null || true
}

# Parse "file:lineno:content" from git grep -n output.
parse_hit() {
  local hit="$1"
  HIT_FILE="${hit%%:*}"
  local rest="${hit#*:}"
  HIT_LINE="${rest%%:*}"
  HIT_TEXT="${rest#*:}"
}

# ══════════════════════════════════════════════════════════════════════════════
# CHECK 1 — Tracked private workspace artifacts
# ══════════════════════════════════════════════════════════════════════════════
yellow "── Check 1/4: tracked private workspace artifacts ──"

# "pattern:label" entries
ARTIFACT_ENTRIES=(
  "^keys/:wallet / keypair directory"
  "^\.venv/:Python virtual environment"
  "^snapshots/:local devnet state snapshot"
  "^node_modules/:npm dependency tree"
  "^target/:Rust/Anchor build output"
  "^test-ledger/:local validator ledger data"
  "^__pycache__/:Python bytecode cache"
  "\.pyc$:Python compiled bytecode"
)

while IFS= read -r tracked_path; do
  for entry in "${ARTIFACT_ENTRIES[@]}"; do
    pat="${entry%%:*}"
    label="${entry#*:}"
    if echo "$tracked_path" | grep -qE "$pat"; then
      report_violation "$tracked_path" "" \
        "private/generated artifact tracked in git — ${label}" \
        "git rm --cached '${tracked_path}' && ensure path is in .gitignore"
    fi
  done
done < <(git ls-files)

# ══════════════════════════════════════════════════════════════════════════════
# CHECK 2 — Hardcoded personal / local absolute paths
# ══════════════════════════════════════════════════════════════════════════════
yellow "── Check 2/4: hardcoded personal/local paths ──"

# /home/<username>/ — absolute user home path (safe form is ~/ or $HOME/)
while IFS= read -r hit; do
  parse_hit "$hit"
  report_violation "$HIT_FILE" "$HIT_LINE" \
    "hardcoded absolute home path: ${HIT_TEXT}" \
    "Replace with tilde (~/) or a shell variable (\$HOME) — never commit absolute user paths"
done < <(tracked_grep_p '/home/[a-z][a-z0-9_.-]+/')

# C:\Users\ or C:/Users/ — Windows user path
while IFS= read -r hit; do
  parse_hit "$hit"
  report_violation "$HIT_FILE" "$HIT_LINE" \
    "hardcoded Windows user path: ${HIT_TEXT}" \
    "Remove local absolute path; use relative paths or cross-platform env vars"
done < <(tracked_grep_p 'C:\\Users\\|C:/Users/')

# DESKTOP-XXXXX — Windows machine name prefix
while IFS= read -r hit; do
  parse_hit "$hit"
  report_violation "$HIT_FILE" "$HIT_LINE" \
    "Windows machine hostname in tracked file: ${HIT_TEXT}" \
    "Remove machine-specific hostname — it identifies a developer's workstation"
done < <(tracked_grep_p 'DESKTOP-[A-Z0-9]{4,}')

# \\wsl$\ — WSL UNC path (\\wsl$\Distro\...)
while IFS= read -r hit; do
  parse_hit "$hit"
  report_violation "$HIT_FILE" "$HIT_LINE" \
    "WSL UNC path in tracked file: ${HIT_TEXT}" \
    "Remove WSL-specific path; use portable relative paths"
done < <(tracked_grep_p '\\\\wsl\$\\')

# /mnt/<drive>/Users/ — WSL2 Linux-side Windows drive mount
while IFS= read -r hit; do
  parse_hit "$hit"
  report_violation "$HIT_FILE" "$HIT_LINE" \
    "WSL2 drive-mount path in tracked file: ${HIT_TEXT}" \
    "Remove Windows filesystem mount path; use portable relative paths"
done < <(tracked_grep_p '/mnt/[a-z]/Users/')

# ══════════════════════════════════════════════════════════════════════════════
# CHECK 3 — Secret / token leak patterns
# ══════════════════════════════════════════════════════════════════════════════
yellow "── Check 3/4: secret/token patterns ──"

# PEM private key block header (RSA, OPENSSH, EC, or generic PRIVATE KEY).
# Only fires on the PEM header line; safe prose like "PRIVATE KEY" in docs is not flagged.
while IFS= read -r hit; do
  parse_hit "$hit"
  report_violation "$HIT_FILE" "$HIT_LINE" \
    "PEM private key block found in tracked file" \
    "Remove the key file; rotate the key if it was ever pushed to a remote"
done < <(tracked_grep_e '-----BEGIN [A-Z ]*(PRIVATE KEY|EC PARAMETERS)-----')

# GitHub classic PAT (ghp_...) or fine-grained (github_pat_...)
while IFS= read -r hit; do
  parse_hit "$hit"
  report_violation "$HIT_FILE" "$HIT_LINE" \
    "GitHub personal access token pattern detected" \
    "Revoke at github.com/settings/tokens immediately; never commit tokens"
done < <(tracked_grep_e 'ghp_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}')

# Slack tokens (xoxb-bot, xoxa-app, xoxp-user, xoxr-refresh, xoxs-service)
while IFS= read -r hit; do
  parse_hit "$hit"
  report_violation "$HIT_FILE" "$HIT_LINE" \
    "Slack API token pattern detected" \
    "Revoke at api.slack.com/apps immediately; never commit tokens"
done < <(tracked_grep_e 'xox[baprs]-[0-9A-Za-z-]{10,}')

# Literal secret assignment: PRIVATE_KEY=realvalue (not a shell ref, placeholder, or comment).
# Matches:  PRIVATE_KEY=abc123xyz   API_KEY=AKIAxxxxxxxxxx
# Skips:    PRIVATE_KEY=${VAR}   API_KEY=<your_key>   PRIVATE_KEY=""   # comment line
while IFS= read -r hit; do
  parse_hit "$hit"
  report_violation "$HIT_FILE" "$HIT_LINE" \
    "secret variable with literal value: ${HIT_TEXT}" \
    "Use an env-var reference instead, e.g. PRIVATE_KEY=\${PRIVATE_KEY}"
done < <(tracked_grep_p '(?<![#*])\b(PRIVATE_KEY|API_KEY|SECRET_KEY|WEBHOOK_SECRET)\s*=\s*(?![${<"'"'"'\s])[A-Za-z0-9+/_.-]{8,}')

# Solana keypair-shaped JSON: top-level array of exactly 64 integers in [0,255].
# Lightweight detection; a full scan requires check_no_secrets.sh.
if command -v python3 &>/dev/null; then
  while IFS= read -r jsonfile; do
    [[ -f "$jsonfile" ]] || continue
    IS_KEYPAIR=$(python3 - "$jsonfile" <<'PYEOF'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    if isinstance(data, list) and len(data) == 64 and all(isinstance(x, int) and 0 <= x <= 255 for x in data):
        print("yes")
    else:
        print("no")
except Exception:
    print("no")
PYEOF
)
    if [[ "$IS_KEYPAIR" == "yes" ]]; then
      report_violation "$jsonfile" "" \
        "Solana keypair-shaped JSON array (64 integers) tracked in git" \
        "git rm --cached '${jsonfile}' && add to .gitignore; rotate the wallet if pushed to remote"
    fi
  done < <(git ls-files '*.json')
fi

# ══════════════════════════════════════════════════════════════════════════════
# CHECK 4 — Unsafe devnet operator examples (anchor run admin/demo)
# ══════════════════════════════════════════════════════════════════════════════
yellow "── Check 4/4: unsafe anchor run admin/demo devnet examples ──"
dim   "   (anchor run forces cluster=localnet from Anchor.toml, overriding ANCHOR_PROVIDER_URL)"

while IFS= read -r hit; do
  parse_hit "$hit"

  # Acceptable — explicit negative warning (tells readers NOT to use this)
  if echo "$HIT_TEXT" | grep -qiE "do not|don'?t|avoid|never|NOT run"; then
    dim "  SKIP  ${HIT_FILE}:${HIT_LINE}  (negative warning — acceptable)"
    continue
  fi

  # Acceptable — localnet-only guidance (same line resets a local validator)
  if echo "$HIT_TEXT" | grep -q "solana-test-validator"; then
    dim "  SKIP  ${HIT_FILE}:${HIT_LINE}  (localnet-only guidance — acceptable)"
    continue
  fi

  report_violation "$HIT_FILE" "$HIT_LINE" \
    "'anchor run admin/demo' routes devnet operators to local validator instead of devnet" \
    "Replace with: ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=keys/admin.json npx ts-node scripts/..."
done < <(tracked_grep_e 'anchor run (admin|demo)')

# ══════════════════════════════════════════════════════════════════════════════
# Result
# ══════════════════════════════════════════════════════════════════════════════
echo ""
printf '%0.s─' {1..64}; echo
if [[ "$FAILURES" -eq 0 ]]; then
  green "  Public hygiene check PASSED — no violations found."
else
  red   "  Public hygiene check FAILED — ${FAILURES} violation(s) found."
  red   "  Resolve all issues above before pushing to a public remote."
  printf '%0.s─' {1..64}; echo
  exit 1
fi
printf '%0.s─' {1..64}; echo
