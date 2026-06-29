#!/usr/bin/env bash
# CI gate: every API route that mints OR re-mints a token (initial issue OR
# refresh) MUST call `passkeyEnforcementBlocks` to enforce the tenant
# `requirePasskey` policy, OR be listed in the exempt allowlist
# (scripts/checks/passkey-mint-gate-exempt.txt) with a justified reason.
#
# Background: the passkey-enforcement-token-paths plan (C7) found that the
# tenant `requirePasskey` policy was enforced only at the web page-route layer;
# token-issuance choke points — extension bridge-code, iOS mobile authorize,
# MCP OAuth authorize/consent, and all three refresh routes — did NOT enforce
# it. A user signed in before enforcement could mint tokens without ever
# registering a passkey. This guard makes the gated set machine-checked so a
# new token-mint route cannot land gate-free without an explicit, justified
# allowlist entry.
#
# Detection (route files only — src/app/api/**/route.ts):
#   A file is a "mint/re-mint route" if it contains ANY of the token-producing
#   primitives below — both initial-mint AND refresh re-mint:
#
#   createAuthorizationCode       — MCP authorization code (initial)
#   extensionBridgeCode.create    — extension bridge code (initial)
#   mobileBridgeCode.create       — iOS mobile bridge code (initial)
#   issueAutofillToken            — iOS autofill token (initial, lib wrapper)
#   exchangeRefreshToken          — MCP refresh rotation (re-mint)
#   refreshIosToken               — iOS token refresh (re-mint, lib wrapper)
#   extensionToken.create         — extension token re-mint (refresh route)
#
# Note: `createRefreshToken` is intentionally NOT in this set. It is an
# initial-issue primitive in the MCP authorization_code branch, not a re-mint;
# the actual MCP rotation is `exchangeRefreshToken` (plan F13).
#
# Trigger is the MINT PRIMITIVE ALONE — not `await auth()`. The cookieless
# refresh routes (extension/token/refresh, mobile/token/refresh, mcp/token)
# have no `auth()` call, so triggering on it would miss exactly those routes.
#
# Pass criteria, per matched file:
#   (a) the file also contains `passkeyEnforcementBlocks`, OR
#   (b) the file path appears in passkey-mint-gate-exempt.txt.
#
# Fail: exits 1 with one MISSING_PASSKEY_GATE line per offending route.
#
# Scope note: only `src/app/api/**/route.ts` is scanned. Library/service files
# (src/lib/mcp/oauth-server.ts, src/lib/mobile/mobile-token.ts, etc.)
# legitimately contain these primitives as their implementations. The plan's
# C8 gate-layer decision (gate in the route, not the lib) keeps the route.ts
# scope sufficient — every gate call lives in the route file.
#
# Known limitations (same granularity as the project's other grep-based guards):
#   - Satisfied by ANY `passkeyEnforcementBlocks` token in the file, regardless
#     of which HTTP method or code path it guards. Multi-handler files that gate
#     only one method while leaving another ungated would pass. Such routes need
#     manual confirmation.
#   - A call that is COMMENTED OUT still satisfies the grep. Deliberately
#     commenting out a security gate is a conscious act for code review to catch.
# The guard targets the realistic failure mode — a new mint route landing with
# no gate at all, or the gate call being deleted entirely. Both of these it
# catches. AST-level flow analysis is not worth the fragility.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# Scan root, exempt file, and path-root are overridable so the self-test
# (scripts/__tests__/check-passkey-mint-gate.test.mjs) can point the guard
# at fixtures. Production CI uses the defaults. Reported/exempt paths are
# resolved against PATH_ROOT; enumerated route paths are stripped of PATH_ROOT/
# so they print repo-relative.
API_DIR="${MINT_GATE_API_DIR:-$REPO_ROOT/src/app/api}"
PATH_ROOT="${MINT_GATE_PATH_ROOT:-$REPO_ROOT}"
EXEMPT_FILE="${MINT_GATE_EXEMPT_FILE:-$REPO_ROOT/scripts/checks/passkey-mint-gate-exempt.txt}"

# Build the exempt allowlist (paths only; strip comments/blanks/CR). bash 3.2
# has no associative arrays, so keep a newline-delimited list + grep -qxF.
#
# Every exempt entry MUST carry a non-trivial trailing `# reason` — the
# allowlist is the guard's only bypass, so a no-justification add (which would
# silently disable the passkey gate on a mint route) is rejected at the CI
# layer, not left to code-review vigilance.
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
      echo "EXEMPT_NO_REASON: $path has no (or too short) justification comment in passkey-mint-gate-exempt.txt — every exemption MUST state why the passkey gate does not apply."
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

# Token-mint and token-refresh primitives (extended regex). Trigger on the
# primitive call shape; omit `createRefreshToken` (plan F13 — initial-issue
# only in the authorization_code branch, not a re-mint rotation).
MINT_SIGNAL='createAuthorizationCode|extensionBridgeCode\.create|mobileBridgeCode\.create|issueAutofillToken|exchangeRefreshToken|refreshIosToken|extensionToken\.create'

# Enumerate candidate route files.
fail=0
routes=()
while IFS= read -r route_line; do
  [ -n "$route_line" ] && routes+=("$route_line")
done < <(
  grep -rlE "$MINT_SIGNAL" "$API_DIR" --include='route.ts' 2>/dev/null \
    | sed "s|^$PATH_ROOT/||" \
    | sort
)

for route in ${routes[@]+"${routes[@]}"}; do
  if grep -qE '(^|[^A-Za-z0-9_])passkeyEnforcementBlocks\(' "$PATH_ROOT/$route" 2>/dev/null; then
    continue # gate present (called)
  fi
  if is_exempt "$route"; then
    continue # documented exemption
  fi
  echo "MISSING_PASSKEY_GATE: $route contains a token-mint or token-refresh primitive but does not call passkeyEnforcementBlocks (and is not in the exempt allowlist)."
  fail=1
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "Add 'if (passkeyEnforcementBlocks(state)) { /* refuse */ }' BEFORE the mint/re-mint call,"
  echo "OR add the route to scripts/checks/passkey-mint-gate-exempt.txt with a justified reason."
  echo "See docs/archive/review/passkey-enforcement-token-paths-plan.md (C7)."
  exit 1
fi

# Lib-level assertion: the token-mint library files that have absorbed the
# passkey gate from their callers MUST contain `passkeyEnforcementBlocks`.
# If either lib loses the gate call, the entire token class becomes unguarded
# regardless of whether the route is in the exempt allowlist.
LIB_GATE_FAIL=0
for lib_file in \
  "$PATH_ROOT/src/lib/mcp/oauth-server.ts" \
  "$PATH_ROOT/src/lib/auth/tokens/mobile-token.ts"
do
  if [ ! -f "$lib_file" ]; then
    echo "MISSING_LIB_PASSKEY_GATE: $lib_file does not exist (expected lib-level gate)."
    LIB_GATE_FAIL=1
    continue
  fi
  if ! grep -qE '(^|[^A-Za-z0-9_])passkeyEnforcementBlocks\(' "$lib_file" 2>/dev/null; then
    rel="${lib_file#"$PATH_ROOT/"}"
    echo "MISSING_LIB_PASSKEY_GATE: $rel must contain passkeyEnforcementBlocks (gate moved from route into lib — see passkey-mint-gate-exempt.txt)."
    LIB_GATE_FAIL=1
  fi
done

if [ "$LIB_GATE_FAIL" -ne 0 ]; then
  echo
  echo "The passkey gate was moved from the route into these lib functions to ensure"
  echo "replay detection fires before enforcement. Removing it from the lib leaves"
  echo "all token-mint paths in those libs completely unguarded."
  exit 1
fi

# Anti-drift: every exempt entry must still be a real mint/re-mint route.
# A stale allowlist entry (route deleted, or no longer mints) silently weakens
# the guard's documentation — fail so it gets cleaned up.
EXEMPT_DRIFT=0
while IFS= read -r exempt_path; do
  [ -z "$exempt_path" ] && continue
  if [ ! -f "$PATH_ROOT/$exempt_path" ]; then
    echo "STALE_EXEMPT: $exempt_path is allowlisted but the file does not exist."
    EXEMPT_DRIFT=1
    continue
  fi
  if ! grep -qE "$MINT_SIGNAL" "$PATH_ROOT/$exempt_path" 2>/dev/null; then
    echo "STALE_EXEMPT: $exempt_path is allowlisted but no longer matches a mint/re-mint primitive — remove it from passkey-mint-gate-exempt.txt."
    EXEMPT_DRIFT=1
  fi
done < <(printf '%s' "$EXEMPT_LIST")

if [ "$EXEMPT_DRIFT" -ne 0 ]; then
  exit 1
fi

exit 0
