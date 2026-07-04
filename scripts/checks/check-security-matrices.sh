#!/usr/bin/env bash
# CI check: the generated security matrices are in sync with the code.
#
# Regenerates docs/security/route-policy-matrix.md and
# docs/security/deletion-retention-matrix.md, then asserts each generated file
# is tracked, non-empty, and byte-identical to the committed version.
#
# `git diff --quiet` alone only detects MODIFICATIONS to tracked files: it
# reports clean if the generator starts writing to an untracked path, if a
# matrix file is `git rm`'d, or if it is truncated to empty. The explicit
# tracked + non-empty guards close those silent-pass modes so the drift check
# cannot vacuously pass while a matrix is missing.
#
# Exit 0 = in sync, Exit 1 = drift / missing / empty.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Resolve the local `tsx` whether this runs via `npm run` (PATH already has
# node_modules/.bin) or is invoked directly (it does not).
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"

MATRICES=(
  "docs/security/route-policy-matrix.md"
  "docs/security/deletion-retention-matrix.md"
)

# Regenerate in place; the generator is deterministic (sorted keys).
tsx scripts/generate-security-matrices.ts

failures=0
for f in "${MATRICES[@]}"; do
  if ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    echo "check-security-matrices: FAIL — $f is not tracked by git (generator output path drift or file removed)" >&2
    failures=1
    continue
  fi
  if [ ! -s "$f" ]; then
    echo "check-security-matrices: FAIL — $f is empty" >&2
    failures=1
  fi
done

# Only meaningful for files that exist; drift on a missing file is already
# reported above.
if ! git diff --quiet -- "${MATRICES[@]}"; then
  echo "check-security-matrices: FAIL — generated matrices differ from committed version. Run 'npm run generate:security-matrices' and commit the result." >&2
  git --no-pager diff --stat -- "${MATRICES[@]}" >&2
  failures=1
fi

if [ "$failures" -ne 0 ]; then
  exit 1
fi

echo "check-security-matrices: OK"
