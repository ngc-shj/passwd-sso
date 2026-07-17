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

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))"

# WORKFLOWS_DIR is overridable so the self-test
# (scripts/__tests__/check-actions-sha-pinned.test.mjs) can point the guard at
# a fixture tree. Production CI uses the default. Mirrors the STEPUP_GUARD_*
# scan-root idiom (check-permanent-delete-stepup.sh).
WORKFLOWS_DIR="${ACTIONS_SHA_PINNED_WORKFLOWS_DIR:-$REPO_ROOT/.github/workflows}"

# CI-auditable: print effective scan path on one line.
echo "check-actions-sha-pinned: WORKFLOWS_DIR=$WORKFLOWS_DIR"

# sec-F6: env-pollution guard. Any override + CI=true requires an explicit
# fixture-mode acknowledgement, so a stray `export` leaking into a real CI
# run cannot silently point the gate at an empty fixture dir and green it.
if [ "${CI:-}" = "true" ] && [ -n "${ACTIONS_SHA_PINNED_WORKFLOWS_DIR:-}" ]; then
  if [ "${ACTIONS_SHA_PINNED_FIXTURE_MODE:-}" != "1" ]; then
    echo "ENV_POLLUTION_GUARD: ACTIONS_SHA_PINNED_WORKFLOWS_DIR override set under CI=true without ACTIONS_SHA_PINNED_FIXTURE_MODE=1 — refusing to run against a possibly-unintended path."
    exit 1
  fi
fi

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
