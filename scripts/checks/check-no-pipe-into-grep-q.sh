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

# Resolved from the script's OWN location, never from `git rev-parse` in the
# caller's cwd: a gate whose root depends on where it is invoked from can be
# pointed at the wrong tree by nothing more than a stray `cd`, and a `.git`
# directory found by walking up from an unrelated cwd (e.g. a submodule, or a
# worktree checked out elsewhere) would silently scan that tree instead.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_ROOT="${NO_PIPE_GREP_Q_ROOT:-$REPO_ROOT}"
cd "$FIXTURE_ROOT"

SCAN_DIR="scripts"
# The credential hook is a shell script too, and a race of exactly this shape lived
# in it while this gate scanned scripts/ only (audit-tenant-adjudicator round 15,
# F-R15-2).
HOOKS_DIR=".claude/hooks"
SETTINGS_FILE=".claude/settings.json"

echo "check-no-pipe-into-grep-q: FIXTURE_ROOT=$FIXTURE_ROOT SCAN_DIR=$SCAN_DIR HOOKS_DIR=$HOOKS_DIR"

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
# needle on line 1 and a body past the pipe buffer, `-q`, `--quiet`, `--silent`,
# `-m1` AND `-l` all report the match as rc=141.
#
# `-l` was previously excluded on a GNU-grep measurement, where it keeps draining
# stdin and so does not invert. BSD grep (macOS) exits on first match and takes
# SIGPIPE exactly like `-q` — re-measured at rc=141 on a 3 MB haystack. Since the
# gate runs on both platforms, the member set is the UNION: excluding `-l` left
# the guard under-covering on every macOS developer's machine.
#
# Non-members, also measured, so the widening stops here: `-c`, `-o`, `-n` all
# return rc=0 on both platforms — they consume their input.
detect_awk='
function has_quiet(seg) {
  # Trailing digits so `-m1` (and `-im1`) match as well as `-m 1`.
  # `l` is in the cluster class alongside `q`/`m`, so `-ql`, `-il`, `-rl` match
  # too. Case-sensitive by construction: `-L` (files-WITHOUT-match) is a
  # different flag and is deliberately not a member.
  return (seg ~ /(^|[ \t])-[A-Za-z]*[qml][A-Za-z]*[0-9]*([ \t]|=|$)/ ||
          seg ~ /(^|[ \t])--(quiet|silent|max-count|files-with-matches)([ \t]|=|$)/)
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
# Truncates a physical line at the shell comment that starts it, if any.
#
# A `#` opens a comment when it begins a word and is not quoted. A word begins
# at the start of the line, after a blank, and after an UNQUOTED metacharacter —
# blanks are not required, so `producer |#comment` is a comment too. The
# metacharacter set was measured rather than assumed: with `#zzz` placed
# directly after each candidate, bash treats it as a comment after
# `| & ; ( ) < >` and a blank, and as literal text after `$ { } =` or any
# word character. That is what keeps `${x#y}`, `${#x}`, `$#`, `file#1` and
# `"#tag"` intact.
#
# Everything downstream works on this effective line, which is why a trailing
# comment can neither hide the operator a continuation depends on nor be
# mistaken for command text.
function strip_comment(s,   i, n, c, q, prev) {
  n = length(s); q = ""; prev = ""
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (q != "") {
      if (c == "\\" && q == "\"") { i++; prev = ""; continue }
      if (c == q) q = ""
      prev = c
      continue
    }
    if (c == "\\") { i++; prev = "x"; continue }
    if (c == "\047" || c == "\"") { q = c; prev = c; continue }
    if (c == "#" && (i == 1 || prev ~ /^[ \t|&;()<>]$/)) return substr(s, 1, i - 1)
    prev = c
  }
  return s
}
{
  # The effective line is what bash would execute. Once comments are gone, a
  # physical line carrying no command text is simply an empty one — whether it
  # was blank, a standalone comment, or a comment trailing a pipe operator. It
  # is dropped WITHOUT ending a logical line already in progress, because bash
  # continues a pipeline across all three:
  #     printf %s "$BODY" |   # pipeline explanation
  #                           <- or a blank line, or a standalone comment
  #       grep -q needle
  raw = strip_comment($0)
  if (raw ~ /^[ \t]*$/) next
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

# Files physically present under HOOKS_DIR. Absence of the directory itself is
# NOT an error here — a tree with nothing wired to it either (below) has
# nothing to scan there and says so. A directory that DOES exist but holds no
# *.sh is still EMPTY_SCAN: that shape means the scan path is wrong, same as
# for SCAN_DIR above.
hook_present_files=""
if [ -d "$HOOKS_DIR" ]; then
  hook_present_files=$(find "$HOOKS_DIR" -name '*.sh' -type f | sort)
  hook_present_count=$(grep -c . <<<"$hook_present_files" || true)
  if [ "${hook_present_count:-0}" -lt 1 ]; then
    echo "EMPTY_SCAN: no shell scripts found under $HOOKS_DIR/ (expected >= 1) — the scan path is wrong, not the tree."
    exit 1
  fi
fi

# The hook member set is WIRED ∪ PRESENT, not just PRESENT: a hook can be
# wired to a path this gate would otherwise never look at, and a script sitting
# unwired in HOOKS_DIR must still be scanned (that is what F-R15-2 was). Wiring
# is read from settings — the same file Claude Code itself reads to decide
# which script actually runs — via `node`'s JSON.parse, not a filename glob or
# a regex over the file: a hand-rolled parser would drift from what Claude Code
# accepts as JSON and could be fooled by a comment-like string value.
#
# Absence of the settings file is an empty wired set, not a failure — most
# fixture trees have no `.claude/settings.json` at all. A settings file that
# fails to parse, or a `command` this gate cannot place into one of the two
# known shapes, fails the gate instead of being silently skipped: a hook this
# gate cannot classify is a hook it cannot prove is scanned.
classify_status=0
classify_out=$(node -e '
const fs = require("node:fs");
const path = require("node:path");

const settingsPath = ".claude/settings.json";

// Deliberately conservative: only two shapes are RECOGNISED, everything else
// is UNCLASSIFIABLE and fails the gate rather than being guessed at.
//   - "bash <path>" / "sh <path>" / a bare "<path>.sh", with a literal
//     relative path -> a shell member, scanned below.
//   - "node <path>" / "python3 <path>" -> recorded as not-shell, not scanned.
// Several commands joined by `&&`, `;`, `|`; a variable or
// `$CLAUDE_PROJECT_DIR` in the path; `bash -c "…"` (the argument is CODE, not
// a path) — none of these can be resolved to a literal file, so all are
// unclassifiable.
function classify(command) {
  const trimmed = command.trim();
  if (/[;&|`$]/.test(trimmed)) {
    return { kind: "unclassifiable", detail: "contains a shell operator or a variable expansion" };
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { kind: "unclassifiable", detail: "empty command" };
  }
  if (tokens.length === 1) {
    const p = tokens[0];
    if (!p.endsWith(".sh") || path.isAbsolute(p)) {
      return { kind: "unclassifiable", detail: `bare command is not a literal relative .sh path: ${command}` };
    }
    return { kind: "shell", path: p };
  }
  if (tokens.length === 2) {
    const [interpreter, arg] = tokens;
    if (interpreter === "bash" || interpreter === "sh") {
      if (arg === "-c" || path.isAbsolute(arg)) {
        return { kind: "unclassifiable", detail: `not a literal relative path: ${command}` };
      }
      return { kind: "shell", path: arg };
    }
    if (interpreter === "node" || interpreter === "python3") {
      return { kind: "not-shell", interpreter };
    }
    return { kind: "unclassifiable", detail: `unrecognized interpreter: ${command}` };
  }
  return { kind: "unclassifiable", detail: `more than one argument: ${command}` };
}

if (!fs.existsSync(settingsPath)) {
  process.exit(0);
}

let raw;
try {
  raw = fs.readFileSync(settingsPath, "utf8");
} catch (err) {
  console.log(`ERROR: cannot read ${settingsPath}: ${err.message}`);
  process.exit(1);
}

let settings;
try {
  settings = JSON.parse(raw);
} catch (err) {
  console.log(`ERROR: ${settingsPath} is not valid JSON: ${err.message}`);
  process.exit(1);
}

const commands = [];
for (const entries of Object.values(settings.hooks ?? {})) {
  if (!Array.isArray(entries)) continue;
  for (const entry of entries) {
    for (const hook of entry?.hooks ?? []) {
      if (typeof hook?.command === "string") commands.push(hook.command);
    }
  }
}

for (const command of commands) {
  const result = classify(command);
  if (result.kind === "shell") {
    console.log(`SHELL\t${result.path}`);
  } else if (result.kind === "not-shell") {
    console.log(`NOTSHELL\t${result.interpreter}`);
  } else {
    console.log(`ERROR: unclassifiable hook command in ${settingsPath}: ${command} (${result.detail})`);
    process.exit(1);
  }
}
') || classify_status=$?

if [ "$classify_status" -ne 0 ]; then
  echo "$classify_out"
  exit 1
fi

wired_shell_paths=""
wired_shell_count=0
notshell_count=0
while IFS=$'\t' read -r kind value; do
  [ -z "$kind" ] && continue
  if [ "$kind" = "SHELL" ]; then
    wired_shell_count=$((wired_shell_count + 1))
    wired_shell_paths="${wired_shell_paths}${value}
"
  elif [ "$kind" = "NOTSHELL" ]; then
    notshell_count=$((notshell_count + 1))
  fi
done <<<"$classify_out"
wired_count=$((wired_shell_count + notshell_count))

# A wired shell hook that does not exist is fatal: the settings file is making
# a promise this tree does not keep, and scanning would silently skip it.
while IFS= read -r p; do
  [ -z "$p" ] && continue
  if [ ! -f "$p" ]; then
    echo "ERROR: $SETTINGS_FILE wires a hook that does not exist: $p"
    exit 1
  fi
done <<<"$wired_shell_paths"

scanned_hook_files=$(printf '%s\n%s\n' "$hook_present_files" "$wired_shell_paths" | sed '/^$/d' | sort -u)
scanned_hook_count=$(grep -c . <<<"$scanned_hook_files" || true)
scanned_hook_count=${scanned_hook_count:-0}

if [ -n "$scanned_hook_files" ]; then
  files="$files
$scanned_hook_files"
fi

violations=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  awk_status=0
  hits=$(awk "$detect_awk" "$f") || awk_status=$?
  if [ "$awk_status" -ne 0 ]; then
    echo "ERROR: scanner failed on $f (awk exit $awk_status)"
    exit 1
  fi
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

echo "OK ($file_count shell scripts and $scanned_hook_count hook script(s) scanned; $wired_count hook(s) wired ($wired_shell_count shell, $notshell_count not-shell); no pipeline into grep -q)"
