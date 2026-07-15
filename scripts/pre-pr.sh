#!/usr/bin/env bash
# Pre-PR verification — runs the same checks as CI's app-ci job locally.
# Usage: npm run pre-pr
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

# PRE_PR_STATIC_ONLY=1 runs only the environment-independent static checks
# (grep/script guards) and skips Lint, Test, Build, integration, and the
# staged-diff secret scan. CI's static-checks job sets this so the security
# static guards run in CI from the same definition as the local hook — there
# is no second copy to drift (R33).
STATIC_ONLY="${PRE_PR_STATIC_ONLY:-0}"

# Web-side heavy steps (Lint / Typecheck / vitest / integration / next build /
# CLI / Extension) only matter when the diff actually touches Web/Node code.
# On an iOS-only branch they spin uselessly — and in an ios worktree the Web
# suite can flaky-timeout, blocking every push. Mirror CI's `app` paths-filter
# (.github/workflows/ci.yml `changes` job) so the local decision matches CI's:
# if none of the app-filter paths changed, CI skips the app job too, so we can
# safely skip the Web steps here. RUN_WEB=0 ⇒ skip. Escape hatches:
#   PRE_PR_FORCE_FULL=1 ⇒ always run Web steps (override the auto-skip).
#   Detection failure (no git, no base) ⇒ fail safe = run everything.
# The iOS static guards above (e.g. check-ios-no-diagnostic-logging) always run.
detect_web_changes() {
  [ "${PRE_PR_FORCE_FULL:-0}" = "1" ] && return 0
  # Keep this list in lockstep with the `app:` filter in
  # .github/workflows/ci.yml (R33 — single source of truth for what gates Web).
  local app_paths='^(Dockerfile|docker-compose.*\.yml|src/|prisma/|proxy\.ts|instrumentation\.ts|messages/|package\.json|package-lock\.json|tsconfig.*\.json|vitest\.config\.|eslint\.config\.|next\.config\.|scripts/)'
  local base diff ref
  # Prefer origin/main (CI's base; survives a stale local main) and fall back to
  # local main only if the remote ref is absent.
  ref=origin/main
  git rev-parse --verify --quiet "$ref" >/dev/null 2>&1 || ref=main
  base=$(git merge-base "$ref" HEAD 2>/dev/null) || return 0  # no base ⇒ run all
  diff=$(git diff --name-only "$base"...HEAD 2>/dev/null) || return 0
  # Empty diff (e.g. nothing committed yet) ⇒ run all, can't prove iOS-only.
  [ -z "$diff" ] && return 0
  printf '%s\n' "$diff" | grep -qE "$app_paths"
}
if detect_web_changes; then
  RUN_WEB=1
else
  RUN_WEB=0
fi

passed=0
failed=0
failures=()
tempfiles=()

cleanup_tempfiles() {
  local logfile
  for logfile in "${tempfiles[@]:-}"; do
    [ -n "$logfile" ] && [ -f "$logfile" ] && rm -f "$logfile"
  done
  # The for-loop's last iteration short-circuits at `[ -f "$logfile" ]` when
  # run_step already removed the file on success — leaving the function's
  # exit code at 1, which the EXIT trap then propagates as the script's
  # exit code (a known Bash quirk: EXIT trap's last command sets the exit
  # status). Force `return 0` so cleanup never influences the success/failure
  # signal that the explicit `exit 1` / fall-through 0 at the bottom carry.
  return 0
}

show_failure_context() {
  local label="$1"
  local logfile="$2"
  local markers='(FAIL |Failed Tests|AssertionError|TypeError|ReferenceError|SyntaxError|^Error:|error TS[0-9]+|FORBIDDEN:|✗ |violations in)'
  # Audit dead-letter test fixtures emit pino JSON containing "TypeError"
  # inside the error field — exclude those structured-log lines so the
  # marker scan surfaces real failures, not log-shaped noise.
  local noise='"_logType":'
  local matches
  local fail_summary_line
  local fail_count
  local first_line
  local start_line
  local end_line

  printf "\n${BOLD}▸ %s${RESET}" "$label"
  if [ -n "$logfile" ]; then
    printf "  %s" "$logfile"
    # `|| true` keeps `set -e + pipefail` from killing the function when
    # the inner greps find no match (common: not a vitest run).
    fail_count=$({ grep -oE 'Failed Tests [0-9]+' "$logfile" || true; } \
      | tail -1 | { grep -oE '[0-9]+' || true; })
    if [ -n "$fail_count" ]; then
      printf "  ${RED}(%s failed)${RESET}" "$fail_count"
    fi
    printf "\n"
  else
    printf "\n  (no captured logfile; see output above)\n"
    return
  fi

  matches=$({ grep -nE "$markers" "$logfile" || true; } \
    | { grep -v "$noise" || true; } | head -30)
  if [ -n "$matches" ]; then
    printf "%s\n" "$matches"
    echo ""

    # Prefer vitest's "Failed Tests N" summary line as the context anchor —
    # it marks the start of the actual failure block. Fall back to the
    # first non-noise marker for non-vitest failures (lint, build, etc.).
    fail_summary_line=$({ grep -nE 'Failed Tests [0-9]+' "$logfile" || true; } \
      | tail -1 | cut -d: -f1)
    if [ -n "$fail_summary_line" ]; then
      start_line=$(( fail_summary_line > 3 ? fail_summary_line - 3 : 1 ))
      end_line=$(( start_line + 60 ))
    else
      first_line=$(printf "%s\n" "$matches" | head -1 | cut -d: -f1)
      start_line=$(( first_line > 5 ? first_line - 5 : 1 ))
      end_line=$(( start_line + 24 ))
    fi
    sed -n "${start_line},${end_line}p" "$logfile"
  else
    tail -20 "$logfile"
  fi
}

trap cleanup_tempfiles EXIT

run_step() {
  local label="$1"
  shift
  local logfile
  local ec

  logfile=$(mktemp -t "pre-pr.XXXXXX")
  tempfiles+=("$logfile")
  printf "${BOLD}▸ %s${RESET}\n" "$label"

  set +e
  "$@" 2>&1 | tee "$logfile"
  ec=${PIPESTATUS[0]}
  set -e

  if [ "$ec" -eq 0 ]; then
    printf "${GREEN}  ✓ %s${RESET}\n\n" "$label"
    passed=$((passed + 1))
  else
    printf "${RED}  ✗ %s${RESET}\n\n" "$label"
    failed=$((failed + 1))
    failures+=("$label|$logfile")
    return
  fi

  rm -f "$logfile"
}

echo ""
printf "${BOLD}═══ Pre-PR Checks ═══${RESET}\n\n"

run_step "Static: e2e-selectors"  bash scripts/checks/check-e2e-selectors.sh
run_step "Static: security-doc-exists" bash scripts/checks/check-security-doc-exists.sh
run_step "Static: test-hygiene"   bash scripts/checks/check-test-hygiene.sh
run_step "Static: settings-card-layout"  bash scripts/checks/check-settings-card-layout.sh
run_step "Static: api-error-codes" bash scripts/checks/check-api-error-codes.sh
run_step "Static: api-error-body-drift" bash scripts/checks/check-api-error-body-drift.sh
run_step "Static: fail-closed-routes-have-test" bash scripts/checks/check-fail-closed-routes-have-test.sh
run_step "Static: permanent-delete-stepup" bash scripts/checks/check-permanent-delete-stepup.sh
run_step "Static: step-up-client-coverage" bash scripts/checks/check-step-up-client-coverage.sh
run_step "Static: passkey-mint-gate" bash scripts/checks/check-passkey-mint-gate.sh
run_step "Static: raw-body-read" bash scripts/checks/check-raw-body-read.sh
run_step "Static: actions-sha-pinned" bash scripts/checks/check-actions-sha-pinned.sh
run_step "Static: workflow-supply-chain" node scripts/checks/check-workflow-supply-chain.mjs
run_step "Static: dockerfile-prisma-pin" bash scripts/checks/check-dockerfile-prisma-pin.sh
run_step "Static: ios-no-diagnostic-logging" bash scripts/checks/check-ios-no-diagnostic-logging.sh
run_step "Static: ios-authenticated-session-pinning" bash scripts/checks/check-ios-authenticated-session-pinning.sh
# Runs here (ubuntu OpenSSL 3.x), never the macOS iOS job — the .p12 fixtures are
# -legacy-encrypted and macOS LibreSSL rejects `openssl pkcs12 -legacy`.
run_step "Static: tls-fixture-expiry" bash scripts/checks/check-tls-fixture-expiry.sh

if [ "$RUN_WEB" != "1" ]; then
  printf "${BOLD}▸ Web steps skipped${RESET}  (no app-filter paths changed — iOS-only diff; set PRE_PR_FORCE_FULL=1 to override)\n\n"
fi

if [ "$STATIC_ONLY" != "1" ] && [ "$RUN_WEB" = "1" ]; then
  run_step "Lint"                   npx eslint .
  # tsc --noEmit typechecks test files too (vitest does not; next build excludes
  # them), catching mock/type drift that would otherwise rot silently.
  run_step "Typecheck"              npx tsc --noEmit
fi
run_step "Static: env drift check"  npm run check:env-docs
run_step "Static: security-matrices drift check" npm run check:security-matrices
run_step "Static: team-auth-rls"  node scripts/checks/check-team-auth-rls.mjs
run_step "Static: bypass-rls"     node scripts/checks/check-bypass-rls.mjs
run_step "Static: count-then-create-lock" node scripts/checks/check-count-then-create-lock.mjs
run_step "Static: crypto-domains" node scripts/checks/check-crypto-domains.mjs
run_step "Static: migration-drift" node scripts/checks/check-migration-drift.mjs
run_step "Static: raw-sql-usage" node scripts/checks/check-raw-sql-usage.mjs
# Cross-tenant SQL parse check (issue #434). Runs against the local docker DB
# if reachable; skips gracefully otherwise (preserves pre-pr.sh's "no Postgres
# required" contract for the static checks above).
if command -v docker >/dev/null 2>&1 && docker exec passwd-sso-db-1 pg_isready -U passwd_user -q 2>/dev/null; then
  run_step "Static: rls-cross-tenant SQL parse" bash -c '
    set -uo pipefail
    # sed (not awk) — bash -c "..." double-escapes positional vars and breaks awk $1 references.
    EXPECTED_TABLES=$(sed -E "/^#/d; /^[[:space:]]*$/d; s/^[[:space:]]+//; s/[[:space:]]+$//" \
      scripts/rls-cross-tenant-tables.manifest | paste -sd,)
    out=$(cat scripts/rls-cross-tenant-verify.sql | docker exec -i passwd-sso-db-1 \
      psql -U passwd_app -d passwd_sso -v ON_ERROR_STOP=1 -v expected_tables="$EXPECTED_TABLES" 2>&1) && ec=0 || ec=$?
    # Whitelist exact codes — typos like [E-RLS-NUL] would otherwise pass.
    if (( ec == 0 )) || grep -qE "\[E-RLS-(MANIFEST-(EXTRA|MISSING)|COLPARITY|COUNT-A|COUNT-B|NULL|SYM|BYPASS|DISCOVER|ROLE|COVERAGE|FORCE|SECDEF)\]" <<<"$out"; then
      exit 0
    fi
    printf "%s\n" "$out"
    exit 1
  '
else
  printf "  [skip: rls-cross-tenant SQL parse — local docker DB not running (npm run docker:up to enable)]\n\n"
fi
run_step "Static: no-deprecated-logAudit" bash -c 'if grep -rn "logAudit(" src/ --include="*.ts" --include="*.tsx" | grep -v "logAuditAsync\|logAuditInTx" | grep -v "\.test\." | grep -v "^\s*//" | grep -v "^\s*\*" | grep -q .; then echo "Residual logAudit() calls found:"; grep -rn "logAudit(" src/ --include="*.ts" --include="*.tsx" | grep -v "logAuditAsync\|logAuditInTx" | grep -v "\.test\." | grep -v "^\s*//" | grep -v "^\s*\*"; exit 1; fi'

# C21 / C10: forbid imports of Auth.js builtin WebAuthn providers. The project
# uses Auth.js Credentials provider with a custom authorize() flow that calls
# our own verifyAuthentication(). The @auth/core builtin providers (passkey,
# webauthn) still peer-depend on @simplewebauthn/server@^9 and would invoke
# v9-shape code through v11 internals — a latent auth-bypass risk if ever
# enabled. Keep them dead.
# A02-8 T10: read-only invariant on the PRF per-credential salt migration
# script. The diagnostic must SELECT only — any DDL/DML in the SQL body
# (excluding comments) means an operator running the diagnostic could
# inadvertently mutate the DB. The check extracts the heredoc SQL block
# and greps it for forbidden verbs.
run_step "Static: prf-salt-migration-script-readonly" bash -c '
  SCRIPT="scripts/migrate-prf-per-credential-salt.sh"
  if [ ! -f "$SCRIPT" ]; then
    # The script exists and is load-bearing (A02-8 C9 read-only invariant). A
    # missing file means it was moved/deleted, which would silently disable this
    # gate — fail closed instead. CONTRIBUTING.md pins it at scripts/ root.
    echo "ERROR: $SCRIPT not found at its pinned path — move it back or update this gate"
    exit 1
  fi
  # Extract just the SQL block(s) between `<<EOF` markers and the closing tag.
  # Any of UPDATE/INSERT/DELETE/TRUNCATE inside that block fails the check.
  SQL_BODY=$(awk "/^psql /,/^SQL\$/" "$SCRIPT")
  if echo "$SQL_BODY" | grep -iqE "\\b(UPDATE|INSERT|DELETE|TRUNCATE)\\b"; then
    echo "ERROR: forbidden write verb inside SQL body of $SCRIPT (A02-8 C9 immutable)"
    exit 1
  fi
'

# A02-8 T11: prfSalt is INSERT-only. Any code path that mutates the column
# breaks the PRF wrap binding for that credential. Catch via grep of any
# `prfSalt:` token inside a `.update(...)` block in production source (NOT
# test files — fixtures are allowed to write any shape).
run_step "Static: prf-salt-immutable" bash -c '
  if git diff --diff-filter=AM main...HEAD --name-only -- src \
    | grep -E "\\.tsx?$" | grep -v "\\.test\\." | xargs -r grep -nE "prfSalt\\s*:" 2>/dev/null \
    | grep -B1 "\\.update(" >/dev/null 2>&1; then
    echo "ERROR: prfSalt appears inside a .update() call — column is immutable (A02-8 C1)."
    echo "Production code MUST NOT set prfSalt post-insert. Use .create() only."
    exit 1
  fi
'

run_step "Static: no-argon2-browser-reintroduce" bash -c '
  # A06-2: argon2-browser was swapped for hash-wasm. Forbid any import/require
  # of argon2-browser to catch accidental re-introduction (left-pad scenario
  # for an unmaintained dep). Also forbid hash-wasm imports outside the crypto
  # lib + tests + cli (CLI keeps its own argon2 dep).
  if grep -rnE "(from\s+[\x22\x27]argon2-browser[\x22\x27]|require\([\x22\x27]argon2-browser[\x22\x27]\))" \
    src/ 2>/dev/null | grep -v "\\.test\\." | grep -q .; then
    echo "ERROR: argon2-browser import detected — A06-2 forbids re-introduction; use hash-wasm."
    grep -rnE "(from\s+[\x22\x27]argon2-browser[\x22\x27]|require\([\x22\x27]argon2-browser[\x22\x27]\))" \
      src/ | grep -v "\\.test\\."
    exit 1
  fi
  if grep -qF "argon2-browser" package.json; then
    echo "ERROR: argon2-browser still listed in package.json (A06-2 dropped it)"
    exit 1
  fi
'

run_step "Static: dcr-public-only-literal" bash -c '
  # A07-4: DCR (/api/mcp/register) issues public clients only per RFC 9700 §4.14.
  # The Zod schema must use z.literal("none") (no default fallback, no z.string()
  # optional) so wrong-shape inputs (null/array/case-mismatch) are rejected.
  ROUTE="src/app/api/mcp/register/route.ts"
  if [ ! -f "$ROUTE" ]; then
    echo "OK (route not present)"
    exit 0
  fi
  # Required: z.literal( or z.enum( referencing "none" must appear. Accept both
  # quote styles + leading whitespace + line breaks (perl -0 reads whole file).
  if ! perl -0777 -ne '"'"'exit 1 unless /z\.(literal|enum)\s*\(\s*\[?\s*["\x27]none["\x27]/'"'"' "$ROUTE"; then
    echo "ERROR: $ROUTE must constrain token_endpoint_auth_method via z.literal(\"none\") (A07-4)"
    exit 1
  fi
  # Forbidden: the legacy client_secret_post default literal must not appear here.
  if grep -qF "client_secret_post" "$ROUTE"; then
    echo "ERROR: $ROUTE still references client_secret_post — DCR is public-only (A07-4)"
    exit 1
  fi
  # Forbidden: no secret-shaped randomBytes(...) ... base64url generation in DCR.
  # clientId uses randomBytes(16).toString("hex") which is intentional — narrow
  # the regex to the secret-shape pattern (any-size randomBytes piped to base64url).
  if grep -qE "randomBytes\\([0-9]+\\)\\.toString\\([\"\x27]base64url[\"\x27]\\)" "$ROUTE"; then
    echo "ERROR: $ROUTE generates a base64url secret — DCR must not issue client_secret (A07-4)"
    exit 1
  fi
'

run_step "Static: client-secret-hash-non-null" bash -c '
  # A07-4 R5: McpClient.clientSecretHash MUST remain NOT NULL (empty-string
  # sentinel for public clients). The DCR public-only design + downstream
  # `clientSecretHash === ""` heuristic both depend on this invariant.
  if grep -qE "clientSecretHash\\s+String\\?" prisma/schema.prisma; then
    echo "ERROR: McpClient.clientSecretHash must remain NOT NULL (A07-4 R5)"
    echo "The empty-string sentinel design relies on this. Re-audit DCR + token paths before making it nullable."
    exit 1
  fi
'

run_step "Static: no-authjs-builtin-webauthn-provider" bash -c '
  # Anchor the match with a closing string-delimiter so future siblings like
  # @auth/core/providers/webauthn-safe (or webauthn2) do not get caught by a
  # prefix-loose pattern. The two literal provider paths below are exactly
  # the v9-shape ones we keep dead-coded. Delimiters in the character class
  # are spelled as hex escapes so the regex survives nested bash -c quoting:
  # \x22 = ", \x27 = single quote, \x60 = backtick.
  if grep -rPn --include="*.ts" --include="*.tsx" \
    "@auth/core/providers/(passkey|webauthn)[\x22\x27\x60]" \
    src/; then
    echo "ERROR: @auth/core builtin WebAuthn provider imports are forbidden (C21/C10)."
    echo "These providers still pin @simplewebauthn/server@^9 and are incompatible"
    echo "with our v11 runtime. Use our custom Credentials authorize() flow instead."
    exit 1
  fi
'

# A04-4 C7.1: master-key rotation approve route MUST go through the centralized
# eligibility helper AND apply the two load-bearing CAS WHERE clauses:
#   initiatedById: { not: ... }   — self-approval rejection
#   tenantId: actor.tenantId      — cross-tenant rejection
run_step "Static: master-key-rotation-dual-approval-uses-helper" bash -c '
  ROUTE="src/app/api/admin/rotate-master-key/[rotationId]/approve/route.ts"
  if [ ! -f "$ROUTE" ]; then
    echo "OK (route not present)"
    exit 0
  fi
  if ! grep -qE "computeApproveEligibility\\(" "$ROUTE"; then
    echo "ERROR: $ROUTE must invoke computeApproveEligibility() (A04-4 C6)"
    exit 1
  fi
  if ! grep -qE "initiatedById:\\s*\\{\\s*not:" "$ROUTE"; then
    echo "ERROR: $ROUTE missing CAS self-approval WHERE (initiatedById: { not: ... })"
    exit 1
  fi
  if ! grep -qE "tenantId:\\s*auth\\.tenantId" "$ROUTE"; then
    echo "ERROR: $ROUTE missing CAS cross-tenant WHERE (tenantId: auth.tenantId)"
    exit 1
  fi
'

# A04-4 C7.2: execute route MUST enforce the full state-machine CAS:
#   approvedAt: { not: null }   — approval required
#   executedAt: null            — not already executed
#   revokedAt:  null            — not revoked
#   expiresAt:  { gt: ... }     — not expired
#   tenantId:   actor.tenantId  — cross-tenant rejection
run_step "Static: master-key-rotation-execute-cas" bash -c '
  ROUTE="src/app/api/admin/rotate-master-key/[rotationId]/execute/route.ts"
  if [ ! -f "$ROUTE" ]; then
    echo "OK (route not present)"
    exit 0
  fi
  if ! grep -qE "approvedAt:\\s*\\{\\s*not:\\s*null" "$ROUTE"; then
    echo "ERROR: execute missing approvedAt CAS (approvedAt: { not: null })"
    exit 1
  fi
  if ! grep -qE "executedAt:\\s*null" "$ROUTE"; then
    echo "ERROR: execute missing executedAt CAS (executedAt: null)"
    exit 1
  fi
  if ! grep -qE "revokedAt:\\s*null" "$ROUTE"; then
    echo "ERROR: execute missing revokedAt CAS (revokedAt: null)"
    exit 1
  fi
  if ! grep -qE "expiresAt:\\s*\\{\\s*gt:" "$ROUTE"; then
    echo "ERROR: execute missing expiresAt CAS (expiresAt: { gt: ... })"
    exit 1
  fi
  if ! grep -qE "tenantId:\\s*auth\\.tenantId" "$ROUTE"; then
    echo "ERROR: execute missing tenantId CAS"
    exit 1
  fi
'

# A04-4 C7.3: legacy single-actor endpoint must return 410 Gone and MUST NOT
# call passwordShare.updateMany — that destructive write moved into the
# execute route, gated by dual approval.
run_step "Static: master-key-rotation-legacy-endpoint-gone" bash -c '
  ROUTE="src/app/api/admin/rotate-master-key/route.ts"
  if [ ! -f "$ROUTE" ]; then
    echo "OK (route not present)"
    exit 0
  fi
  if ! grep -qE "status:\\s*410\\b" "$ROUTE"; then
    echo "ERROR: $ROUTE must return 410 Gone (A04-4 FR8)"
    exit 1
  fi
  if grep -qE "passwordShare\\.updateMany" "$ROUTE"; then
    echo "ERROR: legacy rotate-master-key still mutates PasswordShare (single-actor path must be removed)"
    exit 1
  fi
'

# A04-4 C7.4 / C1.AC3: revokedShares is the share-revocation result; written
# ONLY inside the execute route and the helper module. Any other prod source
# writing `revokedShares:` is a regression — the count must originate from the
# execute path or the invariant breaks.
run_step "Static: master-key-rotation-revokedShares-execute-only" bash -c '
  HITS=$(grep -rnE "revokedShares\\s*:" src/ --include="*.ts" --include="*.tsx" 2>/dev/null \
    | grep -v "\\.test\\." \
    | grep -v "src/app/api/admin/rotate-master-key/\\[rotationId\\]/execute/" \
    | grep -v "src/lib/admin-rotation/" || true)
  if [ -n "$HITS" ]; then
    echo "ERROR: revokedShares written outside execute route (A04-4 C1 invariant)"
    echo "$HITS"
    exit 1
  fi
'

# fetch basePath compliance — every client API call must go through fetchApi()
# (which honors NEXT_PUBLIC_BASE_PATH) instead of raw fetch("/api/..."). Mirrors
# the CI gate at .github/workflows/ci.yml "Check fetch basePath compliance".
run_step "Static: fetch basePath compliance" bash -c '
  if grep -rn --include="*.tsx" --include="*.ts" \
    -E "fetch\((API_PATH\.|apiPath\.|\`/api/|\"/api/)" \
    src/ \
    --exclude-dir="src/app/api" \
    | grep -v "fetchApi" | grep -v "\.test\." \
    | grep -v "src/proxy.ts" | grep -v "src/lib/webhook-dispatcher.ts" \
    | grep -v "src/lib/url-helpers.ts"; then
    echo "ERROR: Found fetch() calls that should use fetchApi()"
    exit 1
  fi
'

if [ "$STATIC_ONLY" = "1" ]; then
  printf "${BOLD}▸ Secret scan${RESET}\n  (skipped — PRE_PR_STATIC_ONLY: this is the local --staged scan; CI runs a full-tree gitleaks scan in the secret-scan job)\n\n"
elif command -v gitleaks >/dev/null 2>&1; then
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
    failures+=("Secret scan (gitleaks fallback)|")
  fi
fi

# Refactor-phase verify — only for MOVE refactors (≥1 src rename). A content-only
# refactor/* branch (0 renames) doesn't need the move-only orchestrator: its
# rename-specific scripts no-op, and its rls/crypto/migration checks already run
# as standalone "Static:" steps above. Pass --skip-merge-queue-guards so the
# local run isn't false-failed by a stale, git-ignored
# .refactor-phase-verify-baseline; CI's refactor-phase-verify.yml keeps using
# --force WITHOUT the flag, so its behavior is unchanged.
if [ "$STATIC_ONLY" != "1" ] && git rev-parse --abbrev-ref HEAD | grep -q "^refactor/"; then
  # two-dot -M main (working tree) mirrors verify-move-only-diff.mjs:194; do NOT
  # change to main...HEAD — the gate's rename detector must match the verifier.
  if git diff --name-status -M main -- src | grep -qE '^[RC]'; then
    run_step "Refactor phase verify" node scripts/refactor-phase-verify.mjs --skip-merge-queue-guards
  else
    printf "${BOLD}▸ Refactor phase verify${RESET}\n  (skipped — content-only refactor: 0 src renames; CI's Refactor Phase Verify workflow is authoritative)\n\n"
  fi
fi

# Manual-test artifact gate (R35 Tier-1) — fails if admin-IA changes ship
# without an accompanying docs/archive/review/*-manual-test.md.
if git diff --name-only main...HEAD | grep -q '^src/app/\[locale\]/admin/'; then
  if ! git diff --name-only --diff-filter=A main...HEAD | grep -q '^docs/archive/review/.*-manual-test\.md$'; then
    printf "${RED}ERROR: admin/ changes detected but no docs/archive/review/*-manual-test.md added (R35 Tier-1)${RESET}\n" >&2
    failed=$((failed + 1))
    failures+=("Manual-test artifact gate (R35 Tier-1)|")
  else
    printf "${GREEN}  ✓ Manual-test artifact gate (R35 Tier-1)${RESET}\n\n"
    passed=$((passed + 1))
  fi
fi
if [ "$STATIC_ONLY" != "1" ] && [ "$RUN_WEB" = "1" ]; then
  # Clear vitest cache to match CI's clean environment
  rm -rf node_modules/.vitest extension/node_modules/.vitest 2>/dev/null || true
  run_step "Test"                   npx vitest run
fi

# Integration tests on refactor branches touching auth/DB modules.
# Round 4: T10 (regex covers pre- and post-PR-5 paths), T13 (DB reachability + 3s timeout),
# T22 (CI via ci-integration.yml is authoritative; this local run is a preview).
# Set PREPR_SKIP_INTEGRATION=1 to defer to CI.
if [ "$STATIC_ONLY" != "1" ] && [ "$RUN_WEB" = "1" ] && \
   git rev-parse --abbrev-ref HEAD | grep -q "^refactor/" && \
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

if [ "$STATIC_ONLY" != "1" ] && [ "$RUN_WEB" = "1" ]; then
  run_step "Build"                  npx next build
fi

# Multi-package build + test — mirror CI's "CLI: Build → Test" and
# "Extension: Test → Build" jobs so a package-level break (e.g. an ESM .js
# extension omission that tsc catches but vitest/esbuild tolerates) is caught
# locally, not first in CI. iOS is intentionally excluded: its CI job is
# `xcodebuild` on macos-latest and is not reproducible in this local gate.
# pre-pr does NOT `npm ci` (slow/destructive); it reuses installed deps and
# fails with an actionable hint if a package's node_modules is absent.
if [ "$STATIC_ONLY" != "1" ] && [ "$RUN_WEB" = "1" ]; then
  # CLI: Build → Test (CI order — tsc must run first; cli/ is ESM NodeNext, so a
  # missing .js extension is a tsc TS2835 error that vitest/esbuild tolerates).
  if [ ! -d cli/node_modules ]; then
    printf "${RED}ERROR: cli/node_modules missing — run 'cd cli && npm ci' (pre-pr does not auto-install)${RESET}\n\n" >&2
    failed=$((failed + 1))
    failures+=("CLI: deps missing|")
  else
    run_step "CLI: Build"  bash -c 'cd cli && npm run build'
    run_step "CLI: Test"   bash -c 'cd cli && npm test'
  fi

  # Extension: Test → Build (CI order).
  if [ ! -d extension/node_modules ]; then
    printf "${RED}ERROR: extension/node_modules missing — run 'cd extension && npm ci' (pre-pr does not auto-install)${RESET}\n\n" >&2
    failed=$((failed + 1))
    failures+=("Extension: deps missing|")
  else
    run_step "Extension: Test"   bash -c 'cd extension && npm test'
    run_step "Extension: Build"  bash -c 'cd extension && npm run build'
  fi
fi

echo ""
printf "${BOLD}═══ Results ═══${RESET}\n"
printf "${GREEN}  Passed: %d${RESET}\n" "$passed"

if [ "$failed" -gt 0 ]; then
  printf "${RED}  Failed: %d${RESET}\n" "$failed"
  for failure in "${failures[@]}"; do
    printf "${RED}    - %s${RESET}\n" "${failure%%|*}"
  done
  echo ""
  printf "${BOLD}═══ Failure Context ═══${RESET}\n"
  for failure in "${failures[@]}"; do
    show_failure_context "${failure%%|*}" "${failure#*|}"
  done
  echo ""
  printf "${RED}${BOLD}✗ Pre-PR checks failed. Fix the above before creating a PR.${RESET}\n"
  exit 1
fi

echo ""
printf "${GREEN}${BOLD}✓ All pre-PR checks passed. Ready to create PR.${RESET}\n"
