#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   scripts/bump-version.sh           # Auto-suggest version from git log (interactive)
#   scripts/bump-version.sh <X.Y.Z>   # Bump to explicit version
#
# Updates version in all package.json files, syncs lock files, and creates a git tag.
# Only strict X.Y.Z format is accepted (Chrome manifest compatibility).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ─── Helpers ──────────────────────────────────────────────────

validate_version() {
  local v="$1"
  if ! [[ "$v" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    echo "Error: '$v' is not a valid version (expected X.Y.Z, no leading zeros)" >&2
    return 1
  fi
}

current_version() {
  node -p "require('$ROOT/package.json').version"
}

latest_tag() {
  git -C "$ROOT" tag -l 'v*' --sort=-version:refname | head -1
}

# Increment a semver component: bump_component "0.2.1" major|minor|patch
bump_component() {
  local ver="$1" part="$2"
  IFS='.' read -r major minor patch <<< "$ver"
  case "$part" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
  esac
}

# Analyze commits since last tag and determine bump type
suggest_bump() {
  local tag commits bump="patch"

  tag=$(latest_tag)
  if [ -z "$tag" ]; then
    echo "patch"
    return
  fi

  commits=$(git -C "$ROOT" log "$tag"..HEAD --format="%s" 2>/dev/null || true)
  if [ -z "$commits" ]; then
    echo "No new commits since $tag" >&2
    echo "none"
    return
  fi

  # Check for breaking changes (highest priority)
  if echo "$commits" | grep -qiE '^[a-z]+!:|BREAKING CHANGE'; then
    bump="major"
  # Check for new features
  elif echo "$commits" | grep -qE '^feat(\(.+\))?:'; then
    bump="minor"
  fi

  echo "$bump"
}

# ─── Interactive mode (no arguments) ─────────────────────────

if [ $# -eq 0 ]; then
  CURRENT=$(current_version)
  TAG=$(latest_tag)
  BUMP=$(suggest_bump)

  if [ "$BUMP" = "none" ]; then
    echo "No new commits since $TAG. Nothing to bump."
    exit 0
  fi

  SUGGESTED=$(bump_component "$CURRENT" "$BUMP")

  echo "Current version: $CURRENT"
  echo "Latest tag:      ${TAG:-"(none)"}"
  echo ""
  echo "Commits since ${TAG:-"beginning"}:"
  if [ -n "$TAG" ]; then
    git -C "$ROOT" log "$TAG"..HEAD --format="  %C(auto)%h%Creset %s" --no-decorate
  else
    git -C "$ROOT" log --format="  %C(auto)%h%Creset %s" --no-decorate
  fi
  echo ""
  echo "Suggested bump:  $BUMP → $SUGGESTED"
  echo ""
  read -rp "Version to use [$SUGGESTED]: " INPUT
  VERSION="${INPUT:-$SUGGESTED}"

  validate_version "$VERSION" || exit 1
else
  VERSION="$1"
  validate_version "$VERSION" || exit 1
fi

# ─── Apply version ───────────────────────────────────────────

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
echo ""
echo "Next steps:"
echo "  git add package.json cli/package.json extension/package.json"
echo "  git add package-lock.json cli/package-lock.json extension/package-lock.json"
echo "  git commit -m 'chore: bump version to $VERSION'"
echo "  git tag v$VERSION"
echo "  git push origin \$(git branch --show-current) --tags"
