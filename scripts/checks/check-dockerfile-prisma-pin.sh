#!/usr/bin/env bash
# Assert the Dockerfile runner stage pins `prisma` to the exact version
# resolved in package-lock.json. A floating `latest` (or a drifted pin) breaks
# build reproducibility and risks prisma-CLI / generated-client version skew in
# the production image and the `migrate` compose service. Mirrors the tar /
# picomatch fail-closed tripwires already in the Dockerfile.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))"

DOCKERFILE="Dockerfile"
LOCKFILE="package-lock.json"

[ -f "$DOCKERFILE" ] || { echo "OK ($DOCKERFILE not present)"; exit 0; }
[ -f "$LOCKFILE" ] || { echo "ERROR: $LOCKFILE not found"; exit 1; }

lock_ver=$(node -p "require('./package-lock.json').packages['node_modules/prisma'].version")
docker_ver=$(grep -oE 'PRISMA_VER=[0-9]+\.[0-9]+\.[0-9]+' "$DOCKERFILE" | head -1 | cut -d= -f2)

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
