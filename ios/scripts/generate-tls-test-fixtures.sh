#!/usr/bin/env bash
# Regenerate the real-TLS integration-test fixtures used by
# ServerTrustRealTLSTests: a long-lived local test CA plus two short-lived
# leaf identities it signs.
#
# WHY LEAVES ARE SHORT-LIVED: Apple's TLS trust policy rejects any server leaf
# whose validity span exceeds ~398 days (SecTrust error -67901). So the leaves
# MUST be capped at 397 days — which means they EXPIRE and this script must be
# re-run roughly once a year (the test fails with an actionable message when
# they lapse). The CA has no such cap and stays valid for decades.
#
# These are TEST-ONLY key material scoped to localhost / 127.0.0.1 — never a
# production secret. The PKCS#12 passphrase is intentionally public.
#
# Usage:  ios/scripts/generate-tls-test-fixtures.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="$REPO_ROOT/ios/PasswdSSOTests/fixtures/TLS"
PASS="passwd-sso-test"  # public: matches LocalTLSServer.fixturePassphrase
LEAF_DAYS=397           # Apple caps TLS leaf validity at ~398 days.

mkdir -p "$DEST"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

leaf_ext() {
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n'
  printf 'basicConstraints=CA:FALSE\n'
  printf 'keyUsage=digitalSignature,keyEncipherment\n'
  printf 'extendedKeyUsage=serverAuth\n'
}

# --- Long-lived local CA (EC P-256) ---
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 36500 \
  -subj "/CN=PasswdSSO Test Local CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -out ca.crt
openssl x509 -in ca.crt -outform DER -out "$DEST/testLocalCA.der"

# --- Two leaves signed by that CA (same host, DIFFERENT keys) ---
#   leafA = the pinned "good" server
#   leafB = a rotated / attacker key (drives the mismatch case)
for L in A B; do
  openssl ecparam -name prime256v1 -genkey -noout -out "leaf$L.key"
  openssl req -new -key "leaf$L.key" -subj "/CN=localhost" -out "leaf$L.csr"
  openssl x509 -req -in "leaf$L.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days "$LEAF_DAYS" -sha256 \
    -extfile <(leaf_ext) \
    -out "leaf$L.crt"
  openssl pkcs12 -export -inkey "leaf$L.key" -in "leaf$L.crt" -certfile ca.crt \
    -name "leaf$L" -passout "pass:$PASS" -legacy \
    -out "$DEST/tlsLeaf$L.p12"
  echo "tlsLeaf$L.p12  valid until: $(openssl x509 -in "leaf$L.crt" -noout -enddate | cut -d= -f2)"
done

echo ""
echo "Regenerated TLS test fixtures in $DEST"
echo "Leaves expire in ~$LEAF_DAYS days — re-run this script when the test reports expiry."
