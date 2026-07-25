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
  echo "check-cosign-kms-uri: cosign not installed — skipping (deploy hosts must have it)"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_SH="${COSIGN_URI_CHECK_DEPLOY_SH:-$REPO_ROOT/scripts/deploy.sh}"

# The URI template deploy.sh builds, extracted from the source so this gate
# tracks the real code rather than a copy of it.
TEMPLATE=$(grep -oE 'echo "awskms:/*\$\{arn\}"' "$DEPLOY_SH" | head -1 || true)
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

if echo "$OUT" | grep -q "Failed to parse uri"; then
  echo "ERROR: deploy.sh builds a KMS URI cosign cannot resolve to a key." >&2
  echo "       URI:   $URI" >&2
  echo "       cosign treated the ARN as an endpoint host:" >&2
  echo "$OUT" | grep "Failed to parse uri" | head -1 >&2
  echo "       Use THREE slashes — awskms:///<arn> — the endpoint is empty." >&2
  exit 1
fi

if echo "$OUT" | grep -q "should be in the format"; then
  echo "ERROR: cosign rejected the KMS URI at parse time." >&2
  echo "       URI: $URI" >&2
  echo "$OUT" | head -2 >&2
  exit 1
fi

echo "check-cosign-kms-uri: OK ($URI resolves as a key reference)"
