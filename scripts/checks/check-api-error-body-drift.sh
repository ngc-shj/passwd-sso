#!/usr/bin/env bash
# Detect drift between the 3 parallel `MainApiErrorBody` helper files.
#
# Why 3 copies exist:
#   - src/lib/http/read-api-error-body.ts (main, canonical; types via ApiErrorCode)
#   - cli/src/lib/api-error-body.ts (CLI; separate tsconfig)
#   - extension/src/lib/api-error-body.ts (browser extension; separate tsconfig)
#
# The CLI and extension cannot import from main's `src/` due to separate
# tsconfig / `rootDir` boundaries. To keep drift detectable, this check
# normalizes each file and diffs them.
#
# Normalization (so type-only differences don't trip false positives):
#   - Strip leading comments (everything up to the first `export`).
#   - Strip `import` lines.
#   - Strip blank lines.
#   - Replace `ApiErrorCode` with `string` so main (typed) matches CLI/ext (loose).
#   - Strip path-specific comments inside function bodies (e.g. references to
#     `apiRequest`).
#
# False positives are acceptable — better than missed drift.
set -euo pipefail

cd "$(dirname "$0")/../.."

MAIN_FILE="src/lib/http/read-api-error-body.ts"
CLI_FILE="cli/src/lib/api-error-body.ts"
EXT_FILE="extension/src/lib/api-error-body.ts"

for f in "$MAIN_FILE" "$CLI_FILE" "$EXT_FILE"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: missing file: $f"
    exit 1
  fi
done

normalize() {
  # Aggressive normalization so formatting / line-break differences don't trip
  # false positives. We only care about semantic equivalence of function bodies.
  # Also strips the `MainApiErrorBody` type declaration (CLI/ext define it
  # inline; main imports it) so cross-file comparison only covers helpers.
  perl -0777 -pe '
    s/^.*?(?=\bexport\b)//s;             # drop header (before first export)
    s/^\s*import[^;]*;\s*$//mg;           # drop import lines
    s/^[ \t]*\/\/.*$//mg;                  # drop // comments
    s/\/\*.*?\*\///gs;                     # drop /* ... */ comments
    s/export\s+type\s+MainApiErrorBody\s*=\s*\{[^}]*\}\s*;?//s;  # drop type decl
    s/\bApiErrorCode\b/string/g;           # type-erase
    s/\s+/ /g;                             # collapse all whitespace
    s/^\s+|\s+$//g;
    s/\s*([{}();,:|])\s*/$1/g;             # remove whitespace around structural chars
    s/,\)/)/g;                              # drop trailing commas in arg lists
  ' "$1"
}

# Required exports per file. `MainApiErrorBody` is defined in api-response.ts on
# the main side (imported as a type), so we don't require it as a local export
# in the main file — only in CLI / extension copies (which can't cross-import).
required_in_all=(
  "readApiErrorBody"
  "getApiErrorMessage"
  "getApiErrorDetail"
  "getApiErrorFieldErrors"
  "readMainApiErrorBody"
)
required_in_cli_ext=(
  "MainApiErrorBody"
)

violations=0
for sym in "${required_in_all[@]}"; do
  for f in "$MAIN_FILE" "$CLI_FILE" "$EXT_FILE"; do
    if ! grep -qE "export[[:space:]]+(async[[:space:]]+)?(function|type|const)[[:space:]]+${sym}\b" "$f"; then
      echo "FAIL: $f missing exported symbol \`${sym}\`"
      violations=$((violations + 1))
    fi
  done
done
for sym in "${required_in_cli_ext[@]}"; do
  for f in "$CLI_FILE" "$EXT_FILE"; do
    if ! grep -qE "export[[:space:]]+(async[[:space:]]+)?(function|type|const)[[:space:]]+${sym}\b" "$f"; then
      echo "FAIL: $f missing exported symbol \`${sym}\`"
      violations=$((violations + 1))
    fi
  done
done

# Compare normalized forms pairwise.
tmpdir=$(mktemp -d -t api-error-body-drift.XXXXXX)
trap 'rm -rf "$tmpdir"' EXIT

normalize "$MAIN_FILE" > "$tmpdir/main.norm"
normalize "$CLI_FILE"  > "$tmpdir/cli.norm"
normalize "$EXT_FILE"  > "$tmpdir/ext.norm"

if ! diff -q "$tmpdir/main.norm" "$tmpdir/cli.norm" >/dev/null 2>&1; then
  echo "DRIFT: $MAIN_FILE vs $CLI_FILE"
  diff -u "$tmpdir/main.norm" "$tmpdir/cli.norm" || true
  violations=$((violations + 1))
fi

if ! diff -q "$tmpdir/main.norm" "$tmpdir/ext.norm" >/dev/null 2>&1; then
  echo "DRIFT: $MAIN_FILE vs $EXT_FILE"
  diff -u "$tmpdir/main.norm" "$tmpdir/ext.norm" || true
  violations=$((violations + 1))
fi

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "✗ api-error-body drift detected. Update all 3 copies to match."
  exit 1
fi

echo "✓ api-error-body helpers in sync across main / CLI / extension"
