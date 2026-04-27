# Operator Tokens — Runbook

Per-operator bearer tokens authenticate the admin/maintenance routes:
`/api/admin/rotate-master-key` and `/api/maintenance/{purge-history, purge-audit-logs, dcr-cleanup, audit-outbox-metrics, audit-outbox-purge-failed, audit-chain-verify}`.

Each operator mints their own token via the tenant dashboard. The token is bound at issuance time to:

- the operator's user (`subjectUserId`)
- the operator's tenant (`tenantId`)
- a scope (`maintenance` for v1)
- an expiry (default 30 days, max 90, min 1)

Audit logs attribute every action to the token's bound subject — `actorType=HUMAN`, `userId=subjectUserId`, `metadata.tokenId`, `metadata.tokenSubjectUserId`. There is no SYSTEM-attributed admin path; a leaked token forges exactly **one** operator's identity, never an arbitrary admin UUID.

## Issuance

Pre-condition: a session-authenticated tenant OWNER or ADMIN. The session must have been created within the last **15 minutes** (the create endpoint enforces a fresh-auth window — re-sign-in if your dashboard session is older).

1. Sign in to the tenant dashboard.
2. Navigate to **Admin → Tenant → Operator tokens** (`/admin/tenant/operator-tokens`).
3. Click **Create token**.
4. Enter a label (e.g. `alice laptop, ngc-shj, 2026-04-27`).
5. Pick an expiry (1–90 days; default 30).
6. Confirm. The plaintext is shown **once** in a modal; copy it immediately.
7. Save the plaintext to your password manager and to your operations env file (`ADMIN_API_TOKEN=op_...`).

After closing the modal, the dashboard shows the token's prefix, expiry, and last-used time — but never the plaintext again. If you lose the plaintext, mint a new token and revoke the old one.

## Usage

```bash
# Always preview a purge with DRY_RUN=true before running it for real.
ADMIN_API_TOKEN=op_<43-char base64url> DRY_RUN=true scripts/purge-history.sh
ADMIN_API_TOKEN=op_<43-char base64url> DRY_RUN=true scripts/purge-audit-logs.sh

# Once verified, run without DRY_RUN.
ADMIN_API_TOKEN=op_<43-char base64url> scripts/purge-history.sh
ADMIN_API_TOKEN=op_<43-char base64url> scripts/purge-audit-logs.sh

# Master-key rotation (TARGET_VERSION must match SHARE_MASTER_KEY_CURRENT_VERSION).
ADMIN_API_TOKEN=op_<43-char base64url> TARGET_VERSION=2 scripts/rotate-master-key.sh
```

The token's subject is bound at mint time, so no separate `OPERATOR_ID` env var is needed. The server resolves the operator identity from the token.

### Script options

`scripts/purge-history.sh` and `scripts/purge-audit-logs.sh` share the following optional environment variables:

| Variable | Default (purge-history / purge-audit-logs) | Purpose |
| --- | --- | --- |
| `RETENTION_DAYS` | `90` / `365` | Number of days to retain. Records older than this are eligible for purge. |
| `DRY_RUN` | `false` | When `true`, the script reports the matched count without deleting anything. **Always run with `DRY_RUN=true` first.** |
| `INSECURE` | `false` | When `true`, skip TLS certificate verification. Dev-only — never set in production. |
| `APP_URL` | (auto-detected from `.env`) | Override the target deployment URL. |

For routes without a dedicated script (`dcr-cleanup`, `audit-outbox-metrics`, `audit-outbox-purge-failed`, `audit-chain-verify`), curl directly:

```bash
# DCR cleanup (delete expired unclaimed DCR clients)
curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  "$APP_URL/api/maintenance/dcr-cleanup"

# Outbox metrics (cross-tenant aggregates)
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  "$APP_URL/api/maintenance/audit-outbox-metrics"

# Outbox purge of FAILED rows (optionally filter by tenant or age)
curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"<uuid>","olderThanDays":7}' \
  "$APP_URL/api/maintenance/audit-outbox-purge-failed"

# Audit chain verify
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  "$APP_URL/api/maintenance/audit-chain-verify?tenantId=<uuid>"
```

Note: the operator must be admin in the *target* tenant for `audit-chain-verify`. Multi-tenant operators mint a separate token per tenant.

## Rotation

There is no automatic rotation. The recommended manual flow:

1. A few days before expiry, mint a new token.
2. Update your operations env file with the new plaintext.
3. Reload your shell / CI secret (existing scripts read the new value).
4. Revoke the old token via the UI (or `DELETE /api/tenant/operator-tokens/{id}`).

Both tokens verify until the old one is revoked or expires, so there is no downtime window.

## Revocation

Any tenant OWNER/ADMIN may revoke any operator token in their tenant.

- UI: click the trash icon next to the token row.
- API:

```bash
curl -X DELETE -H "Authorization: Bearer <session-cookie>" \
  "$APP_URL/api/tenant/operator-tokens/<token-id>"
```

Revoking sets `revokedAt`; the row remains for audit-trail forensics. Subsequent uses of the token return 401.

`OPERATOR_TOKEN_CREATE` and `OPERATOR_TOKEN_REVOKE` audit events fire for every issuance and revocation. They land in `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` and propagate via tenant webhooks subscribed to the `group:admin` topic.

## Suspected token compromise

1. Revoke immediately (UI or API).
2. Inspect `audit_logs` for `metadata.tokenId = <revoked id>` to enumerate everything the compromised token did.
3. Mint a fresh token to resume operations.
4. If the compromise vector is unclear, also revoke the operator's dashboard sessions (`DELETE /api/sessions/<id>`). The 15-minute step-up window means an attacker cannot mint a *new* operator token from a stolen session unless they can trigger a fresh sign-in within 15 minutes.

## Audit attribution

Every operator-token-authenticated action emits:

| Field | Value |
|---|---|
| `actorType` | `HUMAN` |
| `userId` | the token's `subjectUserId` |
| `metadata.tokenSubjectUserId` | same — explicit for SIEM ergonomics |
| `metadata.tokenId` | the OperatorToken row id (revocation cross-reference) |
| route-specific metadata | unchanged from prior behavior |

SIEM hint: rules that previously alerted on `actorType=SYSTEM, userId=SYSTEM_ACTOR_ID` for these routes should now alert on `actorType=HUMAN` paired with the route's audit-action (`MASTER_KEY_ROTATION`, `AUDIT_LOG_PURGE`, etc.).

Note: an earlier draft of this design proposed a `metadata.authPath` field
distinguishing `legacy_env` from `operator_token` during a parallel-acceptance
migration window. v1 ships only the operator-token path, so `authPath` is not
emitted — there is no legacy path to discriminate against. SIEM rules can rely
on `actorType=HUMAN` + the route-specific action being non-empty.

## Bootstrap (first deployment)

The very first operator token is minted via the tenant dashboard (Auth.js session auth). There is no env-based break-glass — the dashboard is the only path. Ensure that:

- The first tenant OWNER's dashboard sign-in is verified before the cluster is exposed to production traffic (so they can mint tokens).
- The recovery flow for the OWNER's account (passkey, magic-link email, etc.) is operational; otherwise an OWNER lockout requires DB-direct manipulation to recover.

For self-hosted deployments running these maintenance routes from CI:

- Create a dedicated "ops automation" tenant user (OWNER role, `deactivatedAt: null`).
- Sign in as that user, mint a long-lived token (90-day TTL is the cap).
- Store the token as a CI secret. Rotate quarterly.
