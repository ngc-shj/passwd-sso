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

run_step "Static: e2e-selectors"  bash scripts/checks/check-e2e-selectors.sh
run_step "Static: security-doc-exists" bash scripts/checks/check-security-doc-exists.sh
run_step "Static: test-hygiene"   bash scripts/checks/check-test-hygiene.sh
run_step "Lint"                   npx eslint .
run_step "Static: env drift check"  npm run check:env-docs
run_step "Static: team-auth-rls"  node scripts/checks/check-team-auth-rls.mjs
run_step "Static: bypass-rls"     node scripts/checks/check-bypass-rls.mjs
run_step "Static: crypto-domains" node scripts/checks/check-crypto-domains.mjs
run_step "Static: migration-drift" node scripts/checks/check-migration-drift.mjs
run_step "Static: no-deprecated-logAudit" bash -c 'if grep -rn "logAudit(" src/ --include="*.ts" --include="*.tsx" | grep -v "logAuditAsync\|logAuditInTx" | grep -v "\.test\." | grep -v "^\s*//" | grep -v "^\s*\*" | grep -q .; then echo "Residual logAudit() calls found:"; grep -rn "logAudit(" src/ --include="*.ts" --include="*.tsx" | grep -v "logAuditAsync\|logAuditInTx" | grep -v "\.test\." | grep -v "^\s*//" | grep -v "^\s*\*"; exit 1; fi'

if command -v gitleaks >/dev/null 2>&1; then
  run_step "Secret scan (gitleaks)" gitleaks detect --no-banner --redact --staged
else
  # S19/S27 safe fallback: use node (already available — package.json runtime).
  # No shell-regex dialect issues; safe filename handling via -z.
  printf "${BOLD}▸ Secret scan (gitleaks fallback)${RESET}\n"
  if LEAK_OUTPUT=$(node scripts/lib/hex-leak-scan.mjs 2>&1); then
    printf "${GREEN}  ✓ Secret scan (gitleaks fallback)${RESET}\n"
    passed=$((passed + 1))
    printf "  (WARNING: gitleaks not installed; best-effort Node fallback passed — not a gitleaks substitute)\n\n"
  else
    printf "${RED}  ✗ Secret scan (gitleaks fallback)${RESET}\n\n"
    echo "ERROR: 64-char hex secret detected in staged diff (fallback scan):"
    echo "$LEAK_OUTPUT"
    echo "Install gitleaks for full-coverage scanning (brew install gitleaks / apt install gitleaks)."
    failed=$((failed + 1))
    failures+=("Secret scan (gitleaks fallback)")
  fi
fi

if git rev-parse --abbrev-ref HEAD | grep -q "^refactor/"; then
  run_step "Refactor phase verify" node scripts/refactor-phase-verify.mjs
fi

# Manual-test artifact gate (R35 Tier-1) — fails if admin-IA changes ship
# without an accompanying docs/archive/review/*-manual-test.md.
if git diff --name-only main...HEAD | grep -q '^src/app/\[locale\]/admin/'; then
  if ! git diff --name-only --diff-filter=A main...HEAD | grep -q '^docs/archive/review/.*-manual-test\.md$'; then
    printf "${RED}ERROR: admin/ changes detected but no docs/archive/review/*-manual-test.md added (R35 Tier-1)${RESET}\n" >&2
    failed=$((failed + 1))
    failures+=("Manual-test artifact gate (R35 Tier-1)")
  else
    printf "${GREEN}  ✓ Manual-test artifact gate (R35 Tier-1)${RESET}\n\n"
    passed=$((passed + 1))
  fi
fi
# Clear vitest cache to match CI's clean environment
rm -rf node_modules/.vitest extension/node_modules/.vitest 2>/dev/null || true
run_step "Test"                   npx vitest run

# Integration tests on refactor branches touching auth/DB modules.
# Round 4: T10 (regex covers pre- and post-PR-5 paths), T13 (DB reachability + 3s timeout),
# T22 (CI via ci-integration.yml is authoritative; this local run is a preview).
# Set PREPR_SKIP_INTEGRATION=1 to defer to CI.
if git rev-parse --abbrev-ref HEAD | grep -q "^refactor/" && \
   git diff --name-only main...HEAD | \
     grep -E '^src/lib/(prisma|redis|tenant-(context|rls)|auth/.+-token)\.ts$|^src/lib/(prisma|tenant|auth)/' \
     > /dev/null; then
  if [ "${PREPR_SKIP_INTEGRATION:-0}" = "1" ]; then
    printf "${BOLD}▸ Integration tests${RESET}\n"
    printf "  (skipped — PREPR_SKIP_INTEGRATION=1; CI ci-integration.yml is authoritative)\n\n"
  elif node -e 'const{Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:3000,statement_timeout:3000});p.query("select 1").then(()=>process.exit(0)).catch(()=>process.exit(1)).finally(()=>p.end())' 2>/dev/null; then
    run_step "Integration tests"  npm run test:integration
  else
    printf "${BOLD}▸ Integration tests${RESET}\n"
    printf "  (skipped — no Postgres reachable within 3s; start docker compose or set DATABASE_URL)\n\n"
  fi
fi

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
