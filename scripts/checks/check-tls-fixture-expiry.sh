#!/usr/bin/env bash
# CI/pre-PR guard: the iOS real-TLS test fixtures (tlsLeaf*.p12) carry
# short-lived leaves — Apple's TLS trust policy rejects any server leaf whose
# validity span exceeds ~398 days (SecTrust -67901), so the generator caps them
# at 397 days and they EXPIRE roughly once a year. When they lapse,
# ServerTrustRealTLSTests breaks on the macOS runner with an opaque handshake
# error. This guard catches the lapse EARLY, on Linux, before it reaches CI.
#
# WHY THIS RUNS ON UBUNTU, NOT MACOS: the committed .p12 is `-legacy`-encrypted
# (RC2/3DES PKCS#12). ubuntu-latest ships OpenSSL 3.x which accepts `-legacy`;
# macos-latest ships LibreSSL which does NOT. This guard must run in the
# ubuntu static-checks job — never next to the fixtures on the macOS iOS job.
#
# WHY -clcerts: `openssl pkcs12 -nokeys` emits the leaf AND the CA chain cert.
# `openssl x509` reads only the first cert on stdin, so relying on emission
# order would let a reordering silently check the ~century-lived CA instead of
# the leaf — a check that can never fail. `-clcerts` restricts the output to the
# client (leaf) cert, so the leaf is unambiguously the checked cert.
#
# The PKCS#12 passphrase is TEST-ONLY and intentionally public (the keys are
# scoped to localhost/127.0.0.1, CA:FALSE — never a production secret). We still
# pass it via `-passin env:` rather than `pass:<literal>` so this script models
# the correct idiom: a literal on argv is visible in the process list.
#
# Exit 0 = every leaf valid past the window. Exit 1 = a leaf expired/expiring,
# or a fixture could not be read (which must NOT be mistaken for "healthy").
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Overridable for the self-test (scripts/__tests__/check-tls-fixture-expiry.test.mjs),
# which points these at an isolated tmp fixture tree — never the repo fixtures.
FIXTURE_ROOT="${TLS_FIXTURE_CHECK_ROOT:-$REPO_ROOT/ios/PasswdSSOTests/fixtures/TLS}"
CHECKEND_DAYS="${TLS_FIXTURE_CHECKEND_DAYS:-30}"
# Public test passphrase; matches LocalTLSServer.fixturePassphrase and
# generate-tls-test-fixtures.sh. Overridable so the self-test can drive the
# wrong-passphrase (unreadable) branch.
export TLS_FIXTURE_PASS="${TLS_FIXTURE_PASS:-passwd-sso-test}"

checkend_secs=$(( CHECKEND_DAYS * 86400 ))
fail=0
found=0

shopt -s nullglob
for p12 in "$FIXTURE_ROOT"/tlsLeaf*.p12; do
  found=1
  name="$(basename "$p12")"

  # Extract ONLY the leaf cert. The pkcs12 exit code AND an empty result are
  # BOTH treated as "unreadable" — checking only for empty output would let a
  # partial-then-failed extraction (non-zero exit but some bytes emitted) pass
  # as healthy. `|| true` here would re-hide exactly that, so the exit status is
  # captured explicitly instead.
  extract_ok=1
  leaf_pem="$(openssl pkcs12 -in "$p12" -nokeys -clcerts \
    -passin env:TLS_FIXTURE_PASS -legacy 2>/dev/null)" || extract_ok=0

  if [ "$extract_ok" -eq 0 ] || [ -z "$leaf_pem" ]; then
    echo "TLS_FIXTURE_UNREADABLE: $name — could not extract a leaf certificate" >&2
    echo "    (wrong passphrase, missing openssl -legacy support, or corrupt p12)" >&2
    fail=1
    continue
  fi

  if printf '%s\n' "$leaf_pem" | openssl x509 -checkend "$checkend_secs" -noout >/dev/null 2>&1; then
    enddate="$(printf '%s\n' "$leaf_pem" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    echo "TLS_FIXTURE_OK: $name valid past ${CHECKEND_DAYS}d (until ${enddate})"
  else
    enddate="$(printf '%s\n' "$leaf_pem" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    echo "TLS_FIXTURE_EXPIRING: $name expires within ${CHECKEND_DAYS}d (at ${enddate:-unknown})" >&2
    echo "    Regenerate with: ios/scripts/generate-tls-test-fixtures.sh" >&2
    fail=1
  fi
done

if [ "$found" -eq 0 ]; then
  echo "TLS_FIXTURE_NONE: no tlsLeaf*.p12 found under $FIXTURE_ROOT" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "TLS fixture expiry guard failed." >&2
  echo "Re-run ios/scripts/generate-tls-test-fixtures.sh to refresh the leaves," >&2
  echo "then commit the updated tlsLeaf*.p12 (see ios/README.md)." >&2
  exit 1
fi

echo "TLS fixture expiry guard passed (window: ${CHECKEND_DAYS}d)."
