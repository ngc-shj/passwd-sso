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

## Observations

Tests were partial; the only `[C15-validation]` log captured was from a run where
the vault unlock click immediately preceded the useEffect:

```
[C15-validation] useEffect entry
  isActive: true
  hasBeenActive: true
  documentReferrer: ''
  performanceNow: 10600
  pageLoadMs: 1017
[C15-validation] pre-postMessage
  isActive: true
  hasBeenActive: true
  reqId: <uuid>
  performanceNow: 10606
```

Key fact: `performanceNow - pageLoadMs ≈ 9.5s`. The useEffect fired ~9.5 seconds
after page load, well outside the 5-second transient activation window from
page-load-time gestures alone. `isActive: true` is only possible because a
user gesture occurred WITHIN the preceding 5 seconds — and the most plausible
explanation is the **vault unlock click**.

The "vault already unlocked, no preceding click" scenario could not be
empirically confirmed because every test run reached the page with the vault
re-locked (vault state appears not to persist across tab open in the user's
environment); the AutoExtensionConnect component never mounted without an
unlock click intervening.

`documentReferrer: ''` is consistent with the extension popup → new tab flow
(the `chrome-extension://...` referrer is stripped by default policy).

## Findings

1. **Legitimate flow on this codebase typically routes through vault unlock**,
   and the unlock click satisfies `userActivation.isActive` at the moment of
   `postMessage`. Naive gate would NOT break this flow.

2. **The "vault already unlocked at navigation" path is plausible** (vault
   state could persist via SessionStorage / IndexedDB / SW message channel in
   some configurations) but **could not be reproduced** in the observed
   environment. If such a path exists in production, naive gate would reject
   the legitimate flow on that path — the failure mode is silent (extension
   never connects, user sees `EXTENSION_ABSENT` error code with no
   forensic-server signal because the gate sits in the content script before
   the SW fetch).

3. **Beyond vault unlock click**, any user gesture within 5 seconds of the
   useEffect satisfies the gate — including unrelated clicks, scrolls,
   keypresses. XSS that runs autonomously on page load (zero preceding
   gesture) WOULD be blocked. XSS that races a user click within a 5-second
   window WOULD NOT be blocked.

## Decision

**Skip C15** for the foreseeable future. Rationale:

- **Existing defenses are sufficient for the residual threat**:
  - 60/min/IP IP rate-limit on bridge-code route
  - 10/15min/user per-user rate-limit
  - DPoP sender-constrained tokens (PR #491): token cannot be exfiltrated
  - SW-initiated bridge code with cnf_jkt trust path (PR #492): token never
    reaches a JS heap reachable by XSS
  - Audit visibility on every failure path (PR #495 / C14): operators can
    detect abuse patterns
- **Marginal additional value**: naive gate only blocks XSS that fires before
  any user gesture. XSS-after-gesture is unblocked. Given XSS in a long-lived
  dashboard tab is the higher-impact scenario, the gate doesn't move the
  attacker's effective bar much.
- **Risk of breaking legitimate flow** in the un-tested "vault already
  unlocked" path. The failure mode is silent and indistinguishable from
  "extension not installed" — bad UX.
- **Implementation + maintenance cost** in the extension content script for a
  defense that adds bounded value.

If the threat model later prioritizes "XSS-on-page-load → bridge-code issuance
auto-fire" specifically (e.g., a CSP regression that newly admits XSS), this
decision can be revisited with empirical retest of the "vault already
unlocked" path.

## Out of scope for this PR

- C15 implementation — **not pursued**.
- Any fallback design — not pursued (decision is to skip).
- The instrumentation has been reverted; this document is the sole retained
  artifact.

## Re-validation triggers

Revisit C15 when:
- A new XSS surface is found that bypasses DPoP / rate-limit / cnf_jkt
- Vault state persistence model changes (e.g., shared across tabs via SW)
- Browser User Activation spec evolves to provide a stronger discriminator
- A different threat model (e.g., browser-level malicious extension) requires
  stronger gating in the host page
