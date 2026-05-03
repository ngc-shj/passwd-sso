# Manual Test Plan: audit-log-download-actor-type-filter

Tier: Tier-1 (UI surface — admin audit-logs page changed; not auth/authz/crypto/session, so no Tier-2 adversarial scenarios).

The R3-F2 page change is a pure JSX whitespace re-flow (no logic, no selector, no aria-* changes), so the user-facing behavior under test is the R3-F1 server-side filter parity for the personal and tenant audit log downloads.

## Pre-conditions

- Local dev stack up: `npm run docker:up` (Postgres + Redis + Jackson + Mailpit + audit-outbox-worker)
- App running: `npm run dev`
- Browser session signed in as a tenant admin user (so all three download surfaces are reachable)
- The user's personal audit log has events from at least two distinct actor types (e.g., HUMAN events from logins, plus SERVICE_ACCOUNT events if any service-account activity has occurred). For the tenant view, generate at least one SA token activity to ensure SERVICE_ACCOUNT rows exist:
  - Mint a service account at `/admin/tenant/machine-identity/service-accounts`, generate a token, perform any read via `/api/v1/passwords` with the SA token.

## Steps

### S1. Personal audit log download — actorType=HUMAN
1. Navigate to `/dashboard/account/audit-logs`.
2. Set the actor type dropdown to **HUMAN**.
3. Click **Download → JSONL**.
4. Open the downloaded file.

### S2. Personal audit log download — actorType=SERVICE_ACCOUNT
1. On the same page, set the dropdown to **SERVICE_ACCOUNT**.
2. Click **Download → JSONL**.
3. Open the downloaded file.

### S3. Personal audit log download — actorType=ALL (regression check)
1. Set the dropdown to **ALL**.
2. Click **Download → JSONL**.
3. Open the downloaded file.

### S4. Tenant audit log download — actorType=SERVICE_ACCOUNT
1. Navigate to `/admin/tenant/audit-logs` (admin role required).
2. Set the actor type dropdown to **SERVICE_ACCOUNT**.
3. Pick a date range covering at least the last 7 days.
4. Click **Download → CSV**.
5. Open the CSV.

### S5. Team admin audit-logs page — visual rendering (R3-F2)
1. Navigate to `/admin/teams/<team-id>/audit-logs` (team admin/owner required).
2. Visually compare the layout against `/admin/tenant/members` (the canonical SectionLayout pattern).

## Expected result

- **S1**: Every line in the JSONL has `"actorType": "HUMAN"`. No SERVICE_ACCOUNT or MCP_AGENT rows present.
- **S2**: Every line has `"actorType": "SERVICE_ACCOUNT"`. No HUMAN rows present.
- **S3**: Mixed actorType values present (matches today's full-export behavior — regression check).
- **S4**: CSV body rows are exclusively SERVICE_ACCOUNT actors (the `actorType` column is currently omitted from CSV per the parent review's R2-F2 deferral, so verify by cross-referencing the same date range in the on-screen list with the SA filter applied — row count should match).
- **S5**: The Card sits flush within the `SectionLayout` frame with consistent padding/margin (matches the layout of `/admin/tenant/members` and `/admin/teams/<id>/general/profile`). No visual regression — header, filter row, download button, and log list all aligned.

## Rollback

- Single revert: `git revert <PR-merge-sha>` reverses all 4 commits cleanly. No DB migration to undo, no config change, no data state mutation.
