# Manual Test Plan: rebalance-personal-passkey-session-aal2

Target branch: `feature/rebalance-personal-passkey-session-aal2`
Dev URL: `https://localhost:3001/passwd-sso`
Tier: **R35 Tier-2** — required. Auth flow change, session lifecycle change, schema migration, new WebAuthn ceremony.

Two-filter scope:
- **Filter A** — exclude items already covered by automated tests. Vitest covers: `requireRecentPasskeyVerification` boundary cases, reauth route Zod validation / rate limiting, recent-current-auth-method routing logic, session-timeout resolver values, UI dialog mocks.
- **Filter B** — items requiring real human/runtime verification only (browser WebAuthn ceremony, real cookie, real DB row, multi-device session interleaving, fresh-install migration ordering).

## Pre-conditions

- Docker stack up: `docker compose up -d db redis jackson mailpit`.
- Migrations applied (deploy mode, NOT dev): `npx prisma migrate deploy`.
  - New migrations expected to apply:
    - `20260507083000_add_session_passkey_verified_at` (additive nullable column on `sessions`)
    - `20260510145100_add_audit_action_passkey_reauth` (enum value addition on `AuditAction`)
- Prisma client regenerated after schema change: `npm run db:generate` (memory `feedback_prisma_generate_branch_switch`).
- Dev server restarted after schema change: `npm run dev`. Hot-reload does NOT refresh the cached Prisma client.
- Audit outbox worker running: `npm run worker:audit-outbox` (separate process; without it `audit_logs` rows remain `PENDING` in `audit_outbox`).
- Tenant policy values for the bootstrap tenant set to a value that is materially longer than the previous AAL3 ceiling (e.g. `idle = 60 min` so the post-rebalance behaviour is observable):
  ```bash
  docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
    UPDATE tenants
    SET session_idle_timeout_minutes = 60,
        session_absolute_timeout_minutes = 1440
    WHERE is_bootstrap = true;"
  ```

### Test fixture

Substitute `<test-user-email>` placeholders; do not commit real personal addresses (memory `feedback_no_personal_email_in_docs`).

| Role        | Handle    | Purpose                                                       |
|-------------|-----------|---------------------------------------------------------------|
| OWNER       | Alice     | Bootstrap-tenant personal user with at least one passkey      |
| ADMIN       | Bob       | Bootstrap-tenant operator-token issuer                        |
| MEMBER      | Carol     | Pre-migration session simulator (provider = NULL)             |
| OWNER       | Dave      | Non-bootstrap tenant user (SSO/email-only, no passkey)        |

Setup steps:
- Alice: register two passkeys (e.g. macOS Touch ID + YubiKey) at `Settings → Security → Passkeys`.
- Bob: register one passkey + has permission to issue operator tokens.
- Carol: sign in via email magic-link only (no passkey). After sign-in, manually clear `provider` on Carol's session row to simulate a pre-provenance-migration session:
  ```bash
  docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
    UPDATE sessions SET provider = NULL
    WHERE user_id = (SELECT id FROM users WHERE email = '<carol-email>');"
  ```
- Dave: lives in a separate non-bootstrap tenant (the SSO leakage probe in Scenario 6 needs this).

---

## Scenario 1 — AAL3 clamp removed for bootstrap personal passkey sessions (C1)

**Goal:** Confirm a passkey-signed-in personal session no longer hits a 15-minute idle ceiling and now follows the tenant policy (60-min idle).

**Steps:**
1. Sign in as **Alice** with passkey at `/auth/passkey/signin`.
2. Confirm the new session row:
   ```bash
   docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
     SELECT provider, passkey_verified_at IS NOT NULL AS has_pv,
            EXTRACT(EPOCH FROM (expires - created_at))/60 AS minutes
     FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = '<alice-email>')
     ORDER BY created_at DESC LIMIT 1;"
   ```
3. Wait 16 minutes of idle in the browser (no clicks, no fetches), then attempt a vault read.

**Expected result:**
- Step 2: `provider = webauthn`, `has_pv = t`, `minutes ≈ 60` (matches tenant idle setting, NOT 15).
- Step 3: vault still accessible without re-sign-in. The previous AAL3 clamp would have logged the session out at 15 min.

**Rollback:** none — read-only verification.

---

## Scenario 2 — Operator-token creation triggers passkey reauth inline (C3, C4)

**Goal:** Confirm the operator-token creation route refuses stale freshness and a successful inline reauth retries the create without losing form state.

**Steps:**
1. Sign in as **Bob** with passkey, then immediately set `passkey_verified_at` 16 minutes in the past:
   ```bash
   docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
     UPDATE sessions
     SET passkey_verified_at = now() - INTERVAL '16 minutes'
     WHERE user_id = (SELECT id FROM users WHERE email = '<bob-email>');"
   ```
2. Navigate to `Settings → Developer → Operator Tokens`.
3. Click **Create token**. Fill `name = manual-test-1`, expiry = 30 days. Submit.
4. Confirm the in-app reauth dialog appears (`reauthTitle` = "Passkey verification required"). Click **Verify with passkey** and complete the WebAuthn ceremony.
5. After the ceremony, the dialog closes and the same form values silently re-submit. The plaintext token is rendered once in the same dialog flow (do not lose `name=manual-test-1`).
6. Inspect the audit log: filter by Bob's user, in the `Auth` group.

**Expected result:**
- Step 4: dialog title is `Passkey verification required`, NOT `Network error` or `Sign in again`.
- Step 5: token plaintext appears with `name = manual-test-1`. Form state preserved through the reauth round trip.
- Step 6: TWO audit entries — `AUTH_PASSKEY_REAUTH` (reauth) followed by `OPERATOR_TOKEN_CREATE`. Confirm `AUTH_PASSKEY_REAUTH` exists; previously it would have appeared as `AUTH_LOGIN`, breaking SIEM filtering.
- DB row: `passkey_verified_at` is now ≈ `now()` for Bob's session; no other rows on `sessions` were touched (single-row update).

**Rollback:** revoke the test token via the same UI.

---

## Scenario 3 — Reauth replay rejected (C3)

**Goal:** Confirm a reused reauth challenge is rejected.

**Steps:**
1. As **Alice**, with DevTools open, navigate to `Settings → Developer → Operator Tokens` and start the reauth flow (Scenario 2 step 1-3).
2. In DevTools Network tab, capture the `POST /api/auth/passkey/reauth/options` response (record `challengeId`).
3. Complete the reauth ceremony normally.
4. Replay the previously-captured `POST /api/auth/passkey/reauth/verify` body (with the same `challengeId`).

**Expected result:**
- Step 4: HTTP 400 with `error: "WEBAUTHN_VERIFICATION_FAILED"` (or equivalent challenge-expired code). The replay does NOT set `passkey_verified_at`.

**Adversarial scenario tier requirement:** Tier-2 mandatory.

---

## Scenario 4 — Cross-user reauth binding (C3)

**Goal:** Confirm a passkey assertion from User A cannot be replayed against User B's session.

**Steps:**
1. Sign in as **Alice** in Browser 1, sign in as **Bob** in Browser 2.
2. In Browser 1 (Alice), call `POST /api/auth/passkey/reauth/options` to generate a challenge.
3. Have Alice complete a WebAuthn ceremony with her passkey.
4. From Browser 2 (Bob), with Bob's session cookie, send `POST /api/auth/passkey/reauth/verify` carrying Alice's `credentialResponse` and `challengeId`.

**Expected result:**
- Step 4: HTTP 400/401, `error: "WEBAUTHN_VERIFICATION_FAILED"`. Bob's `passkey_verified_at` does NOT update.

**Adversarial scenario tier requirement:** Tier-2 mandatory.

---

## Scenario 5 — Pre-migration session (provider = NULL) falls back to recent-session gate

**Goal:** Confirm `requireRecentCurrentAuthMethod` routes legacy sessions to `requireRecentSession` instead of passkey reauth.

**Steps:**
1. Use **Carol** with the `provider = NULL` session created in Pre-conditions.
2. Wait 16 minutes, then attempt to issue an operator token (or any sensitive route Carol has permission for).

**Expected result:**
- The route returns `OPERATOR_TOKEN_STALE_SESSION` / `SESSION_STEP_UP_REQUIRED`.
- The UI shows the **Sign in again** dialog (NOT the passkey reauth dialog), because Carol has no passkey AND her session has `provider = NULL`.
- The audit log records no `AUTH_PASSKEY_REAUTH` event.

---

## Scenario 6 — Non-bootstrap tenant user sees no passkey-related change (C1 + S1 deviation D1)

**Goal:** Confirm the global D1 clamp removal did not regress non-bootstrap surfaces unexpectedly.

**Steps:**
1. Sign in as **Dave** in his non-bootstrap tenant via SSO (or email magic-link if SSO is not configured).
2. Confirm Dave's session row:
   - `provider != "webauthn"` (SSO or email)
   - `passkey_verified_at IS NULL`
3. Wait until tenant idle timeout, then attempt a sensitive action.
4. Inspect: ordinary recent-session gate fires; UI shows **Sign in again** dialog.

**Expected result:**
- No reference to passkey reauth in Dave's UI.
- `passkey_verified_at` remains `NULL` throughout.
- `AUTH_PASSKEY_REAUTH` audit action never appears for Dave.

This scenario validates that D1's wider scope did not accidentally route non-passkey sessions through the passkey reauth path.

---

## Scenario 7 — Fresh-install migration ordering (R32 / R35)

**Goal:** Confirm the two new migrations apply cleanly to a fresh DB and the resulting Prisma client matches the runtime image.

**Steps:**
1. Stop the dev stack and drop the dev DB (operator confirmation required — destructive):
   ```bash
   # ⚠ destructive, operator-only
   docker compose down
   docker volume rm passwd-sso_postgres_data || true
   docker compose up -d db
   ```
2. Apply migrations in deploy mode: `npx prisma migrate deploy`.
3. Confirm both migrations applied:
   ```bash
   docker compose exec -T db psql -U passwd_user -d passwd_sso -c "
     SELECT migration_name, finished_at FROM _prisma_migrations
     WHERE migration_name LIKE '%passkey_verified_at%'
        OR migration_name LIKE '%passkey_reauth%';"
   ```
4. Restart the app: `npm run docker:up` (or `npm run dev`).
5. Look for the runtime ready signal in app logs: `Ready - started server on 0.0.0.0:3001`.
6. Run Scenarios 1-2 against this fresh install.

**Expected result:** Both migration rows present, app boots, Scenarios 1-2 pass.

**Rollback:** `git checkout main && npx prisma migrate deploy` (downgrade requires manual `ALTER TYPE ... RENAME VALUE` shenanigans — Postgres does not allow `DROP VALUE` on enums; if rollback is needed for production, follow the standard "don't" rule for enum value removal).

---

## Step-level destructive markers

- Scenario 7 step 1 is **destructive — operator-only**. Do not run automatically in CI.
- All other scenarios are read-only or scoped to the test fixture and leave clean state on completion.

## Out of scope (excluded by Filter A — covered by automated tests)

- Reauth route Zod validation (covered by `reauth/verify/route.test.ts`).
- Reauth options-route challenge generation (covered by `reauth/options/route.test.ts`).
- Rate limiter wiring on reauth endpoints (covered by `vitest`).
- `requireRecentPasskeyVerification` window comparisons (covered by `recent-passkey-verification.test.ts`).
- `recent-current-auth-method` provider routing (covered by `recent-current-auth-method.test.ts`).

## Out of scope (this rollout)

- Migration of `api-keys`, `service-accounts`, `scim-tokens`, `mcp-clients`, `access-requests`, `mobile-authorize` to `requireRecentPasskeyVerification` — these stay on `requireRecentSession` per plan C4 (sso-mixed / non-passkey-capable callers).
- SSO/IdP step-up contract — future plan.
