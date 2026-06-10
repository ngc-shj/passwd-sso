#!/usr/bin/env bash
set -euo pipefail

# Generate the iOS AppIcon (single-size 1024x1024) from ios/scripts/app-icon.svg.
#
# iOS marketing/app icons must be a full-bleed OPAQUE square with NO alpha
# channel (App Store validation rejects alpha; iOS applies its own corner
# mask). rsvg-convert renders the SVG to a raster PNG, then ImageMagick
# flattens onto the brand background and strips alpha + pins 8-bit RGB so
# actool/App Store accept the result.
#
# Prerequisites: rsvg-convert (librsvg), magick (ImageMagick), sips (macOS).
#   macOS: brew install librsvg imagemagick

for cmd in rsvg-convert magick sips; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is not installed." >&2
    case "$cmd" in
      rsvg-convert) echo "  macOS: brew install librsvg" >&2 ;;
      magick)       echo "  macOS: brew install imagemagick" >&2 ;;
      sips)         echo "  sips ships with macOS; this script is macOS-only." >&2 ;;
    esac
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SVG="$SCRIPT_DIR/app-icon.svg"
OUT_DIR="$SCRIPT_DIR/../PasswdSSOApp/Assets.xcassets/AppIcon.appiconset"
OUT_PNG="$OUT_DIR/AppIcon-1024.png"
BRAND="#5B57D6"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$OUT_DIR"

echo "Rendering $SVG -> 1024x1024 PNG ..."
rsvg-convert -w 1024 -h 1024 "$SVG" -o "$TMP_DIR/icon-raw.png"

# Flatten onto the brand background, strip alpha, pin 8-bit true-color RGB.
magick "$TMP_DIR/icon-raw.png" \
  -background "$BRAND" -flatten -alpha off \
  -depth 8 -define png:color-type=2 \
  "PNG24:$OUT_PNG"
echo "  -> $OUT_PNG"

# Self-assert the output contract: 1024x1024, no alpha (depth pinned above).
w=$(sips -g pixelWidth  "$OUT_PNG" | awk '/pixelWidth/{print $2}')
h=$(sips -g pixelHeight "$OUT_PNG" | awk '/pixelHeight/{print $2}')
a=$(sips -g hasAlpha    "$OUT_PNG" | awk '/hasAlpha/{print $2}')
if [ "$w" != 1024 ] || [ "$h" != 1024 ] || [ "$a" != no ]; then
  echo "Error: icon contract violated: ${w}x${h} hasAlpha=$a (want 1024x1024 hasAlpha=no)" >&2
  exit 1
fi

echo "Done. ${w}x${h}, hasAlpha=$a"
