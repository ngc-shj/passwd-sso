#!/usr/bin/env bash
# Forbid `<writer> | grep -q …` in shell scripts.
#
# `grep -q` exits the moment it matches. Under load the writer is still writing
# when the pipe closes, takes SIGPIPE (141), and `set -o pipefail` reports the
# whole pipeline as failed — so a SUCCESSFUL match is observed as a failure.
# Every such pipeline is therefore a coin flip whose bias runs the wrong way:
# the more matches there are, the sooner grep exits, and the likelier the
# inversion. In a condition that inverts the decision, and roughly half of the
# call sites in this repo skipped a check when it fired (`RUN_WEB=0`, "not a
# refactor branch", "no admin changes") — a green that proved nothing.
#
# The fix is to remove the writer process, not to retry: `grep -q PAT <<<"$VAR"`
# has no second process, so there is no race. Where the input comes from a
# command, capture it first (`v=$(cmd || true)`) and feed the herestring.
#
# No exclusions. A pipeline inside `bash -c '…'` happens to be safe today
# (a fresh shell has no pipefail), but that is a property of the *caller*, not
# of the line — one `set -o pipefail` added to such a block would silently arm
# it. Rejecting the shape outright is what makes this gate cheap to trust, and
# the scanner recurses into those bodies rather than treating the quote around
# them as data.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))"
FIXTURE_ROOT="${NO_PIPE_GREP_Q_ROOT:-$REPO_ROOT}"
cd "$FIXTURE_ROOT"

SCAN_DIR="scripts"

echo "check-no-pipe-into-grep-q: FIXTURE_ROOT=$FIXTURE_ROOT SCAN_DIR=$SCAN_DIR"

# Env-pollution guard: an override under CI needs an explicit acknowledgement,
# so a stray export cannot point the gate at an empty tree and green it.
if [ "${CI:-}" = "true" ] && [ -n "${NO_PIPE_GREP_Q_ROOT:-}" ]; then
  if [ "${NO_PIPE_GREP_Q_FIXTURE_MODE:-}" != "1" ]; then
    echo "ENV_POLLUTION_GUARD: NO_PIPE_GREP_Q_ROOT override set under CI=true without NO_PIPE_GREP_Q_FIXTURE_MODE=1 — refusing to run against a possibly-unintended path."
    exit 1
  fi
fi

if [ ! -d "$SCAN_DIR" ]; then
  echo "ERROR: $SCAN_DIR/ not found under $FIXTURE_ROOT"
  exit 1
fi

# Matching is done in awk, not by a line regex, because the shape has several
# spellings a regex over raw lines gets wrong:
#   * the early-exit flag can sit anywhere in a short cluster (-q, -qxF, -iqE,
#     -Eq, -m1) or appear long (--quiet, --silent, --max-count=1);
#   * the pipe and the grep can be split across a `\` continuation OR across a
#     bare trailing `|` / `|&`, which bash continues without a backslash;
#   * a comment ending in either of those must NOT swallow the line below it,
#     so comment-only lines are dropped before continuations are joined;
#   * `||` is not a pipe, and a `|` inside `grep -qE "a|b"` is not an operator,
#     so operator splitting is quote-aware;
#   * the flag must belong to the grep being tested — scanning the whole line
#     would reject `… | grep x | sort -m`, where -m is sort's and drains.
#
# The flag set was derived by measurement, not from the man page: with the
# needle on line 1 and a body past the pipe buffer, `-q`, `--quiet`, `--silent`
# and `-m1` all report the match as rc=141, while `-l` does not — so `-l` is
# not a member and is deliberately absent.
detect_awk='
function has_quiet(seg) {
  # Trailing digits so `-m1` (and `-im1`) match as well as `-m 1`.
  return (seg ~ /(^|[ \t])-[A-Za-z]*[qm][A-Za-z]*[0-9]*([ \t]|=|$)/ ||
          seg ~ /(^|[ \t])--(quiet|silent|max-count)([ \t]|=|$)/)
}
# Walks the logical line once, tracking quote state, and splits it into
# commands at UNQUOTED operators. Each grep that a single pipe feeds is then
# tested on its OWN argument text — so a later `sort -m` is not read as grep
# is, and a `|` inside `grep -qE "a|b"` is not read as an operator.
function offends(s,   i, n, c, q, seg, start, piped) {
  n = length(s); q = ""; start = 1; piped = 0
  for (i = 1; i <= n + 1; i++) {
    c = (i <= n) ? substr(s, i, 1) : ""
    if (q != "") {
      if (c == "\\" && q == "\"") { i++; continue }
      if (c == q) q = ""
      continue
    }
    if (c == "\\") { i++; continue }
    if (c == "\047" || c == "\"") { q = c; continue }
    if (c != "|" && c != ";" && c != "&" && c != "") continue

    seg = substr(s, start, i - start)
    if (piped && seg ~ /^[ \t]*grep([ \t]|$)/ && has_quiet(seg)) return 1

    if (c == "|") {
      if (substr(s, i + 1, 1) == "|") { piped = 0; i++ }        # || is not a pipe
      else if (substr(s, i + 1, 1) == "&") { piped = 1; i++ }   # |& pipes stderr too
      else piped = 1
    } else {
      piped = 0
      if (c == "&" && substr(s, i + 1, 1) == "&") i++
    }
    start = i + 1
  }
  return 0
}
# The argument of `bash -c` / `sh -c` is CODE, not data, so the quote around it
# must not hide it. Each such body is scanned on its own and then removed from
# the outer line, which is what keeps quote-awareness from becoming a bypass.
function scan(s,   i, n, j, c, cc, qpos, body, outer, found) {
  found = 0; outer = ""; i = 1; n = length(s)
  while (i <= n) {
    if (match(substr(s, i), /(^|[ \t;&|(])(bash|sh)[ \t]+-c[ \t]*/) == 0) break
    qpos = i + RSTART + RLENGTH - 1
    c = substr(s, qpos, 1)
    if (c != "\047" && c != "\"") { outer = outer substr(s, i, qpos - i); i = qpos; continue }
    outer = outer substr(s, i, qpos - i + 1)
    body = ""; j = qpos + 1
    while (j <= n) {
      cc = substr(s, j, 1)
      if (cc == "\\" && c == "\"") { body = body substr(s, j, 2); j += 2; continue }
      if (cc == c) break
      body = body cc; j++
    }
    if (scan(body)) found = 1
    outer = outer substr(s, j, 1)
    i = j + 1
  }
  outer = outer substr(s, i)
  return (found || offends(outer))
}
{
  raw = $0
  # Physical lines that carry no command text — comment-only and blank — are
  # dropped BEFORE the continuation test, and WITHOUT ending a logical line
  # already in progress. Both halves matter, and each was a bypass on its own:
  #   * joining first and then discarding the logical line for starting with
  #     `#` let a comment ending in `|` or `\` swallow the violation below it;
  #   * ending the logical line on them let bash-legal layouts split a pipeline
  #     from its grep, which is exactly what the gate is looking for:
  #         printf %s "$BODY" |
  #           # pipeline explanation      <- or simply a blank line
  #           grep -q needle
  if (raw ~ /^[ \t]*#/ || raw ~ /^[ \t]*$/) next
  if (buf == "") { start = FNR; disp = $0 }
  # bash continues a line ending in `\`, and also one ending in a pipe
  # operator (`|` or `|&`) with no backslash at all.
  cont = (raw ~ /\\[ \t]*$/ || raw ~ /\|&?[ \t]*$/)
  sub(/\\[ \t]*$/, " ", raw)
  buf = buf raw
  if (cont) next
  if (scan(buf)) printf "%d:%s\n", start, disp
  buf = ""
}
END { if (buf != "" && scan(buf)) printf "%d:%s\n", start, disp }
'

files=$(find "$SCAN_DIR" -name '*.sh' -type f -not -path '*/__tests__/fixtures/*' | sort)
file_count=$(grep -c . <<<"$files" || true)

# EMPTY_SCAN: a gate that inspects nothing passes vacuously. The floor is set
# below today's count so an ordinary deletion does not trip it, but a broken
# path or a bad glob does.
MIN_FILES=20
if [ "${file_count:-0}" -lt "$MIN_FILES" ]; then
  echo "EMPTY_SCAN: only ${file_count:-0} shell scripts found under $SCAN_DIR/ (expected >= $MIN_FILES) — the scan path is wrong, not the tree."
  exit 1
fi

violations=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  hits=$(awk "$detect_awk" "$f" || true)
  if [ -n "$hits" ]; then
    while IFS= read -r h; do
      [ -z "$h" ] && continue
      violations="${violations}${f}:${h}
"
    done <<<"$hits"
  fi
done <<<"$files"

if [ -n "$violations" ]; then
  echo "ERROR: pipeline into 'grep -q' found — under pipefail a successful match can be reported as failure (SIGPIPE on the writer)."
  printf '%s' "$violations"
  echo "Use a herestring instead: grep -q PAT <<<\"\$VAR\""
  echo "If the input comes from a command, capture it first: v=\$(cmd || true)"
  exit 1
fi

echo "OK ($file_count shell scripts scanned, no pipeline into grep -q)"
