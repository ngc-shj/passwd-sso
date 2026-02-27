#!/usr/bin/env bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "[ERROR] curl is required" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[ERROR] jq is required" >&2
  exit 1
fi

SCIM_BASE_URL="${SCIM_BASE_URL:-http://localhost:3000/api/scim/v2}"
SCIM_TOKEN="${SCIM_TOKEN:-}"
SCIM_INSECURE="${SCIM_INSECURE:-0}"
SMOKE_USER_EMAIL="${SMOKE_USER_EMAIL:-scim-smoke+$(date +%s)@example.com}"
SMOKE_USER_NAME="${SMOKE_USER_NAME:-SCIM Smoke User}"
SMOKE_USER_EXTERNAL_ID="${SMOKE_USER_EXTERNAL_ID:-ext-user-$(date +%s)}"
SMOKE_GROUP_EXTERNAL_ID="${SMOKE_GROUP_EXTERNAL_ID:-ext-group-admin-$(date +%s)}"
SMOKE_GROUP_DISPLAY_NAME="${SMOKE_GROUP_DISPLAY_NAME:-}"

if [[ -z "$SCIM_TOKEN" ]]; then
  echo "[ERROR] SCIM_TOKEN is required" >&2
  echo "Example: SCIM_TOKEN=scim_xxx npm run scim:smoke" >&2
  exit 1
fi

CURL_FLAGS=(-sS)
if [[ "$SCIM_INSECURE" == "1" ]]; then
  CURL_FLAGS+=(-k)
fi

WORK_DIR="$(mktemp -d)"
USER_ID=""
DONE=0

cleanup() {
  if [[ "$DONE" != "1" && -n "$USER_ID" ]]; then
    curl "${CURL_FLAGS[@]}" \
      -o /dev/null \
      -X DELETE \
      -H "Authorization: Bearer $SCIM_TOKEN" \
      -H "Accept: application/scim+json" \
      "$SCIM_BASE_URL/Users/$USER_ID" || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

log() {
  printf '[SCIM-SMOKE] %s\n' "$*"
}

http_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"

  local body_file="$WORK_DIR/body.json"

  if [[ -n "$body" ]]; then
    RESP_STATUS=$(curl "${CURL_FLAGS[@]}" \
      -o "$body_file" \
      -w "%{http_code}" \
      -X "$method" \
      -H "Authorization: Bearer $SCIM_TOKEN" \
      -H "Content-Type: application/scim+json" \
      -H "Accept: application/scim+json" \
      "$SCIM_BASE_URL$path" \
      --data "$body")
  else
    RESP_STATUS=$(curl "${CURL_FLAGS[@]}" \
      -o "$body_file" \
      -w "%{http_code}" \
      -X "$method" \
      -H "Authorization: Bearer $SCIM_TOKEN" \
      -H "Accept: application/scim+json" \
      "$SCIM_BASE_URL$path")
  fi

  RESP_BODY="$(cat "$body_file")"
}

expect_status() {
  local expected="$1"
  local actual="$2"
  local context="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "[ERROR] $context: expected HTTP $expected, got $actual" >&2
    return 1
  fi
}

extract_json() {
  local payload="$1"
  local query="$2"
  printf '%s' "$payload" | jq -r "$query"
}

log "SCIM base URL: $SCIM_BASE_URL"

log "1/8 Discovery: ServiceProviderConfig"
http_json GET "/ServiceProviderConfig"
expect_status 200 "$RESP_STATUS" "GET /ServiceProviderConfig"
printf '%s' "$RESP_BODY" | jq -e '.schemas | index("urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig")' >/dev/null

log "2/8 Discovery: ResourceTypes"
http_json GET "/ResourceTypes"
expect_status 200 "$RESP_STATUS" "GET /ResourceTypes"
printf '%s' "$RESP_BODY" | jq -e 'if type=="array" then length >= 2 else (.Resources | length >= 2) end' >/dev/null

log "3/8 Discovery: Schemas"
http_json GET "/Schemas"
expect_status 200 "$RESP_STATUS" "GET /Schemas"
printf '%s' "$RESP_BODY" | jq -e 'if type=="array" then length >= 2 else (.Resources | length >= 2) end' >/dev/null

log "4/8 Users: POST create"
create_body=$(jq -n \
  --arg email "$SMOKE_USER_EMAIL" \
  --arg name "$SMOKE_USER_NAME" \
  --arg ext "$SMOKE_USER_EXTERNAL_ID" \
  '{schemas:["urn:ietf:params:scim:schemas:core:2.0:User"],userName:$email,name:{formatted:$name},externalId:$ext,active:true}')
http_json POST "/Users" "$create_body"
expect_status 201 "$RESP_STATUS" "POST /Users"
USER_ID=$(extract_json "$RESP_BODY" '.id')
if [[ -z "$USER_ID" || "$USER_ID" == "null" ]]; then
  echo "[ERROR] POST /Users returned no user id" >&2
  exit 1
fi

log "5/8 Users: GET by externalId filter"
filter="externalId%20eq%20\"$SMOKE_USER_EXTERNAL_ID\""
http_json GET "/Users?filter=$filter"
expect_status 200 "$RESP_STATUS" "GET /Users?filter=externalId"
printf '%s' "$RESP_BODY" | jq -e '.totalResults >= 1' >/dev/null

log "6/8 Groups: PATCH add/remove user in ADMIN group"
http_json GET "/Groups"
expect_status 200 "$RESP_STATUS" "GET /Groups?filter=displayName"
admin_group_id=$(extract_json "$RESP_BODY" '.Resources[] | select(.displayName | test(":ADMIN$")) | .id' | head -n 1)
admin_group_name=$(extract_json "$RESP_BODY" '.Resources[] | select(.displayName | test(":ADMIN$")) | .displayName' | head -n 1)
if [[ ( -z "$admin_group_id" || "$admin_group_id" == "null" ) && -n "$SMOKE_GROUP_DISPLAY_NAME" ]]; then
  log "No existing *:ADMIN group mapping found. Creating one with displayName=$SMOKE_GROUP_DISPLAY_NAME"
  group_post=$(jq -n \
    --arg ext "$SMOKE_GROUP_EXTERNAL_ID" \
    --arg dn "$SMOKE_GROUP_DISPLAY_NAME" \
    '{schemas:["urn:ietf:params:scim:schemas:core:2.0:Group"],displayName:$dn,externalId:$ext}')
  http_json POST "/Groups" "$group_post"
  expect_status 201 "$RESP_STATUS" "POST /Groups"
  admin_group_id=$(extract_json "$RESP_BODY" '.id')
  admin_group_name=$(extract_json "$RESP_BODY" '.displayName')
fi
if [[ -z "$admin_group_id" || "$admin_group_id" == "null" ]]; then
  echo "[ERROR] ADMIN group id not found. Set SMOKE_GROUP_DISPLAY_NAME='<teamSlug>:ADMIN'" >&2
  exit 1
fi
log "Using group: $admin_group_name ($admin_group_id)"

patch_add=$(jq -n --arg uid "$USER_ID" '{schemas:["urn:ietf:params:scim:api:messages:2.0:PatchOp"],Operations:[{op:"add",path:"members",value:[{value:$uid}]}]}')
http_json PATCH "/Groups/$admin_group_id" "$patch_add"
expect_status 200 "$RESP_STATUS" "PATCH /Groups/{id} add"

patch_remove=$(jq -n --arg uid "$USER_ID" '{schemas:["urn:ietf:params:scim:api:messages:2.0:PatchOp"],Operations:[{op:"remove",path:"members",value:[{value:$uid}]}]}')
http_json PATCH "/Groups/$admin_group_id" "$patch_remove"
expect_status 200 "$RESP_STATUS" "PATCH /Groups/{id} remove"

log "7/8 Users: PATCH active false -> true"
patch_deactivate='{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":false}]}'
http_json PATCH "/Users/$USER_ID" "$patch_deactivate"
expect_status 200 "$RESP_STATUS" "PATCH /Users/{id} active=false"

patch_reactivate='{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":true}]}'
http_json PATCH "/Users/$USER_ID" "$patch_reactivate"
expect_status 200 "$RESP_STATUS" "PATCH /Users/{id} active=true"

log "8/8 Users: DELETE cleanup"
http_json DELETE "/Users/$USER_ID"
expect_status 204 "$RESP_STATUS" "DELETE /Users/{id}"
USER_ID=""

log "Optional: register group mapping (POST /Groups)"
if [[ -n "$SMOKE_GROUP_DISPLAY_NAME" ]]; then
  group_post=$(jq -n \
    --arg ext "$SMOKE_GROUP_EXTERNAL_ID" \
    --arg dn "$SMOKE_GROUP_DISPLAY_NAME" \
    '{schemas:["urn:ietf:params:scim:schemas:core:2.0:Group"],displayName:$dn,externalId:$ext}')
  http_json POST "/Groups" "$group_post"
  expect_status 201 "$RESP_STATUS" "POST /Groups"
else
  log "Skipped: set SMOKE_GROUP_DISPLAY_NAME='<teamSlug>:ADMIN' to run optional POST /Groups"
fi

DONE=1
log "All SCIM smoke checks passed"
