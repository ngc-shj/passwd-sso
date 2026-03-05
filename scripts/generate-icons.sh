#!/usr/bin/env bash
set -euo pipefail

# Generate all app icons from public/icon.svg
# Prerequisites: rsvg-convert (librsvg), magick (ImageMagick)
# macOS: brew install librsvg imagemagick

for cmd in rsvg-convert magick; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is not installed." >&2
    echo "  macOS: brew install $([ "$cmd" = rsvg-convert ] && echo librsvg || echo imagemagick)" >&2
    exit 1
  fi
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$REPO_ROOT/public/icon.svg"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Generating icons from $SVG ..."

# PNG generation via rsvg-convert
for size in 16 32 48 128 180 192 512; do
  rsvg-convert -w "$size" -h "$size" "$SVG" -o "$TMP_DIR/icon-${size}.png"
  echo "  icon-${size}.png"
done

# favicon.ico (multi-size) via ImageMagick
magick "$TMP_DIR/icon-16.png" "$TMP_DIR/icon-32.png" "$TMP_DIR/icon-48.png" \
  "$REPO_ROOT/public/favicon.ico"
echo "  -> public/favicon.ico"

# Icon PNGs
cp "$TMP_DIR/icon-32.png"  "$REPO_ROOT/public/icon.png"
cp "$TMP_DIR/icon-180.png" "$REPO_ROOT/public/apple-icon.png"
echo "  -> public/icon.png, apple-icon.png"

# PWA / web manifest icons
cp "$TMP_DIR/icon-192.png" "$REPO_ROOT/public/icon-192.png"
cp "$TMP_DIR/icon-512.png" "$REPO_ROOT/public/icon-512.png"
echo "  -> public/icon-192.png, icon-512.png"

# Chrome extension icons
cp "$TMP_DIR/icon-16.png"  "$REPO_ROOT/extension/public/icons/icon-16.png"
cp "$TMP_DIR/icon-48.png"  "$REPO_ROOT/extension/public/icons/icon-48.png"
cp "$TMP_DIR/icon-128.png" "$REPO_ROOT/extension/public/icons/icon-128.png"
echo "  -> extension/public/icons/icon-{16,48,128}.png"

echo "Done."
