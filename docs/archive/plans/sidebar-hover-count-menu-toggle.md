# エントリー数の表示位置のみホバーで「...」に切り替える

## Context
現在、サイドバーのタグ/フォルダ項目は行全体（`group/tag` / `group/folder`）をホバーするとカウント → 3ドットメニューが切り替わる。ユーザーの要件は、カウント表示位置（右端の `w-7 h-7` コンテナ）のみをホバーしたときに切り替わるようにすること。

## 修正内容

### 1. `src/components/layout/sidebar-sections.tsx`（タグ）
- 行247: `group/tag` を外側の行divから削除
- 行261: `group/tag` を内側のカウント/メニューコンテナdivに追加

```diff
- <div key={tag.id} className="group/tag flex items-center">
+ <div key={tag.id} className="flex items-center">
  ...
-   <div className="shrink-0 relative flex items-center justify-center w-7 h-7">
+   <div className="group/tag shrink-0 relative flex items-center justify-center w-7 h-7">
```

### 2. `src/components/layout/sidebar-shared.tsx`（フォルダ）
- 行91: `group/folder` を外側の行divから削除
- 行113: `group/folder` を内側のカウント/メニューコンテナdivに追加

```diff
- <div className="group/folder flex items-center" ...>
+ <div className="flex items-center" ...>
  ...
-   <div className="shrink-0 relative flex items-center justify-center w-7 h-7">
+   <div className="group/folder shrink-0 relative flex items-center justify-center w-7 h-7">
```

## 検証
- `npm run lint` で lint 通過を確認
- ブラウザで確認: タグ/フォルダ名をホバーしても「...」が出ない
- ブラウザで確認: カウント表示位置をホバーしたら「...」が出る
- 3ドットメニューのクリックで編集/削除が動作する
