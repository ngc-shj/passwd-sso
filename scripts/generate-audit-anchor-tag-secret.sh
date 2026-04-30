#!/usr/bin/env bash
# Generate a 32-byte random secret for the AUDIT_ANCHOR_TAG_SECRET.
#
# The secret is used as the HMAC key for computing tenant tags in
# audit anchor manifests.
#
# Usage:
#   bash scripts/generate-audit-anchor-tag-secret.sh [--out <path>]
#
# Options:
#   --out <path>   Write the hex secret to <path> (mode 0600) instead of stdout.
#
# Exit codes:
#   0 — success
#   1 — error

set -euo pipefail

OUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      shift
      OUT_FILE="${1:-}"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

SECRET="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"

if [[ -n "$OUT_FILE" ]]; then
  (umask 077; printf '%s\n' "$SECRET" > "$OUT_FILE")
  echo "[generate-audit-anchor-tag-secret] Written to ${OUT_FILE}" >&2
else
  printf '%s\n' "$SECRET"
fi

echo "# Set this as AUDIT_ANCHOR_TAG_SECRET in .env" >&2
