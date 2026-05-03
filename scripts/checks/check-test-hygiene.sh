#!/usr/bin/env bash
# check-test-hygiene.sh — grep gates for forbidden patterns in NEW test files.
#
# Establishes the four gates promised in PR2's plan §Non-functional 4 +
# §Testing strategy 4-8. PR #425 did NOT establish these gates; PR2 does.
#
# Scope: only files added or modified relative to main are checked. Pre-existing
# violations in legacy test files are out-of-scope (separate technical-debt
# task). The gate's purpose is to prevent NEW violations slipping in.
#
# Gates (each fails the script with a specific message):
#   (a) `vi.mock("node:crypto", ...)`     — silently disables AES/HKDF
#   (b) `it.skip` / `describe.skip` / `fdescribe(` / `fit(`
#   (c) Direct `process.env.X = ...` mutations in tests (allowlist setup.ts)
#   (d) `@ts-ignore` / `@ts-nocheck` in tests
set -uo pipefail

RED='\033[0;31m'
RESET='\033[0m'

# Determine the base ref. Default: main. Override via TEST_HYGIENE_BASE.
BASE_REF="${TEST_HYGIENE_BASE:-main}"

# Verify the base ref resolves; bail out informatively if not (e.g., shallow clone).
if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  printf "${RED}check-test-hygiene: base ref '%s' not found. Set TEST_HYGIENE_BASE=<ref> if your CI uses a different default branch.${RESET}\n" "$BASE_REF" >&2
  exit 2
fi

# Identify added or modified test files since BASE_REF. Status filter:
# A=added, M=modified, R=renamed (treat as added). Compatible with bash 3.2 (no mapfile).
CHANGED_LIST=$(git diff --name-only --diff-filter=AMR "$BASE_REF...HEAD" 2>/dev/null \
  | grep -E '\.test\.(ts|tsx)$' \
  | grep -v -E '^src/__tests__/setup\.ts$' \
  || true)

if [ -z "$CHANGED_LIST" ]; then
  echo "check-test-hygiene: no changed test files (vs $BASE_REF) — skipping"
  exit 0
fi

# Count for the summary line.
CHANGED_COUNT=$(echo "$CHANGED_LIST" | wc -l | tr -d ' ')

# Single-pass scan with detail output. The while loop runs in a subshell (pipe
# right side), so a counter incremented inside it is invisible after the loop.
# Capture all violations into a single string and decide pass/fail by string
# emptiness — avoids the subshell-counter pitfall while still emitting per-rule
# context to stderr.
#
# scan_pattern <regex> <message> <file>: emits the matching lines on stdout
# (collected into VIOLATIONS) and a per-rule message to stderr. Extracted from
# 4 copy-pasted blocks so adding a 5th gate is a one-liner.
scan_pattern() {
  local regex="$1" msg="$2" file="$3" matches
  if matches=$(grep -nE "$regex" "$file" 2>/dev/null); then
    printf "%s\n" "${file}: ${matches}"
    printf "${RED}  ✗ FORBIDDEN: %s${RESET}\n" "$msg" >&2
  fi
}

VIOLATIONS=$(
  echo "$CHANGED_LIST" | while IFS= read -r file; do
    [ -f "$file" ] || continue

    # Gate (a): vi.mock("node:crypto", ...) — would silently disable AES/HKDF
    scan_pattern "vi\.mock\(['\"]node:crypto['\"]" \
      "vi.mock('node:crypto', ...) silently disables AES/HKDF; use vi.spyOn(cryptoModule, 'randomBytes') only" \
      "$file"

    # Gate (b): focused/skipped tests
    scan_pattern "\b(it|describe)\.skip\b|\b(fdescribe|fit)\(" \
      "skipped/focused tests (it.skip / describe.skip / fdescribe / fit); document deviation in skip-log instead" \
      "$file"

    # Gate (c): direct process.env mutation (allowlist setup.ts is excluded
    # via the CHANGED_LIST filter at the top of this script)
    scan_pattern "^[[:space:]]*process\.env\.[A-Z_]+ *=" \
      "direct process.env.X = mutation in tests; use vi.stubEnv (afterEach unstubs are wired in setup.ts)" \
      "$file"

    # Gate (d): @ts-ignore / @ts-nocheck
    scan_pattern "@ts-(ignore|nocheck)" \
      "@ts-ignore / @ts-nocheck in tests; fix the type instead (R36)" \
      "$file"
  done
)

if [ -n "$VIOLATIONS" ]; then
  printf "${RED}check-test-hygiene: violations in %d changed test file(s)${RESET}\n" "$CHANGED_COUNT" >&2
  exit 1
fi

echo "check-test-hygiene: ok ($CHANGED_COUNT changed test file(s) scanned)"
