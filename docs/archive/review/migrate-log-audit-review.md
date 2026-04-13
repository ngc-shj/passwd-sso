# Plan Review: migrate-log-audit
Date: 2026-04-14
Review round: 2

## Changes from Previous Round (Round 1 → 2)

Round 1 findings addressed:
- F1/S5/F4: tenantId in structured emit → `params.tenantId ?? null` pre-resolution
- F2: webhook-dispatcher TEAM scope → `userId: NIL_UUID`
- F3/T7: Test file lists expanded, audit-fifo-flusher.test.ts added
- S1: auth.ts → `await logAuditAsync` (NextAuth v5 async events)
- S2: dead letter sanitization — sanitized output only
- T1-T5: Test strategy rewritten with substeps 10a-10d
- T6: pre-pr.sh grep check added

Round 2 new findings addressed:
- F5: try/catch wraps entire body including resolveTenantId
- F6: TENANT scope userId:"system" decision documented explicitly
- F7: NOT an issue — AuditLog.userId is nullable, no FK
- S6 (M1): All 3 dead letter paths sanitized (not just catch block)
- G1: logAudit test blocks explicitly rewritten (not supplemented)
- G4/T4: Step 1 + Step 10a/10b in same commit
- T6 impl note: grep with `if/then` pattern for pipefail safety
- G2: NOT an issue — no auditLogger.enabled guard in code
- G3: Deferred to implementation (grep during Step 10d)

## Functionality Findings

### F1 Major: structured JSON emit に tenantId が欠落 — 明示的決定が必要
- Problem: 計画の Step 1 で `logAuditAsync` に `auditLogger.info` emit を移植するが、tenantId を含めるか否かが未定義。現行 `logAudit` も tenantId を emit していないが、移行を機に方針を明確にすべき。
- Impact: SIEM 等の外部転送先でテナント別フィルタリングが不完全になる。
- Recommended action: MF1 に「tenantId を structured JSON に含めるか否かを明示的に決定」を追記。含める場合は `resolveTenantId()` の結果を emit に渡す。

### F2 Major: webhook-dispatcher.ts TEAM scope の `userId: "system"` + tenantId 欠落 → dead letter
- Problem: `webhook-dispatcher.ts:231` の TEAM scope 呼び出しは `userId: "system"` (非UUID) かつ `tenantId` なし。`logAuditAsync` の non-UUID userId 分岐では `params.tenantId ?? null` が null → dead letter に落ちる。
- Impact: `WEBHOOK_DELIVERY_FAILED` (TEAM) イベントが監査ログに記録されない。
- Recommended action: TEAM scope 呼び出しに `tenantId` を追加するか、`userId` を `NIL_UUID` に変更して通常の outbox パスを使う。MF6 の作業範囲に含める。

### F3 Minor: テストファイル網羅性の不完全
- Problem: logAuditBatch を参照するテストファイル（bulk-*.route.test.ts 等）が計画の Step 10 に明示されていない。
- Recommended action: Step 10 に「logAuditBatch を参照する全テストファイル」を明示的にリストアップ。

### F4 Minor: emit-first と tenantId 解決の順序矛盾
- Problem: MN4（structured emit は同期的）と tenantId を emit に含める場合の矛盾。
- Recommended action: 「structured emit は tenantId を含まない（emit first 優先）」 or 「emit は tenantId 解決後（MN4 を "outbox 成功に非依存" と再解釈）」を明記。

## Security Findings

### S1 Major: AUTH_LOGIN/AUTH_LOGOUT の `void logAuditAsync` — Graceful shutdown 時の監査消失
- Problem: `void logAuditAsync(params)` は await されないため、プロセス終了直前に発火した場合、outbox 書き込みが完了しないまま終了する。認証イベントは最も監査価値の高い操作。
- Impact: 攻撃者のアカウント乗っ取り後のフォレンジック品質が低下。SOC 2 / ISO 27001 の監査証跡完全性違反。
- Recommended action: NextAuth `events` callback は async function を受け付ける。`void` ではなく `await` に変更するか、SIGTERM ハンドラで保留中 outbox 書き込み完了を保証する仕組みを計画に追記。

### S2 Major: dead letter ログへの raw `params.metadata` 出力 — sanitize 前データ漏洩
- Problem: `deadLetterLogger.warn({ auditEntry: params, ... })` は `sanitizeMetadata()` 適用前の生 `metadata` を出力する。
- Impact: 業務データが stdout 経由でログ集約基盤に流出するリスク。
- Recommended action: dead letter 書き込み前に `sanitizeMetadata(params.metadata)` を適用するか、出力を `{ scope, action, userId, reason }` に限定。Step 1 で明示的にカバー。

### S3 Minor: `internal/audit-emit` の never-throws 保証がテスト未担保
- Problem: 動的 action エンドポイントで `logAuditAsync` が想定外に throw した場合 500 を返す可能性。
- Recommended action: MF2 の never-throws をユニットテストで担保。

### S4 Minor: concurrent enqueueAudit での RLS session-local 設定の並行安全性
- Problem: `set_config(..., true)` (is_local=true) が Prisma `$transaction` のコネクションプール内で適切にリセットされるか未検証。
- Recommended action: インテグレーションテストで concurrent enqueueAudit が tenantId を混入しないことを検証。

### S5 Minor: structured JSON emit に tenantId 欠落 (F1 と重複)
- Merged with F1.

## Testing Findings

### T1 Critical: `logAuditAsync` の auditLogger emit テストがゼロ
- Problem: 現在の `audit.mocked.test.ts` は `logAudit` のみテスト。`logAuditAsync` の structured JSON emit、エラーキャッチ、never-throws をテストするケースが存在しない。
- Impact: MF1/MF2 の回帰を検出不能。
- Recommended action: Step 10 に以下を追加：
  1. `logAuditAsync` が `auditLogger.info` を呼び出すこと
  2. `enqueueAudit` が throw しても `logAuditAsync` が throw しないこと
  3. `auditLogger.info` が throw しても `logAuditAsync` が throw しないこと

### T2 Critical: MF1 実装が現コードに存在せず — テスト駆動の順序を計画に明記すべき
- Problem: 現在の `logAuditAsync` (L161-203) は `auditLogger.info` を呼び出す行がない。計画の Step 1 で追加する予定だが、テスト更新 (Step 10) との順序関係が不明確。
- Impact: Step 1 が正しく実装されたかの検証手段がない。
- Recommended action: Step 1 の直後にテスト更新を配置するか、TDD 的にテストを先に書くことを計画に明記。

### T3 Major: `mockEnqueueAudit` の呼び出しアサーション欠落
- Problem: `audit.mocked.test.ts` の `mockEnqueueAudit` は `vi.hoisted` で定義済みだが、どのテストも `expect(mockEnqueueAudit)` でアサートしていない。
- Recommended action: 書き直し時に正常系で `expect(mockEnqueueAudit).toHaveBeenCalled()` を追加。

### T4 Major: `audit-fifo-flusher.test.ts` の「propagates rejection」テストが MF2 と矛盾
- Problem: L153-168 のテストは `logAuditAsync` が reject を伝播することを `rejects.toThrow` でアサート。MF2「never throws」と正反対。
- Impact: MF2 を正しく実装するとこのテストが fail する。
- Recommended action: Step 10 に「`rejects.toThrow` を `not.rejects` + `deadLetterLogger` 呼び出しアサーションに書き換え」を明記。

### T5 Major: `audit-and-isolation.test.ts` がモック中心で実 outbox 書き込みを未検証
- Problem: `vi.mock("@/lib/audit", ...)` で `logAudit` をモックに差し替え、呼び出しのみアサート。実際の outbox 動作は未検証。
- Recommended action: Step 10 に「モックを `logAuditAsync` に置き換えるが、outbox 書き込みの実検証は db-integration テストへの昇格を検討」と明記。

### T6 Minor: grep 検証が手動依存で CI 未組み込み
- Recommended action: pre-pr.sh 等に残留 `logAudit(` 検出を追加。

### T7 Minor: `audit-fifo-flusher.test.ts` が Testing strategy テーブルに記載漏れ
- Recommended action: テーブルに追加し、変更内容（propagation 反転、auditLogger emit 追加）を明記。

## Adjacent Findings
- [Adjacent from T2] RT2: `logAuditAsync` の型シグネチャは変わらないが never-throws 保証という仕様変化が ~152 ファイルのレビューで漏れるリスク — Functionality expert scope

## Quality Warnings
None (local LLM pre-screening found no issues)

## Recurring Issue Check

### Functionality expert
- R1 (Shared utility reimplementation): Checked — no issue (logAuditAsync is the existing shared utility)
- R2 (Constants hardcoded): Checked — MF10 addresses string literal → constant migration
- R3 (Pattern propagation): Checked — all ~160 call sites covered
- R4 (Event dispatch gaps): Checked — F2 found webhook-dispatcher TEAM scope issue
- R5 (Missing transactions): N/A — migration keeps calls outside transactions
- R6 (Cascade delete orphans): N/A — no deletes
- R7 (E2E selector breakage): N/A — no UI changes
- R8 (UI pattern inconsistency): N/A — no UI changes
- R9 (Transaction boundary for fire-and-forget): Checked — auth.ts `void logAuditAsync` is intentional, not inside tx
- R10 (Circular module dependency): Checked — lazy import in webhook-dispatcher preserved
- R11 (Display group ≠ subscription group): N/A — no event grouping changes
- R12 (Enum/action group coverage gap): N/A — no new audit actions
- R13 (Re-entrant dispatch loop): N/A — no dispatch changes
- R14 (DB role grant completeness): N/A — no new DB roles
- R15 (Hardcoded env values in migrations): N/A — no migrations
- R16 (Dev/CI environment parity): N/A — no DB role/privilege tests

### Security expert
- R1-R5: Not applicable (no raw queries, XSS, CSRF, auth bypass, IDOR)
- R6 (Sensitive data in logs): S2 — raw params.metadata in dead letter logs
- R7-R8: Not applicable (no crypto, no access control changes)
- R9 (Security misconfiguration): S4 — RLS session-local parallel safety
- R10 (Audit/logging gaps): S1, S5 — auth event fire-and-forget, tenantId in emit
- R11-R14: Not applicable
- R15 (Business logic vulnerabilities): S1 — audit completeness violation
- R16: Not applicable
- RS1 (Multi-tenant isolation): S4 — concurrent enqueueAudit tenantId contamination
- RS2 (E2E encryption integrity): Not applicable
- RS3 (Outbox atomicity): Addressed by plan design, residual risk is S1

### Testing expert
- R1 (False-positive tests): T5 — mock-only assertion in audit-and-isolation
- R2 (Missing tests for critical path): T1, T2 — logAuditAsync emit untested
- R3 (Flaky tests): No issue
- R4 (Mock inconsistency): T4 — propagation spec contradicts MF2
- R5 (Coverage gaps): T3 — outbox assertion missing
- R6-R8: No issue
- R9 (CI integration): T6 — grep verification manual only
- R10 (Integration test as unit test): T5 — audit-and-isolation uses mocks
- R11-R15: No issue
- R16 (Documentation-test mismatch): T7 — testing strategy table incomplete
- RT1 (Write-read consistency): T5 — mock write, mock assert
- RT2 (Type checking): Adjacent finding — never-throws spec change across 152 files
- RT3 (Test validation): T4 — existing test contradicts plan requirement
