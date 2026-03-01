# プランレビュー: optimized-plotting-aurora.md
日時: 2026-03-01
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### 指摘 1 [高]: `useBulkAction` の `actions: BulkActionConfig[]` 設計が過剰に汎用的
- **問題**: `BulkActionConfig` に `buildBody` / `extractCount` / `endpoint` を持たせる設計は、呼び出し側がアクションごとに設定オブジェクトを組み立てる必要があり、重複解消の恩恵が半減する
- **影響**: 各コンポーネントで `BulkActionConfig[]` を定義する定型コードが発生
- **推奨対応**: `mode: "personal" | "team"` + `teamId?` に簡略化し、エンドポイント/ボディ組み立てをフック内部に持たせる

### 指摘 2 [中]: `selectionHandle` フィールドが冗長
- **問題**: `UseBulkSelectionReturn` に `selectionHandle` と `toggleSelectAll`/`allSelected` が重複
- **影響**: 呼び出し側が混乱、Surface Area が広い
- **推奨対応**: `selectAllRef` をフック引数として受け取り、内部で `useImperativeHandle` を呼ぶ

### 指摘 3 [中]: `FloatingActionBar` の `position` prop がチーム画面レイアウトを吸収できない
- **問題**: チーム画面は `md:pl-60` 等の複雑なスタイルを持つ
- **推奨対応**: `className` prop で呼び出し側がレイアウトを決める形にする

### 指摘 4 [低]: `extractCount` 関数の外部化が不要
- **問題**: フォールバック連鎖のパターンは統一可能
- **推奨対応**: フック内で一括フォールバック

### 指摘 5 [高]: Step 6 の移行順序でリスクが高いファイルを後半に置いている
- **問題**: 子コンポーネントを先に移行すると親とのインターフェース不整合が発生
- **推奨対応**: `[teamId]/page.tsx` を最初に移行するか、親子同一コミットで移行

### 指摘 6 [低]: `reconcileSelectedIds` の最適化の明示と検証
- **推奨対応**: JSDocコメント + 同一参照テストケース追加

## セキュリティ観点の指摘

### 指摘 1 [低]: `endpoint` を自由に渡せるSSRFリスクの芽
- **問題**: `BulkActionConfig.endpoint` が `string` 型で検証なし
- **判定**: フロントエンドのみの変更でエンドポイントは `apiPath.*` 関数からのハードコード値。ユーザー入力がエンドポイントに流入する経路はない。機能指摘1で `scope` ベース設計に変更することで、endpoint文字列の外部指定自体がなくなり解消。

### 指摘 2 [中]: `guard` の役割が不明確
- **問題**: `guard` が省略可能でチーム操作で渡し忘れるリスク
- **判定**: `scope` ベース設計に変更することで、`scope.type === "team"` の場合はフック内部で `teamId` 存在チェックが自動適用される。`guard` オプション自体が不要になる。

### 指摘 3 [低]: `extractCount` の値検証
- **判定**: 自社APIサーバーからのレスポンスでトースト表示のみに使用。過剰対応。

### 指摘 4 [中]: `executeAction` が直接呼び出せる設計
- **問題**: ダイアログを経由せず破壊的操作が実行可能
- **判定**: 部分的に妥当。API設計で `requestAction` → ダイアログ → confirm の流れを明確にする。

### 指摘 5 [低]: `selectedIds` のリセットタイミングの競合
- **判定**: プランの設計で `selectedIds` は `useBulkSelection` が管理し、`onSuccess` で `clearSelection` を呼ぶ責務分離が明確。問題なし。

## テスト観点の指摘

### 指摘 1 [中]: `password-list-selection.ts` の最適化パスが未テスト
- **推奨対応**: 同一参照テストケース追加

### 指摘 2 [高]: `extractCount` フォールバック連鎖の網羅テスト不足
- **推奨対応**: 各アクションタイプの全フォールバックパターンをテスト

### 指摘 3 [中]: テスト更新後の責務境界が未定義
- **推奨対応**: テストファイルごとの責務をプランに明記

### 指摘 4 [高]: チームコンポーネントの一括操作テストがプランに欠落
- **推奨対応**: チーム側テストケースを追加

### 指摘 5 [中]: `allSelected` エッジケースのテスト不在
- **推奨対応**: `entryIds` 空配列時のテスト追加
