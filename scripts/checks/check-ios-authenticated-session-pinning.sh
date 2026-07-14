#!/usr/bin/env bash
# CI/pre-PR guard: every iOS production request that carries an Authorization
# or DPoP header MUST run over a TLS-pinned URLSession. Enforced structurally,
# not by trusting the author to remember.
#
# Threat model: an authenticated same-server client added later constructs its
# own `URLSession(...)` (or reaches for `URLSession.shared`) instead of deriving
# the session from `ServerTrustService`. That session skips leaf-key pinning, so
# a MITM that presents any CA-valid certificate for the host silently harvests a
# live access/refresh token. This is exactly the regression `EntryUploader`'s
# comment warns about ("a `.shared` default previously let the AutoFill caller
# silently … "). The current tree is clean; this guard keeps it that way.
#
# Rule (derivation-based, NOT a blanket `URLSession(` ban):
#   A production Swift file that sets HTTPHeader.authorization or HTTPHeader.dpop
#   must NOT itself construct a URLSession. It must obtain the session from a
#   pinned primitive — by constructor injection, `ServerTrustService`,
#   `pinnedSession(`, or `validatedSession(`. The ONE file allowed to call
#   `URLSession(` is the pinning primitive itself (ServerTrustService.swift),
#   which is where the LeafKeyPinningDelegate is wired in.
#
# A blanket ban would false-positive on non-authenticated, third-party, or
# public-API traffic; keying off the auth-header primitives targets only
# credential-bearing calls. New legitimately-unpinned callers (none today) go in
# UNPINNED_ALLOWLIST with a one-line justification.
#
# Exit 0 = clean, Exit 1 = an authenticated file constructs its own session.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IOS_DIR="$REPO_ROOT/ios"

# Files permitted to call `URLSession(` despite (or because of) their role.
# Justify every entry — an unjustified addition defeats the guard.
#
#   Shared/Network/ServerTrustService.swift
#     The pinning primitive. It builds the URLSession WITH the
#     LeafKeyPinningDelegate attached; this is the single sanctioned
#     construction site every other caller derives from.
UNPINNED_ALLOWLIST=(
  "Shared/Network/ServerTrustService.swift"
)

# Header primitives that mark a request as credential-bearing.
AUTH_HEADER_PATTERN='forHTTPHeaderField: HTTPHeader\.(authorization|dpop)'
# Session construction primitives that bypass the pinned derivation path.
SESSION_CTOR_PATTERN='URLSession\(|URLSession\.shared'

is_allowlisted() {
  local rel="$1" entry
  for entry in "${UNPINNED_ALLOWLIST[@]}"; do
    [ "$rel" = "$entry" ] && return 0
  done
  return 1
}

fail=0

# Enumerate production Swift files (exclude the test targets) that set an
# auth/DPoP header, then flag any that also construct a session.
while IFS= read -r abs; do
  [ -n "$abs" ] || continue
  rel="${abs#"$IOS_DIR"/}"

  ctor_hits="$(grep -nE -- "$SESSION_CTOR_PATTERN" "$abs" 2>/dev/null || true)"
  [ -n "$ctor_hits" ] || continue

  if is_allowlisted "$rel"; then
    echo "OK (allowlisted): $rel constructs a URLSession by design"
    continue
  fi

  echo "FAIL: authenticated file constructs its own URLSession (must be pinned): $rel" >&2
  echo "$ctor_hits" | sed 's/^/    /' >&2
  fail=1
done < <(
  grep -rlE --include='*.swift' -- "$AUTH_HEADER_PATTERN" \
    "$IOS_DIR/PasswdSSOApp" "$IOS_DIR/Shared" "$IOS_DIR/PasswdSSOAutofillExtension" 2>/dev/null \
    | grep -vE '/(PasswdSSOTests|PasswdSSOUITests)/' \
    | sort
)

# Second, independent guard: the allowlist must not name a file that no longer
# constructs a session (stale allowlist entries hide future violations by
# whitelisting a file that has stopped being the sanctioned construction site).
for entry in "${UNPINNED_ALLOWLIST[@]}"; do
  abs="$IOS_DIR/$entry"
  if [ ! -f "$abs" ]; then
    echo "FAIL: UNPINNED_ALLOWLIST names a missing file: $entry" >&2
    echo "    Update this guard's allowlist to match the moved/renamed primitive." >&2
    fail=1
  elif ! grep -qE -- "$SESSION_CTOR_PATTERN" "$abs" 2>/dev/null; then
    echo "FAIL: UNPINNED_ALLOWLIST names a file that no longer constructs a URLSession: $entry" >&2
    echo "    Remove the stale entry so the allowlist keeps meaning something." >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "iOS authenticated-session pinning guard failed." >&2
  echo "An Authorization/DPoP-bearing request must run over a pinned session." >&2
  echo "Derive it from ServerTrustService (pinnedSession/validatedSession) or" >&2
  echo "take a URLSession by constructor injection — do not build one inline." >&2
  exit 1
fi

echo "iOS authenticated-session pinning guard passed."
