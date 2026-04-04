# Plan: security-review-csp-session-docs

## Objective

Address four findings from a comprehensive security evaluation of the codebase.
Two Medium-severity and two Low-severity items covering CSP architecture documentation,
session cache multi-worker limitations, WebAuthn interceptor constant sync, and
PSSO_PASSPHRASE misuse prevention.

## Requirements

### Functional
- PSSO-1: Display a runtime warning on stderr whenever PSSO_PASSPHRASE env var is used to auto-unlock
- PSSO-2: Document PSSO_PASSPHRASE as CI/automation-only in README.md
- CSP-1: Add architectural comment to `next.config.ts` explaining why CSP is absent (nonce requirement)
- CSP-2: Align `Permissions-Policy` values between `next.config.ts` and `src/proxy.ts`
- SESSION-1: Document multi-worker sessionCache TTL limitation in `src/proxy.ts`
- WEBAUTHN-1: Add local variable declarations for `WEBAUTHN_TYPE_GET/CREATE` in `webauthn-interceptor.js` with sync comments
- WEBAUTHN-2: Update sync comment in `extension/src/lib/constants.ts`

### Non-functional
- No behavioral changes to CSP logic or session cache eviction
- All existing tests must pass
- Production build must succeed

## Technical Approach

### PSSO-1: Runtime Warning on PSSO_PASSPHRASE Use

`cli/src/commands/unlock.ts:autoUnlockIfNeeded()` reads `process.env.PSSO_PASSPHRASE`.
Add `output.warn()` call immediately after the `if (!passphrase) return false` guard,
before calling `return unlockWithPassphrase(passphrase)`.
The `output` module is already imported.

`output.warn` currently uses `console.log` (stdout). Since warnings are diagnostic messages,
they should go to stderr — consistent with `output.error` which already uses `console.error`.
Fix `output.warn` in `cli/src/lib/output.ts` to use `console.error` instead of `console.log`.
This affects all existing `output.warn` callers (export.ts, agent.ts, api-key.ts, env.ts, login.ts),
all of which are diagnostic messages appropriate for stderr.

**Important**: The warning message must NOT include the passphrase value or any derivative.
Only the env var name should appear in the message.

**Files to modify:**
1. `cli/src/lib/output.ts` — Change `output.warn` from `console.log` to `console.error`
2. `cli/src/commands/unlock.ts` — Add `output.warn(...)` in `autoUnlockIfNeeded()` after `if (!passphrase) return false`

### PSSO-2: README Documentation

Add a security note to the CLI section of `README.md` documenting:
- PSSO_PASSPHRASE is intended for CI/CD pipelines only
- Not recommended for production interactive environments
- The passphrase is stored in process environment (visible to child processes)

**Files to modify:**
1. `README.md` — Add security note to CLI section

### CSP-1 & CSP-2: CSP Architecture Comment + Permissions-Policy Alignment

`next.config.ts` intentionally omits CSP because the nonce-based CSP requires per-request
generation (dynamic) which is only possible in middleware.

Current inconsistency found:
- `next.config.ts` Permissions-Policy: `camera=(), microphone=(), geolocation=(), browsing-topics=()`
- `src/proxy.ts` applySecurityHeaders: `camera=(), microphone=(), geolocation=(), payment=()`

Both `payment=()` and `browsing-topics=()` should be in both locations.

**Files to modify:**
1. `next.config.ts` — Add comment explaining CSP is middleware-only; add `payment=()` to Permissions-Policy
2. `src/proxy.ts` — Add `browsing-topics=()` to Permissions-Policy in `applySecurityHeaders`

### SESSION-1: sessionCache Multi-Worker Documentation

`src/proxy.ts:29` declares `const sessionCache = new Map<...>()` at module scope.
In multi-process or multi-pod deployments, each process holds an independent cache.
Session revocation on one worker takes up to TTL_MS (30s) to propagate to other workers.

Add a comment documenting this known limitation. No code change to eviction logic.

The comment should also note that cache keys are plaintext session token values (not hashed), which is a known trade-off (avoiding per-request SHA-256 overhead) documented as a future improvement candidate.

**Files to modify:**
1. `src/proxy.ts` — Add comment to `sessionCache` declaration explaining multi-worker TTL gap and plaintext key trade-off

### WEBAUTHN-1 & WEBAUTHN-2: Constant Sync Pattern

`extension/src/lib/constants.ts:76-77` defines:
```
export const WEBAUTHN_TYPE_GET = "webauthn.get";
export const WEBAUTHN_TYPE_CREATE = "webauthn.create";
```
with a comment that `webauthn-interceptor.js` (MAIN world, plain JS) cannot import them.

`webauthn-interceptor.js` uses the string literals inline at lines 121 and 206
without any reference back to `constants.ts`.

Apply the same pattern already used for `BRIDGE_MSG`/`BRIDGE_RESP` (lines 12-14):
add local variable declarations at the top of the file with sync comments.

**Files to modify:**
1. `extension/src/content/webauthn-interceptor.js` — Add `var WEBAUTHN_TYPE_GET` / `var WEBAUTHN_TYPE_CREATE` with sync comment; use variables at lines 121 and 206
2. `extension/src/lib/constants.ts` — Update comment at line 74 to mention the interceptor.js local vars

## Implementation Steps

1. **output.warn stderr**: Change `console.log` → `console.error` in `cli/src/lib/output.ts:warn()`
2. **PSSO-1**: Add `output.warn(...)` in `autoUnlockIfNeeded()` after `if (!passphrase) return false`, before `return unlockWithPassphrase(passphrase)`
3. **PSSO-2**: Add security note to README.md CLI section
4. **CSP-1**: Add comment to `next.config.ts` explaining nonce-based CSP is middleware-only
4b. **CSP-2 impl**: Add `payment=()` to `next.config.ts` Permissions-Policy; add `browsing-topics=()` to `src/proxy.ts` Permissions-Policy
4c. **CSP-2 test**: Update `src/__tests__/proxy.test.ts:411` expected value to `"camera=(), microphone=(), geolocation=(), payment=(), browsing-topics=()"`
5. **SESSION-1**: Add multi-worker TTL limitation comment to `src/proxy.ts:sessionCache`
6. **WEBAUTHN-1**: Add local variable declarations + sync comment in `webauthn-interceptor.js`; replace inline literals at lines 121 and 206
7. **WEBAUTHN-2**: Update comment in `extension/src/lib/constants.ts` at line 74
8. Run `npx vitest run` + `npx next build` to verify no regressions

## Testing Strategy

- `cli/src/__tests__/unit/unlock.test.ts` already mocks `output.warn` as `vi.fn()` (line 26). The following test cases must be updated:
  1. "calls unlockWithPassphrase when PSSO_PASSPHRASE is set and vault is locked" — add `expect(output.warn).toHaveBeenCalledWith(expect.stringContaining("PSSO_PASSPHRASE"))` and `expect(output.warn).toHaveBeenCalledTimes(1)`
  2. "returns false when PSSO_PASSPHRASE is set but unlock fails" — same assertions
  3. "returns false when vault is locked and no PSSO_PASSPHRASE env" — add `expect(output.warn).not.toHaveBeenCalled()` to confirm warn is NOT called when the env var is absent
- `src/__tests__/proxy.test.ts:411` asserts the Permissions-Policy value — must be updated to the exact expected string after CSP-2: `"camera=(), microphone=(), geolocation=(), payment=(), browsing-topics=()"` (payment first, then browsing-topics, following the existing order in `applySecurityHeaders`).
- Note: `webauthn-interceptor.js` is a MAIN world plain-JS file excluded from the vitest test suite. WEBAUTHN-1 changes (variable substitution at lines 121 and 206) must be verified by code review (visual inspection).
- Production build verifies TypeScript correctness.
- Manual check: set `PSSO_PASSPHRASE=test` and run `passwd-sso env 2>/dev/null` to confirm warning does NOT appear when stderr is suppressed; run without redirect to confirm it appears on stderr.
- Add `expect(output.warn).not.toHaveBeenCalled()` to the "vault is already unlocked" test case in `unlock.test.ts` to confirm warn is not called when vault was already unlocked.
- `cli/src/lib/output.ts` — `warn` changed to `console.error`; confirm existing tests that mock `output.warn` still pass (mocks replace the implementation, so stdout/stderr distinction is irrelevant in unit tests).

## Considerations & Constraints

- **PSSO_PASSPHRASE warn**: The warning fires only when `PSSO_PASSPHRASE` is actually used for unlock (i.e., vault is locked and env var is present). If the vault is already unlocked, `if (isUnlocked()) return true` exits before the env check — no warning fires. This is intentional: warning on every command invocation when the env var is set (even when unused) would be noisy in CI pipelines. Users who set the env var in an already-unlocked context will not see the warning, which is acceptable for the intended use case.
- **PSSO_PASSPHRASE empty string**: If `PSSO_PASSPHRASE=""` (empty/falsy), the existing `if (!passphrase) return false` guard exits before the warn call — no warning fires. This is intentional and unchanged behavior.
- **output.warn stderr**: `output.warn` will be changed to use `console.error` (stderr), consistent with `output.error`. This affects all 7 existing callers (export.ts, agent.ts ×2, api-key.ts, env.ts, login.ts, unlock.ts) — all are diagnostic messages appropriate for stderr. CI pipelines can now cleanly separate program output (stdout) from warnings (stderr).
- **Permissions-Policy browsing-topics**: `browsing-topics=()` is a newer directive that may generate browser console noise on older browsers — acceptable since we're adding it as a privacy restriction. Only two files set this header (`next.config.ts` and `src/proxy.ts`) — confirmed by grep.
- **Permissions-Policy as shared constant**: Both locations share the same directives conceptually, but a shared constant would require importing from next.config.ts into src/proxy.ts (different runtimes, different module scopes). Keeping them as aligned string literals is intentional; the inconsistency found (payment vs. browsing-topics) is the root issue being fixed.
- **sessionCache Redis migration**: Out of scope. A Redis-backed session cache would eliminate the multi-worker gap entirely but is a separate, larger task involving middleware Redis client setup
- **webauthn-interceptor.js type values**: `"webauthn.get"` and `"webauthn.create"` are W3C WebAuthn spec-defined values (https://www.w3.org/TR/webauthn-2/ §5.8.1). They cannot drift from the protocol. The sync comment and local variables follow the existing BRIDGE_MSG/BRIDGE_RESP pattern for consistency. Other plain-JS files in extension/src/content/ (autofill.js, token-bridge.js, etc.) confirmed to have no WEBAUTHN_TYPE usage — scope is limited to webauthn-interceptor.js only.

## User Operation Scenarios

1. **CI pipeline using PSSO_PASSPHRASE**: User sets `PSSO_PASSPHRASE` in CI secret → runs `passwd-sso env DATABASE_URL` → sees warning on stderr → command still works → user is informed of the risk
2. **Developer on multi-pod deployment revokes session**: Session revoked on pod A → user's request hits pod B → cached session still valid for up to 30s → comment makes this limitation explicit for operators

## Files to Modify (Summary)

| File | Change |
|------|--------|
| `cli/src/lib/output.ts` | Change `warn()` from `console.log` to `console.error` |
| `cli/src/commands/unlock.ts` | Add `output.warn()` in `autoUnlockIfNeeded()` |
| `README.md` | Add PSSO_PASSPHRASE security note to CLI section |
| `next.config.ts` | Add CSP architecture comment; add `payment=()` to Permissions-Policy |
| `src/proxy.ts` | Add multi-worker comment to `sessionCache`; add `browsing-topics=()` to Permissions-Policy |
| `extension/src/content/webauthn-interceptor.js` | Add local vars + sync comment; use vars at lines 121 and 206 |
| `extension/src/lib/constants.ts` | Update sync comment at line 74 |
