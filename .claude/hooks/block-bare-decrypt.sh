#!/usr/bin/env bash
# Pre-tool-use hook for the Bash tool: a LINT against the common way a vault
# credential ends up in the conversation — a decrypt whose stdout is transcribed.
#
# Scope, stated plainly because an overstated guard is worse than none:
#
#   This is not a security boundary. It matches the command STRING before
#   execution, and a shell string does not determine the argv the process sees.
#   Passing the subcommand through a variable, or splitting it across quotes,
#   reaches the same program unseen by this scanner. A determined caller —
#   including the model — evades it trivially.
#
#   The boundary would be a decrypt that is not a Bash command at all: a tool or
#   MCP surface that consumes the credential and never returns plaintext to the
#   model. This hook is the stopgap for accidents until that exists (SC2).
#
# It allows the shape .claude/skills/use-credential/SKILL.md documents (_CRED
# assigned inside a subshell, consumed in place, never printed) and refuses the
# shapes that put plaintext on stdout.
#
# The decision is delegated entirely to lib/decrypt-command-scan.py (the python3
# this hook already requires to read tool_input.command, so this adds no
# dependency — stdlib only). Earlier revisions decided with regexes over the
# WHOLE command string, and that surface form has a class of false negative no
# window regex survives: a quoted operator ends a text match early
# (`awk -F'|' '{print}' <<<"$_CRED"` — the quoted `|` inside `-F'|'` closes the
# match window before `$_CRED`), and an operator inside `$( … )` reads as a real
# split point to a quote-only scanner (`echo $(true | false) "$_CRED"` is ONE
# command to bash; a quote-only scanner splits it in two and neither half
# matches). The scanner instead walks the command ONCE, tracking quote state,
# nesting depth ($( ), a backtick span, a ( ) subshell — each scanned
# RECURSIVELY as its own command list) and heredoc bodies, and splits it into
# simple commands at unquoted, unnested `| |& ; & && ||` and newline. Every
# rule it applies is a question about ONE parsed segment, never a regex over
# raw text. `grep` is gone from this hook entirely, and with it the three
# defects its use produced: SIGPIPE under `pipefail` losing a match's exit
# status, the 64 KB here-string temp file silently failing to write, and BSD
# `grep -P` not existing on macOS.
#
# Residual (documented here, not closed by this change): inside a recognised
# Shape 1 (`_CRED=$(… decrypt …)`), the scanner now refuses any segment it
# cannot attribute to a plain command word — a reserved word (`if`, `{`, …),
# an invocation prefix (`command`, `sudo`, `bash -c`, …), anything that is not
# a literal name — rather than silently skipping it, so what stays open is
# DETECTION, not a wrong allow: a decrypt reached through a quoted or split
# subcommand, a variable, `eval`, or an invocation prefix not on the
# scanner's recognised list degrades to "this scanner never saw a decrypt
# here" (the command is allowed outright, the same as any unrelated command),
# never to "saw it and let it through"; a consuming command that itself
# prints what it is handed (Pattern C grants an arbitrary consumer the
# credential it is given, by design); and anything whose spelling bash
# assembles at run time, which this scanner does not evaluate. The cost of
# the inversion: a compound command or an invocation prefix inside Shape 1 is
# refused even when it is harmless — `command echo "$_CRED"` refuses under
# the gate's own message, not because `command` does anything unsafe here.
# A decrypt surface that never returns plaintext is the real closure (SC2);
# this hook stays a stopgap for accidents, a lint and not a security boundary.

set -euo pipefail

# A top-level command that fails without being handled below would end the hook with
# its own status, and only exit 2 blocks: a check that could not finish has not
# cleared the command. Failures inside the scanner invocation are handled there
# (below), so this trap only needs to catch what nothing else does.
trap 'echo "{\"error\": \"BLOCKED: credential guard failed while checking this command. Refusing rather than allowing.\"}" >&2; exit 2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCANNER="$SCRIPT_DIR/lib/decrypt-command-scan.py"

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

# `timeout` is GNU coreutils and is not present on stock macOS; Homebrew
# installs it as `gtimeout` (and as `timeout` when coreutils is linked). This
# is defense-in-depth, not the primary bound — the scanner's own recursion
# depth already caps a pathologically nested input — so when neither exists
# the scanner just runs unwrapped rather than refusing every command a
# machine without either binary would ever run.
TIMEOUT_BIN=""
for candidate in timeout gtimeout; do
  if command -v "$candidate" >/dev/null 2>&1; then TIMEOUT_BIN="$candidate"; break; fi
done

# The scanner is the ONE adjudicator (item 8 of the C1 contract): its own exit
# code IS the verdict — 0 allow, 2 block with its message already on stdout as
# the JSON error object this hook relays verbatim. Any OTHER exit (a raised
# exception, a timeout, output the scanner itself could not produce) is "the
# scanner did not decide," refused here under a message that NAMES the
# scanner and is never the wording either of the two decided outcomes use
# (R44) — this hook does not forward the scanner's raw exit status as its own,
# a status borrowed from another tool having already caused one collision
# here once (the old `grep exit 3` case this rewrite removes).
#
# A failing command substitution assigned this way still fires the ERR trap
# above — `set +e` disables errexit, not the trap, and only the specific
# syntactic exemptions bash documents (the test following `if`, among them)
# suppress it. Capturing the status through the `if` itself is what keeps a
# block verdict (status 2) from being reported as "the guard failed" instead
# of relaying the scanner's own reason.
if [ -n "$TIMEOUT_BIN" ]; then
  if VERDICT=$(printf '%s' "$COMMAND" | "$TIMEOUT_BIN" 4 python3 "$SCANNER" --hook 2>/dev/null); then status=0; else status=$?; fi
else
  if VERDICT=$(printf '%s' "$COMMAND" | python3 "$SCANNER" --hook 2>/dev/null); then status=0; else status=$?; fi
fi

case "$status" in
  0)
    exit 0
    ;;
  2)
    printf '%s' "$VERDICT" >&2
    exit 2
    ;;
  *)
    echo '{"error": "BLOCKED: credential guard'"'"'s command scanner (decrypt-command-scan.py) could not decide — it raised, timed out, or produced no verdict while parsing this command. Refusing rather than allowing."}' >&2
    exit 2
    ;;
esac
