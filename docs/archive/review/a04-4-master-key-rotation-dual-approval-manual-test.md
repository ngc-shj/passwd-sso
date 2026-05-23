# A04-4 Master-Key Rotation Dual-Approval — Manual Smoke Test

**OWASP**: A04 Insecure Design (Tier-2 per R35 — key custody change)
**Scope**: end-to-end operator UX with two real op_* tokens, no mocks.
**Required environment**: dev DB running (`npm run docker:up`), dev server up (`npm run dev`).

The unit tests in `src/app/api/admin/rotate-master-key/**/route.test.ts` exercise
auth, validation, CAS WHERE shape, audit emission, and the eligibility helpers
under mocked Prisma. This document covers the gaps unit tests cannot cover:
real op_* token lifecycle, real RLS enforcement, real PasswordShare
revocation across tenants, and real notification fan-out.

## Pre-conditions

1. **Two operator accounts** in the SAME tenant T1 (call them Alice and Bob),
   both OWNER or ADMIN. Substitute the placeholder logins below with real
   accounts on your dev DB:
   - `<alice-email>` — initiator
   - `<bob-email>` — approver
2. **Two op_* tokens** with `MAINTENANCE` scope, minted via
   `/dashboard/tenant/operator-tokens` while logged in as each user:
   - `<op-alice-token>` (Alice's token)
   - `<op-bob-token>` (Bob's token)
3. **A third operator** Carol in DIFFERENT tenant T2 (also OWNER/ADMIN, also
   with a MAINTENANCE op_* token) — required for the cross-tenant
   adversarial scenario.
4. **Seeded PasswordShare rows**: at least 3 rows with
   `masterKeyVersion < TARGET_VERSION`, `revokedAt = null`,
   `expiresAt > now`. Create via the dashboard or directly via psql against
   the dev DB.
5. **TARGET_VERSION**: pick the current `SHARE_MASTER_KEY_CURRENT_VERSION`
   from `.env` (e.g. `2`).

> ⚠ Never commit real emails / token strings into this doc. Use placeholders
> per `feedback_no_personal_email_in_docs.md` / RS4.

## Test Steps

For each step, "Expected result" includes both the HTTP response check AND
the audit-log query that confirms the row landed.

### Step 1 — Initiate (Alice)

```bash
PHASE=initiate \
  ADMIN_API_TOKEN=<op-alice-token> \
  TARGET_VERSION=2 \
  REASON="2026-05-23 quarterly rotation drill" \
  scripts/rotate-master-key.sh
```

**Expected**:
- HTTP 201.
- stdout contains `rotationId=<uuid>` and `expiresAt=<iso8601>`.
- Audit query `SELECT * FROM audit_logs WHERE action = 'MASTER_KEY_ROTATION_INITIATE' ORDER BY created_at DESC LIMIT 1`
  shows row with `metadata.rotationId` matching and `metadata.targetVersion = 2`.
- **Notification fan-out**: every other active OWNER/ADMIN in T1 receives a
  `MASTER_KEY_ROTATION_PENDING_APPROVAL` notification (visible in the
  dashboard's notification center). Alice does NOT receive one.

**Capture**: `ROTATION_ID=<uuid>` for subsequent steps.

### Step 2 — Self-approve attempt (Alice) → rejected

```bash
PHASE=approve \
  ADMIN_API_TOKEN=<op-alice-token> \
  ROTATION_ID=<uuid-from-step-1> \
  scripts/rotate-master-key.sh
```

**Expected**:
- HTTP 403.
- Response body `{ "error": "FORBIDDEN_SELF_APPROVAL" }`.
- Audit query for `MASTER_KEY_ROTATION_APPROVE` shows a row with
  `metadata.cause = 'FORBIDDEN_SELF_APPROVAL'` and `metadata.rotationId`
  matching — the forensic signal that someone tried self-approval.
- Rotation row state in DB unchanged: `approvedAt IS NULL`.

### Step 3 — Cross-approve (Bob) → succeeds

```bash
PHASE=approve \
  ADMIN_API_TOKEN=<op-bob-token> \
  ROTATION_ID=<uuid-from-step-1> \
  scripts/rotate-master-key.sh
```

**Expected**:
- HTTP 200.
- Response body `{ "ok": true, "status": "approved", "expiresAt": "<iso8601>" }`.
- `expiresAt` is **narrowed** to within ~60 minutes from now (NOT the
  initiate-time +24h). Verify by comparing to step 1's `expiresAt`.
- Audit row `MASTER_KEY_ROTATION_APPROVE` with
  `metadata.newExpiresAt` matching the response.
- Rotation row state: `approvedAt IS NOT NULL`, `approvedById = <bob-userId>`,
  `executedAt IS NULL`.

### Step 4 — Execute (Alice or Bob) → succeeds

```bash
PHASE=execute \
  ADMIN_API_TOKEN=<op-alice-token> \
  ROTATION_ID=<uuid-from-step-1> \
  scripts/rotate-master-key.sh
```

**Expected**:
- HTTP 200.
- Response body `{ "ok": true, "status": "executed", "revokedShares": <N> }`
  where `N >= 1` (matches the seeded share count from Pre-conditions step 4).
- Audit row `MASTER_KEY_ROTATION_EXECUTE` with
  `metadata.revokedShares = N`, `metadata.targetVersion = 2`,
  `metadata.shareRevocationSkipped = false`.
- DB: `master_key_rotations.executedAt IS NOT NULL`,
  `master_key_rotations.revokedShares = N`.
- DB: seeded `PasswordShare` rows now have `revokedAt IS NOT NULL`.

### Step 5 — Double-execute → rejected silently

```bash
# Re-run step 4 exactly.
PHASE=execute \
  ADMIN_API_TOKEN=<op-alice-token> \
  ROTATION_ID=<uuid-from-step-1> \
  scripts/rotate-master-key.sh
```

**Expected**:
- HTTP 409 (`ROTATION_NOT_EXECUTABLE`).
- **Forensic-silent**: audit log for this rotationId still shows EXACTLY ONE
  `MASTER_KEY_ROTATION_EXECUTE` row (from step 4). NO new
  `RACE_LOST_OR_TERMINAL` audit row is emitted for execute race-losses
  (this mirrors AdminVaultReset — execute race losses are silent;
  approve race losses are NOT silent — see step 2 / step 8 in C6.AC4).

### Step 6 — Revoke-before-execute on a FRESH rotation

This step exercises the revoke path. Use a NEW rotationId.

```bash
# 6.a Initiate a fresh rotation.
PHASE=initiate \
  ADMIN_API_TOKEN=<op-alice-token> \
  TARGET_VERSION=2 \
  REASON="revoke-flow test" \
  scripts/rotate-master-key.sh
# capture ROTATION_ID_2

# 6.b Bob approves it.
PHASE=approve \
  ADMIN_API_TOKEN=<op-bob-token> \
  ROTATION_ID=<ROTATION_ID_2> \
  scripts/rotate-master-key.sh
# expect 200 status: approved

# 6.c Bob revokes before executing.
PHASE=revoke \
  ADMIN_API_TOKEN=<op-bob-token> \
  ROTATION_ID=<ROTATION_ID_2> \
  REASON="changing plan" \
  scripts/rotate-master-key.sh
```

**Expected**:
- 6.c HTTP 200, response `{ "ok": true, "status": "revoked" }`.
- Audit row `MASTER_KEY_ROTATION_REVOKE` with
  `metadata.cause = 'SECOND_ACTOR_REVOKE'` (Bob is not the initiator).
- DB: `master_key_rotations.revokedAt IS NOT NULL`,
  `master_key_rotations.executedAt IS NULL`.
- A subsequent execute attempt returns 409 (CAS WHERE `revokedAt: null`
  no longer matches).

### Step 7 — Expiry case

Set up a rotation with a short TTL to test expiry.

> **Setup**: in psql against the dev DB, manually UPDATE a fresh rotation row
> to set `expires_at` to a past timestamp. This simulates the 24h initiate
> window elapsing without approval, without waiting 24h in real time.

```sql
UPDATE master_key_rotations
SET expires_at = NOW() - interval '1 minute'
WHERE id = '<ROTATION_ID_3>'
  AND approved_at IS NULL
  AND executed_at IS NULL
  AND revoked_at IS NULL;
```

```bash
PHASE=approve \
  ADMIN_API_TOKEN=<op-bob-token> \
  ROTATION_ID=<ROTATION_ID_3> \
  scripts/rotate-master-key.sh
```

**Expected**:
- HTTP 409 (`ROTATION_NOT_EXECUTABLE`).
- Audit row `MASTER_KEY_ROTATION_APPROVE` with
  `metadata.cause = 'RACE_LOST_OR_TERMINAL'` (the eligibility helper detected
  `expiresAt <= now` as ALREADY_TERMINAL).

## Rollback

After each step, the dev DB is left in a known state. To reset:

```sql
-- Drop the rotation rows we created during this test.
DELETE FROM master_key_rotations
WHERE reason IN ('2026-05-23 quarterly rotation drill', 'revoke-flow test')
   OR reason LIKE '%test%';
-- Restore the test shares we revoked at step 4.
UPDATE password_shares
SET revoked_at = NULL
WHERE revoked_at >= NOW() - interval '1 hour'
  AND master_key_version < 2;
```

## Adversarial Scenarios (R35 Tier-2)

### A1. Cross-tenant op_* token replay

**Threat**: An attacker has stolen Carol's op_* token (different tenant T2).
They attempt to approve a rotation initiated in T1, hoping the system grants
authority by op_* presence alone.

**Setup**: Alice (T1) initiates a fresh rotation → capture `<ROTATION_ID_4>`.

**Action**:
```bash
PHASE=approve \
  ADMIN_API_TOKEN=<op-carol-token-tenant-T2> \
  ROTATION_ID=<ROTATION_ID_4> \
  scripts/rotate-master-key.sh
```

**Expected (normal-path under RLS)**:
- HTTP 404 — the `withTenantRls(actor.tenantId, ...)` wrapper at findFirst
  filters by Carol's tenant T2; the rotationId from T1 is invisible, so the
  route returns 404 BEFORE reaching the eligibility helper.
- NO `MASTER_KEY_ROTATION_APPROVE` audit row is emitted (404 = "row not
  found in your tenant" — the forensic emission only fires if RLS is
  bypassed). Forensic visibility for cross-tenant probes defers to HTTP
  access logs + the existing operator-token usage audit.
- DB: `master_key_rotations.approvedAt` for `<ROTATION_ID_4>` IS STILL NULL.

**Expected (defense-in-depth path, RLS regresses)**:
- HTTP 403 (`FORBIDDEN_CROSS_TENANT`).
- Audit row `MASTER_KEY_ROTATION_APPROVE` with
  `metadata.cause = 'FORBIDDEN_CROSS_TENANT'` — only emitted if the
  withTenantRls wrapper is replaced with withBypassRls (regression). This
  is the trip-wire that catches RLS regression. The CAS WHERE
  `tenantId: auth.tenantId` provides the final guard regardless.

### A2. Token scope downgrade

**Threat**: Bob's MAINTENANCE-scoped token is revoked / re-issued with a
narrower scope; the old (revoked) bearer string is replayed.

**Setup**: In `/dashboard/tenant/operator-tokens`, REVOKE Bob's token; mint
a new one without MAINTENANCE.

**Action**: re-run step 3 with the OLD (now-revoked) `<op-bob-token>`.

**Expected**:
- HTTP 401 (auth layer rejects revoked tokens —
  `validateOperatorToken` checks `revokedAt: null` and `expiresAt > now`
  on every request).
- NO new audit row for `MASTER_KEY_ROTATION_APPROVE` (auth failure short-
  circuits before the route's audit emission).

### A3. Expired-token replay

**Threat**: A long-lived stolen op_* token has its `expires_at` past;
attacker replays a rotationId from leaked logs.

**Setup**: in psql, set Bob's token row `expires_at = NOW() - interval '1 second'`.
(Don't forget to reset it after.)

**Action**: re-run step 3 with the now-expired token.

**Expected**:
- HTTP 401. Same forensic posture as A2 (auth layer rejects;
  no route-level audit row).

## Notes for the Operator

- The 60-minute execute window (post-approval) is intentional. If you
  approve at 23:00 UTC and forget to execute by 00:00 UTC, the rotation
  expires and you must initiate a fresh one. The cost is bounded
  (re-initiate, re-approve, re-execute); the security benefit is that a
  stolen approval window has a hard upper bound.

- In single-operator tenants (only one MAINTENANCE-scoped operator),
  initiate succeeds but no second actor exists to approve. The rotation
  row sits inert until expiry. This is by design — dual approval requires
  two parties.

- The legacy `POST /api/admin/rotate-master-key` (single-actor) returns
  `410 Gone` with a `replacedBy` discovery payload pointing at the four
  new endpoints. Update any external runbook or monitoring that still
  references the old endpoint.
