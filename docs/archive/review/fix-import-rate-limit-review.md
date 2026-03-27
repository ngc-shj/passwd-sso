# Plan Review: fix-import-rate-limit
Date: 2026-03-28
Review round: 2 (Option 2 — Bulk API endpoint)

## Changes from Previous Round
Complete redesign from Option 1 (header-based rate limit relaxation) to Option 2 (bulk API endpoint).
Option 1 was rejected due to structural security flaw: client-controlled header selecting privileged rate limit.

## Functionality Findings

### F-1 [Major] `ENTRY_BULK_IMPORT` が Prisma schema / audit 定数に未定義
- **Problem:** プランは `ENTRY_BULK_IMPORT` を監査アクションとして使うが、Prisma の `AuditAction` enum にも `AUDIT_ACTION` 定数にも存在しない。マイグレーションが必要。
- **Impact:** TypeScript コンパイルエラー。ビルド不可。
- **Recommended action:** Prisma schema にマイグレーション追加。`audit.ts` の定数・グループ・テストにも追加。Critical Files に含める。

### F-2 [Major] チームインポートの `isFavorite` 処理がプランに未記載
- **Problem:** チームのfavoriteはjoinテーブル経由（個別 PUT `/api/teams/[teamId]/passwords/[id]/favorite`）。バルクAPI内で一括処理するロジックが設計されていない。
- **Impact:** チームインポートでfavoriteが無視される。
- **Recommended action:** バルクAPI内でfavorite toggleを呼ぶか、プランに「チームバルクインポートではisFavoriteは無視、後で手動設定」と明記。

### F-3 [Major] 429 リトライ時の進捗カウント・failedCount の仕様不明確
- **Problem:** リトライ中に onProgress が重複呼出されるリスク。リトライ全失敗時の failedCount 加算ロジックが未定義。
- **Recommended action:** onProgress はチャンク処理確定後に1回のみ呼ぶ。失敗チャンクは chunk.length 分を failedCount に加算。

### F-4 [Minor] `withUserTenantRls` のトランザクション境界が不明確
- **Problem:** withUserTenantRls を1回呼び、内部で全エントリをループする設計が明示されていない。
- **Recommended action:** 実装パターンを明示。

## Security Findings

### S-1 [Major] バルクAPIと通常APIのレートリミッターが独立
- **Problem:** ユーザーが `/api/passwords` (30件/min) と `/api/passwords/bulk-import` (1,500件/min相当) を並行利用可能。合算制限がない。
- **Impact:** 実効レートが設計意図を超える可能性。
- **Recommended action:** インポートは正当なユースケースのため許容範囲と判断するが、プランに「合算制限は設けない。理由: インポートはセッション認証限定の一時的な操作であり、通常利用との並行は想定される正当なユースケース」と明記して設計意図を記録。

### S-2 [Major] folder/tag チェックと create の TOCTOU
- **Problem:** 事前一括チェック後にループで create すると、チェックと実行の間に tag/folder が削除される可能性。
- **Impact:** 所有権の一貫性保証が単一エントリ版より弱い。
- **Recommended action:** 各エントリごとに folder/tag チェック + create を実行（既存の単一 POST と同様）。事前一括チェックは行わない。

### S-3 [Minor] 失敗レスポンスの情報漏洩リスク
- **Problem:** 失敗エントリの詳細理由を返すと、tag/folder ID の存在確認に悪用される可能性。
- **Recommended action:** failedCount のみ返し、個別の失敗理由は含めない。

### S-4 [Minor] チーム用エンドポイントの認証方式が未明示
- **Problem:** Step 3 が「Step 2と同様」とだけ記載。実装者が誤って authOrToken を使うリスク。
- **Recommended action:** Step 3 に「`auth()` のみ使用」を明記。

## Testing Findings

### T-1 [Critical] チーム用バルクインポートAPIのテストケースが未定義
- **Problem:** Step 6 にチーム用テストファイルのケースが一切ない。チーム権限チェック、teamId 付きRLキーの検証が欠落。
- **Recommended action:** チーム用テストケースを明示（正常系 + 権限エラー + RL）。

### T-2 [Major] クライアント側テストの response() ヘルパーがバルクAPIレスポンス形式に未対応
- **Problem:** 既存 `response()` は `json: async () => []` を返す。バルクAPIは `{ success, failed }` を返す。
- **Recommended action:** `bulkResponse(ok, success, failed)` ヘルパーを追加。

### T-3 [Major] rate-limit モックパターンが未記載
- **Problem:** 新規テストファイルでのモック設定方法が不明。
- **Recommended action:** 既存パターンに従うことを明記。

### T-4 [Major] onProgress の具体的アサーション仕様が未定義
- **Problem:** 120件3チャンクの場合の期待値 `(50,120)→(100,120)→(120,120)` が明示されていない。
- **Recommended action:** テストケースに具体的な呼び出し順と引数を記載。

### T-5 [Minor] 部分失敗ケースのアサーション不明確
- **Problem:** success と failed の両方を検証する仕様が未記載。

## Adjacent Findings
なし（全て適切なスコープに収まっている）
