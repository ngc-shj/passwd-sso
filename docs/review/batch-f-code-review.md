# Code Review: batch-f
Date: 2026-03-06T10:00:00+09:00
Review rounds: Session 3 Round 1
Reviewers: 3 expert agents (functional, security, test)

## Review Sessions

### Session 1 (previous conversation): Rounds 1-4
Initial implementation review — all findings resolved.

### Session 2 (previous conversation): Rounds 1-4
Full codebase re-review after Session 1 fixes were committed.

### Session 3 (this conversation): Round 1
Post-fix review after 4 additional commits (0d6dad2, f9adb4c, a79fac7, 1798db9).

---

## Session 3 Round 1 Findings

### FUNC-Medium-1: Hardcoded English "or" divider in vault-lock-screen.tsx
- **File**: `src/components/vault/vault-lock-screen.tsx:195`
- **Problem**: `<span>or</span>` is not internationalized. Japanese users see English "or" on the vault lock screen.
- **Impact**: i18n consistency broken on the most visible screen
- **Recommendation**: Add `"or"` key to `Vault.json` (en/ja) and use `{t("or")}`

### SEC-Medium-1: PSSO_PASSPHRASE leaks to child processes via `run` command
- **File**: `cli/src/commands/run.ts:133-134`
- **CWE**: CWE-214 (Invocation of Process Using Visible Sensitive Information)
- **Problem**: `env: { ...process.env, ...secretEnv }` spreads entire parent environment including `PSSO_PASSPHRASE` and `PSSO_API_KEY` to the child process
- **Impact**: Compromised child dependency could exfiltrate vault master passphrase
- **Recommendation**: Strip `PSSO_PASSPHRASE` and `PSSO_API_KEY` from env before spawning

### SEC-Low-1: `prfSupported: true` hardcoded regardless of PRF config
- **File**: `src/app/api/webauthn/register/options/route.ts:80`
- **Problem**: Always returns `prfSupported: true` even when `WEBAUTHN_PRF_SECRET` is not configured
- **Recommendation**: Set `prfSupported: prfSalt !== null`

### SEC-Low-2: Extension tokens can manage API keys without scope check
- **File**: `src/app/api/api-keys/route.ts:17-26`
- **CWE**: CWE-863 (Incorrect Authorization)
- **Problem**: `authOrToken(req)` allows extension tokens to create/revoke API keys without scope restriction
- **Recommendation**: Restore session-only auth or add scope check

### SEC-Low-3: API_KEYS bearer bypass allows child path prefix matching in proxy
- **File**: `src/proxy.ts:89`
- **Problem**: Prefix matching on `/api/api-keys` allows bypass of any future child routes
- **Recommendation**: Exact-match for API key routes

### SEC-Low-4: TOCTOU race in socket directory creation
- **File**: `cli/src/lib/ssh-agent-socket.ts:49`
- **CWE**: CWE-367
- **Problem**: `statSync` follows symlinks; should use `lstatSync`
- **Note**: Previously accepted as Low in Session 2 (uid check mitigates)

### TEST-High-1: proxy test missing `/api/api-keys` Bearer bypass tests
- **File**: `src/__tests__/proxy.test.ts`
- **Problem**: `API_PATH.API_KEYS` added to `extensionTokenRoutes` but no test coverage
- **Recommendation**: Add Bearer bypass test for `/api/api-keys` and `/api/api-keys/[id]`

### TEST-High-2: proxy test missing `/api/v1/*` Public API bypass tests
- **File**: `src/__tests__/proxy.test.ts`
- **Problem**: `/api/v1/*` session check bypass has no test
- **Recommendation**: Add test for `/api/v1/passwords` without session

### TEST-Medium-1: `SettingsNavSection` test missing `isAdmin` coverage
- **File**: `src/components/layout/sidebar-section-security.test.tsx`
- **Problem**: `isAdmin` condition for tenant settings link not tested
- **Recommendation**: Add tests for `isAdmin={true}` and `isAdmin={false}`

### TEST-Medium-2: `parse-user-agent.ts` unit tests missing
- **File**: `src/lib/parse-user-agent.ts` (28 lines, new file)
- **Problem**: Pure function with no test coverage
- **Recommendation**: Add tests for null, major browsers, unknown UA

### TEST-Medium-3: `webauthn-server.ts` `getRpOrigin()` tests missing
- **File**: `src/lib/webauthn-server.ts:52-63`
- **Problem**: 3-stage fallback logic untested
- **Recommendation**: Add tests for each fallback path

### TEST-Low-1: `api-path.test.ts` missing new path assertions
- **File**: `src/lib/constants/api-path.test.ts`
- **Problem**: New API_PATH entries and path builder functions not covered
- **Recommendation**: Add assertions for all new paths

### TEST-Low-2: CLI `openssh-key-parser.ts` tests missing
- **File**: `cli/src/lib/openssh-key-parser.ts` (348 lines)
- **Note**: Already deferred as F-TEST-1

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 (test gaps) |
| Medium | 4 (1 func + 1 sec + 2 test) |
| Low | 6 (3 sec + 1 sec-accepted + 2 test) |

## 対応状況
(修正後に追記)
