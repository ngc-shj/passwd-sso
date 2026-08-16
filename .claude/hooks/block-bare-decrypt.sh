#!/usr/bin/env bash
# Pre-tool-use hook for the Bash tool: refuses vault decrypt commands, whose
# stdout is captured into Claude's conversation context.
#
# Deny by default. There is no "safe shape" of decrypt-via-Bash to allow: where a
# process's stdout ends up depends on redirections, the pipeline's last stage,
# command substitution and the surrounding shell — none of which can be
# recovered by matching the command string. An earlier version allowed a leading
# "(" or a "|" after the subcommand, and both a bare subshell and a pipe into
# `cat` satisfied those checks while printing the credential to stdout.
#
# The two failure modes this must not have, both of which it did have:
#   - allowing on a heuristic that proves nothing. Fixed by removing the
#     heuristics, not by refining them: a wrong "allowed" is read as
#     "checked and safe".
#   - allowing because the guard could not evaluate its own input or matcher.
#     Both now route to a refusal.
#
# Credential use goes through the /use-credential skill instead, which consumes
# the value without routing it through a shell whose output is transcribed.

set -euo pipefail

# Read tool input from stdin
INPUT=$(cat)

# Extract the command from the Bash tool input.
#
# Parse failure is NOT "no command". Swallowing a JSON error into an empty
# string made every malformed payload — `{bad json`, a missing tool_input, a
# non-string command — take the "not a decrypt command" path and exit 0. A guard
# that cannot read its input has not cleared the input; it has failed to look.
COMMAND=$(printf '%s' "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)                      # raises on malformed JSON
cmd = data.get('tool_input', {}).get('command')
if not isinstance(cmd, str):                     # missing, null, or non-string
    raise SystemExit(3)
print(cmd)
" 2>/dev/null) || {
  echo '{"error": "BLOCKED: credential guard could not read tool_input.command (malformed JSON, missing key, or non-string value). Refusing rather than allowing."}' >&2
  exit 2
}

# Patterns are POSIX ERE, not PCRE. `grep -P` does not exist on BSD grep, which
# is what macOS ships: it exits 2, and `! grep -qP ...` turned that failure into
# "this is not a decrypt command", so the hook exited 0 and allowed the very
# command it exists to block. An unusable matcher must deny, never allow.
matches() {
  local pattern="$1" status
  set +e
  printf '%s' "$COMMAND" | grep -qE "$pattern"
  status=$?
  set -e
  case "$status" in
    0) return 0 ;;   # matched
    1) return 1 ;;   # did not match
    *)
      # grep could not evaluate the pattern at all (bad option, unusable regex).
      # "Could not decide" is not "safe" — refuse, and name the reason.
      echo "{\"error\": \"BLOCKED: credential guard could not evaluate its matcher (grep exit $status). Refusing rather than allowing.\"}" >&2
      exit 2
      ;;
  esac
}

# Skip if not a decrypt command
if ! matches 'passwd-sso[[:space:]]+decrypt\b|index\.ts[[:space:]]+decrypt\b'; then
  exit 0
fi

# It is a decrypt command: refuse.
#
# This used to allow two "safe" shapes — a leading `(` (subshell) or a `|` after
# `decrypt`. Neither proves anything about where the plaintext ends up, and both
# are trivially satisfied by a command that dumps it straight to stdout:
#
#   (passwd-sso decrypt item)        <- subshell, output still goes to stdout
#   passwd-sso decrypt item | cat    <- piped, `cat` writes it to stdout
#
# Both were accepted by the old heuristics and both put the credential in the
# transcript. A regex over shell text cannot decide where a process's stdout
# lands: that depends on redirections, the pipeline's last stage, command
# substitution, and the surrounding shell — none of which are recoverable from
# the string. Deciding it wrongly is worse than not deciding, because a guard
# that says "allowed" is read as "checked and safe".
#
# So the answer is not a better pattern; it is to stop adjudicating. Every
# Bash-issued decrypt is refused, and credential use goes through the
# /use-credential skill, which consumes the value without routing it through a
# shell whose output is captured into the conversation.
echo '{"error": "BLOCKED: passwd-sso decrypt must not run via the Bash tool — its stdout is captured into the conversation. A subshell or a pipe does not change that. Use the /use-credential skill, which consumes the credential without exposing it."}' >&2
exit 2
