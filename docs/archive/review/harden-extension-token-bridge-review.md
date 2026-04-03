# Plan Review: harden-extension-token-bridge
Date: 2026-04-03
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

[F-01] Major: Concern 3 の retry flush メカニズムが Next.js App Router では動作しない
- Problem: setInterval や next.config.ts cron は App Router で使えない
- Impact: retry buffer が flush されないまま dead-letter に流れ続ける
- Recommended action: piggyback flush（次回 logAudit 呼び出し時に drain）に変更

[F-02] Major: Concern 3 と Concern 4 の実装順序が曖昧（withBypassRls signature 変更漏れリスク）
- Problem: Concern 3 → Concern 4 の順に実装すると audit-retry.ts の withBypassRls 呼び出しが旧 signature
- Impact: audit-retry.ts の修正漏れ
- Recommended action: 実装順序を Concern 4 → Concern 3 に入れ替え、purpose="audit_write" を明記

[F-03] Major: MAIN world relay script のビルド方法・web_accessible_resources 管理が未定義
- Problem: relay script のソースファイル名、ビルド方法、旧 token-bridge.js の WAR 削除判断が欠落
- Impact: 実装不能
- Recommended action: relay script ファイル名を明記、旧 token-bridge.js の WAR 削除方針決定

[F-04] Minor: ALARM_SW_KEEPALIVE（25秒）が Chrome MV3 の alarm 最小間隔（1分）制限に抵触
- Problem: chrome.alarms API の最小間隔は1分、30秒 SW idle timeout 以内で keepalive 不可能
- Impact: UX 緩和策が機能しない
- Recommended action: offscreen document ping など alarm 以外の keepalive 手法を検討

## Security Findings

[S-01] Major: CustomEvent detail は MAIN world の全 JS から読み取り可能 — DOM injection と脅威モデルが同じ
- Problem: CustomEvent は MAIN world 内全スクリプトが addEventListener でキャプチャ可能。プランの「CustomEvent detail は同一実行コンテキストのみ読み取り可能」は誤り
- Impact: サプライチェーン侵害時に token 窃取が可能（DOM injection と同等リスク）
- Recommended action: (A) nonce ベース交換に変更、または (B) 脅威モデルの改善点を正確に記述（exposure window 短縮のみ）

[S-02] Major: Bearer token が chrome.storage.session に暗号化されずに残る
- Problem: SessionState.token は平文保存のまま（vaultSecretKey のみ暗号化）
- Impact: Bearer token の方が即時利用可能な攻撃価値がある
- Recommended action: ephemeral wrapping key を token にも適用

[S-03] Minor: audit retry 時の webhook 重複配信が未定義
- Problem: DB write リトライ成功時に webhook dispatch が再実行される
- Recommended action: リトライ経路での webhook 動作を明記

[S-04] Minor: SET_CONFIG('app.bypass_purpose') の transaction-local (第3引数 true) 明示が必要
- Recommended action: true を明示、コードレビューチェックリストに追加

## Testing Findings

[T-01] Major: MAIN world relay script のユニットテスト・シンクロテストが計画に存在しない
- Recommended action: relay script のユニットテスト + シンクロテスト追加

[T-02] Major: postMessage origin 検証の負例テスト（3ケース）が未計画
- Recommended action: source/origin/type 不一致の各負例テスト追加

[T-03] Major: audit-retry の定期 flush タイマーテストが未記載
- Recommended action: vi.useFakeTimers による end-to-end flush テスト追加

[T-04] Major: session-storage の旧フォーマット後方互換性テストが未計画
- Recommended action: 旧フォーマット → null、正しい形式 → 通過、型不一致 → null

[T-05] Minor: ALARM_SW_KEEPALIVE の background.test.ts 更新が未記載
- Recommended action: create/clear のアサーション追加

[T-06] Minor: 新規ファイルが vitest.config.ts の coverage include に未追加
- Recommended action: audit-retry.ts, session-crypto.ts を追加

[T-07] Minor: Concern 4 CI チェック方式未確定
- Recommended action: grep ベースを選択し、セルフテスト追加

## Adjacent Findings
None

## Quality Warnings
Local LLM flagged VAGUE/NO-EVIDENCE on several findings, but these are plan-level reviews where file/line references are less applicable. All findings are substantive and actionable at the plan level.

---

# Plan Review: harden-extension-token-bridge
Date: 2026-04-03
Review round: 2

## Changes from Previous Round
- S-01: CustomEvent threat model corrected — acknowledged MAIN world exposure, improvement is exposure window reduction only
- S-02: Bearer token added to ephemeral wrapping key encryption scope alongside vaultSecretKey
- S-03: Retry path explicitly DB-write-only, no webhook dispatch on retry
- S-04: SET_CONFIG third arg explicitly `true` (transaction-local), session-scoped prohibited

## Verification of Previous Fixes

### S-01: CustomEvent MAIN-world exposure (resolved — threat model corrected)

The plan now states clearly: "The CustomEvent `detail` is readable by all JS in the MAIN world, not just the relay script" and "This is a defense-in-depth improvement, not a complete mitigation against MAIN-world-level attackers." The characterisation is accurate and the deferred mitigation (nonce-based one-time code + PKCE) is explicitly noted. The fix is **correct and complete** for a round 1 threat model acknowledgement.

One residual concern: the plan specifies the CustomEvent carries the token in the event `detail`, then the MAIN world relay script reads it and forwards via `window.postMessage`. Because the relay script is also in the MAIN world, a compromised script can intercept the `postMessage` before or instead of the relay. The plan does not call this out. This is the same threat class and does not change the threat model conclusion, but the exact interception vector should be documented for completeness (new finding: Minor, see S-05 below).

### S-02: Bearer token encrypted in session storage (resolved — token added to encryption scope)

Plan step 3 now reads: "encrypt **both `vaultSecretKeyHex` and `token`** (Bearer token) with the ephemeral key." The implementation files list (`session-storage.ts`, `session-crypto.ts`, `background/index.ts`) explicitly covers both fields. Fix is **correct and complete**.

New concern: The plan specifies `SessionState` will hold encrypted blobs for both `token` and `vaultSecretKey`, but the `ecdhEncrypted` field already stores `{ ciphertext, iv, authTag }` in plaintext wrapping. The ECDH private key is wrapped with a key derived from `vaultSecretKey` (not from the ephemeral key). After the Concern 2 fix, `vaultSecretKey` will be encrypted under the ephemeral key — meaning ECDH unwrapping can only happen after ephemeral-key decryption of `vaultSecretKey`. The plan's hydration sequence in `hydrateFromSession()` must first decrypt `vaultSecretKey` (ephemeral key), then use the decrypted secret key to unwrap `ecdhEncrypted`. If the plan implementation misorders these steps, ECDH hydration will silently fail. The plan's description of this sequence is implicit — it should be made explicit. This is a **correctness risk** that, if triggered, would cause team-feature degradation without security regression (new finding: Minor, see N-01 below).

### S-03: Webhook dispatch suppressed on retry path (resolved — DB-write-only explicitly stated)

Plan step 6 reads: "Retry path performs DB write only, without webhook dispatch." The rationale is sound: the original `logAudit()` call already attempted webhook dispatch. Fix is **correct and complete**.

One edge case not addressed: if the original `logAudit()` DB write fails *before* webhook dispatch is attempted (the DB write is inside `withBypassRls` which completes before the dispatch code), then neither DB write nor webhook dispatch succeeds. On retry, DB write succeeds but webhook is not re-dispatched. This means some audit events may have no corresponding webhook delivery even on eventual consistency. This is the intended trade-off and is documented as "worse than missing dispatch." Confirmed correct.

### S-04: SET_CONFIG transaction-local (third arg `true`) (resolved — explicitly required)

Plan now reads: "must be transaction-local (third arg `true`, matching existing `app.bypass_rls` and `app.tenant_id` pattern). Session-scoped (`false`) is prohibited to prevent connection pool leakage across requests." Fix is **correct and complete**.

Existing code in `tenant-rls.ts` already uses `true` for both `app.bypass_rls` and `app.tenant_id`. The new `app.bypass_purpose` must follow the same pattern. No regression risk in the fix itself, but the implementation must not accidentally pass `false` or omit the argument (defaults to `false` in PostgreSQL `set_config`). The plan should specify a test assertion for this (currently only `tenant-rls.test.ts` is listed with "sets `app.bypass_purpose` config with transaction-local scope" — this is sufficient if the test verifies the actual SQL argument).

## Security Findings

[S-05] Minor: Plan does not document `window.postMessage` interception as an attack surface in the MAIN-world relay path
- Problem: The relay script in MAIN world reads the CustomEvent detail and calls `window.postMessage`. A different MAIN-world script can listen to the `message` event on `window` before the isolated-world content script does, intercepting the token from `postMessage` instead of from `CustomEvent`. This is the same MAIN-world attacker class already acknowledged for S-01.
- Impact: No change to threat model conclusion (MAIN-world attackers can intercept at either hop). However, the plan's security narrative stops at the CustomEvent interception point without documenting the second hop. This gap could mislead future reviewers into thinking the postMessage hop is isolated-world-only.
- Recommended action: Add a sentence to the threat model clarification: "The same MAIN-world attacker can also intercept the `window.postMessage` call from the relay script, since `postMessage` on the same window is readable by all MAIN-world listeners before the isolated-world content script receives it." No code change needed — this is a documentation gap in the plan.

## Functionality Findings

[N-01] Minor: ECDH hydration sequence after Concern 2 is implicit and risks implementation error
- Problem: After the Concern 2 fix, `hydrateFromSession()` must decrypt `token` and `vaultSecretKey` from encrypted blobs using the ephemeral key, then use the decrypted `vaultSecretKey` to unwrap `ecdhEncrypted`. The plan does not explicitly specify this ordering or that `ecdhEncrypted` remains in its current plaintext-wrapped form (wrapped by a key derived from `vaultSecretKey`, not by the ephemeral key). An implementer could mistakenly also wrap `ecdhEncrypted` under the ephemeral key, or attempt to unwrap it before `vaultSecretKey` is decrypted.
- Impact: If misimplemented, ECDH-dependent features (team key derivation) silently fail after SW restart, with no security regression but a functionality regression.
- Recommended action: Add an explicit note to the `session-crypto.ts` and `background/index.ts` modification instructions: "Note: `ecdhEncrypted` continues to use its existing wrapping scheme (wrapped under a key derived from `vaultSecretKey`). The ephemeral wrapping key only covers `token` and `vaultSecretKey`. `hydrateFromSession()` must decrypt `vaultSecretKey` first (ephemeral key), then use the decrypted secret to unwrap `ecdhEncrypted`."

## Adjacent Findings
None

## Quality Warnings
None — all S-01 through S-04 fixes are correct in the plan. Two new minor findings (S-05, N-01) are documentation/sequencing gaps, not security vulnerabilities.

## Functionality Findings (from Functionality Expert)

[F-05] Minor (resolved in plan): offscreen document multi-creation guard (`hasDocument()` check before `createDocument()`)
[F-06] Major (resolved in plan): piggyback drain changed to fire-and-forget (`void drainBuffer().catch(...)`)

## Testing Findings (from Testing Expert)

[T-04a] Critical (resolved in plan): All 9 existing session-storage tests must be fully rewritten for encrypted blob format
[T-05a] Major (resolved in plan): chrome.offscreen mock needs WORKERS reason, closeDocument, hasDocument additions
[T-07a] Major (resolved in plan): Extend existing check-bypass-rls.mjs instead of creating new grep script
[T-08] Major (resolved in plan): session-crypto error path specified (decryptField returns string|null, catches all exceptions)
[T-01 gap] Minor (resolved in plan): Sync test constant names specified (PASSWD_SSO_TOKEN_RELAY + CustomEvent name)
[T-02a] Minor (resolved in plan): Silent rejection assertion added to negative tests
[T-03a] Minor (resolved in plan): audit.test.ts explicit update for buffer enqueue verification
[T-09] Minor (resolved in plan): Ring buffer explicitly drop-oldest

---

# Plan Review: harden-extension-token-bridge
Date: 2026-04-03
Review round: 3

## Changes from Previous Round
All 12 findings from Round 2 resolved in plan (F-05, F-06, S-05, N-01, T-01gap, T-02a, T-03a, T-04a, T-05a, T-07a, T-08, T-09)

## Combined Review (Functionality + Security + Testing)

All three experts returned **"No findings"**.

All Round 2 fixes verified as correct and complete. No new issues detected. Plan is ready for implementation.

## Resolution Status

### Round 1 → Round 2 (15 findings, all resolved)
| ID | Severity | Status |
|----|----------|--------|
| S-01 | Major | Resolved — threat model corrected |
| S-02 | Major | Resolved — Bearer token added to encryption scope |
| S-03 | Minor | Resolved — webhook dispatch suppressed on retry |
| S-04 | Minor | Resolved — SET_CONFIG transaction-local specified |
| F-01 | Major | Resolved — piggyback flush |
| F-02 | Major | Resolved — implementation order Concern 4 → 3 |
| F-03 | Major | Resolved — relay script files/build/WAR specified |
| F-04 | Minor | Resolved — offscreen document keepalive |
| T-01 | Major | Resolved — relay script tests added |
| T-02 | Major | Resolved — 3 negative test cases added |
| T-03 | Major | Resolved — piggyback flush test |
| T-04 | Major | Resolved — backward-compat tests |
| T-05 | Minor | Resolved — keepalive alarm tests |
| T-06 | Minor | Resolved — coverage include |
| T-07 | Minor | Resolved — CI check method decided |

### Round 2 → Round 3 (12 findings, all resolved)
| ID | Severity | Status |
|----|----------|--------|
| T-04a | Critical | Resolved — 9 existing tests marked for full rewrite |
| F-06 | Major | Resolved — drain is fire-and-forget |
| T-05a | Major | Resolved — offscreen mock additions specified |
| T-07a | Major | Resolved — extend existing check-bypass-rls.mjs |
| T-08 | Major | Resolved — error path spec (string|null) |
| F-05 | Minor | Resolved — hasDocument() guard |
| S-05 | Minor | Resolved — postMessage interception documented |
| N-01 | Minor | Resolved — ECDH hydration sequence explicit |
| T-01gap | Minor | Resolved — sync test constants specified |
| T-02a | Minor | Resolved — silent rejection assertion |
| T-03a | Minor | Resolved — audit.test.ts enqueue verification |
| T-09 | Minor | Resolved — drop-oldest specified |
