#!/usr/bin/env bash
# CI gate: API route handlers must not read the request body via the
# unbounded primitives `req.text()` / `req.arrayBuffer()` / `req.formData()`
# without a streaming byte cap. The App Router has no platform body-size cap,
# so a chunked / no-Content-Length body would otherwise be buffered into memory
# unbounded (availability DoS, worst on pre-auth/public OAuth endpoints).
#
# Canonical helpers (src/lib/http/parse-body.ts):
#   readJsonWithCap / parseBody     — JSON bodies (authoritative streaming cap)
#   readFormWithCap                 — application/x-www-form-urlencoded
#   readBytesWithCap                — raw bytes (e.g. replay-vs-retry hash)
#   rejectOversizedMultipart        — gate before req.formData() (multipart)
#
# Rules enforced (over src/app/api/**/route.ts, excluding *.test.ts):
#   (1) req.text()       — FORBIDDEN. Use readFormWithCap / readBytesWithCap.
#   (2) req.arrayBuffer()— FORBIDDEN. Use readBytesWithCap.
#   (3) req.formData()   — ALLOWED only when the same file also calls
#                          rejectOversizedMultipart(...). req.formData() cannot
#                          be stream-capped (the parser owns the stream), so the
#                          pre-parse Content-Length gate is mandatory.
#
# A genuinely-exempt route may be added to the allowlist file
# scripts/checks/raw-body-read-allowlist.txt (one path per line, `#` comments).
#
# Fail: exits 1 with one RAW_BODY_READ line per offending route.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
API_DIR="$REPO_ROOT/src/app/api"
ALLOWLIST="$REPO_ROOT/scripts/checks/raw-body-read-allowlist.txt"

# Normalize allowlist into a newline-delimited list (bash 3.2: no assoc arrays).
ALLOW_LIST=""
if [ -f "$ALLOWLIST" ]; then
  while IFS= read -r line; do
    line="${line%$'\r'}"
    line="${line## }"; line="${line%% }"
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    ALLOW_LIST="${ALLOW_LIST}${line}
"
  done < "$ALLOWLIST"
fi

is_allowed() {
  printf '%s' "$ALLOW_LIST" | grep -qxF "$1"
}

fail=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  rel="${file#"$REPO_ROOT"/}"
  is_allowed "$rel" && continue

  # (1) + (2): text() / arrayBuffer() are never allowed in routes.
  if grep -nE "\b(req|request)\.(text|arrayBuffer)\(\)" "$file" >/dev/null; then
    hit=$(grep -nE "\b(req|request)\.(text|arrayBuffer)\(\)" "$file" | head -1)
    echo "RAW_BODY_READ: $rel — req.text()/req.arrayBuffer() is forbidden (use readFormWithCap / readBytesWithCap): $hit"
    fail=1
  fi

  # (3): formData() requires a rejectOversizedMultipart gate in the same file.
  if grep -nE "\b(req|request)\.formData\(\)" "$file" >/dev/null; then
    if ! grep -q "rejectOversizedMultipart(" "$file"; then
      hit=$(grep -nE "\b(req|request)\.formData\(\)" "$file" | head -1)
      echo "RAW_BODY_READ: $rel — req.formData() without rejectOversizedMultipart() gate: $hit"
      fail=1
    fi
  fi
done < <(
  grep -rlE "\b(req|request)\.(text|arrayBuffer|formData)\(\)" "$API_DIR" \
    --include="route.ts" 2>/dev/null \
    | grep -v "\.test\.ts$" \
    | sort
)

if [ "$fail" -ne 0 ]; then
  echo
  echo "Route handlers must cap the request body. Use the helpers in"
  echo "src/lib/http/parse-body.ts, or add a justified entry to"
  echo "scripts/checks/raw-body-read-allowlist.txt."
  exit 1
fi

exit 0
