#!/usr/bin/env bash
# Generate a 32-byte random seed for the AUDIT_ANCHOR_SIGNING_KEY.
#
# The seed is used as an Ed25519 private key seed; node:crypto.createPrivateKey
# reconstructs the full keypair from this seed alone.
#
# Usage:
#   bash scripts/generate-audit-anchor-signing-key.sh [--out <path>]
#
# Options:
#   --out <path>   Write the hex key to <path> (mode 0600) instead of stdout.
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

KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"

if [[ -n "$OUT_FILE" ]]; then
  (umask 077; printf '%s\n' "$KEY" > "$OUT_FILE")
  echo "[generate-audit-anchor-signing-key] Written to ${OUT_FILE}" >&2
else
  printf '%s\n' "$KEY"
fi

echo "# Set this as AUDIT_ANCHOR_SIGNING_KEY in .env" >&2
