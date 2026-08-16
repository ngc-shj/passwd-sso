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

# It looks like a decrypt command. Decide on the ONE property that matters:
# is that command's stdout consumed, or does it reach the transcript?
#
# What this hook is: a lint against the common accident. What it is NOT: a
# security boundary. It matches the pre-execution command STRING, and a shell
# string does not determine the argv the process will see — a quoted, split, or
# variable-passed subcommand reaches the same program unseen. Closing that needs
# the decrypt to stop being a Bash command at all: a tool or MCP surface that
# consumes the credential and never returns plaintext to the model.
#
# The check is anchored on the decrypt OCCURRENCE, not on unrelated features of
# the line. Two independent tests ("starts with (" AND "contains _CRED=$(")
# accepted a decoy:
#
#   (_CRED=$(true); <cli> <sub> item)
#
# — the assignment captured something else entirely while the real decrypt ran
# bare. Requiring the decrypt itself to sit inside the capture, or inside a pipe
# into a consuming sink, is what makes the allow mean anything.
DECRYPT_RE='(passwd-sso|index\.ts)[[:space:]]+decrypt\b'

# Shape 1 — captured: _CRED=$( ... decrypt ... ). The value lands in a variable
# and is consumed in place. This is /use-credential Patterns A, B and C.
if matches "_CRED=\\\$\\([^)]*${DECRYPT_RE}"; then
  # Still refuse if the captured value is then printed — the accident the
  # skill's own rules forbid.
  if matches 'echo[[:space:]]+[^|]*\$_CRED|printf[^|]*\$_CRED|cat[^|]*\$_CRED'; then
    echo '{"error": "BLOCKED: do not echo/print the credential variable. Pass $_CRED directly to the command that consumes it."}' >&2
    exit 2
  fi
  exit 0
fi

# Shape 2 — piped into a sink that consumes without printing. This is
# /use-credential Patterns D and E (clipboard). The sink list is deliberately a
# closed set: `| cat`, `| tee`, `| head` all print, and a decrypt piped into an
# unknown command is not something this lint can vouch for.
if matches "${DECRYPT_RE}[^|]*\\|[[:space:]]*(pbcopy|xclip|xsel|wl-copy)\\b"; then
  exit 0
fi

echo '{"error": "BLOCKED: this decrypt puts its stdout in the conversation. Use a /use-credential pattern: capture it with _CRED=$(...) and pass $_CRED to the consuming command, or pipe it straight into a clipboard sink (pbcopy/xclip/xsel/wl-copy)."}' >&2
exit 2
