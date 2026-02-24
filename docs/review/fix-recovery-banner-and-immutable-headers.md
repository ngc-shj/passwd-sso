# コードレビュー: fix/recovery-banner-and-immutable-headers
日時: 2026-02-24T00:00:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### F-1 (軽微/既存) useMemo の依存配列から isDismissedInStorage() の結果が漏れている
- **ファイル:** `src/components/vault/recovery-key-banner.tsx` 33-37行目
- **問題:** `isDismissedInStorage()` は localStorage を読み取る外部副作用だが、useMemo の依存配列にリアクティブな値として含まれない。24時間後に dismiss 期限切れになっても再計算されない。
- **影響:** 実害は低い（ページ遷移等で再評価される）
- **推奨:** 今回の変更スコープ外。将来の改善として対応。

### F-2 (情報) NextResponse 固有プロパティの clone 時の喪失可能性
- **ファイル:** `src/lib/with-request-log.ts` 52-56行目
- **問題:** `new Response(response.body, response)` は NextResponse 固有の内部プロパティを引き継がない。
- **影響:** Auth.js リダイレクトレスポンス（body null, immutable headers）に限定されるため実害なし。

### F-3 (推奨) immutable headers テストの欠如
- **ファイル:** `src/__tests__/with-request-log.test.ts`
- **問題:** 新しい try/catch + clone パスのテストがない。
- **推奨:** immutable headers を持つ Response を返すテストケースを追加。

### F-4 (軽微/既存) dismiss ボタンが重複
- **ファイル:** `src/components/vault/recovery-key-banner.tsx` 63-76行目
- **問題:** テキスト付き「後で」ボタンと X アイコンボタンの両方が同じ handleDismiss を呼ぶ。
- **影響:** UX の問題。今回の変更スコープ外。

## セキュリティ観点の指摘

### S-1 (低リスク/既存) x-request-id ヘッダの入力バリデーション不足
- **ファイル:** `src/lib/with-request-log.ts` 29-30行目
- **問題:** クライアントからの `x-request-id` ヘッダをバリデーションなしに信頼。ログインジェクションの可能性。
- **推奨:** UUID形式 or 妥当な長さ・文字セットにバリデーション。
- **注意:** 今回のコミットで導入された問題ではない。

その他の観点（脅威モデル、認証・認可、データ保護、XSS/injection）: **指摘なし。**
VaultGate の認証境界は維持されており、秘密情報の露出リスク増加もない。

## テスト観点の指摘

### T-1 (高) immutable headers clone フォールバックパスのテスト不在
- **ファイル:** `src/__tests__/with-request-log.test.ts` (新規追加)
- **問題:** catch ブロック（49-57行目）が今回の変更の核心だがテストがない。
- **推奨:** `Response.redirect()` または headers.set をスローするモックでテスト。

### T-2 (低) clone 後のレスポンスボディ保全テスト
- **ファイル:** `src/__tests__/with-request-log.test.ts` (新規追加)
- **問題:** clone 後にボディが正しく転送される検証がない。実害は低い（リダイレクトは body null）。

### T-3 (低/既存) vault-gate / dashboard-shell のコンポーネントテスト不在
- 今回の変更スコープ外の既存問題。

## 対応状況
（修正後に追記）
