# コードレビュー: feat/folder-tag-context-title
日時: 2026-02-28T22:10:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### F-1: `buildFolderPath` の深さ制限のコメント不足 [Low]
- ファイル: `src/lib/folder-path.ts` 21行目
- 問題: ループ条件 `parts.length < MAX_FOLDER_DEPTH` の意図が自明でない
- 判定: **スキップ** — ロジックは正しく動作し（depth=5で5セグメント正常表示）、コードから十分読み取れる

### F-2: `usePersonalTags` が `vault-data-changed` イベントを購読していない [Medium]
- ファイル: `src/hooks/use-personal-tags.ts` 11〜29行目
- 問題: タグ追加・削除後にダッシュボードタイトルが更新されない
- 判定: **スキップ** — `usePersonalFolders` も同一の問題を持つ既存設計。Context昇格は別PRスコープとして計画済み

### F-3: タグ未ロード時に `defaultTags=undefined` [Low]
- ファイル: `src/components/passwords/password-dashboard.tsx` 118〜121行目
- 判定: **スキップ** — タグfetchは高速で実害は極小。フォルダIDは直渡しで影響なし

### F-4: テストファイルの `"use client"` ディレクティブ [Low]
- ファイル: `src/hooks/use-personal-tags.test.ts` 2行目
- 判定: **スキップ** — `use-personal-folders.test.ts` と一貫したパターン

### F-5: `tags.find` のラムダ変数名 `t2` が紛らわしい [Low]
- ファイル: `src/components/passwords/password-dashboard.tsx` 81行目、118行目
- 問題: 翻訳変数 `t` と紛らわしい
- 判定: **修正** — F-6と合わせて対応

### F-6: `tags.find` が2回呼ばれて冗長 [Low]
- ファイル: `src/components/passwords/password-dashboard.tsx` 81行目と118行目
- 問題: 同じ配列に対して同じ検索を2回実行
- 判定: **修正** — `matchedTag` を先に定義し `tagLabel = matchedTag?.name` に変更

## セキュリティ観点の指摘

### S-1: `buildFolderPath` のループ上限 off-by-one [Low]
- F-1と重複。ロジックは正しい。**スキップ**

### S-2: `fetchError` が `PasswordDashboard` で無視 [Low]
- F-2と関連。**スキップ** — 既存の `usePersonalFolders` と同一パターン

### S-3: タグIDのサーバー側検証確認 [Info]
- 判定: **確認済み** — `/api/passwords` POST でタグ所有権検証あり。本ブランチの変更範囲外

### S-4: XSS (フォルダ名・タグ名レンダリング) [確認済み]
- React JSX テキストノードのため自動エスケープ。問題なし

### S-5: `/api/tags` への二重フェッチ [Low]
- 判定: **スキップ** — Context昇格は別PRスコープ

## テスト観点の指摘

### T-1: 循環参照テストのアサーションが緩い [Low]
- ファイル: `src/lib/folder-path.test.ts` 48〜55行
- 問題: `toContain("A")` のみで、正確な戻り値 `"B / A"` を検証していない
- 判定: **修正**

### T-2: `MAX_FOLDER_DEPTH` 境界値テスト欠落 [Medium]
- ファイル: `src/lib/folder-path.test.ts`
- 問題: 深さ5（ちょうど上限）と深さ6（超過時の打ち切り）が未検証
- 判定: **修正**

### T-3: 非配列レスポンステストの `waitFor` 条件が不正確 [Low]
- 判定: **スキップ** — `use-personal-folders.test.ts` と同一パターン

### T-4: 非配列 fetchError 状態遷移テスト欠落 [Low]
- 判定: **スキップ** — 低優先度

### T-5: `buildPersonalPasswordFormInitialValues` の defaults テスト欠落 [High]
- ファイル: `src/hooks/personal-password-form-initial-values.ts`
- 問題: 新しい `defaults` パラメータのテストが一切ない
- 判定: **修正**

### T-6: `buildPersonalPasswordFormDerived` の defaults テスト欠落 [High]
- ファイル: `src/hooks/personal-password-form-derived.ts`
- 問題: `defaults` を渡した場合の `hasChanges` 判定が未検証
- 判定: **修正**

## 対応状況

### F-5/F-6: tags.find 重複と変数名
- 対応: `matchedTag` を先に定義し、`tagLabel = matchedTag?.name` に変更。重複検索を排除、変数名を `tag` に統一
- 修正ファイル: `src/components/passwords/password-dashboard.tsx`

### T-1: 循環参照テストのアサーション
- 対応: `toContain` → `toBe("B / A")` に厳密化
- 修正ファイル: `src/lib/folder-path.test.ts`

### T-2: MAX_FOLDER_DEPTH 境界値テスト
- 対応: depth=5（ちょうど上限）と depth=6（打ち切り）の2ケースを追加
- 修正ファイル: `src/lib/folder-path.test.ts`

### T-5: defaults パラメータテスト（initial values）
- 対応: 4ケース追加（defaultFolderId使用、defaultTags使用、initialData優先×2）
- 修正ファイル: `src/hooks/personal-password-form-initial-values.test.ts`

### T-6: defaults パラメータテスト（derived）
- 対応: 3ケース追加（hasChanges=false with defaultFolderId、hasChanges=true差分、hasChanges=false with defaultTags）
- 修正ファイル: `src/hooks/personal-password-form-derived.test.ts`
