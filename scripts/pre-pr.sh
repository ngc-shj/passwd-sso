#!/usr/bin/env bash
# Pre-PR verification — runs the same checks as CI's app-ci job locally.
# Usage: npm run pre-pr
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

passed=0
failed=0
failures=()

run_step() {
  local label="$1"
  shift
  printf "${BOLD}▸ %s${RESET}\n" "$label"
  if "$@"; then
    printf "${GREEN}  ✓ %s${RESET}\n\n" "$label"
    passed=$((passed + 1))
  else
    printf "${RED}  ✗ %s${RESET}\n\n" "$label"
    failed=$((failed + 1))
    failures+=("$label")
  fi
}

echo ""
printf "${BOLD}═══ Pre-PR Checks ═══${RESET}\n\n"

run_step "Static: e2e-selectors"  bash scripts/check-e2e-selectors.sh
run_step "Lint"                   npx eslint .
run_step "Static: team-auth-rls"  node scripts/check-team-auth-rls.mjs
run_step "Static: bypass-rls"     node scripts/check-bypass-rls.mjs
run_step "Static: crypto-domains" node scripts/check-crypto-domains.mjs
run_step "Static: migration-drift" node scripts/check-migration-drift.mjs
run_step "Test"                   npx vitest run
run_step "Build"                  npx next build

echo ""
printf "${BOLD}═══ Results ═══${RESET}\n"
printf "${GREEN}  Passed: %d${RESET}\n" "$passed"

if [ "$failed" -gt 0 ]; then
  printf "${RED}  Failed: %d${RESET}\n" "$failed"
  for f in "${failures[@]}"; do
    printf "${RED}    - %s${RESET}\n" "$f"
  done
  echo ""
  printf "${RED}${BOLD}✗ Pre-PR checks failed. Fix the above before creating a PR.${RESET}\n"
  exit 1
fi

echo ""
printf "${GREEN}${BOLD}✓ All pre-PR checks passed. Ready to create PR.${RESET}\n"
