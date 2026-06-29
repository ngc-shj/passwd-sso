# Manual Test: Passkey Enforcement on Token-Issuance Paths

**Plan reference**: `passkey-enforcement-token-paths-plan.md`
**Tier**: Tier-2 (auth-flow change; mandatory before merge per R35)
**Date authored**: 2026-06-29

---

## Pre-conditions

1. A running dev server connected to a local Postgres instance.
2. Two test tenant accounts:
   - **Tenant A** — `requirePasskey: true`, `passkeyGracePeriodDays: 7`, `requirePasskeyEnabledAt` set to **more than 7 days ago** (grace expired).
   - **Tenant B** — `requirePasskey: false` (control; no policy).
3. A test user `<test-user-email>` who is a member of **both** Tenant A (active) and Tenant B.
   - The user has **no WebAuthn credentials registered** for Tenant A (to trigger the block).
4. The browser extension (dev build) installed and pointing at the dev server.
5. The iOS app (dev build) with `APP_URL` pointing at the dev server.
6. An MCP client registered via DCR (`POST /api/mcp/register`), with client_id recorded.
7. A valid `IOS_APP`-kind extension token for `<test-user-email>` obtained while the grace period was still active (pre-policy enforcement simulation).
   - Specifically: a still-valid `extensionToken` row and a valid MCP refresh-token family older than the grace expiry date.

---

## Steps and Expected Results

### T1 — Extension bridge-code refused (C2)

**Steps:**
1. Sign in as `<test-user-email>` on Tenant A via Google OIDC (session active, no passkey).
2. Navigate to the dashboard and open the `?ext_connect=1` flow.
3. Click "Allow extension connection".

**Expected result:**
- The extension SW calls `POST /api/extension/bridge-code`.
- The server responds `403` with `{"error": "PASSKEY_REQUIRED"}`.
- `extractErrorCode` in the SW returns `"PASSKEY_REQUIRED"`.
- `coerceErrorCode` passes it through (not coerced to `GENERIC_FAILURE`).
- The connect UI shows the **"Passkey registration required"** card (title: `connectPasskeyRequiredTitle`), NOT a generic failure.
- No bridge code row is created in the database.
- An `PASSKEY_ENFORCEMENT_BLOCKED` audit event is recorded with `metadata.blockedPath: "/api/extension/bridge-code"`.

**Rollback**: No state change occurred (no token minted). Nothing to roll back.

---

### T2 — Extension bridge-code allowed within grace (C2, FR2)

**Steps:**
1. Update Tenant A's `requirePasskeyEnabledAt` to **3 days ago** (within a 7-day grace window).
2. Repeat T1 steps.

**Expected result:**
- The server responds `200` and a bridge code is minted.
- The extension completes the token exchange; the connect UI shows "Connection complete".
- No audit block event emitted.

**Rollback**: Revert `requirePasskeyEnabledAt` to the original value (>7 days ago).

---

### T3 — iOS mobile authorize refused (C3)

**Steps:**
1. Restore Tenant A to grace-expired state.
2. Launch the iOS app and initiate the sign-in flow via `ASWebAuthenticationSession` pointing at `GET /api/mobile/authorize`.

**Expected result:**
- The server calls `derivePasskeyState` (fresh DB read), finds `!hasPasskey` + grace expired.
- The authorize endpoint redirects to `passwd-sso://auth/callback?error=passkey_required` with `Cache-Control: no-store`.
- No `mobileBridgeCode` row is created.
- iOS `AuthCoordinator` receives the error callback (surfacing TBD per SC1 — server refusal is the security boundary).
- An audit `PASSKEY_ENFORCEMENT_BLOCKED` event is recorded with `metadata.blockedPath: "/api/mobile/authorize"`.

**Rollback**: Nothing minted. No state to roll back.

---

### T4 — MCP OAuth consent POST refused (C6, authoritative gate)

**Steps:**
1. Using the MCP client credentials from Pre-conditions step 6, initiate the OAuth 2.1 PKCE flow.
2. Complete the `GET /api/mcp/authorize` step (early-reject UX gate — assert a JSON error or redirect away from the consent page).
3. If the GET does not redirect, POST directly to `/api/mcp/authorize/consent` with a valid CSRF token and the consent form body.

**Expected result:**
- **GET**: Returns a JSON early-reject (per the route's existing error convention) before showing the consent form, OR redirects to the passkey-setup page.
- **POST**: Returns `302` to the validated `redirect_uri` with `error=access_denied&error_description=passkey_required`.
- No `createAuthorizationCode` is called; no authorization code is minted.
- Audit `PASSKEY_ENFORCEMENT_BLOCKED` with `metadata.blockedPath: "/api/mcp/authorize/consent"`.

**Rollback**: No token minted. No state to roll back.

---

### T5 — Extension token refresh refused post-grace (C8)

**Steps:**
1. Use the extension token from Pre-conditions step 7 (obtained before enforcement; grace now expired).
2. Trigger a token refresh: `POST /api/extension/token/refresh` with the Bearer token.

**Expected result:**
- The route re-derives passkey state via `derivePasskeyState({ userId, tenantId: activeSession.tenantId })`.
- State: `requirePasskey=true`, `hasPasskey=false`, grace expired → `passkeyEnforcementBlocks` returns `true`.
- Response: non-200 error (refuse the refresh — no new token issued).
- The old token is NOT rotated; no `extensionToken.create` called.
- Audit `PASSKEY_ENFORCEMENT_BLOCKED` with `metadata.blockedPath: "/api/extension/token/refresh"`.

**Rollback**: Token not rotated; existing token remains (will expire naturally).

---

### T6 — iOS token refresh refused post-grace (C8)

**Steps:**
1. Use a still-valid iOS refresh token obtained before grace expiry.
2. `POST /api/mobile/token/refresh` with DPoP-bound credentials.

**Expected result:**
- Route reads the token row's `tenantId`, re-derives passkey state.
- `passkeyEnforcementBlocks` fires; refresh refused.
- `refreshIosToken` lib function is NOT called.
- Audit event emitted with `blockedPath: "/api/mobile/token/refresh"`.

**Rollback**: Token not rotated; existing iOS session invalidated at next use.

---

### T7 — MCP token refresh refused post-grace (C8)

**Steps:**
1. Use the MCP refresh token family from Pre-conditions step 7 (human-bound, userId non-null).
2. `POST /api/mcp/token` with `grant_type=refresh_token` and the existing refresh token.

**Expected result:**
- Route opens a `withBypassRls` transaction, reads the refresh-token row (for `tenantId`/`userId`), re-derives passkey state.
- `passkeyEnforcementBlocks` fires; `exchangeRefreshToken` is NOT called.
- Response: OAuth error (e.g. `invalid_grant` or custom passkey error).
- The rotation family is NOT advanced; no new access/refresh token pair issued.
- Audit `PASSKEY_ENFORCEMENT_BLOCKED` with `blockedPath: "/api/mcp/token"`.

**Rollback**: Token family not rotated. No state to roll back.

---

### T8 — Tenant B (no requirePasskey) — no enforcement (FR3)

**Steps:**
1. Switch the user's active tenant to Tenant B (`requirePasskey: false`).
2. Repeat T1 (extension connect flow) and T5 (token refresh).

**Expected result:**
- Both flows proceed normally; tokens minted/refreshed without any passkey check error.
- No audit block events.

**Rollback**: Switch active tenant back to Tenant A if needed.

---

## Tier-2 Adversarial Scenarios

### A1 — Post-grace refresh refused across all three clients (C8)

**Scenario**: A user connected all three clients (extension, iOS, MCP) while grace was active. Grace expires. Each client's refresh is independently refused.

**Verification**: Run T5, T6, T7 sequentially. Each produces a distinct audit row keyed `${userId}:${blockedPath}`. The dedup map ensures: a SECOND refresh attempt on the SAME path within the `PASSKEY_AUDIT_DEDUP_MS` window emits no second row; a retry on a DIFFERENT path DOES emit (per-path dedup key per C1/S14).

---

### A2 — Multi-tenant policy source: extension rebinds to active tenant (C8/F16)

**Scenario**: `<test-user-email>` is a member of both Tenant A (`requirePasskey=true`, grace expired) and Tenant B (`requirePasskey=false`). The user's active tenant is Tenant B. An old extension token was issued under Tenant A.

**Steps:**
1. Ensure the user's active tenant is Tenant B (the extension rebinds on refresh to the active tenant's `tenantId`).
2. Trigger `POST /api/extension/token/refresh`.

**Expected result:**
- The route uses `activeSession.tenantId` (Tenant B) for the gate — NOT the token row's original `tenantId` (Tenant A).
- Tenant B has `requirePasskey=false` → `passkeyEnforcementBlocks` returns `false` → refresh succeeds.
- The new token is bound to Tenant B (correct behavior: follows active tenant).

**Contrast**: Switch active tenant back to Tenant A, repeat. Refresh is now refused (Tenant A enforces). This confirms the gate matches the token's destination tenant.

---

### A3 — SA-bound MCP token skips passkey check (C8)

**Scenario**: A service account (no `userId`) holds a valid MCP refresh token.

**Steps:**
1. Use the SA refresh token: `POST /api/mcp/token` with `grant_type=refresh_token`.

**Expected result:**
- Route detects `rt.userId === null` (SA-bound) and skips `passkeyEnforcementBlocks`.
- Token is rotated normally.
- No passkey audit event.

**Why this is correct**: Passkeys are a human-identity ceremony; SA tokens are machine-identity scoped to a service account, not a user. The policy `requirePasskey` targets human sign-ins (same as the `auth.ts:393-398` C13 precedent).

---

### A4 — Autofill token reachable only via still-valid host token post-grace (C9)

**Scenario**: Tenant A grace has expired. `<test-user-email>` holds a still-valid `IOS_APP`-kind extension token (the host token, obtained before enforcement). The iOS AutoFill extension requests an autofill token.

**Steps:**
1. `POST /api/mobile/autofill-token` with the still-valid `IOS_APP` Bearer token.

**Expected result:**
- The autofill-token route **succeeds** (it is transitively gated, not directly gated — C9).
- The returned `IOS_AUTOFILL` token has `passwords:write` scope.
- No `PASSKEY_ENFORCEMENT_BLOCKED` event.

**Residual risk confirmation**: The window is bounded — once the host token expires and C8 refuses the host-token refresh (T6), the autofill-token endpoint becomes unreachable for this user post-grace. The ≤ idle-window exposure is the documented C9 residual.

---

### A5 — DB blip during re-derivation → fail-closed (S13)

**Scenario**: The Postgres instance becomes temporarily unavailable exactly when `derivePasskeyState` is called by a token-issuance route.

**Simulation**: Point the app at an unreachable DB host during a `POST /api/extension/bridge-code` or `POST /api/extension/token/refresh` request.

**Expected result:**
- `derivePasskeyState` throws (DB connection error).
- The route catches the throw as fail-closed: returns a server-error response (503 or 500).
- **No token is minted / no rotation occurs.**
- No successful token response; client receives an error.

**Contrast with web page-route**: The `auth.ts` session callback (unchanged) catches a DB error and fails OPEN (leaves `requirePasskey: false`), so web navigation during a DB blip is not redirected to passkey-setup (SC5). The token routes diverge intentionally — token issuance must never proceed on an indeterminate passkey state.

---

## Rollback Plan

All changes in this PR are additive gate checks on the server side:
- Rolling back means removing the `passkeyEnforcementBlocks` call from each gated route.
- No schema migration needs rollback for C5/C7/C9/R35 (Batch 5 — no schema changes).
- For the full PR rollback (including C8's MCP `familyCreatedAt` column): see the two-step migration described in the plan. The column is nullable in migration 1; rollback simply leaves it as nullable.

**Fastest rollback**: disable the feature via a `PASSKEY_ENFORCEMENT_TOKEN_PATHS_DISABLED` env flag (if wired) or revert the PR on the deploy branch and redeploy.
