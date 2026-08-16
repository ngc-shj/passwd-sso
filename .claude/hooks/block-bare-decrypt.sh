#!/usr/bin/env bash
# Pre-tool-use hook for Bash tool: blocks bare `passwd-sso decrypt` commands
# that would expose credentials in Claude's conversation context.
#
# Allowed patterns:
#   - Inside subshell: ( _CRED=$(...decrypt...) && ... )
#   - Piped: ...decrypt... | curl ...
#   - Variable assignment inside subshell: $(...decrypt...)
#
# Blocked patterns:
#   - Bare execution: passwd-sso decrypt ... (stdout visible to Claude)
#   - Echo after decrypt: PASS=$(...decrypt...); echo $PASS

set -euo pipefail

# Read tool input from stdin
INPUT=$(cat)

# Extract the command from the Bash tool input
COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('command', ''))
except:
    print('')
" 2>/dev/null)

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

# Block if the command is not wrapped in a safe pattern
# Safe patterns: starts with '(' (subshell) or has pipe '|' after decrypt
if matches '^[[:space:]]*\('; then
  # Subshell — check it doesn't echo/print the credential
  if matches 'echo[[:space:]]+.*\$_CRED|printf.*\$_CRED|cat.*\$_CRED'; then
    echo '{"error": "BLOCKED: Do not echo/print credential variables. Use the /use-credential skill instead."}' >&2
    exit 2
  fi
  exit 0
fi

if matches 'decrypt.*\|'; then
  # Piped to another command — OK
  exit 0
fi

# Not a safe pattern — block
echo '{"error": "BLOCKED: passwd-sso decrypt must be wrapped in a subshell to prevent credential exposure. Use the /use-credential skill instead."}' >&2
exit 2
