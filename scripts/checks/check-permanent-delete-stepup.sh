#!/usr/bin/env bash
# CI gate: every API route that performs an IRREVERSIBLE vault-data hard-delete
# MUST call `requireRecentCurrentAuthMethod` (step-up reauth), OR be listed in
# the exempt allowlist (scripts/checks/stepup-delete-exempt.txt) with a reason.
#
# Background: the OWASP re-review (owasp-rereview-stepup-and-failclosed) found
# that bulk/wholesale permanent-purge endpoints lacked the step-up that single
# permanent-delete already required (a leaked session cookie could wipe data).
# That gap was an enumeration miss — the destructive route set was never
# mechanically defined. This guard makes the set machine-checked so a NEW
# destructive route cannot land step-up-free without an explicit, justified
# allowlist entry.
#
# Detection (route files only — src/app/api/**/route.ts):
#   A file is a "vault-destruction route" if it contains any of the
#   irreversible-delete primitives below (hard-delete of vault entry rows or a
#   full-vault wipe). Soft-deletes (`update { deletedAt }`), history-trim
#   (`passwordEntryHistory.*`), attachment-management deletes, and non-vault
#   tables are intentionally NOT matched.
#
#   passwordEntry.delete( / .deleteMany(        — personal entry hard-delete
#   teamPasswordEntry.delete( / .deleteMany(    — team entry hard-delete
#   executeVaultReset(                          — full-vault wipe (route call)
#   deleteTeamPassword(                         — team entry service (perm flag)
#   team.delete(                                — team deletion CASCADES to all
#                                                 team password entries (schema
#                                                 onDelete: Cascade) — wholesale
#                                                 vault-data destruction via the
#                                                 parent row, so it is in-class.
#
# Pass criteria, per matched file:
#   (a) the file also contains `requireRecentCurrentAuthMethod`, OR
#   (b) the file path appears in stepup-delete-exempt.txt.
#
# Fail: exits 1 with one MISSING_STEPUP line per offending route.
#
# Scope note: only `src/app/api/**/route.ts` is scanned. Service/worker files
# (src/lib/services, src/lib/vault, retention-gc worker) legitimately contain
# the delete primitives but are gated by the ROUTE that calls them; scanning
# them would false-positive. SCIM/maintenance hard-deletes target non-vault or
# non-entry tables and are excluded by the table-name-specific primitives.
#
# Known limitations (same granularity as the project's other grep-based guards):
#   - The gate is satisfied by ANY `requireRecentCurrentAuthMethod(` call in the
#     file, regardless of which HTTP method or branch it guards. This holds for
#     today's routes because every matched file is single-purpose (the
#     destructive method IS the gated one), but a future multi-handler route
#     that step-up's a GET while leaving its DELETE unguarded would pass. Such
#     routes need manual confirmation.
#   - A step-up call that is COMMENTED OUT still satisfies the call-pattern grep.
# The guard targets the realistic failure mode — a new destructive route landing
# with no step-up at all, or the line being deleted — both of which it catches.
# Deliberately commenting out / misplacing a security check is a conscious act
# for code review to catch; teaching this bash grep to do reachability/ordering
# analysis is not worth the fragility.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# Scan root, exempt file, and path-root are overridable so the self-test
# (scripts/__tests__/check-permanent-delete-stepup.test.mjs) can point the guard
# at fixtures. Production CI uses the defaults. Reported/exempt paths are
# resolved against PATH_ROOT; enumerated route paths are stripped of PATH_ROOT/
# so they print repo-relative.
API_DIR="${STEPUP_GUARD_API_DIR:-$REPO_ROOT/src/app/api}"
PATH_ROOT="${STEPUP_GUARD_PATH_ROOT:-$REPO_ROOT}"
EXEMPT_FILE="${STEPUP_GUARD_EXEMPT_FILE:-$REPO_ROOT/scripts/checks/stepup-delete-exempt.txt}"

# Build the exempt allowlist (paths only; strip comments/blanks/CR). bash 3.2
# has no associative arrays, so keep a newline-delimited list + grep -qxF.
#
# Every exempt entry MUST carry a non-trivial trailing `# reason` — the
# allowlist is the guard's only bypass, so a no-justification add (which would
# silently disable step-up on a destructive route) is rejected at the CI layer,
# not left to code-review vigilance.
EXEMPT_LIST=""
EXEMPT_PARSE_FAIL=0
if [ -f "$EXEMPT_FILE" ]; then
  while IFS= read -r raw; do
    raw="${raw%$'\r'}"
    # Skip blank lines and full-line comments.
    trimmed="${raw#"${raw%%[![:space:]]*}"}"
    [ -z "$trimmed" ] && continue
    case "$trimmed" in \#*) continue ;; esac

    # Path = text before the first `#`; reason = text after.
    path="${raw%%#*}"
    path="${path#"${path%%[![:space:]]*}"}"
    path="${path%"${path##*[![:space:]]}"}"
    [ -z "$path" ] && continue

    reason=""
    case "$raw" in *#*) reason="${raw#*#}" ;; esac
    reason="${reason#"${reason%%[![:space:]]*}"}"
    reason="${reason%"${reason##*[![:space:]]}"}"
    # Require a reason of at least a few characters (not just `#` or `# x`).
    if [ "${#reason}" -lt 10 ]; then
      echo "EXEMPT_NO_REASON: $path has no (or too short) justification comment in stepup-delete-exempt.txt — every exemption MUST state why step-up does not apply."
      EXEMPT_PARSE_FAIL=1
    fi

    EXEMPT_LIST="${EXEMPT_LIST}${path}
"
  done < "$EXEMPT_FILE"
fi

if [ "$EXEMPT_PARSE_FAIL" -ne 0 ]; then
  exit 1
fi

is_exempt() {
  printf '%s' "$EXEMPT_LIST" | grep -qxF "$1"
}

# Irreversible vault-data delete primitives (extended regex). Keep table-name
# specific so soft-deletes / history / attachments do not match. `team.delete(`
# is included because team deletion cascades to all team password entries.
DELETE_SIGNAL='passwordEntry\.delete(Many)?\(|teamPasswordEntry\.delete(Many)?\(|executeVaultReset\(|deleteTeamPassword\(|[^A-Za-z0-9_]team\.delete\('

# Enumerate candidate route files. bash 3.2 has no `mapfile`.
fail=0
routes=()
while IFS= read -r route_line; do
  [ -n "$route_line" ] && routes+=("$route_line")
done < <(
  grep -rlE "$DELETE_SIGNAL" "$API_DIR" --include='route.ts' 2>/dev/null \
    | sed "s|^$PATH_ROOT/||" \
    | sort
)

for route in ${routes[@]+"${routes[@]}"}; do
  # Require the call-shaped token `requireRecentCurrentAuthMethod(` (open paren),
  # not a bare import or a prefixed/renamed identifier
  # (e.g. DISABLED_requireRecentCurrentAuthMethod) — the leading boundary
  # [^A-Za-z0-9_] rejects an identifier that merely ends with the name. This is
  # still a grep, not an AST check: a COMMENTED-OUT call satisfies it too (see
  # the "Known limitations" note in the header) — catching that is left to code
  # review, by design.
  if grep -qE '(^|[^A-Za-z0-9_])requireRecentCurrentAuthMethod\(' "$PATH_ROOT/$route" 2>/dev/null; then
    continue # step-up present (called)
  fi
  if is_exempt "$route"; then
    continue # documented exemption
  fi
  echo "MISSING_STEPUP: $route performs an irreversible vault-data delete but does not call requireRecentCurrentAuthMethod (and is not in the exempt allowlist)."
  fail=1
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "Add 'const stepUp = await requireRecentCurrentAuthMethod(req); if (stepUp) return stepUp;'"
  echo "BEFORE the delete (for conditional ?permanent=true, gate it inside that branch),"
  echo "OR add the route to scripts/checks/stepup-delete-exempt.txt with a justified reason."
  echo "See docs/archive/review/owasp-rereview-stepup-and-failclosed-plan.md (C1)."
  exit 1
fi

# Anti-drift: every exempt entry must still be a real vault-destruction route.
# A stale allowlist entry (route deleted, or no longer hard-deletes) silently
# weakens the guard's documentation — fail so it gets cleaned up.
EXEMPT_DRIFT=0
while IFS= read -r exempt_path; do
  [ -z "$exempt_path" ] && continue
  if [ ! -f "$PATH_ROOT/$exempt_path" ]; then
    echo "STALE_EXEMPT: $exempt_path is allowlisted but the file does not exist."
    EXEMPT_DRIFT=1
    continue
  fi
  if ! grep -qE "$DELETE_SIGNAL" "$PATH_ROOT/$exempt_path" 2>/dev/null; then
    echo "STALE_EXEMPT: $exempt_path is allowlisted but no longer matches a vault-delete primitive — remove it from stepup-delete-exempt.txt."
    EXEMPT_DRIFT=1
  fi
done < <(printf '%s' "$EXEMPT_LIST")

if [ "$EXEMPT_DRIFT" -ne 0 ]; then
  exit 1
fi

exit 0
