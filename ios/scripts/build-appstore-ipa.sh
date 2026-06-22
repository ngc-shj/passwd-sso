#!/usr/bin/env bash
set -euo pipefail

# Build an App Store .ipa for PasswdSSO: xcodegen → archive → export.
#
# Produces ios/build/PasswdSSO.ipa, ready to upload to App Store Connect via
# Xcode Organizer, Transporter.app, or `xcrun altool` (see UPLOAD note below).
#
# Signing: uses automatic signing (-allowProvisioningUpdates), matching
# project.yml's CODE_SIGN_STYLE: Automatic and DEVELOPMENT_TEAM 4789NDA9RQ.
# Xcode must be signed in with an Apple ID that has access to that team — no
# secrets are stored in this repo. The build number comes from
# CURRENT_PROJECT_VERSION = $(MARKETING_VERSION); this script does not bump it.
#
# Prerequisites: Xcode (xcodebuild), xcodegen. Run from anywhere.
#   brew install xcodegen
#
# Usage:
#   ios/scripts/build-appstore-ipa.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$IOS_DIR/build"
ARCHIVE_PATH="$BUILD_DIR/PasswdSSO.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"
EXPORT_OPTIONS="$SCRIPT_DIR/ExportOptions.plist"
SCHEME="PasswdSSOApp"

for cmd in xcodebuild xcodegen; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: '$cmd' not found in PATH" >&2; exit 1; }
done

cd "$IOS_DIR"

echo "==> Regenerating Xcode project (xcodegen)"
xcodegen generate

echo "==> Archiving $SCHEME (Release, generic iOS device)"
rm -rf "$ARCHIVE_PATH"
xcodebuild archive \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates

echo "==> Exporting .ipa (app-store-connect)"
rm -rf "$EXPORT_DIR"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates

# exportArchive names the .ipa after the product; surface a stable path.
IPA_SRC="$(find "$EXPORT_DIR" -maxdepth 1 -name '*.ipa' -print -quit)"
[ -n "$IPA_SRC" ] || { echo "error: no .ipa produced in $EXPORT_DIR" >&2; exit 1; }
IPA_OUT="$BUILD_DIR/PasswdSSO.ipa"
cp -f "$IPA_SRC" "$IPA_OUT"

echo
echo "==> Done: $IPA_OUT"
echo
echo "UPLOAD (pick one):"
echo "  - Xcode Organizer: Window → Organizer → select archive → Distribute App"
echo "  - Transporter.app: drag in $IPA_OUT"
echo "  - CLI (needs App Store Connect API key .p8 + key id + issuer id):"
echo "      xcrun altool --upload-app -f \"$IPA_OUT\" -t ios \\"
echo "        --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>"
