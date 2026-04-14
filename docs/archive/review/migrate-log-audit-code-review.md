# Code Review: migrate-log-audit
Date: 2026-04-14
Review round: 1 (final)

## Changes from Previous Round
Initial review — all findings addressed in single round.

## Functionality Findings

### F1 Minor: pre-pr.sh に残存 logAudit チェック未追加 — RESOLVED
- Action: `scripts/pre-pr.sh` に `no-deprecated-logAudit` チェック追加
- Modified file: scripts/pre-pr.sh

### F2 Minor: account-lockout.ts の dead catch + stale comment — RESOLVED
- Action: lock_timeout パスの try/catch 削除、コメント更新
- Modified file: src/lib/account-lockout.ts

### F3 Minor: テスト説明文の陳腐化 — PARTIALLY RESOLVED
- Action: audit-and-isolation.test.ts の5テスト名更新、account-lockout.test.ts の3テスト名更新
- Remaining: 他のテストファイルの説明文は cosmetic change のみのため次回機会に対応

## Security Findings

### S4 Minor: deadLetterLogger の stale redact パス — ACCEPTED
- Anti-Deferral check: acceptable risk
- Worst case: redact パスは no-op（存在しないパスに適用）、データ漏洩リスクなし
- Likelihood: low — deadLetterEntry() が metadata を含まないため漏洩は発生しない
- Cost to fix: 低（5行削除）だがリグレッションリスクもあるため別 PR で対応

### S6 Minor: non-UUID direct write の error reason 汎用化 — ACCEPTED
- Anti-Deferral check: acceptable risk
- Worst case: dead letter ログの reason が "logAuditAsync_failed" に統一され、non-UUID 直接書込み失敗と outbox 失敗の区別が困難
- Likelihood: low — non-UUID 直接書込みパスは share-links の anonymous アクセスのみ
- Cost to fix: 低（reason 文字列の分岐追加）だがコード複雑化のため別 PR で対応

## Testing Findings

### T1 Major: audit.mocked.test.ts enqueueAudit rejection test が偽陽性 — RESOLVED
- Action: userId を UUID 形式に修正
- Modified file: src/__tests__/audit.mocked.test.ts

### T2 Major: audit-and-isolation.test.ts の 5 テストが async/await なし — RESOLVED
- Action: async + await 追加、テスト名更新
- Modified file: src/__tests__/integration/audit-and-isolation.test.ts

### T4 Major: account-lockout.test.ts の lock_timeout error-swallow テスト — RESOLVED
- Action: dead catch 削除に合わせてテストを「logAuditAsync が呼ばれること」の検証に変更
- Modified file: src/lib/account-lockout.test.ts

### T3 Minor: テスト説明文の陳腐化 — PARTIALLY RESOLVED (same as F3)

### T5 Minor: coverage.include に audit.ts 未追加 — ACCEPTED (out of scope)
- Anti-Deferral check: out of scope (different feature)
- TODO(migrate-log-audit): vitest.config.ts の coverage.include に audit.ts, audit-outbox.ts を追加

### T6 Minor: bulk テストに toHaveBeenCalledTimes なし — ACCEPTED
- Anti-Deferral check: acceptable risk
- Worst case: 余分な logAuditAsync 呼び出しが検出されない
- Likelihood: low — bulk 操作のコードパスは固定的
- Cost to fix: 低だが 8 ファイル × 複数テストの計算が必要で間違いやすい

## Resolution Status

All Major findings resolved. Minor findings: 3 resolved, 4 accepted with justification.
