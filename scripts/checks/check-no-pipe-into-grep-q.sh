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

# `[^|]` before the pipe keeps `||  grep -q` (logical OR — no pipe, no race)
# out of the match. `-q` may carry other short flags (`-qxF`, `-qiE`).
PATTERN='[^|]\|[[:space:]]*grep[[:space:]]+-q'

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
  # Strip comment-only lines so the prose that documents this rule does not
  # trip it.
  hits=$(grep -nE "$PATTERN" "$f" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
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
