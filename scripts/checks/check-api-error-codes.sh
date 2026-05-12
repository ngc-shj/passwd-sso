#!/usr/bin/env bash
# Enforce API error envelope conventions per docs/api/error-handling.md.
#
# Patterns checked:
#  (1) C5: legacy `{ error: "ACCESS_DENIED" }` string literal in production
#      code (must go through `errorResponse(API_ERROR.ACCESS_DENIED, ...)`).
#  (2) C2: prose English `error` value — `{ error: "<Sentence with space>" }`
#      in non-OAuth/SCIM routes (catches `audit-chain-verify:203`-style drift
#      and accidental Java-style messages).
#  (3) C2: lowercase-leading `{ error: "x..." }` outside OAuth/SCIM/MCP routes
#      (catches snake_case OAuth-style leakage into main API).
#  (4) C11: retired internal-jargon code names must not reappear anywhere
#      in `src/` (production or tests).
set -euo pipefail

cd "$(dirname "$0")/../.."

violations=0

# (1) C5 — ACCESS_DENIED string literal outside tests
hits=$(grep -RnE 'NextResponse\.json\(\s*\{\s*error:\s*"ACCESS_DENIED"' src/ \
  --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.' | grep -v '/__tests__/' || true)
if [ -n "$hits" ]; then
  echo "FORBIDDEN: legacy ACCESS_DENIED string literal in production code (C5)"
  echo "$hits"
  violations=$((violations + 1))
fi

# (2) C2 — uppercase-leading English-prose string as `error` value
# Allowed: SCIM (RFC 7644 envelope), OAuth/MCP routes (RFC 6749 envelope).
prose_hits=$(grep -RnE 'NextResponse\.json\(\s*\{\s*error:\s*"[A-Z][^"]*[[:space:]]' src/ \
  --include='*.ts' --include='*.tsx' \
  | grep -vE '/(scim|mcp)/' \
  | grep -v '\.test\.' | grep -v '/__tests__/' || true)
if [ -n "$prose_hits" ]; then
  echo "FORBIDDEN: English-prose error value in main API envelope (C2)"
  echo "$prose_hits"
  violations=$((violations + 1))
fi

# (3) C2 — lowercase-leading error value outside OAuth/SCIM/MCP
lc_hits=$(grep -RnE 'NextResponse\.json\(\s*\{\s*error:\s*"[a-z]' src/ \
  --include='*.ts' --include='*.tsx' \
  | grep -vE '/(scim|mcp)/' \
  | grep -v '\.test\.' | grep -v '/__tests__/' || true)
if [ -n "$lc_hits" ]; then
  echo "FORBIDDEN: snake_case error value in main API envelope (C2)"
  echo "$lc_hits"
  violations=$((violations + 1))
fi

# (4) C11 — retired internal-jargon code names
retired=(
  LEGACY_BODY_HASH_MISMATCH
  ATTACHMENT_CEK_MANIFEST_MISMATCH
  INVALID_IV_FORMAT
  INVALID_AUTH_TAG_FORMAT
  MOBILE_DPOP_INVALID
  MOBILE_REFRESH_REPLAY_DETECTED
  MOBILE_REFRESH_FAMILY_EXPIRED
  EXTENSION_TOKEN_FAMILY_EXPIRED
  LEGACY_ATTACHMENTS_RESIDUAL
  KEY_ESCROW_NOT_COMPLETED
)
retired_pat=$(IFS='|'; echo "${retired[*]}")
retired_hits=$(grep -RnE "\"(${retired_pat})\"" src/ \
  --include='*.ts' --include='*.tsx' || true)
if [ -n "$retired_hits" ]; then
  echo "FORBIDDEN: retired internal-jargon error code name (C11)"
  echo "$retired_hits"
  violations=$((violations + 1))
fi

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "✗ $violations API error code violation(s). See docs/api/error-handling.md."
  exit 1
fi

echo "✓ API error code conventions OK"
