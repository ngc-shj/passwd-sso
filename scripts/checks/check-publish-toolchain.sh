#!/usr/bin/env bash
# Enforce the publish-toolchain trust boundary in release.yml, per trust domain
# (NOT a single global npm version across every file). The load-bearing invariant
# is the OIDC publish job's isolation, not version identity:
#
#   publish-cli / verify-published (id-token / verification jobs)
#     - MUST pin an exact Node patch (node-version: "X.Y.Z"), so the bundled npm
#       is deterministic and can be asserted at runtime.
#     - MUST NOT run `npm install -g npm@...` (fetching npm from the registry
#       would execute externally-sourced code; the publish job holds id-token).
#       This is also enforced structurally by findPublishJobIsolationViolation in
#       check-workflow-supply-chain.mjs — checked here too as a targeted tripwire.
#     - The declared PUBLISH_NPM_VERSION must meet Trusted Publishing's floor
#       (npm >= 11.5.1).
#
# Dockerfile / dependency-signatures.yml pin npm for their OWN roles (runtime
# migration tooling; the signature verifier). They are intentionally NOT required
# to equal the publish npm — each trust domain pins what it needs. This script
# only asserts they ARE pinned (no floating `latest`), not that they match.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))"

RELEASE_WF=".github/workflows/release.yml"
SIGS_WF=".github/workflows/dependency-signatures.yml"
DOCKERFILE="Dockerfile"

fail() {
  echo "ERROR: $1"
  exit 1
}

[ -f "$RELEASE_WF" ] || fail "$RELEASE_WF not found"

# Compare two dotted versions: returns 0 if $1 >= $2.
ver_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

# --- Publish toolchain: exact Node pin + floor + no registry npm install ------

node_pin=$(grep -oE 'PUBLISH_NODE_VERSION:\s*"[0-9]+\.[0-9]+\.[0-9]+"' "$RELEASE_WF" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
npm_pin=$(grep -oE 'PUBLISH_NPM_VERSION:\s*"[0-9]+\.[0-9]+\.[0-9]+"' "$RELEASE_WF" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)

[ -n "$node_pin" ] || fail "release.yml: PUBLISH_NODE_VERSION must be an exact Node patch (X.Y.Z), not a floating major — the bundled npm must be deterministic"
[ -n "$npm_pin" ] || fail "release.yml: PUBLISH_NPM_VERSION (the npm bundled with the pinned Node) must be declared as X.Y.Z and asserted at runtime"

# Trusted Publishing floor.
ver_ge "$npm_pin" "11.5.1" || fail "release.yml: PUBLISH_NPM_VERSION=$npm_pin is below the npm Trusted Publishing floor (>= 11.5.1)"

# PUBLISH_NODE_VERSION must be an EXACT patch (X.Y.Z), so the bundled npm is
# deterministic. (The grep above already required the X.Y.Z shape; assert the
# captured value has no trailing `.x`/range and is a full three-part semver.)
printf '%s' "$node_pin" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "release.yml: PUBLISH_NODE_VERSION=$node_pin must be an exact patch (X.Y.Z), not a partial or floating version"

# Every setup-node in release.yml MUST resolve node-version from the pinned env —
# never a literal (which could be a floating major like "24" or "24.x" while the
# env pin stays valid, silently un-pinning a job) and never node-version-file
# (which would inherit the Node-20 .nvmrc). Enforce the POSITIVE form: any
# `node-version:` line whose value is not exactly `${{ env.PUBLISH_NODE_VERSION }}`
# is a violation, as is any `node-version-file:` line. This is the structural
# guard that a per-value blocklist ("2[0-9]") kept missing.
bad_node_version=$(grep -nE '^\s*node-version:' "$RELEASE_WF" \
  | grep -vF 'node-version: ${{ env.PUBLISH_NODE_VERSION }}' || true)
if [ -n "$bad_node_version" ]; then
  echo "ERROR: release.yml pins node-version literally instead of \${{ env.PUBLISH_NODE_VERSION }}:"
  echo "$bad_node_version"
  echo "Every publish/verify job must use the exact env-pinned Node so the bundled npm is deterministic."
  exit 1
fi
if grep -nE '^\s*node-version-file:' "$RELEASE_WF" >/dev/null; then
  fail "release.yml: node-version-file is present — the publish toolchain must pin an exact Node via \${{ env.PUBLISH_NODE_VERSION }}, not inherit .nvmrc (Node 20)"
fi

# No registry npm install anywhere in release.yml. The build job also avoids it
# now (uses the bundled npm), and the publish job must never fetch npm under OIDC.
# Ignore comment lines (a `# ... npm install -g npm@ ...` explainer is allowed);
# only an actual command occurrence is a violation.
if grep -vE '^\s*#' "$RELEASE_WF" | grep -E 'npm\s+install\s+-g\s+npm@' >/dev/null; then
  fail "release.yml: 'npm install -g npm@...' present — the publish toolchain must use the npm bundled with the pinned Node distribution, not a registry fetch"
fi

# --- Verifier & Docker: each pinned for its own role (no cross-domain identity)-

if [ -f "$SIGS_WF" ]; then
  sigs_npm=$(grep -oE 'npm@[0-9]+\.[0-9]+\.[0-9]+' "$SIGS_WF" | head -1 | cut -d@ -f2 || true)
  [ -n "$sigs_npm" ] || fail "$SIGS_WF: the signature verifier must pin an explicit npm@X.Y.Z (no floating 'latest')"
  ver_ge "$sigs_npm" "11.5.1" || fail "$SIGS_WF: npm@$sigs_npm is too old to verify current attestation formats (>= 11.5.1)"
fi

if [ -f "$DOCKERFILE" ]; then
  docker_npm=$(grep -oE 'NPM_VER=[0-9]+\.[0-9]+\.[0-9]+' "$DOCKERFILE" | head -1 | cut -d= -f2 || true)
  [ -n "$docker_npm" ] || fail "$DOCKERFILE: npm must be version-pinned (NPM_VER=X.Y.Z), not floating"
fi

echo "OK (publish toolchain: Node $node_pin / npm $npm_pin bundled, no registry npm install; verifier & Docker npm pinned per role)"
