# コードレビュー: refactor/bulk-selection-dedup
日時: 2026-03-01T14:00:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘
（API制限によりサブエージェント結果取得不可 — スキップ）

## セキュリティ観点の指摘

### 指摘S1 [低]: `teamId` に空文字列が渡される可能性
- **ファイル**: `src/components/team/team-archived-list.tsx:226`, `src/components/team/team-trash-list.tsx:192`
- **問題**: `scopedTeamId` が `undefined` の場合、`useBulkAction` の scope に `{ type: "team", teamId: "" }` が渡される。`resolveEndpoint` が `/api/teams//passwords/bulk-*` のような不正URLを生成する。
- **影響**: 現状 `effectiveSelectionMode` が `false` になるためUIからは到達不可能だが、防御的コーディングとして不十分。
- **推奨**: `useBulkAction` の `executeAction` 内で `scope.type === "team" && !scope.teamId` の場合早期リターンするガードを追加。

### その他確認事項（問題なし）
- 認証・認可: 全バルクAPIでセッション検証+チーム権限チェック+RLS適用済み
- データ保護: フックはIDのみを扱い暗号化データに触れない
- XSS: Reactの自動エスケープ+翻訳文字列のみ使用
- CSRF: SameSite Cookie + JSON Content-Type + CSP connect-src 'self'

## テスト観点の指摘

### 指摘T1: `pendingAction` override テスト不足
- **ファイル**: `src/hooks/use-bulk-action.test.ts`
- **問題**: `requestAction("trash")` → `requestAction("archive")` → `executeAction()` で最新のアクションが使われるかの検証がない

### 指摘T2: `pendingAction === null` ガードのテスト不足
- **ファイル**: `src/hooks/use-bulk-action.test.ts`
- **問題**: `requestAction` を呼ばずに `executeAction` を直接呼んだ場合のテストがない

### 指摘T3: fetch ネットワーク例外のテスト不足
- **ファイル**: `src/hooks/use-bulk-action.test.ts`
- **問題**: `fetch` が reject するケース（ネットワーク障害）のテストがない

### 指摘T4: エラー時の `dialogOpen` 状態検証不足
- **ファイル**: `src/hooks/use-bulk-action.test.ts`
- **問題**: エラー時にダイアログが開いたままになる設計の検証がない

### 指摘T5: `selectAllRef` (useImperativeHandle) テスト不足
- **ファイル**: `src/hooks/use-bulk-selection.test.ts`
- **問題**: `selectAllRef` を通した `toggleSelectAll` のテストがない

### 指摘T6: `setDialogOpen` 手動クローズのテスト不足
- **ファイル**: `src/hooks/use-bulk-action.test.ts`
- **問題**: ユーザーがESC等でダイアログを閉じた場合の状態遷移が未検証

### 指摘T7: チームコンポーネントのワイヤリングテスト欠如
- **問題**: 個人用の `password-list-bulk-actions.test.ts`/`trash-list-bulk-restore.test.ts` に相当するチーム側テストがない

### 指摘T8: `password-list.test.ts` が `bulk-selection-helpers.test.ts` と重複
- **問題**: リファクタリング後、同一関数を2箇所でテストしている冗長状態

### 指摘T9: 共通コンポーネントのユニットテスト欠如
- **問題**: `BulkActionConfirmDialog` と `FloatingActionBar` にテストがない

### 指摘T10: `extractCount` の `processedCount: 0` 境界テスト不足
- **問題**: `??` が `||` に誤変更された場合のリグレッション防止テストがない

## 対応状況
（修正後に追記）
