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
  # `eslint\.extension\.config\.` is listed separately: `eslint\.config\.` does NOT
  # match `eslint.extension.config.mjs`, so without it a PR editing only that file
  # (which is what adding an entry to its two-file override audit surface looks
  # like) would skip the self-test that proves the gate can still fail.
  local app_paths='^(Dockerfile|docker-compose.*\.yml|src/|prisma/|proxy\.ts|instrumentation\.ts|messages/|package\.json|package-lock\.json|tsconfig.*\.json|vitest\.config\.|eslint\.config\.|eslint\.extension\.config\.|next\.config\.|scripts/)'
  local base diff ref
  # Prefer origin/main (CI's base; survives a stale local main) and fall back to
  # local main only if the remote ref is absent.
  ref=origin/main
  git rev-parse --verify --quiet "$ref" >/dev/null 2>&1 || ref=main
  base=$(git merge-base "$ref" HEAD 2>/dev/null) || return 0  # no base ⇒ run all
  diff=$(git diff --name-only "$base"...HEAD 2>/dev/null) || return 0
  # Empty diff (e.g. nothing committed yet) ⇒ run all, can't prove iOS-only.
  [ -z "$diff" ] && return 0
  grep -qE "$app_paths" <<<"$diff"
}
if detect_web_changes; then
  RUN_WEB=1
else
  RUN_WEB=0
fi

# Captured once, and fed to the branch-shape tests below as a herestring rather
# than piped: `git … | grep -q` dies with SIGPIPE when grep matches and exits
# first, and pipefail turns that into "no match" — silently skipping the very
# steps the match was supposed to enable.
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)

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
      first_line=$(head -1 | cut -d: -f1) <<<"$matches"
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

# ── Bounded-parallel batch runner ───────────────────────────────────────────
# Only the contiguous block of independent static checks below goes through
# this; everything else keeps using run_step directly. Those checks are pure
# readers of the working tree (the only two that write anything use their own
# `mktemp -d`), so they can run concurrently — the block was ~90% of the
# static phase's wall clock and almost all of it was spent waiting.
#
# Contract (each clause exists because the naive version of it is a real bug,
# verified by probe on bash 5.2):
#   * counters are mutated ONLY here in the parent shell during replay. A
#     backgrounded job's writes to `passed`/`failed` are discarded on exit, so
#     incrementing inside the job silently reports "Passed: 0 / Failed: 0".
#   * `wait -n` is a THROTTLE ONLY and its status is discarded. It does not say
#     which job it reaped, so assigning its status to the dispatch loop's index
#     blames the wrong step: measured 7 0 0 against a truth of 0 0 7, i.e. a
#     failing gate reported as passing.
#   * the join reads status per index through an `if`, never a bare
#     `wait "$pid"`. Under this script's `set -e` a non-zero bare wait kills the
#     run outright: the remaining gates are never joined and the Results block
#     never prints, so a single failure silently truncates the gate set.
#   * every `wait` return value IS that step's status. 127 means the step's
#     command was not found — never "no such job".
#   * results replay in declaration order regardless of completion order, so
#     output stays diff-comparable with the serial path, and each step's log is
#     printed for PASSES too (the serial path's `tee` shows them, and several
#     gates print CI-auditable config on success).
batch_labels=()
batch_cmds=()

queue_step() {
  local label="$1"
  shift
  batch_labels+=("$label")
  # Store argv safely for later eval-free replay via bash arrays-of-strings.
  batch_cmds+=("$(printf '%q ' "$@")")
}

resolve_jobs() {
  local want="${PRE_PR_JOBS:-}" cores cap
  cores=$( { command -v nproc >/dev/null 2>&1 && nproc; } || echo 4)
  cap=$(( cores < 8 ? cores : 8 ))
  [ "$cap" -lt 1 ] && cap=1
  # Untrusted input: anything non-numeric or out of range falls back to the
  # cap rather than to unbounded (PRE_PR_JOBS=0 would otherwise spin forever).
  case "$want" in
    ''|*[!0-9]*) printf '%s' "$cap" ;;
    *) if [ "$want" -lt 1 ]; then printf '%s' 1
       elif [ "$want" -gt "$cap" ]; then printf '%s' "$cap"
       else printf '%s' "$want"; fi ;;
  esac
}

run_batch() {
  local n=${#batch_labels[@]}
  [ "$n" -eq 0 ] && return 0
  local jobs i ec active=0
  local -a pids logs
  jobs=$(resolve_jobs)

  # `wait -n` (wait for ANY child) needs bash 4.3+. On bash 3.2 — still the
  # system bash on macOS, and the version the sibling gates deliberately stay
  # compatible with — it fails immediately, and a `|| true` would swallow that
  # and mark a slot free without anything having finished. The throttle would
  # then be a no-op: measured 6 concurrent children against a cap of 2, i.e.
  # every queued gate launching at once and PRE_PR_JOBS=1 not serializing.
  # Fall back to waiting on the OLDEST outstanding job, which is bounded and
  # correct everywhere, just slightly less eager.
  # `wait -n` landed in bash 4.3, so the test is ">= 4.3", spelled as
  # "major > 4" OR "major == 4 AND minor >= 3". Note it is `> 4`, not `>= 4`:
  # with `>=` the 4.0-4.2 range would wrongly take the `wait -n` path and hit
  # exactly the runaway described above.
  local wait_any=0
  if ((BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3))); then
    wait_any=1
  fi
  local oldest=0

  for ((i = 0; i < n; i++)); do
    logs[i]=$(mktemp -t "pre-pr.XXXXXX")
    tempfiles+=("${logs[i]}")
    # No `tee`, no shared pipe: each job owns its logfile, so nothing
    # interleaves and no pipeline can mask the exit status.
    bash -c "${batch_cmds[i]}" >"${logs[i]}" 2>&1 &
    pids[i]=$!
    active=$((active + 1))
    if [ "$active" -ge "$jobs" ]; then
      # Throttle only — the status is deliberately dropped in BOTH branches.
      # `wait -n` cannot say which job it reaped, so using its status here
      # would attribute a failure to the wrong step; verdicts are read per
      # index in the join phase below.
      if [ "$wait_any" -eq 1 ]; then
        wait -n 2>/dev/null || true
      else
        wait "${pids[oldest]}" 2>/dev/null || true
        oldest=$((oldest + 1))
      fi
      active=$((active - 1))
    fi
  done

  for ((i = 0; i < n; i++)); do
    if wait "${pids[i]}" 2>/dev/null; then ec=0; else ec=$?; fi
    printf "${BOLD}▸ %s${RESET}\n" "${batch_labels[i]}"
    [ -s "${logs[i]}" ] && cat "${logs[i]}"
    if [ "$ec" -eq 0 ]; then
      printf "${GREEN}  ✓ %s${RESET}\n\n" "${batch_labels[i]}"
      passed=$((passed + 1))
      rm -f "${logs[i]}"
    else
      printf "${RED}  ✗ %s${RESET}\n\n" "${batch_labels[i]}"
      failed=$((failed + 1))
      failures+=("${batch_labels[i]}|${logs[i]}")
    fi
  done

  batch_labels=()
  batch_cmds=()
}

echo ""
printf "${BOLD}═══ Pre-PR Checks ═══${RESET}\n\n"

queue_step "Static: e2e-selectors"  bash scripts/checks/check-e2e-selectors.sh
queue_step "Static: security-doc-exists" bash scripts/checks/check-security-doc-exists.sh
queue_step "Static: test-hygiene"   bash scripts/checks/check-test-hygiene.sh
queue_step "Static: settings-card-layout"  bash scripts/checks/check-settings-card-layout.sh
queue_step "Static: api-error-codes" bash scripts/checks/check-api-error-codes.sh
queue_step "Static: console-sinks"  node scripts/checks/check-console-sinks.mjs
queue_step "Static: extension no-console" node scripts/checks/lint-extension.mjs
queue_step "Static: boot-diagnostic-shape" node scripts/checks/check-boot-diagnostic-shape.mjs
queue_step "Static: public-contract" node scripts/checks/check-public-contract.mjs
queue_step "Static: api-error-body-drift" bash scripts/checks/check-api-error-body-drift.sh
queue_step "Static: fail-closed-routes-have-test" bash scripts/checks/check-fail-closed-routes-have-test.sh
queue_step "Static: permanent-delete-stepup" bash scripts/checks/check-permanent-delete-stepup.sh
queue_step "Static: step-up-client-coverage" bash scripts/checks/check-step-up-client-coverage.sh
queue_step "Static: passkey-mint-gate" bash scripts/checks/check-passkey-mint-gate.sh
queue_step "Static: raw-body-read" bash scripts/checks/check-raw-body-read.sh
queue_step "Static: actions-sha-pinned" bash scripts/checks/check-actions-sha-pinned.sh
queue_step "Static: workflow-supply-chain" node scripts/checks/check-workflow-supply-chain.mjs
queue_step "Static: crypto-auth-deps-classified" node scripts/checks/check-crypto-auth-deps-classified.mjs
queue_step "Static: dockerfile-prisma-pin" bash scripts/checks/check-dockerfile-prisma-pin.sh
queue_step "Static: dockerignore-secrets" bash scripts/checks/check-dockerignore-secrets.sh
queue_step "Static: cosign-kms-uri" bash scripts/checks/check-cosign-kms-uri.sh
queue_step "Smoke: worker-bundle-boot" bash scripts/checks/check-worker-bundle-smoke.sh
queue_step "Static: critical-audit-atomic" node scripts/checks/check-critical-audit-atomic.mjs
queue_step "Static: session-token-hashed" node scripts/checks/check-session-token-hashed.mjs
queue_step "Static: bound-unknown-ip" node scripts/checks/check-bound-unknown-ip.mjs
queue_step "Static: publish-toolchain" bash scripts/checks/check-publish-toolchain.sh
queue_step "Static: ios-no-diagnostic-logging" bash scripts/checks/check-ios-no-diagnostic-logging.sh
queue_step "Static: ios-authenticated-session-pinning" bash scripts/checks/check-ios-authenticated-session-pinning.sh
# Runs here (ubuntu OpenSSL 3.x), never the macOS iOS job — the .p12 fixtures are
# -legacy-encrypted and macOS LibreSSL rejects `openssl pkcs12 -legacy`.
queue_step "Static: tls-fixture-expiry" bash scripts/checks/check-tls-fixture-expiry.sh
run_batch

if [ "$RUN_WEB" != "1" ]; then
  printf "${BOLD}▸ Web steps skipped${RESET}  (no app-filter paths changed — iOS-only diff; set PRE_PR_FORCE_FULL=1 to override)\n\n"
fi

# Lint / Typecheck / Test / Build used to run here and at three later points,
# serially. They now run through the bounded scheduler at the end of the script
# instead, staged across two batches according to which of them write shared
# paths — see "Heavy web steps" below.
queue_step "Static: env drift check"  npm run check:env-docs
queue_step "Static: security-matrices drift check" npm run check:security-matrices
queue_step "Static: team-auth-rls"  node scripts/checks/check-team-auth-rls.mjs
queue_step "Static: bypass-rls"     node scripts/checks/check-bypass-rls.mjs
queue_step "Static: count-then-create-lock" node scripts/checks/check-count-then-create-lock.mjs
queue_step "Static: null-tenant-fail-closed" node scripts/checks/check-null-tenant-fail-closed.mjs
queue_step "Static: crypto-domains" node scripts/checks/check-crypto-domains.mjs
queue_step "Static: migration-drift" node scripts/checks/check-migration-drift.mjs
queue_step "Static: destructive-migration" node scripts/checks/check-destructive-migration.mjs
queue_step "Static: migration-transaction" node scripts/checks/check-migration-transaction.mjs
queue_step "Static: raw-sql-usage" node scripts/checks/check-raw-sql-usage.mjs
queue_step "Static: gate-selftest-coverage" bash scripts/checks/check-gate-selftest-coverage.sh
queue_step "Static: no-pipe-into-grep-q" bash scripts/checks/check-no-pipe-into-grep-q.sh
queue_step "Static: destructive-wrapper-derivation" node scripts/checks/check-destructive-wrapper-derivation.mjs
run_batch
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
run_step "Static: no-deprecated-logAudit" bash -c 'hits=$(grep -rn "logAudit(" src/ --include="*.ts" --include="*.tsx" | grep -v "logAuditAsync\|logAuditInTx" | grep -v "\.test\." | grep -v "^\s*//" | grep -v "^\s*\*" || true); if [ -n "$hits" ]; then echo "Residual logAudit() calls found:"; printf "%s\n" "$hits"; exit 1; fi'

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
  if grep -iqE "\\b(UPDATE|INSERT|DELETE|TRUNCATE)\\b" <<<"$SQL_BODY"; then
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
  argon2_hits=$(grep -rnE "(from\s+[\x22\x27]argon2-browser[\x22\x27]|require\([\x22\x27]argon2-browser[\x22\x27]\))" \
    src/ 2>/dev/null | grep -v "\\.test\\." || true)
  if [ -n "$argon2_hits" ]; then
    echo "ERROR: argon2-browser import detected — A06-2 forbids re-introduction; use hash-wasm."
    printf "%s\n" "$argon2_hits"
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
  # gitleaks 8.19+ moved the staged scan from `detect --staged` to
  # `git --staged`; `detect` now rejects the flag outright ("unknown flag:
  # --staged"), so the old invocation FAILED the step on every run rather than
  # scanning anything. Pick the form this binary supports so the scan actually
  # runs on both generations.
  if gitleaks git --help >/dev/null 2>&1; then
    run_step "Secret scan (gitleaks)" gitleaks git --no-banner --redact --staged
  else
    run_step "Secret scan (gitleaks)" gitleaks detect --no-banner --redact --staged
  fi
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
if [ "$STATIC_ONLY" != "1" ] && grep -q "^refactor/" <<<"$CURRENT_BRANCH"; then
  # two-dot -M main (working tree) mirrors verify-move-only-diff.mjs:194; do NOT
  # change to main...HEAD — the gate's rename detector must match the verifier.
  src_rename_status=$(git diff --name-status -M main -- src 2>/dev/null || true)
  if grep -qE '^[RC]' <<<"$src_rename_status"; then
    run_step "Refactor phase verify" node scripts/refactor-phase-verify.mjs --skip-merge-queue-guards
  else
    printf "${BOLD}▸ Refactor phase verify${RESET}\n  (skipped — content-only refactor: 0 src renames; CI's Refactor Phase Verify workflow is authoritative)\n\n"
  fi
fi

# Manual-test artifact gate (R35 Tier-1) — fails if admin-IA changes ship
# without an accompanying docs/archive/review/*-manual-test.md.
branch_changed_files=$(git diff --name-only main...HEAD 2>/dev/null || true)
branch_added_files=$(git diff --name-only --diff-filter=A main...HEAD 2>/dev/null || true)
if grep -q '^src/app/\[locale\]/admin/' <<<"$branch_changed_files"; then
  if ! grep -q '^docs/archive/review/.*-manual-test\.md$' <<<"$branch_added_files"; then
    printf "${RED}ERROR: admin/ changes detected but no docs/archive/review/*-manual-test.md added (R35 Tier-1)${RESET}\n" >&2
    failed=$((failed + 1))
    failures+=("Manual-test artifact gate (R35 Tier-1)|")
  else
    printf "${GREEN}  ✓ Manual-test artifact gate (R35 Tier-1)${RESET}\n\n"
    passed=$((passed + 1))
  fi
fi
if [ "$STATIC_ONLY" != "1" ] && [ "$RUN_WEB" = "1" ]; then
  # Clear vitest cache to match CI's clean environment. This is a repo-global
  # mutation, so it must happen BEFORE the heavy batch starts — not inside a
  # job racing the Extension test that shares extension/node_modules/.vitest.
  rm -rf node_modules/.vitest extension/node_modules/.vitest 2>/dev/null || true
fi

# Integration tests on refactor branches touching auth/DB modules.
# Round 4: T10 (regex covers pre- and post-PR-5 paths), T13 (DB reachability + 3s timeout),
# T22 (CI via ci-integration.yml is authoritative; this local run is a preview).
# Set PREPR_SKIP_INTEGRATION=1 to defer to CI.
if [ "$STATIC_ONLY" != "1" ] && [ "$RUN_WEB" = "1" ] && \
   grep -q "^refactor/" <<<"$CURRENT_BRANCH" && \
   grep -qE '^src/lib/(prisma|redis|tenant-(context|rls)|auth/.+-token)\.ts$|^src/lib/(prisma|tenant|auth)/' \
     <<<"$branch_changed_files"; then
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

# Build is dispatched in the heavy batch below, not here.

# Multi-package build + test — mirror CI's "CLI: Build → Test" and
# "Extension: Test → Build" jobs so a package-level break (e.g. an ESM .js
# extension omission that tsc catches but vitest/esbuild tolerates) is caught
# locally, not first in CI. iOS is intentionally excluded: its CI job is
# `xcodebuild` on macos-latest and is not reproducible in this local gate.
# pre-pr does NOT `npm ci` (slow/destructive); it reuses installed deps and
# fails with an actionable hint if a package's node_modules is absent.
# ── Heavy web steps ─────────────────────────────────────────────────────────
# Lint / Typecheck / Test / Build / CLI / Extension are the bulk of a full run
# (~150s of a ~160s wall clock; the ~40 static gates above are ~11s), so they
# go through the same bounded scheduler.
#
# Most are pure readers of the working tree and can run in any order. The
# exceptions are the ones that WRITE, and they are what the staging below is
# for: `next build` writes .next/ (and Typecheck reads it), CLI: Build writes
# cli/dist (and CLI: Test reads it), Extension: Build writes its own output.
# Steps are placed in a batch according to those shared write targets, not
# merely by how long they take.
#
# Ordering constraints are honored by STAGING across two batches, never by
# chaining steps together — a step that must follow another is queued in the
# later batch, so it still runs and reports even when the earlier one fails:
#
#   batch 1: Lint, Test, Build, CLI: Build,  Extension: Test
#   batch 2:       Typecheck,   CLI: Test,   Extension: Build
#
#   * CLI is Build→Test (cli/ is ESM NodeNext, so a missing .js extension is a
#     tsc TS2835 error that vitest/esbuild tolerate) and Extension is
#     Test→Build — matching the CI job names.
#   * Typecheck reads .next/types/**, which Build generates.
#
# Do NOT collapse a pair into one `a && b` job to express the order: `&&` skips
# the second half whenever the first fails, so a broken CLI build would leave
# CLI Test unevaluated. That is the same truncated-gate-run failure the join
# phase above is written to avoid, and pre-pr-run-batch.test.mjs pins it.
#
# Memory: measured peak RSS is Build ~3.1G, Lint ~1.6G, Typecheck ~1.2G, Test
# ~0.6G — ~6.5G combined against 47G available here. PRE_PR_JOBS caps the
# concurrency, so a smaller machine runs fewer at once rather than thrashing.
if [ "$STATIC_ONLY" != "1" ] && [ "$RUN_WEB" = "1" ]; then
  # Typecheck is NOT in this batch — it is the one step with a real dependency
  # on another. `tsconfig.json` includes `.next/types/**/*.ts`, which `next
  # build` generates, so running the two concurrently makes tsc read a
  # half-written tree:
  #   .next/types/validator.ts: error TS2307: Cannot find module './routes.js'
  # It therefore runs in a second batch below, after Build has finished.
  #
  # Build itself is safe here despite writing `.next/`: no test in the suite
  # reads that directory. (Two tests DID fail when Build first joined the
  # batch — but both were 10s-timeout expiries under CPU contention, not file
  # races, and they no longer occur now that Build overlaps Test rather than
  # competing with the whole batch.)
  queue_step "Lint"       npx eslint .
  queue_step "Test"       npx vitest run
  queue_step "Build"      npx next build

  # CLI is Build→Test and Extension is Test→Build (CI order). Each pair is
  # SPLIT ACROSS THE TWO BATCHES rather than chained with `&&` in one job:
  # `&&` would skip the second half whenever the first fails, so a broken CLI
  # build would leave CLI Test unevaluated — the same "truncated gate run"
  # the serial script never had, where all four were independent run_steps.
  # Staging keeps the required order while both halves always run and report.
  cli_ok=0
  if [ ! -d cli/node_modules ]; then
    printf "${RED}ERROR: cli/node_modules missing — run 'cd cli && npm ci' (pre-pr does not auto-install)${RESET}\n\n" >&2
    failed=$((failed + 1))
    failures+=("CLI: deps missing|")
  else
    cli_ok=1
    queue_step "CLI: Build"  bash -c 'cd cli && npm run build'
  fi

  ext_ok=0
  if [ ! -d extension/node_modules ]; then
    printf "${RED}ERROR: extension/node_modules missing — run 'cd extension && npm ci' (pre-pr does not auto-install)${RESET}\n\n" >&2
    failed=$((failed + 1))
    failures+=("Extension: deps missing|")
  else
    ext_ok=1
    queue_step "Extension: Test"  bash -c 'cd extension && npm test'
  fi

  run_batch

  # Second batch: steps that must observe the first batch's output.
  #   Typecheck  — reads .next/types/**, which Build generates.
  #   CLI: Test  — runs against cli/dist from CLI: Build.
  #   Extension: Build — CI runs it after Extension: Test.
  queue_step "Typecheck"  npx tsc --noEmit
  if [ "$cli_ok" = "1" ]; then
    queue_step "CLI: Test"  bash -c 'cd cli && npm test'
  fi
  if [ "$ext_ok" = "1" ]; then
    queue_step "Extension: Build"  bash -c 'cd extension && npm run build'
  fi
  run_batch

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
