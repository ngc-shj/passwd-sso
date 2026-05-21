#!/usr/bin/env bash
# C23 / T13: Enforce that every GitHub Actions workflow uses SHA-pinned
# `uses:` references. Floating tags (e.g. `actions/checkout@v4`) are
# vulnerable to supply-chain attacks where an attacker hijacks the tag.
#
# Allowed forms:
#   uses: <owner>/<repo>@<40-char-hex-sha>  # vX.Y.Z   (recommended)
#   uses: ./local-path                       (local actions)
#   uses: docker://...                       (docker registry)
#
# Forbidden:
#   uses: actions/checkout@v4
#   uses: actions/checkout@main
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))"

WORKFLOWS_DIR=".github/workflows"
if [ ! -d "$WORKFLOWS_DIR" ]; then
  exit 0
fi

# Extract ref after @, then filter:
#   - drop SHA-pinned (40-char hex)
#   - drop local actions (./) and docker:// (no @ ref to extract)
violations=$(
  grep -rEn '^[[:space:]]*-?[[:space:]]*uses:[[:space:]]+[^.][^[:space:]]+@[^[:space:]]+' "$WORKFLOWS_DIR" 2>/dev/null \
  | awk -F'@' '{
      # last field before any # comment is the ref
      ref = $NF
      sub(/[[:space:]].*$/, "", ref)
      if (ref !~ /^[a-f0-9]{40}$/) print $0
    }' \
  || true
)

if [ -n "$violations" ]; then
  printf "FORBIDDEN: floating tags in .github/workflows/ (C23 — pin to 40-char SHA + comment):\n"
  printf "%s\n" "$violations"
  exit 1
fi

exit 0
