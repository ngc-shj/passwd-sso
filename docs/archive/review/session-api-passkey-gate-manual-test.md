# Manual Test: session-api-passkey-gate

Covers issue `#959`: the session `/api/*` passkey gate, the recovery screen, and the CI e2e env
change (`WEBAUTHN_RP_ID`, `WEBAUTHN_PRF_SECRET`).

## Pre-conditions
- Dev stack up (`npm run docker:up`) and the app on its usual port. The browser has a platform
  authenticator or a security key.
- Two tenants.
  - **Tenant P:** `requirePasskey` on, with a grace period already past, i.e.
    `requirePasskeyEnabledAt` more than `passkeyGracePeriodDays` ago. Set it through the tenant
    policy page, or by updating the tenant row as an admin.
  - **Tenant N:** `requirePasskey` off.
- Members:
  - Member A in tenant P, with no passkey and a vault set up.
  - Member B in tenant N, with no passkey.
  - An admin of tenant P who already has a passkey.

## Steps and expected results
1. **API refusal.** Sign in as A (magic link or OIDC).
   - Call `GET /api/passwords` from the browser devtools (`fetch`). Expect 403 with
     `{"error":"PASSKEY_REQUIRED"}` and `Cache-Control: no-store`.
   - The `audit_outbox` gets one `PASSKEY_ENFORCEMENT_BLOCKED` row with
     `metadata.blockedPath = "GET /api/passwords"`. A second call within 5 minutes adds no row.
2. **Minimal screen.** As A, open `/ja/dashboard`.
   - The page shows the passkey-required screen (a registration card and sign-out), not the
     vault unlock.
   - The network panel shows no 403 and no request to `/api/vault/status`.
3. **Stale sign-in.**
   - As A, with a sign-in older than the step-up window (or after waiting it out), press
     register. Expect the "sign in again" dialog (`SESSION_STEP_UP_REQUIRED`).
   - Sign in again and press register: the passkey registers with the vault still locked.
   - Registration always needs a recent sign-in, not only while blocked. As B (tenant N), with
     a sign-in older than the step-up window, press register on the passkey settings page:
     expect the same "sign in again" dialog, and no credential is created.
4. **After registration.**
   - The page reloads into the normal dashboard, and the vault asks to unlock.
   - `GET /api/passwords` now returns 200.
   - After unlocking, the passkey settings page offers to enable auto-unlock for the new
     credential, and the text does not mention a key rotation.
5. **Open tab.** As A in a second, already-open dashboard tab: its next API call reloads it
   once onto the passkey page. There is no reload loop.
6. **Admin.** A blocked tenant-P admin opening `/ja/admin` is redirected to the passkey page.
7. **Unaffected users.** B (tenant N), and A during the grace period, use every API and page as
   before.
8. **Credential deletion.**
   - As A (tenant P, past grace) with a recent sign-in, delete A's only passkey from settings.
     Expect the refusal toast saying to register a new passkey first. The response is 403
     `CANNOT_DELETE_LAST_PASSKEY`, the passkey is still listed, and `GET /api/passwords` still
     returns 200.
   - Register a second passkey, then delete either one: the delete succeeds and
     `GET /api/passwords` stays 200. Deleting the remaining one is refused again.
   - As B (tenant N), and as A while tenant P is still within its grace period, deleting the
     only passkey succeeds.
   - As A with only one passkey and a sign-in older than the step-up window, delete it. Expect
     the same `CANNOT_DELETE_LAST_PASSKEY` refusal, not the "sign in again" dialog: the refusal
     is answered before the step-up. With two passkeys and the same stale sign-in, deleting one
     shows the "sign in again" dialog (`SESSION_STEP_UP_REQUIRED`).
   - **Compromised sole passkey (incident response).** As A with one passkey, treat it as
     compromised: sign in again, register a replacement, then delete the compromised one.
     Expect the delete to succeed and the replacement to stay listed.
   - For a member with no second authenticator, a tenant-P admin turns `requirePasskey` off;
     the member can then delete the compromised passkey (it is no longer refused). The admin
     turns the requirement back on once the member has registered a replacement. There is no
     admin-side credential revoke yet (follow-up).
     - While it is off, the requirement is off for every tenant-P member. Expect another
       passkey-less member's API calls to succeed during that window.
     - Turning it back on restarts the grace period for everyone. With a non-zero grace period,
       expect a passkey-less member to stay allowed until the new window expires.
     - In the tenant policy card, switching the requirement off clears the grace field.
       Re-enabling with the field left blank should block that member at once.
     - Over the API, `PATCH {requirePasskey: true, passkeyGracePeriodDays: null}` should do the
       same.
     - An MCP access token obtained while the requirement was off should keep working until it
       expires (up to 1 h). Its refresh should be refused.
   - A delete through the route can no longer leave a past-grace member without a passkey, so
     the former "next API call returns `PASSKEY_REQUIRED` within seconds" check is not
     reachable here. The delete's session-cache invalidation is still covered by the route's
     unit test and the integration suite.
9. **Outage (D7).**
   - Make the session callback's passkey read fail, for example by briefly revoking the app
     role's read on `webauthn_credentials` in a scratch DB, or by stopping the DB for a moment.
   - Users of tenant N see the "temporarily unavailable" retry state on the dashboard. API calls
     return 503, not `PASSKEY_REQUIRED`, and no audit rows appear.
   - Restore access. Within about 5 seconds a retry shows the normal page, at the same URL.
10. **iOS AutoFill token.** From the iOS app (`IOS_APP` token), the AutoFill passkey-upload
    token still mints. A request with only a session cookie gets 401.

## Adversarial scenarios
- **Stolen blocked cookie, registration.**
  - With A's session cookie from a sign-in older than the step-up window, call
    `POST /api/webauthn/register/options` and `/verify` directly. Expect
    `SESSION_STEP_UP_REQUIRED`, and no credential is created.
  - An OAuth callback carrying that cookie does not link a new IdP account to A (`#966`), so
    "sign in again" cannot be satisfied by an attacker's IdP account.
- **Exemption probing.** As A, try:
  - `DELETE /api/webauthn/credentials/<id>`;
  - `GET /api/vault/status`;
  - `PUT /api/tenant/policy` (with a matching Origin);
  - `GET /api/auth/passkey/reauth/options`;
  - `GET /api/auth/session/x`;
  - `POST /api/auth/csrf`.

  Each must give `PASSKEY_REQUIRED`, or the route's own refusal, never a pass.
- **Cookie tricks.**
  - Send A's cookie twice, or as a `.0` chunk, to `POST /api/auth/passkey/reauth/options`:
    expect 401.
  - Send a junk `Authorization: Bearer x` alongside A's cookie to `GET /api/passwords`: expect
    `PASSKEY_REQUIRED`.
- **Cross-tenant passkey.** A passkey A registered under another tenant counts: A is not
  blocked in tenant P.
- **Forged degraded marker.** A client cannot set `passkeyStateDegraded`. The proxy reads only
  the server's own `/api/auth/session` response.

## Rollback
- Revert the PR commit range on `main` and redeploy.
- No migration is involved. After a rollback, cached session entries carrying
  `passkeyStateDegraded` are still accepted, because the old schema ignores the extra key.
- The CI change is two env lines in the e2e job. Reverting them only disables the new spec's
  PRF path.
