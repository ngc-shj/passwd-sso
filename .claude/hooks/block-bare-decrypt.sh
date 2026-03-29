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

# Skip if not a decrypt command
if ! echo "$COMMAND" | grep -q "decrypt.*--field\|decrypt.*--mcp-token"; then
  exit 0
fi

# Block if the command is not wrapped in a safe pattern
# Safe patterns: starts with '(' (subshell) or has pipe '|' after decrypt
if echo "$COMMAND" | grep -qP '^\s*\('; then
  # Subshell — check it doesn't echo/print the credential
  if echo "$COMMAND" | grep -qP 'echo\s+.*\$_CRED|printf.*\$_CRED|cat.*\$_CRED'; then
    echo '{"error": "BLOCKED: Do not echo/print credential variables. Use the /use-credential skill instead."}' >&2
    exit 2
  fi
  exit 0
fi

if echo "$COMMAND" | grep -qP 'decrypt.*\|'; then
  # Piped to another command — OK
  exit 0
fi

# Not a safe pattern — block
echo '{"error": "BLOCKED: passwd-sso decrypt must be wrapped in a subshell to prevent credential exposure. Use the /use-credential skill instead."}' >&2
exit 2
