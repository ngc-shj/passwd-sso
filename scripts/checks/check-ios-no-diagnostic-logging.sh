#!/usr/bin/env bash
# CI/pre-PR guard: the iOS host app and AutoFill extension must ship no
# diagnostic logging or reverted crypto/scheme regressions (C11/C13.7).
#
# Forbidden in ios/**/*.swift:
#   - PSSO_DIAG               diagnostic NSLog markers (leak server error
#                             bodies / KDF metadata / blob lengths to logs)
#   - Authorization: DPoP <accessToken>  resource calls must use Bearer (C9)
#   - Data(base64Encoded: unlockData...)  vault-unlock fields are hex, not
#                             base64 (C8) — base64-decoding them silently fails
#
# Exit 0 = clean, Exit 1 = a forbidden pattern was found.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# IOS_DIR is overridable so the self-test
# (scripts/__tests__/check-ios-no-diagnostic-logging.test.mjs) can point the
# guard at a fixture tree. Production CI uses the default. Mirrors the
# STEPUP_GUARD_* scan-root idiom (check-permanent-delete-stepup.sh).
IOS_DIR="${IOS_DIAG_GUARD_IOS_DIR:-$REPO_ROOT/ios}"

# CI-auditable: print effective scan path on one line.
echo "check-ios-no-diagnostic-logging: IOS_DIR=$IOS_DIR"

# sec-F6: env-pollution guard. Any override + CI=true requires an explicit
# fixture-mode acknowledgement, so a stray `export` leaking into a real CI
# run cannot silently point the gate at an empty fixture dir and green it.
if [ "${CI:-}" = "true" ] && [ -n "${IOS_DIAG_GUARD_IOS_DIR:-}" ]; then
  if [ "${IOS_DIAG_GUARD_FIXTURE_MODE:-}" != "1" ]; then
    echo "ENV_POLLUTION_GUARD: IOS_DIAG_GUARD_IOS_DIR override set under CI=true without IOS_DIAG_GUARD_FIXTURE_MODE=1 — refusing to run against a possibly-unintended path." >&2
    exit 1
  fi
fi

fail=0

check_pattern() {
  local label="$1" pattern="$2"
  # -F where possible; here patterns are fixed strings.
  local hits
  hits="$(grep -rnF --include='*.swift' -- "$pattern" "$IOS_DIR" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "FAIL: forbidden iOS pattern ($label):" >&2
    echo "$hits" >&2
    fail=1
  else
    echo "OK: no '$label' in ios/**/*.swift"
  fi
}

check_pattern "PSSO_DIAG diagnostic logging" "PSSO_DIAG"
# Intentionally narrow: matches the specific regression (access token sent with
# the DPoP scheme). It must NOT broaden to `DPoP \(` because the token-refresh
# path legitimately uses `Authorization: DPoP \(refreshToken)`.
check_pattern "DPoP scheme on access token (must be Bearer)" "DPoP \\(accessToken)"
check_pattern "base64-decode of vault-unlock data (fields are hex)" "Data(base64Encoded: unlockData"

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "iOS diagnostic-logging / regression guard failed. Remove the pattern(s) above." >&2
  exit 1
fi

echo "iOS diagnostic-logging guard passed."
