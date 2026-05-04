# Manual Test Plan: centralize-state-transitions

R35 Tier-2 deliverable. Touches authorization changes (JIT access tokens) + emergency-access break-glass flows.

**Scope of this document**: only steps that genuinely require human hands — multi-session HTTP concurrency, end-to-end UI flows, and post-merge production sanity checks. Everything else is covered by:

- Vitest unit/route tests (`npx vitest run`) — 853 tests, includes per-route mock-Prisma assertions
- Real-DB integration suite (`src/__tests__/db-integration/centralize-state-transitions.integration.test.ts`) — T6 CAS race, T9 wrong-from/wrong-scope, C3 bypass guard, T16 vault-reset atomicity, T17 vault auto-promote race + single-audit-row, T18 bulkTransition mixed-status + F15, F14 keyVersion guard
- CI guard (`scripts/check-state-mutation-centralization.sh`) — AST-level "no inline `data: { status }` outside state.ts"

What automated tests cannot cover and therefore lives here:

1. HTTP-layer races between two real client sessions (browser ↔ admin terminal)
2. End-to-end vault key rotation (UI vault-unlock → rotation → grantee fetch)
3. Audit-shape verification on production routes (until the T2 audit-shape fixture lands in the follow-up PR)

---

## Pre-conditions (operator setup, ~10 min)

```bash
# Fresh local stack, schema at HEAD
npm run docker:up
npx prisma migrate dev

# Audit-outbox worker MUST be running so audit_logs actually populates
npm run worker:audit-outbox &  # in a separate terminal
```

Test fixtures (operator substitutes — RS4: no real PII):

| Placeholder | Operator substitutes |
|-------------|----------------------|
| `<owner-email>` | Test owner account, vault unlocked |
| `<grantee-email>` | Test grantee account |
| `<grant-id>` | UUID captured in step 1 below |

Bootstrap a grant to `IDLE` (programmatic — saves ~5 min of UI clicking before the actual tests):
1. Sign in as `<owner-email>` in browser. Create EA grant for `<grantee-email>` with wait-days = 0 (so `waitExpiresAt` is immediately past after request).
2. Sign in as `<grantee-email>` in a second browser profile. Accept the invitation.
3. Sign back in as `<owner-email>`. Confirm key escrow.
4. Note `<grant-id>` from the URL.

---

## M1. HTTP-level race: revoke vs. vault auto-promote (F5/S15 critical)

The integration suite races two `autoPromoteIfElapsed()` calls at the lib level. The HTTP-layer F5 invariant — that a revoked grant's wrapped secretKey is NEVER returned in a response body, even when revoke commits between auto-promote and serialization — requires two real HTTP processes.

**Setup**:
- `<grant-id>` in `IDLE` status (from pre-conditions). Have `<grantee-email>` request emergency access (`/api/emergency-access/<grant-id>/request`) so it transitions to `REQUESTED` with `waitExpiresAt` ~immediately past.

**Steps** (run from one shell):

```bash
# Two concurrent HTTP calls from two different authenticated sessions
GRANT_ID=<grant-id>
OWNER_COOKIE='authjs.session-token=<owner-session>'
GRANTEE_COOKIE='authjs.session-token=<grantee-session>'

# Run revoke + vault-fetch in parallel; capture both responses
(
  curl -s -X POST -b "$OWNER_COOKIE" -H 'Content-Type: application/json' \
    -d '{"permanent":true}' \
    "http://localhost:3000/api/emergency-access/$GRANT_ID/revoke" > /tmp/revoke.json &
  curl -s -b "$GRANTEE_COOKIE" \
    "http://localhost:3000/api/emergency-access/$GRANT_ID/vault" > /tmp/vault.json &
  wait
)

# Inspect outcomes
cat /tmp/revoke.json /tmp/vault.json
```

**Expected — one of two outcomes, both safe**:

- **Revoke wins**: `vault.json` is `{"error":"GRANT_REVOKED"}` HTTP 403 OR `not_eligible` fall-through (no crypto fields).
- **Auto-promote wins**: `vault.json` includes crypto fields (the legitimate ACTIVATED-state response).

**MUST NOT happen** — the F5 leak this PR was designed to prevent:

- `revoke.json` shows status `REVOKED` AND `vault.json` body contains `"encryptedSecretKey"` with non-null value.

**SQL post-check**:

```sql
SELECT revoked_at, encrypted_secret_key, status
FROM emergency_access_grants WHERE id = '<grant-id>';
```

If `revoked_at IS NOT NULL`, then `encrypted_secret_key` MUST be NULL (the C7 / R31 crypto-clear invariant). Cross-check that the `vault.json` from the race did NOT include the pre-revoke `encryptedSecretKey` value.

---

## M2. End-to-end vault key rotation with in-flight REQUESTED grant (PR #433/S1)

The integration suite covers `markGrantsStaleForOwner()` in isolation. The full UI flow — owner unlocks vault → rotates key → in-flight grantee request flips to STALE → grantee's subsequent vault fetch is denied — exercises real key derivation + auth flow + the post-rotation 403 path.

**Setup**:
- Owner has at least one EA grant in `REQUESTED` state (carry over `<grant-id>` from M1 if it survived as not-revoked, or create a new one).

**Steps**:

1. Sign in as `<owner-email>`. Open vault with master passphrase.
2. Navigate to vault settings → rotate master key. Confirm the rotation.
3. Wait for the rotation flow to complete (UI shows "rotation complete").
4. While still signed in as `<owner-email>`, run:

```sql
SELECT id, status, key_version, owner_ephemeral_public_key, encrypted_secret_key
FROM emergency_access_grants WHERE owner_id = '<owner-id>';
```

5. Sign in as `<grantee-email>` in the second browser profile. Attempt to fetch the vault: navigate to the grant or `GET /api/emergency-access/<grant-id>/vault`.

**Expected**:

- After step 3: SQL shows `<grant-id>` flipped from `REQUESTED` to `STALE`, `owner_ephemeral_public_key IS NULL` (C7 / PR #433/S2 minimum-clear). `encrypted_secret_key` MAY remain (forensic trail allowed) but cannot be unwrapped without the ephemeral pubkey.
- Step 5: vault fetch returns HTTP 403 / 400 (depending on STALE-state routing); response does NOT include any crypto material. The grantee MUST re-prompt the owner for re-confirmation.

This is the C7 PR #433/S1 invariant. Without the matrix's `REQUESTED → STALE (SYSTEM)` row, an in-flight grantee could wait out `waitExpiresAt`, auto-promote to ACTIVATED post-rotation, and unwrap the owner's pre-rotation secretKey via the still-valid escrow.

---

## M3. Audit-shape spot check (until T2 fixture lands)

T2 (PRE_MIGRATION_AUDIT_SHAPES fixture) is deferred to a follow-up PR. Until then, audit-shape drift across the 10 migrated routes can only be verified by triggering each route and inspecting `audit_logs`. **Spot-check 3 routes** (one per actor type) — full coverage is the responsibility of the T2 follow-up.

```sql
-- Run AFTER the M1+M2 sequence above (which exercises ~5 routes naturally)
SELECT action, target_id, scope, metadata
FROM audit_logs
WHERE created_at > now() - interval '10 minutes'
  AND action IN (
    'EMERGENCY_GRANT_ACCEPT',           -- A2 grantee actor
    'EMERGENCY_GRANT_CONFIRM',          -- A3 owner actor
    'EMERGENCY_ACCESS_REVOKE'           -- A7 owner actor
  )
ORDER BY created_at;
```

**Expected**: each row's `metadata` JSON matches the pre-migration shape (refer to the route's source-as-of-base-commit if comparing). Any new key OR missing key in `metadata` → flag as a drift bug.

---

## Sign-off checklist (operator records in PR comment)

- [ ] Pre-conditions: `npm run docker:up`, `npm run worker:audit-outbox`, `npx prisma migrate dev` all clean
- [ ] Automated suites green: `npm run lint` (0 errors), `npx vitest run` (853/0), `npx next build` (exit 0), `bash scripts/check-state-mutation-centralization.sh` (exit 0)
- [ ] Integration suite green (if `DATABASE_URL` set): `npm run test:integration -- centralize-state-transitions` includes T6, T9, T16, T17, T18, F14 — all pass
- [ ] **M1 race** executed; revoke-wins or auto-promote-wins outcome observed; SQL confirms `revoked_at IS NOT NULL → encrypted_secret_key IS NULL`; `vault.json` did NOT contain post-revoke crypto
- [ ] **M2 rotation** executed; STALE flip confirmed in SQL with `owner_ephemeral_public_key IS NULL`; grantee's post-rotation vault fetch returns 4xx with no crypto in body
- [ ] **M3 audit spot-check** on 3 routes; metadata shape matches pre-migration source
- [ ] Operator records execution date, environment (local docker / staging), and any deviations in the PR comment

---

## Rollback

Pure code change — no DB schema migration. To roll back: `git revert <merge-commit-sha>`. Pre-revert sanity: `git diff main..<feature-branch> -- prisma/migrations/` must be empty.

After revert: routes fall back to inline `prisma.<table>.updateMany({ where: ..., data: { status: ... } })`; the CI guard reverts too. State data in `emergency_access_grants` and `access_requests` is untouched.

---

## Follow-up delta: PR `#443` (harden — strictness + RLS FORCE/SECDEF + crypto adversarial)

This section is a **delta**, not a re-execution. The parent plan above stays the source of truth for the centralize-state-transitions surface; only the manual-only items below were added by `#443`.

### What is automation-covered (do NOT re-execute manually)

- `transition()` strict-throw on `count > 1` — covered by unit-mocked tests in `src/lib/{emergency-access,access-request}/*-state.test.ts` (per-file `transition() return-value strictness` describe block, 3 cases each).
- MATRIX const usage (`EA_ACTOR.*` / `AR_ACTOR.*`) — compile-time + the existing `EXPECTED_TRANSITIONS` drift detector.
- State-mutation lint extensions (`upsert`, computed property names, `as`-cast unwrap) — covered by `scripts/__tests__/check-state-mutation-centralization.test.ts` against the 8 expanded bad-fixture cases.
- T17 `[false, true]` shape + `loser.reason === "not_eligible"` — covered by `centralize-state-transitions.integration.test.ts` (already in the parent plan's automated suite).
- RLS `[E-RLS-FORCE]` and `[E-RLS-SECDEF]` — covered by `scripts/rls-cross-tenant-negative-test.sh` Cases 8 and 9 (CI gate).
- Crypto nonce uniqueness / GCM authenticity / rotation rollback — covered by the five `*.adversarial.test.ts` files.

### What genuinely needs manual eyes (M4: access-request UI smoke, ~5 min)

Why manual: the `access-request-card` component re-renders status filter dropdown items + per-request status badges + the conditional approve/deny button via the new `AR_STATUS` constants. Type-checking + the component unit test confirm the values, but the visual rendering of badges (variant mapping `STATUS_VARIANTS[req.status]`) and the locale-bound label (`statusLabel` reading from `t("arStatus*")`) is not exercised by automation against a real request set.

Pre-conditions: all from the parent plan's "Pre-conditions" section, plus at least one tenant member with `service-account.write` permission and one service account.

Steps:

1. As tenant admin, navigate to `/<locale>/dashboard/settings/developer` → "Access Requests" card.
2. Click **+** to create a new request: pick the seeded service account, request scopes `credentials:list,credentials:use`, justification `<placeholder>`, expiry 60 minutes. Submit.
3. The new request renders with a `Pending` badge — confirm the badge variant is `default` (not destructive / outline) and the locale label matches `arStatusPending`.
4. Use the status filter dropdown: cycle through `ALL → PENDING → APPROVED → DENIED → EXPIRED`. Each option must select-and-render correctly; the request created in step 2 should appear under `ALL` and `PENDING`, disappear under the others.
5. Approve the pending request. Badge flips to `Approved` (variant `secondary`). Confirm the approve/deny buttons are no longer visible (the `req.status === AR_STATUS.PENDING` guard hides them).
6. Create a second request, deny it. Badge flips to `Denied` (variant `destructive`).

Expected: every status badge maps to the documented variant, the locale label matches `t("arStatus*")` for all four statuses, and the approve/deny buttons appear only in the `PENDING` state.

Adversarial scenario (M4-adv, optional): in DevTools, manually mutate the rendered `req.status` via React DevTools to a string not in `AR_STATUS` (e.g., `"FAKE"`). The badge should fall back gracefully — if it crashes the component, the runtime narrowing has a gap. Not a regression vector this PR introduces; included for thoroughness.

### Sign-off addendum

- [ ] M4 executed; status filter cycles through all five options; badges render with documented variants; approve/deny buttons appear only on `PENDING`.
- [ ] No `transition: where matched >1 row` server-log entry observed during M4 (the strict-throw never fires under normal UI flows).
