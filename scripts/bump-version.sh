#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/bump-version.sh <new-version>
# Example: scripts/bump-version.sh 0.3.0
#
# Updates version in all package.json files and syncs lock files.
# Only strict X.Y.Z format is accepted (Chrome manifest compatibility).

VERSION="${1:?Usage: $0 <new-version>}"

# Strict semver: X.Y.Z only, no leading zeros, no prerelease
if ! [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Error: '$VERSION' is not a valid version (expected X.Y.Z, no leading zeros)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for PKG in "$ROOT/package.json" "$ROOT/cli/package.json" "$ROOT/extension/package.json"; do
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    pkg.version = process.argv[2];
    fs.writeFileSync(process.argv[1], JSON.stringify(pkg, null, 2) + '\n');
  " "$PKG" "$VERSION"
  echo "Updated: $PKG → $VERSION"
done

# Sync lock files
for DIR in "$ROOT" "$ROOT/cli" "$ROOT/extension"; do
  if [ -f "$DIR/package-lock.json" ]; then
    (cd "$DIR" && npm install --package-lock-only --ignore-scripts --loglevel=error)
    echo "Synced:  $DIR/package-lock.json"
  fi
done

echo ""
echo "Version bumped to $VERSION"
echo "Next steps:"
echo "  git add package.json cli/package.json extension/package.json"
echo "  git add package-lock.json cli/package-lock.json extension/package-lock.json"
echo "  git commit -m 'chore: bump version to $VERSION'"
