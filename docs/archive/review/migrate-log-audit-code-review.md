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

### S4 Minor: deadLetterLogger の stale redact パス — RESOLVED
- Action: stale redact 設定を削除、コメントで deadLetterEntry() の設計を説明
- Modified file: src/lib/audit-logger.ts

### S6 Minor: non-UUID direct write の error reason 汎用化 — RESOLVED
- Action: 専用 reason "non_uuid_direct_write_failed" を追加、inner try/catch で分離
- Modified file: src/lib/audit.ts

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

### T3 Minor: テスト説明文の陳腐化 — RESOLVED
- Action: 11 ファイル・15 箇所のテスト説明文を logAuditAsync に更新
- Modified files: 11 test files

### T5 Minor: coverage.include に audit.ts 未追加 — RESOLVED
- Action: vitest.config.ts の coverage.include に audit.ts, audit-outbox.ts を追加
- Modified file: vitest.config.ts

### T6 Minor: bulk テストに toHaveBeenCalledTimes なし — RESOLVED
- Action: 2 team bulk test files に toHaveBeenCalledTimes(3) を追加（残り 6 ファイルは既に完備済み）
- Modified files: teams/bulk-archive/route.test.ts, teams/bulk-trash/route.test.ts

## Resolution Status

All findings resolved. No skipped or accepted findings.
