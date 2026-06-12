# Code Review: extension-reauth-401-routing

Date: 2026-06-12
Review rounds: 1 (no code changes required from review — findings accepted)
Branch: fix/extension-reauth-401-routing

## Summary

Two fixes to the extension-connect passkey reauth flow in
`auto-extension-connect.tsx`:
1. When the web session fully expires, the reauth options endpoint returns 401
   ("UNAUTHORIZED") and the old code looped on the passkey prompt forever (it can
   never succeed without a session). New code routes the UNAUTHORIZED result to a
   full sign-in via a `redirectToFullSignIn` helper (extracted from the existing
   recent-session path).
2. UX: relabel the in-flight button "Verifying with passkey..." (was the generic
   "Connecting..."), and add a Cancel control that aborts the ceremony via
   `abortInFlightCeremony()`.

## Round 1 findings & disposition

Functionality: No blocking findings (redirectToFullSignIn extraction verified
behavior-equivalent; UNAUTHORIZED branch ordering correct; label/cancel gating
correct — recent-session path keeps "Connecting" + Go-to-dashboard).

Security: **No findings.** Open-redirect safe — `callbackUrl` is built from
same-origin `window.location` and validated on the sign-in side by
`resolveCallbackUrl` (rejects protocol-relative / cross-origin / dangerous
schemes, fails closed to /dashboard). The 401→signOut path is fail-closed (never
connects the extension). Cancel→abort yields AUTHENTICATION_CANCELLED (a failure,
never a pass) — cannot bypass step-up. R37: `connectReauthVerifying` /
`connectReauthCancel` use user-domain language.

### F1 [Minor] Cancel is a no-op during the options-fetch window — ACCEPTED
- **Anti-Deferral check**: acceptable risk (quantified).
- `abortInFlightCeremony()` only acts after `startPasskeyAuthentication`'s
  `navigator.credentials.get()` registers the in-flight controller, i.e. after
  the brief `fetchApi(reauth/options)` POST. A Cancel click during that sub-second
  window does nothing.
- **Worst case**: the user clicks Cancel during the options POST and the button
  stays "Verifying..." until the native passkey dialog appears (which the user can
  then dismiss). **Likelihood**: low — the options POST is sub-second; the actual
  long wait the Cancel targets is the `get()` ceremony (up to 60-120s), which IS
  cancelable. **Cost to fix**: medium — making `reauthenticateWithPasskey`
  abortable end-to-end means threading an AbortSignal through the shared
  passkey-reauth-client (also used by inline-reauth / operator-token), a broader
  change. Deferred as a follow-up; the native dialog + 120s backstop remain escape
  hatches.

### T3 [Minor] Cancel test doesn't assert post-abort recovery — ACCEPTED
- **Anti-Deferral check**: covered elsewhere.
- The new test asserts the click→`abortInFlightCeremony` wiring (load-bearing).
  The post-abort path (ceremony → AUTHENTICATION_CANCELLED → connectReauthCancelled
  prompt) is already covered by the existing "shows cancellation feedback when
  reauth is cancelled" test. No new test needed.

## Verification
- `npx vitest run src/components/extension/auto-extension-connect.test.tsx` — 28 passed
- `npx vitest run` (full) — exit 0
- `npx next build` — ✓ Compiled successfully
