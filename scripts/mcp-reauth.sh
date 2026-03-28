#!/usr/bin/env bash
# MCP OAuth 2.1 re-authorization script with credentials:decrypt scope
# Usage: bash scripts/mcp-reauth.sh <client_id> <client_secret> [server_url]

set -euo pipefail

CLIENT_ID="${1:?Usage: $0 <client_id> <client_secret> [server_url]}"
CLIENT_SECRET="${2:?Usage: $0 <client_id> <client_secret> [server_url]}"
SERVER="${3:-https://localhost:3000}"
REDIRECT_URI="http://localhost:3000/callback"
SCOPE="credentials:decrypt"

# Generate PKCE pair
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=/+' | head -c 43)
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

echo "=== Step 1: Open this URL in your browser ==="
echo ""
echo "${SERVER}/api/mcp/authorize?client_id=${CLIENT_ID}&redirect_uri=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${REDIRECT_URI}'))")&response_type=code&scope=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${SCOPE}'))")&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256&state=reauth"
echo ""
echo "=== Step 2: Paste the 'code' from the redirect URL ==="
read -rp "Authorization code: " AUTH_CODE

echo ""
echo "=== Step 3: Exchanging code for token... ==="
RESPONSE=$(curl -sk -X POST "${SERVER}/api/mcp/token" \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"authorization_code\",
    \"code\": \"${AUTH_CODE}\",
    \"redirect_uri\": \"${REDIRECT_URI}\",
    \"client_id\": \"${CLIENT_ID}\",
    \"client_secret\": \"${CLIENT_SECRET}\",
    \"code_verifier\": \"${CODE_VERIFIER}\"
  }")

echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"

python3 -c "
import sys, json, datetime
try:
    data = json.loads('''$RESPONSE''')
except:
    print('ERROR: Failed to parse response')
    sys.exit(1)

if 'error' in data:
    print(f'ERROR: {data[\"error\"]}')
    if 'error_description' in data:
        print(f'  {data[\"error_description\"]}')
    sys.exit(1)

token = data.get('access_token', '')
expires_in = data.get('expires_in', 0)
scope = data.get('scope', '')

if not token:
    print('ERROR: No access_token in response')
    sys.exit(1)

expires_at = datetime.datetime.now() + datetime.timedelta(seconds=expires_in)

print()
print('=== Success! ===' )
print(f'Token:      {token}')
print(f'Scope:      {scope}')
print(f'Expires in: {expires_in}s ({expires_in // 60} min)')
print(f'Expires at: {expires_at.strftime(\"%Y-%m-%d %H:%M:%S\")} (local)')
print()

if expires_in <= 0:
    print('WARNING: Token is already expired!')
    sys.exit(1)
elif expires_in < 300:
    print(f'WARNING: Token expires in less than 5 minutes ({expires_in}s)')
print('Update Claude Desktop config and test delegation within the TTL window.')
"
