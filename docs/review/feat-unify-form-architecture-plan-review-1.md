# プランレビュー: feat/unify-form-architecture
日時: 2026-03-02T00:00:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### 1-1: Phase 1のデッドコードファイル存在確認 (却下)
- **問題**: ページルートファイルが存在しない可能性
- **判定**: 却下。会話中のfind/grepで存在確認済み

### 1-2: password-detail.tsxのi18n参照クリーンアップ漏れ (採用)
- **問題**: `PasswordDetail`がi18n namespace登録ファイル (`namespace-groups.ts`, `messages.ts`) で参照されている
- **影響**: 削除後に孤立したi18n namespaceが残る
- **推奨対応**: Phase 1にi18n namespaceクリーンアップを追加

### 1-3: テストファイル移行範囲の過小評価 (採用)
- **問題**: Phase 3dの削除対象に対応するテスト14件以上が未計上
- **影響**: 孤立テストがビルド/テスト失敗を引き起こす
- **推奨対応**: テストファイルインベントリを作成し、各テストの移行先を明記

### 2-1: CreditCardFormのbrandSource/auto-detect保持を明記 (採用)
- **問題**: 個人CreditCardFormのカードブランド自動検出ロジックが共通化時に失われるリスク
- **推奨対応**: `brandSource`状態、`handleCardNumberChange`、`detectCardBrand`/`formatCardNumber`を個人フォーム側に維持することを明記

### 2-2: HTML `required`属性の保持 (採用)
- **問題**: 個人フォームのtitle入力に`required`があるが、チームフィールドコンポーネントにはない
- **推奨対応**: タイトルフィールドは各親フォームで描画（チーム既存パターンと同じ）

### 2-3: アクセシビリティ — htmlFor/idペアリング (採用)
- **問題**: 個人フォームは`htmlFor`/`id`を使用、チームフィールドは使用していない
- **推奨対応**: 共通フィールドコンポーネントに`idPrefix`プロップを追加

### 3-1: Phase 3bフック分離の具体化 (採用)
- **推奨対応**: エントリタイプ別フォームはインラインuseState、ベースフックは翻訳/policy/folders/attachments/submitのみ

### 3-2: Per-type submit helpers (採用)
- **問題**: `submitTeamPasswordForm`が全フィールドをflatに受け取る
- **推奨対応**: エントリタイプ別submitヘルパーを作成

### 3-3: buildTeamFormSectionsPropsを削除しない (採用)
- **問題**: 共通セクションprops構築は全エントリタイプで共用
- **推奨対応**: Phase 3dの削除リストから除外し維持

### 4-3: team-archived-list.tsxがPhase 4で漏れている (採用)
- **問題**: `team-archived-list.tsx`もTeamPasswordFormをimportしている
- **推奨対応**: Phase 4スコープに追加

## セキュリティ観点の指摘

### S-1: AADパイプライン維持 (採用 — 注意点として追加)
- **問題**: Phase 3aで新規フォームがsaveレイヤーをバイパスするリスク
- **推奨対応**: 全フォームが`saveTeamEntry()`を経由する制約を明記

### S-2: デッドコード削除 — 指摘なし
### S-3: チーム権限チェック — 指摘なし (注意点あり)
- UI上の条件分岐（VIEWER編集ボタン非表示等）の引き継ぎを手動確認

### S-4: XSS (SecureNote Markdown) — 指摘なし
### S-5: blob構築の一貫性 (採用)
- **推奨対応**: overviewBlobの型定義を作成し構造欠落をコンパイル時検知

## テスト観点の指摘

### T-1: Phase 2 importパス変更でテスト4件以上壊れる (採用)
- **推奨対応**: 移動対象をvi.mock()しているテストの洗い出しと更新をPhase 2に追加

### T-2: Phase 3d削除依存が17ファイル以上 (採用)
- **推奨対応**: 削除前チェックリスト追加（grep結果ゼロ確認）、型定義の移行先明記

### T-3: 新規フォーム7つのテスト計画なし (採用)
- **推奨対応**: Phase 3aに各フォームのテスト作成を追加

### T-4: フック分離後のテスト戦略未定義 (採用)
- **推奨対応**: Phase 3bにベースフック+主要エントリタイプのテスト追加

### T-5: 手動テスト範囲未定義 (採用)
- **推奨対応**: Phase別の手動テストマトリクスを定義

### T-6: CI/CDゲートにvitest run未記載 (採用)
- **推奨対応**: 検証セクションに`npx vitest run`追加
