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
# it. Rejecting the shape outright is what makes this gate cheap to trust.
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

# Matching is done in awk, not by a line regex, because the shape has three
# spellings a regex over raw lines gets wrong:
#   * the quiet flag can sit anywhere in a short cluster (-q, -qxF, -iqE, -Eq)
#     or appear as --quiet;
#   * the pipe and the grep can be split across a `\` continuation;
#   * `||` is not a pipe and must not match.
# So: join continuations into logical lines, mask `||`, then for each piped
# `grep` test its own argument segment for a quiet flag.
detect_awk='
function has_quiet(seg) {
  sub(/[;&].*$/, "", seg)
  return (seg ~ /(^|[ \t])-[A-Za-z]*q[A-Za-z]*([ \t]|$)/ ||
          seg ~ /(^|[ \t])--quiet([ \t]|$)/)
}
function offends(s,   t, seg) {
  t = s
  gsub(/\|\|/, "@@OR@@", t)
  while (match(t, /\|[ \t]*grep([ \t]|$)/)) {
    seg = substr(t, RSTART + RLENGTH - 1)
    if (has_quiet(seg)) return 1
    t = substr(t, RSTART + RLENGTH)
  }
  return 0
}
{
  if (buf == "") { start = FNR; disp = $0 }
  raw = $0
  cont = (raw ~ /\\[ \t]*$/)
  sub(/\\[ \t]*$/, " ", raw)
  buf = buf raw
  if (cont) next
  if (buf !~ /^[ \t]*#/ && offends(buf)) printf "%d:%s\n", start, disp
  buf = ""
}
END { if (buf != "" && buf !~ /^[ \t]*#/ && offends(buf)) printf "%d:%s\n", start, disp }
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
