# Manual Test: long-lived-client-login

Human-run checks for paths automated tests cannot reach (plan VE2/VE3, testing strategy M1–M5). Run against a dev server with the branch's migration applied and the extension built from this branch (`cd extension && npm run build`, load `extension/dist` unpacked).

## Pre-conditions
- Tenant with a user who has a vault and a passkey; extension connected via the bridge flow.
- Tenant admin access to Settings → Security → session policy.
- For M4: an iOS device (or simulator with enrolled Face ID) running this branch's app.

## M1 — lock is not logout (VE3)
1. Unlock the vault in the extension popup.
2. Lock it (popup Lock or shortcut).
3. Open `chrome://serviceworker-internals`, find the extension's worker, press **Stop**.
4. Open the popup.
- Expected: the passphrase unlock screen, not **Connect**. Unlocking with the passphrase works and autofill works afterwards.

Result (2026-09-28, Chrome, dev server): after lock + worker Stop, the popup asked for the passphrase (no Connect); server saw only `unlock/data` + `unlock/verify` 200, no bridge-code. Pass.

## M2 — extension survives web sign-out (smoke; FR1 is covered by the integration test)
1. With the extension connected and unlocked, sign out of the web app tab (single session).
2. Wait for or trigger an extension token refresh (reload the popup after the token's refresh alarm, or shorten the tenant idle/refresh window).
- Expected: the extension stays connected; API calls keep working.

Result (2026-09-28): pass (user-confirmed).

## M3 — tenant forces logout on timeout
1. As tenant admin, enable "Force sign-out on client app vault timeout" and set vault auto-lock to 5 minutes.
2. In the extension, unlock (so the policy is fetched), then leave it idle for 5 minutes.
- Expected: the extension shows **Connect** (token cleared), not the unlock screen; the options page shows the timeout-action selector disabled with the tenant explanation.
3. Disable the flag, reconnect, repeat.
- Expected: after 5 idle minutes the extension shows the unlock screen (lock only).

## M4 — iOS Face ID records presence (VE2, device)
1. Sign in on iOS, unlock with the passphrase, then lock.
2. Unlock with Face ID.
- Expected: vault opens without the passphrase; server `extension_tokens.last_presence_at` for the family advances. After a 422 (e.g. passphrase-derived secret changed server-side), the next Face ID unlock still opens the vault and no longer sends the cached hash.

Result (2026-09-28, iPhone, dev server): passphrase unlock → `unlock/data` + `unlock/verify` 200; Face ID unlock → `unlock/verify` 200 without `unlock/data`; access-row `last_presence_at` advanced to the Face ID unlock time; no `VAULT_UNLOCK_FAILED`. Pass. (The first attempt only exercised Face ID with a pre-branch cache, so no hash was cached and nothing was sent — a passphrase unlock on this build is required once.)

## M5 — presence expiry
1. As tenant admin, set the extension-token idle timeout to 5 minutes (vault auto-lock ≤ 5).
2. Connect and unlock the extension, lock it, and do not unlock again for more than 5 minutes (browser left open).
- Expected: at the next refresh the family is revoked (`EXTENSION_TOKEN_FAMILY_REVOKED`, `metadata.reason = "presence_expired"` in the audit log) and the popup shows **Connect**.
3. Repeat, but unlock with the passphrase every few minutes.
- Expected: the extension stays connected past 5 minutes.

## Adversarial scenarios
- A web page dispatching synthetic (untrusted) events on the inline suggestion dropdown must not extend the auto-lock timer (vault locks on schedule).
- A session-cookie-only `POST /api/vault/unlock/verify` (no Bearer) returns 401 and records nothing.
- Replaying a rotated extension token more than 5 s after rotation revokes the whole family (audit `EXTENSION_TOKEN_FAMILY_REVOKED`, `metadata.reason = "replay_detected"`).

## Rollback
Revert the branch's migration only together with the code: `last_presence_at` is read by refresh; `require_vault_timeout_logout` is read by the policy route and both clients.
