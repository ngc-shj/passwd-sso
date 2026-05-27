# C15 — `navigator.userActivation.isActive` empirical validation

Date: 2026-05-27
Branch: `chore/c15-user-activation-validation`
Status: **awaiting empirical observation**

## Question

Does `navigator.userActivation.isActive` discriminate between:
- **Legitimate flow**: user clicks "Connect" / signs in → navigation → page with `?ext_connect=1` loads → `useEffect` fires `window.postMessage({type:"PASSWD_SSO_EXT_CONNECT_REQUEST"})`
- **XSS flow**: malicious script in the host page autonomously fires the same `postMessage` at an arbitrary time

If `isActive === true` for legitimate AND `isActive === false` for XSS → C15 naive gate is adoptable.
If both are `false` → naive gate breaks the legitimate flow → fallback design required.
If both are `true` → naive gate accepts the XSS → no benefit.

## Hypothesis (from W3C User Activation v2 spec reading)

Both will read `false`.

Rationale: the legitimate `postMessage` is fired from a `useEffect` that runs AFTER cross-document navigation completes. Per the spec, transient activation is bound to a top-level traversable's user activation data and is consumed/expired in the source document; the destination document of a navigation starts with no activation. The `useEffect` is not invoked synchronously from a user gesture handler — it runs after React has committed, well after any inherited activation window would have elapsed.

If the hypothesis holds, the naive `isActive` gate cannot be adopted. Fallback options to consider:
1. **Page-load timestamp window**: accept if `performance.timing.loadEventEnd` is within the last N seconds AND `?ext_connect=1` was present at initial load.
2. **One-shot per page-load idempotency**: content script accepts at most one `EXT_CONNECT_REQUEST` per `document` lifetime (XSS replay still possible *before* legitimate flow if it runs in `<head>`).
3. **Skip C15 entirely**: rely on the rate-limit at the bridge-code route (60/min/IP, 10/15min/user) + the new audit visibility from C14.

## Test environment

- **Web app**: dev server on `http://localhost:3000` (`npm run dev`)
- **Extension**: production build (`npm run build` inside `extension/`), loaded unpacked into Chrome from `extension/dist/`
- **Browser**: macOS Chrome stable (record exact version below)
- **Origin allowlist**: ensure `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS` in `.env` includes the loaded extension's `chrome-extension://<id>` origin

## Instrumentation

A one-line `console.log` has been added to `src/components/extension/auto-extension-connect.tsx` (the `useEffect` body) capturing:
- `navigator.userActivation?.isActive`
- `navigator.userActivation?.hasBeenActive`
- `document.referrer`
- `performance.now()`
- `performance.timing?.loadEventEnd - performance.timing?.navigationStart` (page-load latency at observation time)

The log is emitted at TWO points:
1. **Before** any conditional checks in the `useEffect` (so we observe state immediately on useEffect entry).
2. **Inside** `requestExtensionConnect()` just before `window.postMessage(...)` is called (so we observe state at the exact moment of the postMessage).

Both points report `[C15-validation]` prefix and are easy to grep for in DevTools.

The instrumentation must be **reverted** before the C15 implementation PR (or this validation PR) is opened — only the documented findings remain.

## Test cases

Run each, copy the `[C15-validation]` console lines into the "Observation" table below.

### TC1 — Legitimate flow: post-sign-in redirect (the canonical case)

1. Open a **fresh** browser window (no prior `localhost:3000` history).
2. Sign out if currently signed in (`/api/auth/signout`).
3. Click the extension toolbar icon → "Connect" button.
4. Extension redirects to `/auth/signin?callbackUrl=...ext_connect=1`.
5. Sign in via passkey or magic link or Google.
6. Post-auth redirect lands on `/dashboard?ext_connect=1`.
7. **Observe**: `[C15-validation]` log lines in DevTools console of the post-auth tab.

Expected (if hypothesis holds): `isActive: false`.

### TC2 — Legitimate flow: passkey already-signed-in resume

1. Sign in (any method) so a valid session cookie exists.
2. Close the dashboard tab.
3. Click the extension toolbar icon → "Connect" button.
4. New tab opens at `/dashboard?ext_connect=1` (no sign-in step — session already valid).
5. **Observe**: same console lines.

Expected: `isActive: false` (still post-navigation; no gesture in the new tab).

### TC3 — Direct URL paste (no preceding gesture in this tab)

1. In a new tab, paste `http://localhost:3000/dashboard?ext_connect=1` into the address bar and hit Enter.
2. **Observe**: same console lines.

Expected: `isActive: false`.

### TC4 — Synthetic post-load click (control / sanity check)

1. Navigate to any `/dashboard` page (no `?ext_connect=1`).
2. Open DevTools Console.
3. Run:
   ```js
   document.body.addEventListener("click", () => {
     console.log("[C15-validation-control]", {
       isActive: navigator.userActivation?.isActive,
       hasBeenActive: navigator.userActivation?.hasBeenActive,
     });
   });
   ```
4. Click anywhere on the page.
5. **Observe**.

Expected: `isActive: true` — this is the control that confirms the API is working.

### TC5 — XSS-style autonomous fire (simulated)

1. On `/dashboard?ext_connect=1` after the legitimate flow has completed (status = CONNECTED), open Console.
2. Run:
   ```js
   console.log("[C15-validation-xss]", {
     isActive: navigator.userActivation?.isActive,
     hasBeenActive: navigator.userActivation?.hasBeenActive,
   });
   window.postMessage({ type: "PASSWD_SSO_EXT_CONNECT_REQUEST", reqId: "xss-test-" + Date.now() }, location.origin);
   ```
3. **Observe** — both the console log AND whether the SW responded (look for `[C15-validation]` from the content script side, or any audit log entry on the server).

Expected: `isActive: false`. The postMessage WILL be processed by the SW (per the current behavior) — this is precisely the gap C15 aims to close.

## Observation table

Fill in after running the tests.

| TC | isActive | hasBeenActive | Notes |
|----|----------|---------------|-------|
| TC1 |          |               |       |
| TC2 |          |               |       |
| TC3 |          |               |       |
| TC4 |          |               | Control — should be `true` |
| TC5 |          |               |       |

Chrome version: __________
OS: __________

## Decision matrix

| TC1+TC2+TC3 | TC5 | Decision |
|-------------|-----|----------|
| All `false` | `false` | **Naive gate breaks legitimate flow** → fallback design or skip |
| All `true` | `true` | **Naive gate is useless** (cannot discriminate) → skip |
| All `true` | `false` | **Naive gate works** → implement C15 as planned |
| Mixed | any | **Inconsistent** → investigate per-case before designing |

## Conclusion (to be filled after observation)

_Pending._

## Out of scope for this validation PR

- The implementation of C15 itself (separate PR contingent on the decision above).
- Any fallback design (separate plan if needed).
- The instrumentation is reverted before this PR opens; the only artifact retained is this document with observations filled in.
