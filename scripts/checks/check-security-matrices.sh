#!/usr/bin/env bash
# CI check: the generated security matrices are in sync with the code.
#
# Regenerates docs/security/route-policy-matrix.md and
# docs/security/deletion-retention-matrix.md, then asserts:
#   1. the generator wrote EXACTLY the expected set of paths (no more, no less)
#   2. each expected file is tracked by git and non-empty
#   3. each expected file is byte-identical to the committed version
#
# `git diff --quiet` alone only detects MODIFICATIONS to tracked files: it
# reports clean if the generator's output path drifts to a new (untracked)
# file while the old tracked matrix sits unchanged, if a matrix is `git rm`'d,
# or if one is truncated to empty. Check 1 (written-set equality, driven off
# the generator's own `Wrote <path>` lines) closes the path-drift false
# negative; checks 2-3 close the removed/empty ones.
#
# Exit 0 = in sync, Exit 1 = drift / missing / empty / unexpected output path.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Resolve the local `tsx` whether this runs via `npm run` (PATH already has
# node_modules/.bin) or is invoked directly (it does not).
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"

# Expected outputs, as absolute paths (the generator's `Wrote` lines are
# absolute). Keep in sync with ROUTE_POLICY_OUT / DELETION_RETENTION_OUT in
# scripts/generate-security-matrices.ts — check 1 fails loudly if they drift.
EXPECTED_ABS=(
  "$REPO_ROOT/docs/security/route-policy-matrix.md"
  "$REPO_ROOT/docs/security/deletion-retention-matrix.md"
)
# Repo-relative forms for the git checks.
MATRICES=(
  "docs/security/route-policy-matrix.md"
  "docs/security/deletion-retention-matrix.md"
)

# Regenerate; capture stdout so we can verify WHICH paths were written.
gen_out="$(tsx scripts/generate-security-matrices.ts)"

failures=0

# Check 1: the set of `Wrote <path>` lines must equal the expected set exactly.
# A generator whose output path drifted would write a path not in EXPECTED_ABS
# (or fail to write an expected one), which this catches — unlike a fixed-path
# git diff, which would see the stale file unchanged and pass.
written_sorted="$(printf '%s\n' "$gen_out" | sed -n 's/^Wrote //p' | LC_ALL=C sort)"
expected_sorted="$(printf '%s\n' "${EXPECTED_ABS[@]}" | LC_ALL=C sort)"
if [ "$written_sorted" != "$expected_sorted" ]; then
  echo "check-security-matrices: FAIL — generator wrote a different set of paths than expected." >&2
  echo "  expected:" >&2; printf '    %s\n' "$expected_sorted" >&2
  echo "  written:"  >&2; printf '    %s\n' "${written_sorted:-<none>}" >&2
  echo "  (generator output path drifted? update EXPECTED_ABS + MATRICES to match.)" >&2
  failures=1
fi

# Check 2: each expected file is tracked and non-empty.
for f in "${MATRICES[@]}"; do
  if ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    echo "check-security-matrices: FAIL — $f is not tracked by git (output path drift or file removed)" >&2
    failures=1
    continue
  fi
  if [ ! -s "$f" ]; then
    echo "check-security-matrices: FAIL — $f is empty" >&2
    failures=1
  fi
done

# Check 3: regenerated content matches the committed version.
if ! git diff --quiet -- "${MATRICES[@]}"; then
  echo "check-security-matrices: FAIL — generated matrices differ from committed version. Run 'npm run generate:security-matrices' and commit the result." >&2
  git --no-pager diff --stat -- "${MATRICES[@]}" >&2
  failures=1
fi

if [ "$failures" -ne 0 ]; then
  exit 1
fi

echo "check-security-matrices: OK"
