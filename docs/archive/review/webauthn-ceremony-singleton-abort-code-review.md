# Code Review: webauthn-ceremony-singleton-abort

Date: 2026-06-12
Review rounds: 1 (Round 2 skipped — tightening-only, test-only fixes within Round 1 scope, no security boundary)
Branch: fix/webauthn-ceremony-singleton-abort

## Summary

The browser passkey sign-in (and the extension reauth flow) intermittently showed
NO OS passkey dialog and timed out after ~60s ("接続中..." / cancelled).

Root cause (confirmed by the user reproducing it): Chrome services only ONE
WebAuthn ceremony — `navigator.credentials.get()` or `.create()` — per document at
a time. A stale ceremony left pending after an SPA navigation or a quick retry
silently blocks the next modal request: no OS prompt appears and the call hangs
until the stale request's 120s safety timer fires.

Fix: a module-level singleton in `src/lib/auth/webauthn/webauthn-client.ts` aborts
any prior in-flight ceremony before starting a new one, and releases a ceremony
stranded by navigation via an exported `abortInFlightCeremony()` wired to the
unmount cleanup of the two sign-in components.

## Changed files
- `src/lib/auth/webauthn/webauthn-client.ts` — `beginCeremony`/`endCeremony`/`abortInFlightCeremony`; both `startPasskeyRegistration` (create) and `startPasskeyAuthentication` (get) route through the guard.
- `src/components/auth/passkey-signin-button.tsx`, `security-key-signin-form.tsx` — unmount cleanup `return abortInFlightCeremony`.
- `src/lib/auth/webauthn/webauthn-client.test.ts` — 3 guard tests.
- `src/components/auth/{passkey-signin-button,security-key-signin-form}.test.tsx` — mock alignment + unmount-cleanup tests.

## Round 1 Findings & Resolution

Functionality expert: **No findings** (traced all interleavings — `===` guard
correct, no timer leak, success-path unmount is a no-op, double-cleanup safe,
StrictMode safe, shared register/auth guard intended, no harmed callers).

Security expert: **No findings** (PRF buffer constructed only after a successful
ceremony → nothing to leak on abort; no challenge/credential mixing — each call
has its own options/signal; abort can only deny, never grant; module-global state
is client-only same-document; RS1-RS4 N/A; R37 N/A — no user-facing strings).

### T2 [Minor] Unmount-cleanup wiring untested at component layer — RESOLVED
- The `return abortInFlightCeremony` cleanup was not asserted; the component mocks
  used a no-op rather than a spy.
- Fix: mock `abortInFlightCeremony` as a hoisted `vi.fn()` spy in both component
  test files; added a render→unmount test asserting it is called once.

### T1 [Minor] Guard tests stalled 10s on regression instead of failing fast — RESOLVED
- The "hanging" ceremony only rejects on abort; if the abort-prior logic were
  removed, the awaited stale promise hangs until vitest's 10s testTimeout.
- Fix: added a `within(promise, ms)` helper that races the stale promise against a
  ~500ms sentinel, so a guard regression fails fast with a clear assertion.

## Verification
- `npx vitest run` (3 affected suites) — 48 passed
- `npx vitest run` (full) — exit 0 / all pass
- `npx next build` — ✓ Compiled successfully

## Scope notes
- Not included (separate concerns / branches): extension-connect reauth 401 → full
  sign-in routing; "接続中..." → "verifying with passkey" label + cancel affordance.
- Cross-tab concurrency is handled by the browser itself (the singleton is
  per-document); the existing `OperationError → AUTHENTICATION_PENDING` mapping
  covers it.
