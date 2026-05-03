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

violations=0
report_violation() {
  local label="$1"
  local matches="$2"
  printf "${RED}✗ %s${RESET}\n" "$label" >&2
  echo "$matches" >&2
  echo "" >&2
  violations=$((violations + 1))
}

# Run each gate against the changed-test-files set only.
echo "$CHANGED_LIST" | while IFS= read -r file; do
  [ -f "$file" ] || continue

  # Gate (a): vi.mock("node:crypto", ...)
  if matches=$(grep -nE "vi\.mock\(['\"]node:crypto['\"]" "$file" 2>/dev/null); then
    report_violation "FORBIDDEN: vi.mock('node:crypto', ...) silently disables AES/HKDF; use vi.spyOn(cryptoModule, 'randomBytes') only" \
      "$file: $matches"
  fi

  # Gate (b): focused/skipped tests
  if matches=$(grep -nE "\b(it|describe)\.skip\b|\b(fdescribe|fit)\(" "$file" 2>/dev/null); then
    report_violation "FORBIDDEN: skipped/focused tests (it.skip / describe.skip / fdescribe / fit); document deviation in skip-log instead" \
      "$file: $matches"
  fi

  # Gate (c): direct process.env mutation
  if matches=$(grep -nE "^[[:space:]]*process\.env\.[A-Z_]+ *=" "$file" 2>/dev/null); then
    report_violation "FORBIDDEN: direct process.env.X = mutation in tests; use vi.stubEnv (afterEach unstubs are wired in setup.ts)" \
      "$file: $matches"
  fi

  # Gate (d): @ts-ignore / @ts-nocheck
  if matches=$(grep -nE "@ts-(ignore|nocheck)" "$file" 2>/dev/null); then
    report_violation "FORBIDDEN: @ts-ignore / @ts-nocheck in tests; fix the type instead (R36)" \
      "$file: $matches"
  fi
done

# The while loop runs in a subshell (pipe right side); $violations isn't visible here.
# Re-evaluate by re-running grep across all changed files in aggregate. If any violation
# was reported above, the subshell exited with errors echoed to stderr; capture by re-scanning.
AGGREGATE_VIOLATIONS=$(echo "$CHANGED_LIST" | while IFS= read -r file; do
  [ -f "$file" ] || continue
  grep -nE "vi\.mock\(['\"]node:crypto['\"]|\b(it|describe)\.skip\b|\b(fdescribe|fit)\(|^[[:space:]]*process\.env\.[A-Z_]+ *=|@ts-(ignore|nocheck)" "$file" 2>/dev/null \
    | sed "s|^|$file:|"
done)

if [ -n "$AGGREGATE_VIOLATIONS" ]; then
  printf "${RED}check-test-hygiene: violations in %d changed test file(s)${RESET}\n" "$CHANGED_COUNT" >&2
  exit 1
fi

echo "check-test-hygiene: ok ($CHANGED_COUNT changed test file(s) scanned)"
