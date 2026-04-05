# Plan Review: codebase-audit-fixes
Date: 2026-04-05T00:00:00+09:00
Review round: 2 (final)

## Changes from Previous Round
Initial review

## Functionality Findings

### F-1 [Major]: parseAuditLogParams のエラーハンドリング契約が未定義
- Problem: バリデーション失敗時に throw するのか戻り値で返すのか未規定。throw する場合7つの呼び出し側全てに catch が必要。
- Impact: 実装時に一貫しない対応が入る恐れ
- Recommended action: エラーコントラクトをプランに明記

### F-3 [Minor]: 既存の cursor null チェックパターンの維持確認
- Problem: `...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})` パターンが centralized 後も機能するか
- Recommended action: 実装時の確認事項として記録

## Security Findings

### S-2 [Minor]: CUID v1 と UUID の混在によるバリデーターのリグレッションリスク
- Problem: UUID validator が CUID v1 形式を弾く可能性
- Recommended action: 両方を受け入れるか緩いサニタイズに留める

### S-3 [Minor]: Report-To include_subdomains 削除 — 確認済み、計画通り
### S-4 [Minor]: X-XSS-Protection 削除 — 確認済み、計画通り

## Testing Findings

### T-1 [Major]: audit-query-cursor.test.ts が既存の audit-query.test.ts と重複
- Problem: parseAuditLogParams のテストは既存ファイルに存在。新規ファイル作成は重複。
- Recommended action: 既存の audit-query.test.ts にカーソル検証ケースを追加

### T-3 [Minor]: agent-decrypt IPC テストのスコープが不明確
- Problem: 既存の unit test との役割分担が明記されていない
- Recommended action: 統合テストの範囲（実ソケット通信 vs モック）を明記

## Merged Findings (Cross-expert)

### M-1 [Major]: MCP authorize の redirect_uri 検証タイミング・重複・テスト不足
- Sources: F-2, S-1, T-2
- Problem: authorize/route.ts が認証済みパスでも redirect_uri を検証せずに consent へリダイレクト。早期検証を追加すると consent page との二重 DB lookup。自動テストなし。
- Impact: RFC 6749 §10.15 違反リスク、DB 負荷、リグレッション未検出
- Recommended action: authorize route に単一の検証ステップを追加（認証済み/未認証両方）。consent page との重複扱いを明記。自動テストを追加。

## Adjacent Findings
None

## Quality Warnings
- T-3: [VAGUE] — 具体的なファイル・行番号なし。テスト範囲を明記する方向で対応。
- S-2: [NO-EVIDENCE] — UUID regex がどこで定義されているか未確認。ただし新規追加予定のため計画段階の指摘として有効。

## Round 2 Resolution

All Major findings resolved in plan update:
- F-1 → cursorInvalid field approach (no throw, no call-site changes needed beyond flag check)
- M-1 → Both auth paths validated, consent page kept as defense-in-depth, auto tests added
- T-1 → Tests merged into existing audit-query.test.ts
- S-2 → Cursor regex now accepts both UUIDv4 and CUID v1
- T-3 → IPC test explicitly scoped as real process fork

Round 2: All experts report "No critical/major findings". Plan review complete.
