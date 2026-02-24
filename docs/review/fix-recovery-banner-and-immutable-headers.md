# コードレビュー: fix/recovery-banner-and-immutable-headers
日時: 2026-02-24
総ループ回数: 3回
最終状態: 指摘なし（全観点クリア）

## ラウンド1 指摘と対応

### S-1: x-request-id バリデーション不足
- **対応**: `/^[\w\-]{1,128}$/` でバリデーション追加
- **修正ファイル**: `src/lib/with-request-log.ts:29-31`

### F-1: useMemo + localStorage の誤用
- **対応**: useMemo を削除、通常の変数に変更
- **修正ファイル**: `src/components/vault/recovery-key-banner.tsx:33-37`

### F-4: dismiss ボタン重複
- **対応**: テキストボタンを削除、X アイコンのみ残す。`type="button"` + `aria-label` 追加
- **修正ファイル**: `src/components/vault/recovery-key-banner.tsx:64-71`

### T-1: immutable headers clone パスのテスト欠如
- **対応**: `Response.redirect()` を使ったテストケース追加
- **修正ファイル**: `src/__tests__/with-request-log.test.ts`

## ラウンド2 指摘と対応

### N-1: テストファイル重複
- **対応**: `src/lib/with-request-log.test.ts` を削除（全テストが `src/__tests__/` でカバー済み）

### N-2: aria-label の翻訳
- **対応**: aria-label 用に操作目的の翻訳に変更（en: "Dismiss recovery key banner", ja: "回復キーバナーを閉じる"）

### N-3: isDismissedInStorage の未来タイムスタンプ対策
- **対応**: `elapsed >= 0` ガード追加 + テスト追加
- **修正ファイル**: `src/components/vault/recovery-key-banner.tsx:19`, `recovery-key-banner.test.ts`

### N-4: createRequest が Request を返していた
- **対応**: 共通ヘルパー `src/__tests__/helpers/request-builder.ts` の `createRequest` (NextRequest) に統一
- **修正ファイル**: `src/__tests__/with-request-log.test.ts`

### N-5: sensitive keys テストが実質無意味
- **対応**: テスト削除

### N-6: x-request-id 境界値テスト不足
- **対応**: 128文字(受理), 129文字(拒否), 空文字列(拒否) のテスト追加
- **修正ファイル**: `src/__tests__/with-request-log.test.ts`

## ラウンド3 最終確認

3専門家（機能・セキュリティ・テスト）全員から「指摘なし」。

- 機能: 全ロジック正常、翻訳適切、コンポーネント構造妥当
- セキュリティ: x-request-id バリデーション妥当、ログインジェクション対策済み、XSS リスクなし
- テスト: 全19テスト通過、境界値・異常値・副作用の検証が網羅

## テスト結果
- with-request-log: 11テスト全通過
- recovery-key-banner: 8テスト全通過
- lint: 通過
