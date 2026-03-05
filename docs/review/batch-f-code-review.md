# Code Review: batch-f
Date: 2026-03-06T10:00:00+09:00
Review rounds: Session 4 Round 1
Reviewers: 3 expert agents (functional, security, test)

## Review Sessions

### Session 1 (previous conversation): Rounds 1-4
Initial implementation review — all findings resolved.

### Session 2 (previous conversation): Rounds 1-4
Full codebase re-review after Session 1 fixes were committed.

### Session 3 (previous conversation): Rounds 1-2
Post-fix review after 4 additional commits (0d6dad2, f9adb4c, a79fac7, 1798db9).

### Session 4 (this conversation): Round 1
Full codebase re-review — fresh session.

---

## Session 4 Round 1 Findings

### FUNC-High-2: Okta fetchOktaUsers filter URL not encoded
- **File**: `src/lib/directory-sync/okta.ts:99`
- **Problem**: `filter=status eq "ACTIVE"&limit=200` is concatenated directly into URL without `URLSearchParams`, so spaces and quotes are not percent-encoded. Not RFC-compliant.
- **Recommendation**: Use `URLSearchParams` for proper encoding.

### FUNC-Medium-1: `env` command outputs partial results on fetch failure
- **File**: `cli/src/commands/env.ts:68-70`
- **Problem**: On HTTP error, `continue` skips the failed entry and outputs the rest. CI/CD pipelines using `eval $(passwd-sso env)` get incomplete env vars.
- **Recommendation**: `process.exit(1)` like `run` command does.

### FUNC-Medium-2: `authenticate/options` doesn't catch `derivePrfSalt` exception
- **File**: `src/app/api/webauthn/authenticate/options/route.ts:77`
- **Problem**: Unlike `register/options` which wraps `derivePrfSalt` in try/catch, this handler calls it unprotected. If `WEBAUTHN_PRF_SECRET` is unset, 500 error.
- **Recommendation**: Add try/catch like register/options.

### FUNC-Medium-3: `validateApiKey` no null guard on `expiresAt`
- **File**: `src/lib/api-key.ts:100`
- **Problem**: `key.expiresAt.getTime()` would throw if expiresAt were null (DB inconsistency).
- **Recommendation**: Add `!key.expiresAt ||` guard.

### FUNC-Medium-4: `derToSshEcdsa` assigns dead variable `seqLen = 0`
- **File**: `cli/src/lib/ssh-key-agent.ts:220`
- **Problem**: `seqLen = 0` is unreachable code — variable is unused after assignment.
- **Recommendation**: Remove the line.

### SEC-Low-1: `env` command missing BLOCKED_KEYS check
- **File**: `cli/src/commands/env.ts:61`
- **CWE**: CWE-426 (Untrusted Search Path)
- **Problem**: `run` command blocks PATH/LD_PRELOAD etc. (19 entries) but `env` command has no such check.
- **Recommendation**: Share BLOCKED_KEYS from `run.ts` and apply in `env.ts`.

### TEST-High-3: `auth-or-token.test.ts` missing API key path
- **File**: `src/lib/auth-or-token.test.ts`
- **Problem**: Tests cover session and extension token paths only. API key dispatch (L45-61) is untested.
- **Recommendation**: Add tests for API key success, failure, and scope_insufficient.

### TEST-High-4: `api-key.ts` pure functions have no tests
- **File**: `src/lib/api-key.ts`
- **Problem**: `parseApiKeyScopes()` and `hasApiKeyScope()` are pure functions without tests.
- **Recommendation**: Create `src/lib/api-key.test.ts`.

### TEST-Medium-4: `travel-mode.ts` `filterTravelSafe()` has no tests
- **File**: `src/lib/travel-mode.ts`
- **Problem**: Core travel mode filtering logic untested.
- **Recommendation**: Create `src/lib/travel-mode.test.ts`.

### TEST-Medium-5: `directory-sync/sanitize.ts` has no tests
- **File**: `src/lib/directory-sync/sanitize.ts`
- **Problem**: Security-critical function (credential masking) untested.
- **Recommendation**: Create `src/lib/directory-sync/sanitize.test.ts`.

### TEST-Medium-6: `ssh-agent-protocol.ts` has no tests
- **File**: `cli/src/lib/ssh-agent-protocol.ts`
- **Problem**: Binary protocol pure functions (8 functions) untested.
- **Recommendation**: Create `cli/src/__tests__/unit/ssh-agent-protocol.test.ts`.

### TEST-Medium-7: `secrets-config.ts` `getPasswordPath()` untested
- **File**: `cli/src/lib/secrets-config.ts:58-65`
- **Problem**: Path traversal prevention logic untested.
- **Recommendation**: Create `cli/src/__tests__/unit/secrets-config.test.ts`.

### TEST-Low-3: `parse-user-agent.test.ts` missing ChromeOS/Opera
- **File**: `src/lib/parse-user-agent.test.ts`
- **Problem**: `detectOS()` CrOS branch and `detectBrowser()` Opera branch untested.
- **Recommendation**: Add 2 test cases.

### TEST-Low-4: `webauthn-server.test.ts` missing `derivePrfSalt()` tests
- **File**: `src/lib/webauthn-server.test.ts`
- **Problem**: Only `getRpOrigin()` tested. `derivePrfSalt()` determinism and error cases untested.
- **Recommendation**: Add tests.

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 (1 func + 2 test) |
| Medium | 8 (3 func + 1 sec + 4 test) |
| Low | 3 (2 test + 1 sec) |

### ACCEPTED (修正不要)

- FUNC-High-1: Permissions-Policy — 未宣言の機能はデフォルト `self` で許可。ブロックなし。
- FUNC-Medium-5: v1 PUT history/update 別トランザクション — 内部 API (`/api/passwords/[id]`) と同一パターン。
- FUNC-Low-1: ImageCapture Safari — catch ブロックでハンドル済み。
- FUNC-Low-2: readString 関数名シャドウイング — ファイルスコープ内、実害なし。
- FUNC-Low-3: travel-mode-card busy 状態 — React バッチ処理で問題なし。

## 対応状況

(修正後に追記)
