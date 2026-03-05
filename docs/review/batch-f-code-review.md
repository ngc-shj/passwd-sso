# Code Review: batch-f
Date: 2026-03-06T10:00:00+09:00
Review rounds: Session 4 Round 1-2 (Final)
Reviewers: 3 expert agents (functional, security, test)

## Review Sessions

### Session 1 (previous conversation): Rounds 1-4
Initial implementation review — all findings resolved.

### Session 2 (previous conversation): Rounds 1-4
Full codebase re-review after Session 1 fixes were committed.

### Session 3 (previous conversation): Rounds 1-2
Post-fix review after 4 additional commits (0d6dad2, f9adb4c, a79fac7, 1798db9).

### Session 4 (this conversation): Rounds 1-2

Full codebase re-review — fresh session.

- Round 1: 14 findings (5 func, 1 sec, 8 test) → 5 accepted, 9 fixed
- Round 2: All 3 experts — 指摘なし (zero findings)

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

### FUNC-High-2: Okta filter URL encoding
- 対応: `URLSearchParams` を使用して RFC 準拠のパーセントエンコーディングに修正
- 修正ファイル: `src/lib/directory-sync/okta.ts:98-103`

### FUNC-Medium-1: env command fail-fast
- 対応: `continue` → `process.exit(1)` に変更。CI/CD パイプラインで不完全な env 出力を防止
- 修正ファイル: `cli/src/commands/env.ts:70`

### FUNC-Medium-2: authenticate/options derivePrfSalt 例外処理
- 対応: register/options と同様に try/catch で保護。PRF 未設定時も認証は継続
- 修正ファイル: `src/app/api/webauthn/authenticate/options/route.ts:76-82`

### FUNC-Medium-3: validateApiKey expiresAt null ガード
- 対応: `!key.expiresAt ||` ガードを追加
- 修正ファイル: `src/lib/api-key.ts:100`

### FUNC-Medium-4: derToSshEcdsa dead variable
- 対応: 到達不能な `seqLen = 0` 代入を削除
- 修正ファイル: `cli/src/lib/ssh-key-agent.ts:220`

### SEC-Low-1: env command BLOCKED_KEYS チェック
- 対応: `BLOCKED_KEYS` を共有モジュール (`cli/src/lib/blocked-keys.ts`) に抽出し、`env.ts` と `run.ts` 両方で使用
- 修正ファイル: `cli/src/lib/blocked-keys.ts` (新規), `cli/src/commands/env.ts:18,63-66`, `cli/src/commands/run.ts:17`

### TEST-High-3: auth-or-token API key テスト追加
- 対応: API key 成功・失敗・scope 不足・非 api_ プレフィックスの 4 テスト追加
- 修正ファイル: `src/lib/auth-or-token.test.ts`

### TEST-High-4: api-key.ts テスト作成
- 対応: `parseApiKeyScopes()` (5 tests) + `hasApiKeyScope()` (3 tests) のテスト作成
- 修正ファイル: `src/lib/api-key.test.ts` (新規)

### TEST-Medium-4: filterTravelSafe テスト作成
- 対応: travel mode ON/OFF、全 unsafe、空配列の 4 テスト作成
- 修正ファイル: `src/lib/travel-mode.test.ts` (新規)

### TEST-Medium-5: sanitizeSyncError テスト作成
- 対応: Error/string/object/null/undefined、Bearer/SSWS/token/client_secret マスク、URL クエリ除去、切り詰めの 11 テスト作成。テスト中に `JSON.stringify(undefined)` → `undefined` のバグを発見・修正
- 修正ファイル: `src/lib/directory-sync/sanitize.test.ts` (新規), `src/lib/directory-sync/sanitize.ts:56-58`

### TEST-Medium-6: ssh-agent-protocol テスト作成
- 対応: readUint32, writeUint32, readString, encodeString, frameMessage, buildFailure, buildIdentitiesAnswer, buildSignResponse の 13 テスト作成
- 修正ファイル: `cli/src/__tests__/unit/ssh-agent-protocol.test.ts` (新規)

### TEST-Medium-7: getPasswordPath テスト作成
- 対応: 正常系 + パストラバーサル防止の 6 テスト作成
- 修正ファイル: `cli/src/__tests__/unit/secrets-config.test.ts` (新規)

### TEST-Low-3: ChromeOS/Opera テスト追加
- 対応: CrOS UA → "ChromeOS"、OPR/ UA → "Opera" の 2 テスト追加
- 修正ファイル: `src/lib/parse-user-agent.test.ts`

### TEST-Low-4: derivePrfSalt テスト追加
- 対応: 決定論的出力、ユーザー別ソルト、PRF_SECRET 未設定、長さ不正、RP_ID 未設定の 5 テスト追加
- 修正ファイル: `src/lib/webauthn-server.test.ts`

---

## Session 4 Round 2 (Final)

日時: 2026-03-06
レビュー回数: 2回目

### 機能観点の指摘

指摘なし — Round 1 の全修正が正しく実装されていることを確認。

### セキュリティ観点の指摘

指摘なし — BLOCKED_KEYS 共有モジュール化が適切に実装されていることを確認。

### テスト観点の指摘

指摘なし — 全 52 件の新規テストが適切にカバレッジを確保していることを確認。

### 最終テスト結果

- Vitest: 352 files, 3,578 tests — all passing
- CLI build: 0 errors
- ESLint: 0 errors, 10 warnings (既存の未使用変数)
