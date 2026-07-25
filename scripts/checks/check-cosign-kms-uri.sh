#!/usr/bin/env bash
# Gate: the AWS KMS URI scripts/deploy.sh builds must be one cosign actually
# resolves to a KEY, not one it mistakes for an endpoint host.
#
# cosign's grammar is `awskms://[ENDPOINT]/[ID]`. With no custom endpoint the
# authority is EMPTY, so an ARN belongs in the path — THREE slashes. With two,
# cosign parses the ARN as the endpoint host and never reaches KMS. Because
# deploy.sh verifies signatures fail-closed, that mistake aborts EVERY deploy,
# and a stub-based unit test cannot catch it (the stub ignores argv).
#
# Detection: run `cosign public-key` against a syntactically valid but
# non-existent ARN with dummy credentials. The two forms then fail differently:
#
#   3 slashes -> reaches AWS   -> "UnrecognizedClientException" (creds rejected)
#   2 slashes -> never gets out -> "Failed to parse uri: https://arn:aws:kms:..."
#
# The dummy credentials are required: with NO credentials at all both forms fail
# at the same credential-lookup step and the difference is invisible.
#
# Skips when cosign is absent (it is a deploy-host tool, not a build dependency).
set -euo pipefail

if ! command -v cosign >/dev/null 2>&1; then
  # In CI the gate must never silently skip: a skipped gate is indistinguishable
  # from a passing one, and this is the ONLY check that can catch a malformed
  # KMS URI (the deploy unit tests stub cosign and cannot see the --key value).
  # CI installs cosign; a missing binary there is a workflow regression.
  if [ "${CI:-}" = "true" ]; then
    echo "ERROR: cosign is not installed, but CI=true." >&2
    echo "       This gate is the only check that can catch a malformed KMS URI," >&2
    echo "       so skipping it in CI would hide the failure it exists to find." >&2
    echo "       Restore the cosign install step in the workflow." >&2
    exit 1
  fi
  echo "check-cosign-kms-uri: cosign not installed — skipping (local only; CI requires it)"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_SH="${COSIGN_URI_CHECK_DEPLOY_SH:-$REPO_ROOT/scripts/deploy.sh}"

# The URI template deploy.sh builds, extracted from the source so this gate
# tracks the real code rather than a copy of it.
# Match any `echo "awskms:...${arn}..."` form, not just slashes-then-${arn}: a
# custom endpoint (`awskms://host:port/${arn}`) is legitimate, and a narrower
# pattern would misreport it as "construction moved" instead of verifying it.
TEMPLATE=$(grep -oE 'echo "awskms:[^"]*\$\{arn\}[^"]*"' "$DEPLOY_SH" | head -1 || true)
if [ -z "$TEMPLATE" ]; then
  echo "ERROR: could not find the awskms URI construction in $DEPLOY_SH." >&2
  echo "       If it moved, update this gate — do not delete it." >&2
  exit 1
fi

FAKE_ARN="arn:aws:kms:ap-northeast-1:111122223333:key/11111111-2222-3333-4444-555555555555"
# Substitute the fake ARN into whatever form deploy.sh actually emits.
URI="${TEMPLATE#echo \"}"
URI="${URI%\"}"
URI="${URI/\$\{arn\}/$FAKE_ARN}"

OUT=$(
  AWS_EC2_METADATA_DISABLED=true \
  AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE \
  AWS_SECRET_ACCESS_KEY=dummy \
  AWS_REGION=us-east-1 \
  timeout 90 cosign public-key --key "$URI" 2>&1 || true
)

# ALLOWLIST, not denylist. Require positive evidence that cosign resolved the URI
# to a KMS key and actually issued the API call: the dummy credentials must come
# back rejected by AWS. Listing known-bad error strings instead would fail OPEN on
# every other failure mode — a `awskms:/<arn>` (one slash) URI produced neither
# known string and the gate reported OK, and a timeout or a future cosign error
# message would do the same.
if echo "$OUT" | grep -qE "UnrecognizedClientException|InvalidClientTokenId|SignatureDoesNotMatch|AccessDenied|NotFoundException"; then
  echo "check-cosign-kms-uri: OK ($URI reached AWS KMS as a key reference)"
  exit 0
fi

echo "ERROR: cosign did not resolve this KMS URI to a key." >&2
echo "       URI: $URI" >&2
echo "       Expected the dummy credentials to be rejected BY AWS, which proves" >&2
echo "       cosign parsed the URI and issued the KMS call. Instead:" >&2
echo "$OUT" | head -3 | sed 's/^/         /' >&2
echo "" >&2
if echo "$OUT" | grep -q "Failed to parse uri"; then
  echo "       cosign treated the ARN as an ENDPOINT HOST. The URI grammar is" >&2
  echo "       awskms://[ENDPOINT]/[ID]; with no endpoint the ARN goes in the" >&2
  echo "       path — THREE slashes: awskms:///<arn>." >&2
elif echo "$OUT" | grep -q "should be in the format"; then
  echo "       cosign rejected the URI at parse time — check the slash count and" >&2
  echo "       that the ARN is well formed." >&2
else
  echo "       Unrecognised outcome (timeout, network failure, or a cosign change)." >&2
  echo "       This gate fails CLOSED: it will not pass without proof the URI works." >&2
fi
exit 1
