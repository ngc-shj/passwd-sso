# コードレビュー: fix/recovery-banner-and-immutable-headers

日時: 2026-02-24
総ループ回数: 5回
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

## ラウンド4 指摘と対応

対象: ブランチ全変更（sidebar, selection mode, tag creation, active-vault-context 等）

### 機能観点

#### F-R4-1 [低]: PasswordList/Trash の未使用メッセージキー

- **対応**: `select`/`close` キーを PasswordList.json, Trash.json (en/ja) から削除
- **修正ファイル**: `messages/{en,ja}/PasswordList.json`, `messages/{en,ja}/Trash.json`

#### F-R4-2 [中]: Escape キーが入力中でも selectionMode 解除を優先する

- **対応**: `inInput && searchQuery` の場合は検索クリアを優先するよう修正
- **修正ファイル**: `src/components/passwords/password-dashboard.tsx:140-149`

### セキュリティ観点

- **指摘なし**: XSS (React自動エスケープ), 認証・認可 (サーバーサイド完備), IDOR (userId フィルタ), 情報露出 (非機密データのみ) すべてクリア

### テスト観点

#### T-R4-1 [重大]: navigation-state テスト3件が失敗中

- **原因**: `use-sidebar-navigation-state.ts` のタグフィルタ削除 (`.filter(tag => tag.count > 0)`) に対してテスト未更新
- **対応**: 期待値を count=0 のタグ含む配列に更新、テスト名を "includes zero-count org tags" に変更
- **修正ファイル**: `src/hooks/use-sidebar-navigation-state.test.ts`

#### T-R4-2 [重大]: sidebar-folder-crud テスト9件が失敗中

- **原因**: OrganizeSection の createFolder が DropdownMenuItem (role="menuitem") に移動したが、テストが role="button" でクエリしていた
- **対応**: `getByRole("button", { name: "createFolder" })` → `getByRole("menuitem", { name: "createFolder" })` に変更
- **修正ファイル**: `src/components/layout/sidebar-folder-crud.test.tsx`

#### T-R4-3 [重大]: trash-list-bulk-restore テスト失敗

- **原因**: selectAll/clearSelection が親に移動、sticky が top→bottom に変更
- **対応**: 移動したアサーションを削除、"sticky top-4" → "sticky bottom-4" に修正
- **修正ファイル**: `src/components/passwords/trash-list-bulk-restore.test.ts`

#### T-R4-4 [重大]: sidebar-shared テスト失敗

- **原因**: FolderTreeNode の展開ボタンに `aria-expanded` 属性がなかった
- **対応**: `sidebar-shared.tsx` に `aria-expanded` を追加
- **修正ファイル**: `src/components/layout/sidebar-shared.tsx:86`

#### T-R4-5 [高]: handleTagCreate POST テスト未カバー

- **対応**: personal (POST /api/tags) + org (POST /api/orgs/:orgId/tags) のテスト追加
- **修正ファイル**: `src/hooks/use-sidebar-tag-crud.test.ts`

#### T-R4-6 [高]: tag-dialog 成功時close/エラー時維持テスト未カバー

- **対応**: onOpenChange(false) 呼出確認、reject時 未呼出確認のテスト追加
- **修正ファイル**: `src/components/tags/tag-dialog.test.tsx`

#### T-R4-7 [中]: tag-dialog 新規作成モードテスト未カバー

- **対応**: editTag=null 時の createTag タイトル/create ボタン表示、送信テスト追加
- **修正ファイル**: `src/components/tags/tag-dialog.test.tsx`

#### T-R4-8 [低]: onCreateTag 転送テスト不足

- **対応**: view-model, sidebar-sections, sidebar-content 各テストに onCreateTag 検証追加
- **修正ファイル**: `src/hooks/use-sidebar-view-model.test.ts`, `src/components/layout/sidebar-sections.test.tsx`, `src/components/layout/sidebar-content.test.tsx`

## ラウンド5 最終確認

3専門家（機能・セキュリティ・テスト）全員から「指摘なし」。

- 機能: Escape キー優先度修正・aria-expanded 追加・未使用キー削除すべて確認OK
- セキュリティ: UX改善・アクセシビリティ・テスト修正のみでセキュリティ影響なし
- テスト: ラウンド4の8件すべて正しく修正、テスト期待値と実装の整合確認済み

## テスト結果

- 全275テストファイル / 2368テスト 通過
- lint: 通過
