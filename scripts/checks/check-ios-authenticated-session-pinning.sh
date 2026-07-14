#!/usr/bin/env bash
# CI/pre-PR guard: no iOS production code constructs a raw URLSession. Every
# request must run over a TLS-pinned session derived from ServerTrustService.
# Enforced structurally, not by trusting the author to remember.
#
# Threat model: an authenticated same-server client added later builds its own
# `URLSession(...)` (or reaches for `URLSession.shared`) instead of deriving the
# session from `ServerTrustService`. That session skips leaf-key pinning, so a
# MITM presenting any CA-valid certificate for the host silently harvests a live
# access/refresh token — exactly the regression `EntryUploader`'s comment warns
# about ("a `.shared` default previously let the AutoFill caller silently … ").
#
# Rule: a BLANKET ban on `URLSession(` / `URLSession.shared` in production Swift,
# with ONE narrowly-justified allowlist entry (the pinning primitive itself).
#
# Why blanket, not "files that set an auth header": an auth client can take its
# session by constructor injection, so the credential-bearing FILE need not
# contain any `URLSession(` at all. A rule keyed off auth headers would miss the
# real injection SOURCE — a helper that builds `URLSession.shared` and hands it
# to the auth client. Banning every construction site outside the allowlist
# closes that gap: an unpinned session cannot be created anywhere to inject.
# This is only tractable because the sole production construction site today is
# ServerTrustService; a genuinely-unpinned future caller must be added to
# UNPINNED_ALLOWLIST WITH a justification (and then it is on the reviewer).
#
# Scope: production targets only (PasswdSSOApp / Shared / PasswdSSOAutofillExtension).
# Test targets legitimately build MockURLProtocol / real-TLS sessions and are
# out of scope.
#
# Exit 0 = clean, Exit 1 = a non-allowlisted production file constructs a session.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IOS_DIR="$REPO_ROOT/ios"

# Files permitted to construct a URLSession. Justify every entry — an
# unjustified addition defeats the guard.
#
#   Shared/Network/ServerTrustService.swift
#     The pinning primitive. It builds the URLSession WITH the
#     LeafKeyPinningDelegate attached; this is the single sanctioned
#     construction site every other caller derives from.
UNPINNED_ALLOWLIST=(
  "Shared/Network/ServerTrustService.swift"
)

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

# Enumerate every production Swift file (excluding the test targets) that
# constructs a URLSession, and flag any that is not allowlisted.
while IFS= read -r abs; do
  [ -n "$abs" ] || continue
  rel="${abs#"$IOS_DIR"/}"

  if is_allowlisted "$rel"; then
    echo "OK (allowlisted): $rel constructs a URLSession by design"
    continue
  fi

  echo "FAIL: production file constructs a raw URLSession (must be pinned): $rel" >&2
  grep -nE -- "$SESSION_CTOR_PATTERN" "$abs" 2>/dev/null | sed 's/^/    /' >&2
  fail=1
done < <(
  grep -rlE --include='*.swift' -- "$SESSION_CTOR_PATTERN" \
    "$IOS_DIR/PasswdSSOApp" "$IOS_DIR/Shared" "$IOS_DIR/PasswdSSOAutofillExtension" 2>/dev/null \
    | grep -vE '/(PasswdSSOTests|PasswdSSOUITests)/' \
    | sort
)

# Second, independent guard: the allowlist must not name a file that no longer
# constructs a session (a stale entry would silently re-permit that path).
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
  echo "iOS pinned-session guard failed." >&2
  echo "No production code may construct a raw URLSession — every request must" >&2
  echo "run over a pinned session from ServerTrustService (pinnedSession /" >&2
  echo "validatedSession), taken by constructor injection. If a caller genuinely" >&2
  echo "must be unpinned, add it to UNPINNED_ALLOWLIST with a justification." >&2
  exit 1
fi

echo "iOS pinned-session guard passed."
