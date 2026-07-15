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
# Rule: ban every DIRECT `URLSession(` / `URLSession.shared` / `URLSession.init`
# construction in production Swift, with ONE narrowly-justified allowlist entry
# (the pinning primitive itself). The match tolerates the whitespace/comment/
# backtick spellings Swift treats as equivalent; it does NOT resolve a
# `typealias Alias = URLSession` (see the ACCEPTED GAP note at the pattern below).
#
# Why ban the construction site, not "files that set an auth header": an auth
# client can take its session by constructor injection, so the credential-bearing
# FILE need not contain any `URLSession(` at all. A rule keyed off auth headers
# would miss the real injection SOURCE — a helper that builds `URLSession.shared`
# and hands it to the auth client. Banning every DIRECT construction site outside
# the allowlist closes that gap: an unpinned session cannot be directly
# constructed anywhere to inject. This is only tractable because the sole
# production construction site today is ServerTrustService; a genuinely-unpinned
# future caller must be added to UNPINNED_ALLOWLIST WITH a justification (and then
# it is on the reviewer).
#
# Scope: production targets only (PasswdSSOApp / Shared / PasswdSSOAutofillExtension).
# Test targets legitimately build MockURLProtocol / real-TLS sessions and are
# out of scope.
#
# Exit 0 = clean, Exit 1 = a non-allowlisted production file constructs a session.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# IOS_DIR is the single scan root. The grep roots, the `rel` path stripping, and
# the allowlist file-existence checks all derive from it, so overriding it here
# redirects the entire guard onto an isolated fixture tree — which is how the
# self-test (scripts/__tests__/check-ios-authenticated-session-pinning.test.mjs)
# exercises the guard without touching the working tree.
#
# Fail closed on a bad override: an env var pointing at a nonexistent/empty dir
# must not let a PR pass trivially. When overridden, the path MUST exist.
if [ -n "${IOS_PINNING_CHECK_ROOT:-}" ]; then
  if [ ! -d "$IOS_PINNING_CHECK_ROOT" ]; then
    echo "PINNING_CHECK_ROOT_INVALID: IOS_PINNING_CHECK_ROOT is not a directory: $IOS_PINNING_CHECK_ROOT" >&2
    exit 1
  fi
  IOS_DIR="$(cd "$IOS_PINNING_CHECK_ROOT" && pwd)"
else
  IOS_DIR="$REPO_ROOT/ios"
fi

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
# Matched against RAW source — the guard NEVER rewrites or strips the file. A
# transform that removes comments/strings to "clean up" the input is a
# fail-OPEN trap: a partial lexer (no string-literal, raw-string, escape, or
# nested-comment handling) deletes real code it misreads as a comment, letting
# an actual construction slip through. Matching raw source instead fails CLOSED
# — its only cost is flagging a URLSession mention that lives purely inside a
# comment/string (a false POSITIVE), which is the safe direction for a guard.
#
# The match still tolerates the two token-splitting spellings Swift allows,
# WITHOUT deleting anything: between `URLSession` and the `.`/`(` we allow a run
# of whitespace and/or `/* ... */` block comments (Swift treats a comment as
# whitespace). We do NOT try to span `//` line comments here — a `//` genuinely
# ends the line in Swift, so a construction after it on the SAME line does not
# exist, and one on the NEXT line is matched independently on that line.
#
# `perl -0777` slurps the whole file and the match uses /s (dotall), so a block
# comment spanning newlines between the tokens is crossed by the `.*?` filler.
# FILLER = (whitespace | /* ...(non-greedy, may span lines)... */)*.
# The pattern uses the m{...} delimiter so the literal `/*` `*/` need no escaping,
# and is kept in a single-quoted shell var (NO shell interpolation into the regex
# body). It is handed to perl as an argument, not spliced into -e, so shell
# metacharacters in it can never reshape the program.
#
# `` ` `` before `URLSession` and around `init`/`shared`: Swift lets an identifier
# be backtick-escaped (`` `URLSession` `` and `` .`shared` `` are the SAME
# identifiers), so an optional backtick is allowed at each identifier boundary to
# close that bypass. A leading `(?<![A-Za-z0-9_]) ` boundary keeps this from
# matching `URLSessionConfiguration`/`URLSessionTask` etc. (type REFERENCES, which
# the DI-based design legitimately uses and must NOT flag).
#
# KNOWN, ACCEPTED GAP (fail-open — documented, not fixed): construction through a
# `typealias Alias = URLSession; Alias.shared` is NOT caught. Resolving an alias
# needs real semantic analysis (SwiftSyntax + a symbol table), out of reach for a
# textual guard. This is a deliberately-narrow escape hatch that requires writing
# an obvious alias (trivially caught in code review) and is pinned by an
# expect-PASS regression test so a future SwiftSyntax upgrade has a target.
SESSION_CTOR_PERL='(?<![A-Za-z0-9_]) `?URLSession`? (?:\s|/\*.*?\*/)* (?: \( | \. (?:\s|/\*.*?\*/)* `? (?: init | shared ) `? )'

is_allowlisted() {
  local rel="$1" entry
  for entry in "${UNPINNED_ALLOWLIST[@]}"; do
    [ "$rel" = "$entry" ] && return 0
  done
  return 1
}

# True if the RAW file text contains a URLSession construction (tolerating
# whitespace/block-comment splitting between tokens). No content is modified.
# The pattern arrives via @ARGV[0]; the file text is slurped from @ARGV[1].
constructs_session() {
  perl -0777 -e '
    my ($pat, $file) = @ARGV;
    open my $fh, "<", $file or exit 2;
    local $/; my $src = <$fh>;
    # /s (dotall) so the `.*?` inside a `/* ... */` filler spans newlines — a
    # block comment split across lines between the tokens must still be crossed.
    # Only the two comment-body `.*?` use a bare `.`; every other dot is escaped
    # (`\.`), so dotall does not loosen the token match itself.
    exit($src =~ m{$pat}xs ? 0 : 1);
  ' "$SESSION_CTOR_PERL" "$1"
}

fail=0

while IFS= read -r abs; do
  [ -n "$abs" ] || continue
  constructs_session "$abs" || continue
  rel="${abs#"$IOS_DIR"/}"

  if is_allowlisted "$rel"; then
    echo "OK (allowlisted): $rel constructs a URLSession by design"
    continue
  fi

  # UNPINNED_URLSESSION_CONSTRUCTION / ALLOWLIST_MISSING_FILE / ALLOWLIST_STALE_ENTRY
  # are stable identifiers the self-test asserts on to prove WHICH branch fired
  # (exit code alone conflates all three). They are a test contract — renaming one
  # is a breaking change to the self-test. The prose beside them stays advisory.
  echo "FAIL [UNPINNED_URLSESSION_CONSTRUCTION]: production file constructs a raw URLSession (must be pinned): $rel" >&2
  grep -nE -- 'URLSession' "$abs" 2>/dev/null | sed 's/^/    /' >&2
  fail=1
done < <(
  find "$IOS_DIR/PasswdSSOApp" "$IOS_DIR/Shared" "$IOS_DIR/PasswdSSOAutofillExtension" \
    -name '*.swift' -type f 2>/dev/null \
    | grep -vE '/(PasswdSSOTests|PasswdSSOUITests)/' \
    | sort
)

# Second, independent guard: the allowlist must not name a file that no longer
# constructs a session (a stale entry would silently re-permit that path).
for entry in "${UNPINNED_ALLOWLIST[@]}"; do
  abs="$IOS_DIR/$entry"
  if [ ! -f "$abs" ]; then
    echo "FAIL [ALLOWLIST_MISSING_FILE]: UNPINNED_ALLOWLIST names a missing file: $entry" >&2
    echo "    Update this guard's allowlist to match the moved/renamed primitive." >&2
    fail=1
  elif ! constructs_session "$abs"; then
    echo "FAIL [ALLOWLIST_STALE_ENTRY]: UNPINNED_ALLOWLIST names a file that no longer constructs a URLSession: $entry" >&2
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
