# Extension Re-authentication UX Improvement

## Goal

Improve the UX around browser re-authentication in the extension, **without weakening
the security gate** (15-minute step-up window and passkey requirement stay as-is).

User's core complaint: *"認証したと思ったら、パスキーからの再認証となるのがとても不便"*
— it is surprising and feels redundant.

## Decisions (confirmed with user)

1. **Policy: UX-only.** Do not touch `STEP_UP_WINDOW_MS` / `PASSKEY_VERIFICATION_WINDOW_MS`
   or the passkey-only branch. Security gate unchanged.
2. **popup: distinguish disconnect reason.** "expired/revoked" vs "manual disconnect"
   must read differently, and forewarn that re-auth (passkey) may be required.

## Current behavior (the problem)

- `clearToken()` is called from 6 sites with no record of *why*. The popup then shows
  the generic `LoginPrompt` ("Allow the connection…") with no context.
- After clicking Connect, a new tab opens the web app, which may then demand a passkey
  re-auth (`SESSION_STEP_UP_REQUIRED`) — feeling like a *second* authentication.
- For passkey-provider sessions, after the passkey ceremony the user must click **Allow
  again** (C15-v2 activation consumption), so it reads as a third step.

## Root cause of the passkey surprise (for reference, NOT changed)

`requireRecentCurrentAuthMethod` dispatches on `session.provider`:
- `provider === "webauthn"` → `requireRecentPasskeyVerification` (checks `passkeyVerifiedAt`)
- else → `requireRecentSession` (checks `createdAt`)

Both windows = 15 min. So a passkey-provider user whose `passkeyVerifiedAt` is >15 min old
is *required* to do a passkey ceremony — there is no SSO fallback by design. We keep this;
we only make it predictable and well-explained.

## Design

### Part A — Record the disconnect reason (background)

New module `extension/src/lib/disconnect-reason.ts`:
- Stores a small, **non-sensitive** record under a SEPARATE storage key
  (`DISCONNECT_REASON_KEY = "disconnectReason"`), NOT inside `SESSION_KEY` — because
  `clearSession()` wipes `SESSION_KEY` and the popup reads the reason *after* the token
  is gone.
- Storage area: `chrome.storage.session` (ephemeral; the reason is only meaningful for
  the current browser run, same lifetime as the token it describes).
- Reason enum (const object + derived type, per house style):
  ```ts
  export const DISCONNECT_REASON = {
    EXPIRED: "expired",     // TTL alarm / lazy expiry check (token simply aged out)
    REVOKED: "revoked",     // server rejected refresh (401/403/404) — session invalid
    TIMEOUT_LOGOUT: "timeout_logout", // vault auto-lock action = LOGOUT
    MANUAL: "manual",       // user clicked Disconnect
  } as const;
  ```
- API: `recordDisconnectReason(reason)`, `readDisconnectReason()`, `clearDisconnectReason()`.

`clearToken()` gains an optional `reason` parameter and records it before clearing.
Call-site mapping:

| Site | Reason |
|------|--------|
| index.ts:321 applyToken already-expired | `EXPIRED` |
| index.ts:788 ALARM_TOKEN_TTL | `EXPIRED` |
| index.ts:793 ALARM_VAULT_LOCK + LOGOUT | `TIMEOUT_LOGOUT` |
| index.ts:1860 GET_TOKEN lazy expiry | `EXPIRED` |
| index.ts:1868 CLEAR_TOKEN (manual) | `MANUAL` |
| index.ts:1893 GET_STATUS lazy expiry | `EXPIRED` |
| token-handler.ts:84 refresh 401/403/404 | `REVOKED` |

A fresh successful connect (`applyToken` success path) clears the stored reason so a stale
banner never shows after reconnect.

### Part B — Surface the reason in GET_STATUS

Extend the `GET_STATUS` response with `disconnectReason: DisconnectReason | null`.
Only meaningful when `hasToken === false`. Populated from `readDisconnectReason()`.

### Part C — popup LoginPrompt context (UX)

`LoginPrompt` takes a `reason` prop and renders a context line above the Connect button:

| reason | message key | tone |
|--------|-------------|------|
| `EXPIRED` / `TIMEOUT_LOGOUT` | `popup.disconnectedExpired` "Your session timed out. Reconnect to continue." | neutral/info |
| `REVOKED` | `popup.disconnectedRevoked` "You were signed out. Reconnect to continue." | neutral/info |
| `MANUAL` / null | existing `popup.signIn` | neutral |

Plus a **forewarning** line shown for all non-manual reasons:
`popup.reauthHint` — "You may be asked to re-authenticate (e.g. passkey) for security."
This sets the expectation so the passkey prompt on the web side is no longer a surprise.

App.tsx threads `disconnectReason` from status into `<LoginPrompt reason=… />`.

### Part D — Reduce the "Allow again after passkey" friction (web)

In `auto-extension-connect.tsx`, after a successful passkey reauth we currently bounce
back to `AWAITING_CLICK` (a second Allow click) due to activation consumption. We keep the
re-click (it is a hard browser constraint) but **reframe** it so it reads as a continuation,
not a repeat:
- New copy for the post-reauth AWAITING_CLICK state: title "Re-authentication complete"
  / action "Finish connecting" — only when arriving from reauth (track with a ref flag).
- This applies the OAuth-consent "Allow X"/continuation framing
  (see memory `feedback_oauth_consent_framing_for_duplicate_verbs`).

## Files to change

Extension:
- `src/lib/constants.ts` — add `DISCONNECT_REASON_KEY`.
- `src/lib/disconnect-reason.ts` — NEW (record/read/clear + enum).
- `src/background/index.ts` — `clearToken(reason?)`, thread reasons, clear on connect.
- `src/background/token-handler.ts` — pass `REVOKED` into the `clearToken` callback.
- `src/types/messages.ts` — add `disconnectReason` to GET_STATUS response.
- `src/popup/App.tsx` — thread reason into LoginPrompt.
- `src/popup/components/LoginPrompt.tsx` — reason prop + context/forewarn lines.
- `src/messages/en.json`, `src/messages/ja.json` — new keys.

Web:
- `src/components/extension/auto-extension-connect.tsx` — post-reauth continuation framing.
- `messages/en.json`, `messages/ja.json` — `Extension.connectContinueTitle` / `…Action`.

## Tests

- `disconnect-reason.test.ts` — record/read/clear round-trip; separate key survives `clearSession`.
- background tests — each clearToken site records the expected reason; connect clears it.
- `FillMismatchDialog.test.tsx` unaffected; add `LoginPrompt.test.tsx` for reason rendering.
- update existing GET_STATUS response-shape assertions.

## Out of scope / not changed

- Step-up window length, passkey-only branch, any server gate logic.
- The two-step bridge-code/exchange handshake.
