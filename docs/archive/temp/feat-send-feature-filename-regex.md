# コードレビュー: feat/send-feature (SAFE_FILENAME_RE 拡張 + Org download 修正)
日時: 2026-02-20T13:10:00+09:00
レビュー回数: 3回目

## 前回からの変更 (2回目 → 3回目)

### 2回目で修正済み
- T-1: `\s` → explicit space ` `
- T-2/T-4: `name !== name.trim()` チェック追加
- T-3: 括弧・アポストロフィ境界テスト追加

### 2回目で新規追加
- Org download Content-Disposition → RFC 5987 (`filename="download"; filename*=UTF-8''...`)
- Org download に `X-Content-Type-Options: nosniff` 追加
- Org download テストファイル新規作成 (6テスト)

### 3回目で修正済み (2回目レビュー指摘)
- Security: Org download に `Cache-Control: private, no-cache, no-store, must-revalidate` 追加
- T-5/T-6: Content-Type, Content-Length, Cache-Control ヘッダー検証追加
- T-7: DELETE ハンドラテスト追加 (6テスト: 401, 403, 404x3, 正常削除)
- T-8: orgId 不一致テスト追加 (GET, DELETE 各1ケース)

## 機能観点の指摘
指摘なし (2回目も指摘なし)

## セキュリティ観点の指摘

### 2回目: Cache-Control ヘッダー欠落 → 修正済み
- **問題:** Org download に Cache-Control 未設定で復号済みデータがキャッシュされるリスク
- **対応:** `Cache-Control: private, no-cache, no-store, must-revalidate` 追加

## テスト観点の指摘

### 1回目 T-1~T-4: すべて解決済み
### 2回目 T-5~T-8: すべて解決済み

## 対応状況

| 指摘 | 対応 | 修正ファイル |
|------|------|-------------|
| T-1 (重大) | `\s` → ` ` | validations.ts:428 |
| T-2 (中) | `name !== name.trim()` | validations.ts:438 |
| T-3 (中) | 境界テスト追加 | validations-send.test.ts |
| T-4 (低) | 先頭/末尾スペース拒否テスト | validations-send.test.ts |
| Security | Cache-Control 追加 | [attachmentId]/route.ts:95 |
| T-5 (低) | Content-Length 検証追加 | org-attachment-download.test.ts |
| T-6 (低) | Content-Type 検証追加 | org-attachment-download.test.ts |
| T-7 (中) | DELETE テスト追加 (6ケース) | org-attachment-download.test.ts |
| T-8 (低) | orgId 不一致テスト追加 | org-attachment-download.test.ts |
