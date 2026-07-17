#!/usr/bin/env bash
# Assert the Dockerfile runner stage pins `prisma` to the exact version
# resolved in package-lock.json. A floating `latest` (or a drifted pin) breaks
# build reproducibility and risks prisma-CLI / generated-client version skew in
# the production image and the `migrate` compose service. Mirrors the tar /
# picomatch fail-closed tripwires already in the Dockerfile.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))"

# FIXTURE_ROOT is a SINGLE override covering BOTH inputs (Dockerfile +
# package-lock.json) so the self-test
# (scripts/__tests__/check-dockerfile-prisma-pin.test.mjs) can never end up
# comparing a fixture Dockerfile against the real repo's lockfile (test-F10,
# multi-input gate). Production CI uses the default (repo root).
FIXTURE_ROOT="${DOCKERFILE_PRISMA_PIN_ROOT:-$REPO_ROOT}"
cd "$FIXTURE_ROOT"

DOCKERFILE="Dockerfile"
LOCKFILE="package-lock.json"

# CI-auditable: print effective scan path on one line.
echo "check-dockerfile-prisma-pin: FIXTURE_ROOT=$FIXTURE_ROOT"

# sec-F6: env-pollution guard. Any override + CI=true requires an explicit
# fixture-mode acknowledgement, so a stray `export` leaking into a real CI
# run cannot silently point the gate at an empty fixture dir and green it.
if [ "${CI:-}" = "true" ] && [ -n "${DOCKERFILE_PRISMA_PIN_ROOT:-}" ]; then
  if [ "${DOCKERFILE_PRISMA_PIN_FIXTURE_MODE:-}" != "1" ]; then
    echo "ENV_POLLUTION_GUARD: DOCKERFILE_PRISMA_PIN_ROOT override set under CI=true without DOCKERFILE_PRISMA_PIN_FIXTURE_MODE=1 — refusing to run against a possibly-unintended path."
    exit 1
  fi
fi

[ -f "$DOCKERFILE" ] || { echo "OK ($DOCKERFILE not present)"; exit 0; }
[ -f "$LOCKFILE" ] || { echo "ERROR: $LOCKFILE not found"; exit 1; }

lock_ver=$(node -p "require('./package-lock.json').packages['node_modules/prisma'].version")
# `|| true` on the grep: a floating/absent PRISMA_VER must fall through to the
# explicit error message below, not silently kill the script via pipefail
# (set -e treats a no-match grep as command failure, aborting before the
# intended ERROR line ever prints — RT7 test caught this: see
# check-dockerfile-prisma-pin.test.mjs "no pinned PRISMA_VER" case).
docker_ver=$( (grep -oE 'PRISMA_VER=[0-9]+\.[0-9]+\.[0-9]+' "$DOCKERFILE" || true) | head -1 | cut -d= -f2)

if [ -z "$docker_ver" ]; then
  echo "ERROR: no pinned 'PRISMA_VER=X.Y.Z' found in $DOCKERFILE — prisma must be version-pinned, not floating"
  exit 1
fi

if [ "$docker_ver" != "$lock_ver" ]; then
  echo "ERROR: Dockerfile PRISMA_VER=$docker_ver does not match package-lock.json prisma $lock_ver"
  echo "Update PRISMA_VER in $DOCKERFILE (and the build-time assertion) to $lock_ver."
  exit 1
fi

echo "OK (Dockerfile PRISMA_VER=$docker_ver matches lockfile)"
