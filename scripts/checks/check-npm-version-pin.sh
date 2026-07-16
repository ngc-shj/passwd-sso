#!/usr/bin/env bash
# Assert the pinned npm version is identical across every place that pins it:
#   - Dockerfile               (NPM_VER=X.Y.Z — the release producer's npm)
#   - release.yml              (npm install -g npm@X.Y.Z — build + publish jobs)
#   - dependency-signatures.yml (npm install -g npm@X.Y.Z — the weekly verifier)
#
# These pins are load-bearing for supply-chain integrity: the publish job holds
# id-token:write, and the signature verifier must track the same attestation
# format the packages were produced with (L2). Comments in each file claim
# lockstep ("matches Dockerfile NPM_VER", "match the release producer"), but a
# partial bump would silently break that parity. This guard turns the comment
# into an enforced invariant — the npm sibling of check-dockerfile-prisma-pin.sh.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))"

DOCKERFILE="Dockerfile"
RELEASE_WF=".github/workflows/release.yml"
SIGS_WF=".github/workflows/dependency-signatures.yml"

fail() {
  echo "ERROR: $1"
  exit 1
}

[ -f "$DOCKERFILE" ] || fail "$DOCKERFILE not found"
[ -f "$RELEASE_WF" ] || fail "$RELEASE_WF not found"
[ -f "$SIGS_WF" ] || fail "$SIGS_WF not found"

# Dockerfile pins via `NPM_VER=X.Y.Z`; the workflows pin via `npm@X.Y.Z`.
docker_ver=$(grep -oE 'NPM_VER=[0-9]+\.[0-9]+\.[0-9]+' "$DOCKERFILE" | head -1 | cut -d= -f2)
[ -n "$docker_ver" ] || fail "no pinned 'NPM_VER=X.Y.Z' found in $DOCKERFILE — npm must be version-pinned, not floating"

# Collect every distinct npm@X.Y.Z pin in each workflow. A workflow may pin npm
# in more than one job (release.yml pins it in both build-cli and publish-cli);
# all must agree with the Dockerfile.
mapfile -t release_vers < <(grep -oE 'npm@[0-9]+\.[0-9]+\.[0-9]+' "$RELEASE_WF" | cut -d@ -f2 | sort -u)
mapfile -t sigs_vers < <(grep -oE 'npm@[0-9]+\.[0-9]+\.[0-9]+' "$SIGS_WF" | cut -d@ -f2 | sort -u)

[ "${#release_vers[@]}" -gt 0 ] || fail "no pinned 'npm@X.Y.Z' found in $RELEASE_WF"
[ "${#sigs_vers[@]}" -gt 0 ] || fail "no pinned 'npm@X.Y.Z' found in $SIGS_WF"

for v in "${release_vers[@]}" "${sigs_vers[@]}"; do
  if [ "$v" != "$docker_ver" ]; then
    echo "ERROR: npm pin drift detected."
    echo "  Dockerfile NPM_VER      = $docker_ver"
    echo "  $RELEASE_WF npm@         = ${release_vers[*]}"
    echo "  $SIGS_WF npm@            = ${sigs_vers[*]}"
    echo "All npm pins must be identical. Update them together."
    exit 1
  fi
done

echo "OK (npm pinned to $docker_ver across Dockerfile, release.yml, dependency-signatures.yml)"
