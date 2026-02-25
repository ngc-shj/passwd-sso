# SCIM Smoke Test (without IdP)

Run a quick SCIM 2.0 connectivity check using `curl` against this app directly.

## Prerequisites

- App is running locally (default: `http://localhost:3000`)
- A valid SCIM token issued from Org Settings
- `curl` and `jq` installed

## Run

```bash
SCIM_TOKEN='scim_xxx' npm run scim:smoke
```

## Optional environment variables

- `SCIM_BASE_URL`
  - default: `http://localhost:3000/api/scim/v2`
- `SCIM_INSECURE`
  - set `1` to use `curl -k` for self-signed HTTPS
- `SMOKE_USER_EMAIL`
- `SMOKE_USER_NAME`
- `SMOKE_USER_EXTERNAL_ID`
- `SMOKE_GROUP_EXTERNAL_ID`

Example:

```bash
SCIM_BASE_URL='https://localhost:3000/api/scim/v2' \
SCIM_INSECURE=1 \
SCIM_TOKEN='scim_xxx' \
npm run scim:smoke
```

## What it verifies

1. Discovery endpoints (`ServiceProviderConfig`, `ResourceTypes`, `Schemas`)
2. User lifecycle (`POST -> GET(filter) -> PATCH(active false/true) -> DELETE`)
3. Group membership PATCH (`add` / `remove` in `ADMIN`)
4. Group mapping registration (`POST /Groups`)

This covers the app-side SCIM behavior without Okta/Azure wiring.
