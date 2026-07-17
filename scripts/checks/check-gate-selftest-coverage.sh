#!/usr/bin/env bash
# Meta-gate: every executable security gate must be proven able to fail
# (RT7 applied to the gates themselves) — a sibling self-test OR a reasoned
# debt entry, so a new gate cannot land untested.
#
# Background: docs/archive/review/security-control-verification-plan.md, C1.
# The individual `scripts/checks/*` gates each enforce a specific invariant
# (step-up, RLS, raw-SQL allowlisting, ...), but nothing enforced that the
# gates THEMSELVES fail when their target invariant is violated. A gate with
# a broken regex/parse path can silently green forever. This meta-gate closes
# that hole by requiring RT7 coverage (a fixture-driven test proving the gate
# both passes and fails) for every check, or an explicit debt entry.
#
# Member set (two independent primitives — both required so a new gate cannot
# evade the meta-gate by being written inline in pre-pr.sh instead of as a
# scripts/checks/ file):
#
#   (1) `ls scripts/checks/*.sh scripts/checks/*.mjs` — each file must have a
#       sibling `scripts/__tests__/<base>.test.mjs` or `.test.ts`, OR a
#       reasoned entry in the debt file.
#   (2) inline `run_step "Static: ..." bash -c '...'` gates in
#       scripts/pre-pr.sh (the "Static:" label prefix is the security-gate
#       anchor — CLI/Extension build+test run_step lines are excluded, they
#       are not security controls) — each MUST have a reasoned debt entry
#       (this round does not extract them into tested files; SC7, future
#       hardening). The anti-evasion guarantee (new inline Static: gates
#       cannot ship without a debt entry) is enforced now.
#
# Debt file format (scripts/checks/gate-selftest-debt.txt): one path or
# inline-gate-id per line, `# reason` required (mirrors stepup-delete-exempt.txt
# / raw-sql-usage.txt parse conventions). Path entries are `scripts/checks/<file>`;
# inline-gate entries are `pre-pr:<run_step label>` (the exact string passed as
# run_step's first argument).
#
# Fail-closed:
#   MISSING_GATE_SELFTEST: <path>       — check has no test and no debt entry
#   DEBT_ENTRY_WITHOUT_REASON: <line>   — debt entry missing a non-trivial reason
#   STALE_DEBT_ENTRY: <entry>           — debt entry names a check/inline-gate
#                                          that no longer exists (mirrors
#                                          check-permanent-delete-stepup.sh's
#                                          STALE_EXEMPT anti-drift check)
#
# Env-pollution guard (sec-F6): when CI=true and any override is set, require
# GATE_SELFTEST_FIXTURE_MODE=1 or exit 1 — a stray `export` leaking an
# override into a real CI run must not silently point the gate at an empty
# fixture dir and green it.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

CHECKS_DIR="${GATE_SELFTEST_CHECKS_DIR:-$REPO_ROOT/scripts/checks}"
TESTS_DIR="${GATE_SELFTEST_TESTS_DIR:-$REPO_ROOT/scripts/__tests__}"
DEBT_FILE="${GATE_SELFTEST_DEBT_FILE:-$REPO_ROOT/scripts/checks/gate-selftest-debt.txt}"
PREPR_FILE="${GATE_SELFTEST_PREPR_FILE:-$REPO_ROOT/scripts/pre-pr.sh}"

# CI-auditable: print effective paths on one line.
echo "check-gate-selftest-coverage: CHECKS_DIR=$CHECKS_DIR TESTS_DIR=$TESTS_DIR DEBT_FILE=$DEBT_FILE PREPR_FILE=$PREPR_FILE"

# sec-F6: env-pollution guard. Any override + CI=true requires an explicit
# fixture-mode acknowledgement.
if [ "${CI:-}" = "true" ]; then
  if [ -n "${GATE_SELFTEST_CHECKS_DIR:-}" ] || [ -n "${GATE_SELFTEST_TESTS_DIR:-}" ] || \
     [ -n "${GATE_SELFTEST_DEBT_FILE:-}" ] || [ -n "${GATE_SELFTEST_PREPR_FILE:-}" ]; then
    if [ "${GATE_SELFTEST_FIXTURE_MODE:-}" != "1" ]; then
      echo "ENV_POLLUTION_GUARD: GATE_SELFTEST_* override set under CI=true without GATE_SELFTEST_FIXTURE_MODE=1 — refusing to run against a possibly-unintended path."
      exit 1
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Parse the debt file. Format: `<entry># reason` (path or inline-gate id
# before the first `#`; reason after). Full-line `#` comments and blank
# lines are skipped. Every entry requires a reason of >=10 chars (mirrors
# stepup-delete-exempt.txt / raw-sql-usage.txt's MIN length convention).
# ---------------------------------------------------------------------------
DEBT_LIST=""
DEBT_PARSE_FAIL=0
if [ -f "$DEBT_FILE" ]; then
  while IFS= read -r raw; do
    raw="${raw%$'\r'}"
    trimmed="${raw#"${raw%%[![:space:]]*}"}"
    [ -z "$trimmed" ] && continue
    case "$trimmed" in \#*) continue ;; esac

    entry="${raw%%#*}"
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [ -z "$entry" ] && continue

    reason=""
    case "$raw" in *#*) reason="${raw#*#}" ;; esac
    reason="${reason#"${reason%%[![:space:]]*}"}"
    reason="${reason%"${reason##*[![:space:]]}"}"
    if [ "${#reason}" -lt 10 ]; then
      echo "DEBT_ENTRY_WITHOUT_REASON: $raw"
      DEBT_PARSE_FAIL=1
    fi

    DEBT_LIST="${DEBT_LIST}${entry}
"
  done < "$DEBT_FILE"
fi

if [ "$DEBT_PARSE_FAIL" -ne 0 ]; then
  exit 1
fi

is_debt() {
  printf '%s' "$DEBT_LIST" | grep -qxF "$1"
}

# ---------------------------------------------------------------------------
# Member set (1): scripts/checks/*.sh + *.mjs, each needs a sibling test or
# a debt entry keyed by its repo-relative path (scripts/checks/<file>).
# ---------------------------------------------------------------------------
fail=0
checks=()
while IFS= read -r f; do
  [ -n "$f" ] && checks+=("$f")
done < <(
  { ls "$CHECKS_DIR"/*.sh 2>/dev/null; ls "$CHECKS_DIR"/*.mjs 2>/dev/null; } | sort
)

check_keys=""
for check in ${checks[@]+"${checks[@]}"}; do
  base="$(basename "$check")"
  base_noext="${base%.sh}"
  base_noext="${base_noext%.mjs}"
  rel_key="scripts/checks/$base"
  check_keys="${check_keys}${rel_key}
"

  if [ -f "$TESTS_DIR/${base_noext}.test.mjs" ] || [ -f "$TESTS_DIR/${base_noext}.test.ts" ]; then
    continue # has sibling self-test
  fi
  if is_debt "$rel_key"; then
    continue # documented debt
  fi
  echo "MISSING_GATE_SELFTEST: $rel_key"
  fail=1
done

# ---------------------------------------------------------------------------
# Member set (2): inline `run_step "Static: <label>" bash -c '...'` gates in
# pre-pr.sh. Each MUST have a debt entry keyed by `pre-pr:<label>` — this
# round seeds them all into debt (SC7); the anti-evasion guarantee is that a
# NEW inline bash -c gate landing without a debt entry fails here.
# ---------------------------------------------------------------------------
inline_keys=""
if [ -f "$PREPR_FILE" ]; then
  # Match `run_step "Static: <label>" bash -c` lines only — the inline
  # SECURITY-gate shape (member-set anchor: "Static:" prefix). Non-`bash -c`
  # run_step lines (e.g. `run_step "Static: foo" bash scripts/checks/foo.sh`)
  # are covered by member set (1) via their target script file. Non-"Static:"
  # run_step lines (CLI/Extension build+test steps) are build/test orchestration,
  # not security gates, and are intentionally out of this meta-gate's scope.
  while IFS= read -r label; do
    [ -z "$label" ] && continue
    inline_key="pre-pr:${label}"
    inline_keys="${inline_keys}${inline_key}
"
    if is_debt "$inline_key"; then
      continue
    fi
    echo "MISSING_GATE_SELFTEST: $inline_key (inline bash -c gate in $PREPR_FILE with no debt entry)"
    fail=1
  done < <(
    grep -oE 'run_step[[:space:]]+"Static:[^"]*"[[:space:]]+bash[[:space:]]+-c' "$PREPR_FILE" \
      | sed -E 's/^run_step[[:space:]]+"([^"]*)".*/\1/'
  )
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "Add a sibling scripts/__tests__/<base>.test.mjs (or .test.ts) self-test for the check,"
  echo "OR add a reasoned entry to scripts/checks/gate-selftest-debt.txt."
  echo "See docs/archive/review/security-control-verification-plan.md (C1)."
  exit 1
fi

# ---------------------------------------------------------------------------
# Anti-drift (sec-F5, mirrors check-permanent-delete-stepup.sh's STALE_EXEMPT):
# every debt entry must still name a check/inline-gate that actually exists.
# ---------------------------------------------------------------------------
DEBT_DRIFT=0
while IFS= read -r debt_entry; do
  [ -z "$debt_entry" ] && continue
  case "$debt_entry" in
    pre-pr:*)
      inline_label="${debt_entry#pre-pr:}"
      if ! printf '%s' "$inline_keys" | grep -qxF "$debt_entry"; then
        echo "STALE_DEBT_ENTRY: $debt_entry (no inline \"$inline_label\" bash -c gate found in $PREPR_FILE)"
        DEBT_DRIFT=1
      fi
      ;;
    *)
      if ! printf '%s' "$check_keys" | grep -qxF "$debt_entry"; then
        echo "STALE_DEBT_ENTRY: $debt_entry (no such file under $CHECKS_DIR)"
        DEBT_DRIFT=1
      else
        # A debt entry whose check has SINCE gained a sibling self-test is
        # stale: the test now satisfies coverage, so the debt exemption must
        # be removed (otherwise debt never shrinks, and a later test deletion
        # would be masked by the lingering debt entry). Mirrors the header's
        # "a test since added" clause.
        debt_base="$(basename "$debt_entry")"
        debt_noext="${debt_base%.sh}"
        debt_noext="${debt_noext%.mjs}"
        if [ -f "$TESTS_DIR/${debt_noext}.test.mjs" ] || [ -f "$TESTS_DIR/${debt_noext}.test.ts" ]; then
          echo "STALE_DEBT_ENTRY: $debt_entry (a sibling self-test now exists — remove the debt entry)"
          DEBT_DRIFT=1
        fi
      fi
      ;;
  esac
done < <(printf '%s' "$DEBT_LIST")

if [ "$DEBT_DRIFT" -ne 0 ]; then
  exit 1
fi

exit 0
