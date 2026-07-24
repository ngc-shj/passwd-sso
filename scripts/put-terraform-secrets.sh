#!/usr/bin/env bash
# Inject app / jackson secret VALUES into AWS Secrets Manager out-of-band, so
# they never enter Terraform state (2026-07 review, F3).
#
# Terraform (infra/terraform/secrets.tf) creates only the secret CONTAINERS.
# This script populates their values AFTER `terraform apply` and BEFORE the ECS
# services start (an empty secret makes ECS task launch fail with
# ResourceNotFound on the referenced JSON key).
#
# Values are read from JSON FILES, never from CLI arguments — argv is visible in
# `ps`, shell history, and process listings. Provide one or both of:
#   --app-file <path>      JSON object of app secret key/values
#   --jackson-file <path>  JSON object of jackson secret key/values
#
# The container names are derived from the same "${name_prefix}" Terraform uses
# (var.project + var.environment); pass them explicitly:
#   --name-prefix <prefix>   e.g. passwd-sso-prod   (REQUIRED)
#   --region <region>        AWS region             (default: AWS_REGION env or ap-northeast-1)
#
# Example:
#   scripts/put-terraform-secrets.sh \
#     --name-prefix passwd-sso-prod \
#     --app-file ./app-secrets.json \
#     --jackson-file ./jackson-secrets.json
#
# Exit codes: 0 success; 1 usage / precondition error; 2 AWS call failed.
set -euo pipefail

NAME_PREFIX=""
APP_FILE=""
JACKSON_FILE=""
REGION="${AWS_REGION:-ap-northeast-1}"

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name-prefix) NAME_PREFIX="${2:?--name-prefix requires a value}"; shift 2 ;;
    --app-file)    APP_FILE="${2:?--app-file requires a value}"; shift 2 ;;
    --jackson-file) JACKSON_FILE="${2:?--jackson-file requires a value}"; shift 2 ;;
    --region)      REGION="${2:?--region requires a value}"; shift 2 ;;
    -h|--help)     usage 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage 1 ;;
  esac
done

[ -n "$NAME_PREFIX" ] || { echo "ERROR: --name-prefix is required" >&2; usage 1; }
command -v aws >/dev/null 2>&1 || { echo "ERROR: aws CLI not found" >&2; exit 1; }
command -v jq  >/dev/null 2>&1 || { echo "ERROR: jq not found" >&2; exit 1; }

if [ -z "$APP_FILE" ] && [ -z "$JACKSON_FILE" ]; then
  echo "ERROR: provide at least one of --app-file / --jackson-file" >&2
  exit 1
fi

# Put one secret's value from a JSON file. Validates the file is a JSON object
# and streams it via a temp file so the plaintext never appears in argv.
put_secret() {
  local secret_name="$1" json_file="$2"
  [ -f "$json_file" ] || { echo "ERROR: file not found: $json_file" >&2; exit 1; }
  if ! jq -e 'type == "object"' "$json_file" >/dev/null 2>&1; then
    echo "ERROR: $json_file is not a JSON object" >&2
    exit 1
  fi
  echo "Putting secret value: $secret_name (from $json_file)"
  # `file://` keeps the plaintext out of argv (aws reads it from disk).
  if ! aws secretsmanager put-secret-value \
        --region "$REGION" \
        --secret-id "$secret_name" \
        --secret-string "file://$json_file" >/dev/null; then
    echo "ERROR: put-secret-value failed for $secret_name" >&2
    exit 2
  fi
}

[ -n "$APP_FILE" ]     && put_secret "${NAME_PREFIX}-app-secrets"     "$APP_FILE"
[ -n "$JACKSON_FILE" ] && put_secret "${NAME_PREFIX}-jackson-secrets" "$JACKSON_FILE"

echo "OK — secret values injected out-of-band (not in Terraform state)."
