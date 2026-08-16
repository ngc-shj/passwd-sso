#!/usr/bin/env bash
# Pre-tool-use hook for the Bash tool: a LINT against the common way a vault
# credential ends up in the conversation — a decrypt whose stdout is transcribed.
#
# Scope, stated plainly because an overstated guard is worse than none:
#
#   This is not a security boundary. It matches the command STRING before
#   execution, and a shell string does not determine the argv the process sees.
#   Quoting the subcommand, splitting it across quotes, or passing it through a
#   variable all reach the same program unseen by this matcher. A determined
#   caller — including the model — evades it trivially.
#
#   The boundary would be a decrypt that is not a Bash command at all: a tool or
#   MCP surface that consumes the credential and never returns plaintext to the
#   model. This hook is the stopgap for accidents until that exists.
#
# It allows the shape .claude/skills/use-credential/SKILL.md documents (_CRED
# assigned inside a subshell, consumed in place, never printed) and refuses the
# shapes that put plaintext on stdout. Two failure modes it must not have, both
# of which earlier revisions did:
#
#   - allowing on a heuristic that proves nothing. A leading "(" or a trailing
#     pipe say nothing about where stdout lands; `(<cli> <sub> x)` and
#     `<cli> <sub> x | cat` both satisfied those and both printed the value.
#   - refusing the sanctioned pattern, which made the workflow its own error
#     message recommends impossible to run.

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

# It looks like a decrypt command. Decide by the SHAPE the skill documents.
#
# What this hook is: a lint against the common accident — running a decrypt whose
# stdout lands in the transcript. What it is NOT: a security boundary. It matches
# the pre-execution command STRING, and a shell string does not determine the
# argv the process will see. All three of these reach the same program and this
# matcher does not see any of them:
#
#   <cli> \'"'"'<sub>\'"'"' item          quoted subcommand
#   <cli> <su>"<b>" item        split across quotes
#   s=<sub>; <cli> "$s" item    variable expansion
#
# Closing that gap needs the decrypt to stop being a Bash command at all — a
# dedicated tool or MCP surface that consumes the credential and never returns
# plaintext to the model. Until then this catches the accident, not the evasion,
# and it should not be read as more than that.
#
# The allowed shape is the one .claude/skills/use-credential/SKILL.md specifies:
# assignment to _CRED inside a subshell, so the value is consumed by the command
# that needs it and never printed. An earlier revision of this hook refused that
# shape too, which broke the workflow its own error message recommends.
if matches '_CRED=\$\(' && matches '^[[:space:]]*\('; then
  # Inside the sanctioned subshell. Still refuse if it prints the credential —
  # that is the accident the skill's own rules forbid.
  if matches 'echo[[:space:]]+[^|]*\$_CRED|printf[^|]*\$_CRED|cat[^|]*\$_CRED'; then
    echo '{"error": "BLOCKED: do not echo/print the credential variable. Pass $_CRED directly to the command that consumes it."}' >&2
    exit 2
  fi
  exit 0
fi

echo '{"error": "BLOCKED: a vault decrypt run this way puts its stdout in the conversation. Use the /use-credential skill pattern: assign to _CRED inside a subshell and pass it straight to the consuming command."}' >&2
exit 2
