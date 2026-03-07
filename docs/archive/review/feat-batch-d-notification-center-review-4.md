# コードレビュー: feat/batch-d-notification-center
日時: 2026-03-02T15:14:00+09:00
レビュー回数: 4回目

## 前回からの変更
- ループ3の全指摘を修正済み（IPv6バイパス、API_ERRORカウント、share-linksモック、team-password-formモック）
- タグ階層UIの改善（TagTreeNode、buildTagPath、TagDialogインデント修正）
- チームフォームへのdefaultFolderId/defaultTags追加

## 機能観点の指摘

### 指摘1: `resetTeamFormForClose`がデフォルト値をクリアする（修正済み）
- **ファイル**: `src/hooks/use-team-password-form-lifecycle.ts`
- **問題**: フォームを閉じて再度開くとデフォルトのフォルダ・タグが反映されない
- **影響**: タグAビューで新規作成→閉じる→タグBビューで新規作成→タグBが設定されない
- **対応**: `handleOpenChange`でnew entry時にdefaultsを再適用する`applyDefaults`コールバックを追加

### 情報提供（対応不要）
- `isAncestorOfTag`がMapを毎回再構築 → `FolderTreeNode`と同じパターン、タグ数は通常<100で問題なし
- `buildTagPath`のO(n*d) → 同上、実用上問題なし
- Webhook死コード（到達不能なプライベートIP範囲チェック） → 削除済み

## セキュリティ観点の指摘

**指摘なし**

全観点で問題なし:
- 認証・認可: 全APIルートで適切にチェック
- SSRF対策: IPv6修正確認、FQDN限定が正しく機能
- データ保護: 通知metadataサニタイズ、Webhook秘密鍵のAES-256-GCM暗号化
- インジェクション: Prisma使用、react-markdown XSS保護、CSVエスケープ
- Rate Limiting: 監査ログ2回/分、共有リンク20回/分
- RLS: 全テーブルでテナント分離確認

## テスト観点の指摘

### 情報提供（対応不要）
- `isAncestorOfTag`の循環参照保護欠如 → MAX_DEPTH=3でサーバー側強制のため低リスク
- `buildTagPath`循環参照テストのアサーションが弱い → containsでの検証は十分

## 対応状況

### 指摘1: resetTeamFormForCloseがデフォルトをクリアする
- 対応: `useTeamPasswordFormLifecycle`に`defaults`引数を追加、`applyDefaults`コールバックで再適用
- 修正ファイル: `src/hooks/use-team-password-form-lifecycle.ts`, `src/hooks/use-team-password-form-model.ts`

### 死コード削除
- 対応: WebhookのプライベートIP範囲チェック（到達不能コード）を削除
- 修正ファイル: `src/app/api/teams/[teamId]/webhooks/route.ts`
