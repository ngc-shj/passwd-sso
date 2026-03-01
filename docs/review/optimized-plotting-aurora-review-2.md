# プランレビュー: optimized-plotting-aurora.md
日時: 2026-03-01
レビュー回数: 2回目

## 前回からの変更

- `useBulkAction` を `scope` ベース設計に変更（`BulkActionConfig[]` 廃止）
- `BulkSelectionHandle` から `allSelected` を削除
- `selectAllRef` をフック引数に移動
- `onSuccess` にJSDocで責務を明文化
- `effectiveSelectionMode` の解決責務を呼び出し元に明示
- チーム親子を同一ステップで移行
- `team-archived-list.tsx` の `reconcileSelectedIds` バグ修正を追加
- `team-trash-list.tsx` の `forwardRef` 二重管理解消を追加
- テストファイルの責務定義を更新（ソース文字列テスト → `vi.mock` ベースへ移行）

## 機能観点の指摘

### 指摘 1 [高]: `BulkSelectionHandle.allSelected` 冗長 → handle を `toggleSelectAll` のみに
- 対応済み: プランに反映

### 指摘 2 [中]: `onSuccess` の責務範囲が不明確
- 対応済み: JSDoc追加

### 指摘 3 [中]: `trash-list-selection.ts` の廃止タイミング
- 既にStep 1 + Step 8でカバー済み

### 指摘 4 [低]: `effectiveSelectionMode` の解決責務
- 対応済み: 呼び出し元で解決する旨を明記

## セキュリティ観点の指摘

### 指摘 1 [中]: チームバルク操作の権限レベル不整合 (PASSWORD_DELETE vs PASSWORD_UPDATE)
- スコープ外: サーバー側の既存設計。今回のフロントエンドリファクタリングの範囲外。

### 指摘 2 [低]: IDフォーマット未検証
- スコープ外: サーバー側の既存コード。

### 指摘 3 [低]: TeamArchivedList の reconcileSelectedIds がフィルタ前のエントリを使用
- 対応済み: Step 6のバグ修正として追加

## テスト観点の指摘

### 指摘 1 [高]: trash-list-selection.ts 最適化パス未テスト
- Step 1で既に対応済み（最適化版をベースに統合 + テスト追加）

### 指摘 2 [高]: TeamArchivedList の allSelected 不整合
- 対応済み: Step 6のバグ修正として追加

### 指摘 3 [中]: ソース文字列テスト → vi.mock ベースへ移行
- 対応済み: テスト責務表を更新

### 指摘 4 [中]: TeamArchivedList 固有のガード条件テスト
- use-bulk-action.test.ts のチームスコープテストでカバー

### 指摘 5 [低]: count callback テスト名が曖昧
- 軽微。実装時に適切なテスト名をつける
