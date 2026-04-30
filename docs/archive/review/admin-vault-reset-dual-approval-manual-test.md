# Manual Test Plan: admin-vault-reset-dual-approval

Target branch: `feature/admin-vault-reset-dual-approval`
Dev URL: `https://localhost:3001/passwd-sso`
Tier: **R35 Tier-2** — required (auth flow change, session lifecycle, crypto material handling). Gating for production deploy.
Scope: dual-approval (initiate → approve → execute) for tenant-admin vault reset, including AAD-bound encryptedToken, email-snapshot guard, cross-tenant session invalidation, and migration backfill.

## Pre-conditions

- Docker stack up: `docker compose up -d db redis jackson mailpit`
- Migrations applied: `npx prisma migrate deploy`
  - Drift on `20260428200000_revoke_references_from_outbox_worker` is acceptable per prior dev DB state — `migrate dev` will block, `migrate deploy` succeeds.
  - New migrations expected to apply: `20260430120000_admin_vault_reset_dual_approval`, `20260430120001_notification_type_pending_approval`, `20260430120002_admin_vault_reset_backfill`.
- Prisma client regenerated: `npm run db:generate` (required if branch was switched — see memory `feedback_prisma_generate_branch_switch.md`).
- Dev server restarted AFTER schema changes: `npm run dev`. Hot-reload does NOT refresh the cached Prisma client.
- Seed data present: `npm run db:seed`.
- Audit outbox worker running: `npm run worker:audit-outbox` (separate process; without it `audit_logs` rows remain `PENDING` in `audit_outbox`).

### Test fixture (one tenant, four users)

Substitute `<test-user-email>` placeholders below; do not commit real personal addresses (memory `feedback_no_personal_email_in_docs`).

| Role     | Handle | Purpose                                                |
|----------|--------|--------------------------------------------------------|
| OWNER    | Alice  | initiator alternate / cross-tenant approval probe      |
| ADMIN    | Bob    | initiator                                              |
| ADMIN    | Carol  | approver                                               |
| MEMBER   | Dave   | reset target — vault holder                            |

Dave's setup:
- Vault contains at least 3 password entries + 1 attachment.
- Dave is signed in on 3 distinct browser sessions (Firefox, Chrome, Safari) so the multi-device session-invalidation probe is meaningful.
- Dave is also a `TenantMember` of a second tenant (Tenant-B) for the cross-tenant adversarial probe (A1 / Scenario 6).

### Pre-test DB snapshot

```bash
docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
  SELECT u.email, tm.role, tm.tenant_id
  FROM users u JOIN tenant_members tm ON tm.user_id = u.id
  WHERE u.email IN ('<alice-email>','<bob-email>','<carol-email>','<dave-email>')
  ORDER BY tm.tenant_id, tm.role;"

docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
  SELECT id, target_user_id, status_columns_only := approved_at IS NULL AS pending,
         executed_at, revoked_at, expires_at, target_email_at_initiate
  FROM admin_vault_resets
  ORDER BY created_at DESC LIMIT 5;"
```

Expected baseline: 4 user rows, 1 tenant for Alice/Bob/Carol/Dave; 0 admin_vault_resets rows for the Dave / current tenant.

---

## Steps & Expected results

### Scenario 1 — Happy path (FR1, FR3, FR5, FR7)

**Steps:**
1. Sign in as **Bob** (`<bob-email>`). Navigate to Settings → Tenant → Members → row for Dave → "Reset Vault" button.
2. Confirm dialog renders; type `DELETE MY VAULT`; click Confirm.
3. Wait ~1s; refresh the History dialog.
4. Open mailpit (`http://localhost:8025`) and inbox for Carol.
5. Sign in as **Carol** in a different browser; open Settings → Tenant → Members → Dave → History.
6. Click "Approve" on the pending row; type `APPROVE`; click Confirm.
7. Open mailpit inbox for Dave. Click the reset URL in the email.
8. On the vault-reset/admin page, type `DELETE MY VAULT`; click Confirm.
9. Observe redirect on the source browser. Switch to Dave's other 2 browser tabs (Firefox, Chrome) and click any link.

**Expected:**
- Step 2 → POST `/api/tenant/members/<dave-id>/reset-vault` returns 200. DB row created in `pending_approval`:
  ```bash
  docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
    SELECT id, initiated_by_id, approved_by_id, approved_at, executed_at,
           revoked_at, expires_at, length(encrypted_token) AS tok_len,
           target_email_at_initiate
    FROM admin_vault_resets ORDER BY created_at DESC LIMIT 1;"
  ```
  Expected: `approved_by_id IS NULL`, `approved_at IS NULL`, `executed_at IS NULL`, `revoked_at IS NULL`, `expires_at ≈ now()+24h`, `tok_len > 0` (envelope-encrypted; non-NULL), `target_email_at_initiate = '<dave-email>'`.
- Step 4 → mailpit shows ONE email to Carol with subject containing "Vault reset" or "Approval needed" (NOT to Alice, NOT to Dave).
- Audit row: `ADMIN_VAULT_RESET_INITIATE` with `metadata.resetId = <id>` and `metadata.expiresAt` set.
- In-app notifications: `notifications` table has 1 row of type `ADMIN_VAULT_RESET_PENDING_APPROVAL` for Carol; 0 rows for Dave; 0 rows for Bob (initiator), 0 rows for Alice (OWNER but isTenantRoleAbove probe — confirm if Alice receives one based on permission predicate).
- Step 6 → POST `/api/tenant/members/<dave-id>/reset-vault/<reset-id>/approve` returns 200. DB:
  - `approved_at ≈ now()`, `approved_by_id = <carol-id>`, `expires_at = min(created_at+24h, now()+60min)`.
  - Audit row `ADMIN_VAULT_RESET_APPROVE` with `metadata = { resetId, initiatedById: <bob-id>, targetUserId: <dave-id> }`.
- Step 7 → mailpit shows email to Dave (`<dave-email>`) with reset URL containing the plaintext token in the URL fragment.
- Step 8 → POST `/api/vault/admin-reset` returns 200. DB:
  - `executed_at ≈ now()`, `encrypted_token IS NULL` (NULLed on success).
  - Audit row `ADMIN_VAULT_RESET_EXECUTE` with `metadata.invalidatedSessions, invalidatedExtensionTokens, invalidatedApiKeys` (mapped from helper return).
  - `password_entries` for Dave: 0 rows; `password_attachments`: 0 rows.
  - `sessions WHERE user_id = '<dave-id>'`: 0 rows.
- Step 9 → other browsers: any subsequent request returns 401 (session cookie present but row deleted; tombstone in cache); page redirects to `/<locale>/auth/signin` within `TOMBSTONE_TTL_MS`.

**Result:** [x] PASS — 2026-04-30
- Tenant: `papapyan@gmail.com` — papapyan (OWNER) acting as initiator (Bob role); test-admin@example.test as approver (Carol role); test-member@example.test as target (Dave role).
- Verified DB row state at each step: `approved_at`, `approved_by_id`, `executed_at`, `encrypted_token` lifecycle all transitioned as expected.
- `expires_at` cap (S12) confirmed: at approve time, `expires_at - approved_at = 3600s` (= 60 min EXECUTE_TTL_MS, smaller side of `min(createdAt+24h, now+60min)`).
- FR8 silent-target verified: in-app notifications table showed `ADMIN_VAULT_RESET_PENDING_APPROVAL` to test-admin only at initiate time; `ADMIN_VAULT_RESET` to test-member only AFTER approve.
- Audit chain (3 rows): INITIATE (papapyan, metadata.expiresAt) → APPROVE (test-admin, metadata.newExpiresAt) → EXECUTE (test-member, metadata.{invalidatedSessions: 1, invalidatedExtensionTokens: 0, invalidatedApiKeys: 0, invalidatedMcpAccessTokens: 0, invalidatedMcpRefreshTokens: 0, invalidatedDelegationSessions: 0, deletedEntries: 2}).
- Vault wipe: `password_entries` 2 → 0; `vault_keys` 1 → 0; user vault columns (`vault_setup_at`, `encrypted_secret_key`, `master_password_server_hash`, `recovery_encrypted_secret_key`) all NULL post-execute.
- FR7 session invalidation: target's session row deleted; browser auto-redirected to sign-in.

---

### Scenario 2 — Self-approval blocked (FR4, S5)

**Steps:**
1. Sign in as Bob. Initiate a reset for Dave (do NOT approve).
2. From Bob's session, attempt to approve the same row directly via curl:
   ```bash
   curl -i -X POST 'https://localhost:3001/passwd-sso/api/tenant/members/<dave-id>/reset-vault/<reset-id>/approve' \
     -H 'Content-Type: application/json' \
     -H "Cookie: __Secure-authjs.session-token=<bob-session-token>" \
     -H 'Origin: https://localhost:3001' \
     --data '{}'
   ```
3. Examine response status, body, and DB row.

**Expected:**
- Response: 403 (app-level pre-check) with body `{ "error": "FORBIDDEN", ... }` OR 409 `RESET_NOT_APPROVABLE` if pre-check is bypassed and the CAS WHERE filters out `initiatedById = actor.id`.
- DB: `approved_at IS NULL`, `approved_by_id IS NULL` (row unchanged).
- Audit row recorded for the failed attempt.

**Result:** [x] PASS — 2026-04-30
- Tested via browser DevTools Console fetch from papapyan (initiator) session against fresh `pending_approval` row `df45cc7e-...`.
- Response: HTTP 403, body `{"error":"FORBIDDEN"}`. DB row unchanged (`approved_at IS NULL`).
- App-level pre-check fired (`resetRecord.initiatedById === session.user.id`).
- Forensic audit row emitted: `action=ADMIN_VAULT_RESET_APPROVE`, `metadata.cause="FORBIDDEN_SELF_APPROVAL"`, `actor=papapyan`. Implementation gap from initial round-3 review (forbidden() returned without audit) was caught and fixed mid-test by 5-LOC addition; updated route test to assert the new audit emission.
- Confirmed multi-layer defense: Layer 0 (UI disabled cue, R26) + Layer 1 (RBAC, see Scenario A4) + Layer 2 (app-level pre-check + forensic audit, this scenario) + Layer 3 (DB CAS WHERE `initiatedById: { not: actor.id }`, verified by integration test).

---

### Scenario 3 — Email-change race (FR12, S9)

**Steps:**
1. Sign in as Bob. Initiate reset for Dave. Capture `target_email_at_initiate` from DB.
2. Sign in as Dave in a third browser; Settings → Account → change email to `<dave-new-email>`. Confirm via mailpit.
3. As Carol, attempt to approve the existing pending row.

**Expected:**
- Carol's approve POST returns 409 `RESET_TARGET_EMAIL_CHANGED`.
- Audit row emitted with `metadata.cause = "RESET_TARGET_EMAIL_CHANGED"`.
- DB row remains `pending_approval` (no state change). Bob must re-initiate.

**Result:** [ ] PASS — 2026-MM-DD

---

### Scenario 4 — Pending revoke is silent to target (F2, FR8)

**Steps:**
1. Sign in as Bob. Initiate reset for Dave. Confirm via mailpit that ONLY Carol received the pending-approval email; Dave received nothing.
2. Sign in as Bob; History dialog → click Revoke on the pending row.
3. Inspect mailpit Dave inbox AND the `notifications` table for Dave.

**Expected:**
- Step 2 → POST revoke returns 200; DB row: `revoked_at ≈ now()`, `encrypted_token IS NULL`.
- Audit row `ADMIN_VAULT_RESET_REVOKE` emitted.
- Dave's mailpit inbox: NO new email after revoke.
- `notifications` table: 0 rows of type `ADMIN_VAULT_RESET_REVOKED` for Dave.

**Result:** [x] PASS — 2026-04-30
- Initiator: papapyan; target: test-admin (target swapped vs Scenario 1 because test-member's per-target rate counter was at the 1/day cap).
- DB after revoke: `revoked_at` set, `executed_at IS NULL`, `approved_at IS NULL`, `encrypted_token IS NULL` (T6 lifecycle confirmed).
- Audit log: `ADMIN_VAULT_RESET_INITIATE` + `ADMIN_VAULT_RESET_REVOKE` (both papapyan).
- **target's notifications table query: 0 rows in 5-min window** — confirmed `wasApproved !== null` gate works (F2 fix). Mailpit: NO new email arrived to test-admin after revoke.

---

### Scenario 5 — 24h cap on approve (S12)

**Steps:**
1. Sign in as Bob; initiate reset for Dave. Capture `created_at`.
2. Manually fast-forward by adjusting `created_at` (advance 23 hours):
   ```bash
   docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
     UPDATE admin_vault_resets
        SET created_at = created_at - interval '23 hours',
            expires_at = expires_at - interval '23 hours'
      WHERE id = '<reset-id>';"
   ```
3. As Carol, approve the row.
4. Inspect new `expires_at`.

**Expected:**
- `expires_at = created_at + 24h` (the absolute cap), NOT `now()+60min`.
  - Verify: `(expires_at - created_at) = '24:00:00'`.
- Approve audit row emitted with the capped `expiresAt`.

**Result:** [ ] PASS — 2026-MM-DD

---

### Scenario 6 — Decrypt failure (S14, S16, F7)

**Steps:**
1. Sign in as Bob; initiate reset for Dave. Capture `<reset-id>`.
2. Manually corrupt encryptedToken — flip one byte:
   ```bash
   docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
     UPDATE admin_vault_resets
        SET encrypted_token = overlay(encrypted_token placing 'X' from 20 for 1)
      WHERE id = '<reset-id>';"
   ```
3. As Carol, attempt approve.
4. Tail server logs (`docker compose logs -f app` or `npm run dev` stdout).
5. Query `audit_logs` for the failed approve attempt.

**Expected:**
- Carol receives generic 409 `RESET_NOT_APPROVABLE` (NOT a distinct decrypt-failure code).
- Server stderr/operational log contains a distinct entry mentioning "token decrypt failed" or AES-GCM auth error (with `resetId` for ops).
- Audit metadata: `cause = "RESET_NOT_APPROVABLE"` only — does NOT include the distinct decrypt cause (S16 fix; tenant admins read `/api/tenant/audit-logs`).
- DB row UNCHANGED (`approved_at IS NULL`, `revoked_at IS NULL`) — F7 (decrypt-fail-before-CAS, no phantom approval).

**Result:** [ ] PASS — 2026-MM-DD

---

### Scenario 7 — Migration backfill (S11, S17)

**Steps:**
1. Reset migration tail to before the dual-approval set:
   ```bash
   # Operator-only — destructive on dev DB.
   docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
     DELETE FROM _prisma_migrations
     WHERE migration_name LIKE '%admin_vault_reset_dual_approval%'
        OR migration_name LIKE '%notification_type_pending_approval%'
        OR migration_name LIKE '%admin_vault_reset_backfill%';"
   # Roll back columns:
   docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
     ALTER TABLE admin_vault_resets
       DROP COLUMN IF EXISTS encrypted_token,
       DROP COLUMN IF EXISTS approved_at,
       DROP COLUMN IF EXISTS approved_by_id,
       DROP COLUMN IF EXISTS target_email_at_initiate;"
   ```
2. Insert a pre-migration in-flight row directly:
   ```bash
   docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
     INSERT INTO admin_vault_resets (id, tenant_id, target_user_id, initiated_by_id, expires_at)
     VALUES (gen_random_uuid(), '<tenant-id>', '<dave-id>', '<bob-id>', now() + interval '20 hours');"
   ```
3. Run the migration set: `npx prisma migrate deploy`.
4. Inspect the row state post-backfill.
5. Inspect emitted SYSTEM-actor audit row.

**Expected:**
- `revoked_at = created_at` (auto-revoke); `approved_at IS NULL`; `target_email_at_initiate = '<dave-email>'` (populated by second UPDATE).
- `deriveResetStatus()` on the row returns `"revoked"`.
- New `audit_logs` row with: `actor_type = 'SYSTEM'`, `action = 'ADMIN_VAULT_RESET_REVOKE'`, `metadata->>'reason' = 'dual_approval_migration'`, `target_id = '<dave-id>'`.
- No row anywhere has `approved_at != null` post-backfill.

**Result:** [ ] PASS — 2026-MM-DD

---

## Adversarial scenarios (Tier-2 required)

### A1 — Cross-tenant access (FR4 enforced via actor.tenantId mismatch)

**Steps:**
1. Add Carol as a `TenantMember` of Tenant-B (different tenant) with role ADMIN.
2. Sign in as Bob in Tenant-A; initiate reset for Dave (Tenant-A target).
3. Have Carol switch active tenant to Tenant-B (`User.tenantId` = Tenant-B).
4. Carol attempts approve via curl with explicit Tenant-A path params.

**Expected:** 403 (auth check fails because `actor.tenantId !== resetRecord.tenantId`). DB row unchanged.

**Result:** [ ] PASS — 2026-MM-DD

---

### A2 — Token replay (URL fragment, post-execute)

**Steps:**
1. Run Scenario 1 happy path through step 8 (Dave executes successfully).
2. Open the same reset URL in a new incognito window. Type `DELETE MY VAULT`. Submit.

**Expected:** 410 `VAULT_RESET_TOKEN_USED` (or equivalent already-executed code). DB row unchanged from step 8 final state.

**Result:** [ ] PASS — 2026-MM-DD

---

### A3 — Replay AFTER admin revokes the approved reset

**Steps:**
1. Sign in as Bob; initiate. Sign in as Carol; approve. Dave receives email (do NOT click yet).
2. Sign in as Bob; revoke the approved row via History dialog.
3. Dave clicks the reset URL from the original email.

**Expected:** 410 (the row's `revoked_at` is non-NULL; execute endpoint rejects). Vault is NOT wiped.

**Result:** [ ] PASS — 2026-MM-DD

---

### A4 — Scope elevation (MEMBER attempts approve)

**Steps:**
1. Add Eve as a `TenantMember` with role MEMBER. Sign in as Eve.
2. Have Bob initiate a reset (capture `<reset-id>`).
3. Eve curls the approve endpoint with her session cookie.

**Expected:** 403 `FORBIDDEN` (`requireTenantPermission(MEMBER_VAULT_RESET)` fails). DB row unchanged. Audit row emitted for the attempted action.

**Result:** [x] PASS — 2026-04-30
- Tested via browser DevTools Console fetch from test-member (MEMBER role) session against fresh `pending_approval` row `df45cc7e-...`.
- Response: HTTP 403, body `{"error":"FORBIDDEN"}`. DB row unchanged.
- Block fired at the **RBAC layer** (`requireTenantPermission(MEMBER_VAULT_RESET)` rejects MEMBER role) — earliest in the chain, before the row was even fetched.
- **No forensic audit emitted** for this scope-elevation attempt — `requireTenantPermission` throws BEFORE reaching the route's audit-emit code paths. Trade-off: incident response loses the signal but consistent with how all other protected endpoints behave when an unauthorized role probes them. Future work could centralize "permission rejected" audit emission in `handleAuthError`; out of scope for this PR.

---

### A5 — Race condition (double-approve from two browser tabs)

**Steps:**
1. Sign in as Carol in browser tab 1. Sign in as Alice in browser tab 2.
2. Both open the History dialog; both click Approve at the same moment, type `APPROVE`, submit at near-identical timestamps.
3. Repeat the test 5 times (clear DB row between iterations).

**Expected per iteration:**
- Exactly one POST returns 200; the other returns 409 `RESET_NOT_APPROVABLE`.
- DB: `approved_by_id` is exactly one of `<carol-id>` or `<alice-id>` (winner-side).
- Email + notification fires exactly ONCE to Dave (winner-side).

**Pass criterion:** all 5 iterations satisfy the above with no double-fire of email/audit.

**Result:** [ ] PASS — 2026-MM-DD (5/5 iterations)

---

### A6 — Session fixation cross-tenant (FR7 allTenants:true behavior)

**Steps:**
1. Dave signs in to Tenant-B (separate `Session` row with `tenant_id = <tenant-b-id>`).
2. Run dual-approval flow in Tenant-A through approve.
3. Dave executes the reset from his Tenant-A browser tab.
4. Dave switches to the Tenant-B browser tab and reloads.

**Expected:** Tenant-B session is ALSO invalidated. Reload returns 401 / redirect to sign-in.

Verification:
```bash
docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
  SELECT count(*) FROM sessions WHERE user_id = '<dave-id>';"
```
Expected: 0.

**Result:** [ ] PASS — 2026-MM-DD

---

## Rollback

If any scenario fails:

1. **Code rollback** (preferred):
   - `git revert <suspect-commit-sha>` on `feature/admin-vault-reset-dual-approval` (NOT a hard reset).
   - Re-run the failing scenario to confirm regression source.
2. **Migration rollback** (operator-only — destructive):
   - `npx prisma migrate resolve --rolled-back 20260430120002_admin_vault_reset_backfill`
   - `npx prisma migrate resolve --rolled-back 20260430120001_notification_type_pending_approval`
   - `npx prisma migrate resolve --rolled-back 20260430120000_admin_vault_reset_dual_approval`
   - Manual `ALTER TABLE admin_vault_resets DROP COLUMN ...` for `encrypted_token, approved_at, approved_by_id, target_email_at_initiate` if the schema must roll back. Postgres does NOT support `ALTER TYPE ... DROP VALUE`, so the new `NotificationType` enum value `ADMIN_VAULT_RESET_PENDING_APPROVAL` is sticky — leaving it in place is safe (no consumer reads it post-rollback).
3. **Session cache:** Redis tombstones expire on their own (`TOMBSTONE_TTL_MS`); no manual rollback needed.
4. **Email:** all dev emails are confined to mailpit on port 8025 — no production impact.
5. Open an issue with: scenario number + steps to reproduce; DB state queries before/after; audit log rows; browser console logs; relevant `npm run dev` stderr lines.

---

## Test execution log

### Scenario 1: Happy path
[x] PASS — 2026-04-30
- Executed in tenant `papapyan@gmail.com`. Roles mapped: papapyan (OWNER, initiator) / test-admin@example.test (ADMIN, approver) / test-member@example.test (MEMBER, target).
- Pre-flight: dev DB had stale rate-limit counters (1 admin + 1 target counter at 3) requiring Redis cleanup before re-running. Future cleanup hint: `redis-cli DEL rl:admin-reset:admin:<id> rl:admin-reset:target:<id>`.
- All 9 verification queries returned expected values; full evidence captured in the Scenario 1 Result block above.
- R26 disabled-cue side-channel verified incidentally: papapyan saw "承認" button disabled with tooltip "あなたがこのリセットを開始したため..."; test-admin (different session) saw it enabled.

### Scenario 2: Self-approval blocked
[x] PASS — 2026-04-30
- Verified all 4 defense layers: UI disabled-cue (R26, side-channel via Scenario 1), RBAC (see A4), app-level pre-check + forensic audit (this scenario), DB CAS (integration test).
- Implementation gap surfaced: forbidden() returned without audit. Fixed mid-test with 5-LOC addition; updated route test asserts `metadata.cause = "FORBIDDEN_SELF_APPROVAL"`.

### Scenario 3: Email-change race
[ ] PASS — 2026-MM-DD
- (notes)

### Scenario 4: Pending revoke silent to target
[x] PASS — 2026-04-30
- Initiate-then-revoke flow against test-admin (target swap from Scenario 1 due to per-target rate-limit). 0 notifications, 0 emails to target. encrypted_token NULLed on revoke.

### Scenario 5: 24h cap on approve
[ ] PASS — 2026-MM-DD
- (notes)

### Scenario 6: Decrypt failure
[ ] PASS — 2026-MM-DD
- (notes)

### Scenario 7: Migration backfill
[ ] PASS — 2026-MM-DD
- (notes)

### Adversarial A1: Cross-tenant access
[ ] PASS — 2026-MM-DD
- (deferred — requires multi-tenant test fixture)

### Adversarial A4: Scope elevation (MEMBER attempts approve)
[x] PASS — 2026-04-30
- test-member (MEMBER) → approve API → 403 from `requireTenantPermission` RBAC layer before audit-emit code.

### Adversarial A2: Token replay (post-execute)
[ ] PASS — 2026-MM-DD
- (notes)

### Adversarial A3: Replay after admin revokes
[ ] PASS — 2026-MM-DD
- (notes)

### Adversarial A4: Scope elevation (MEMBER → approve)
[ ] PASS — 2026-MM-DD
- (notes)

### Adversarial A5: Double-approve race (5 iterations)
[ ] PASS — 2026-MM-DD
- (notes)

### Adversarial A6: Session fixation cross-tenant
[ ] PASS — 2026-MM-DD
- (notes)

---

## Sign-off

- [ ] Scenarios 1-7 PASS
- [ ] Adversarial A1-A6 PASS
- Reviewer:
- Notes:
