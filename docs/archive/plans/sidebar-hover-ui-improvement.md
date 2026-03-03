# サイドバー タグ・フォルダの hover UI 改善

## Context

サイドバーのタグとフォルダの行で、hover 時の視覚的フィードバックを改善する。現状は Button 部分のみ hover ハイライトされ、カウント部分は含まれない。また、メニュー付きの行ではカウントが MoreHorizontal アイコンに切り替わるが、メニューなしの行では hover 時の変化がない。

**ユーザー要求**:
1. hover 時、カウント部分も含めて行全体をハイライト
2. hover 時、カウント数を「…」に変更
3. 「…」部分は行全体のハイライトより濃い色で識別可能にする

---

## 現状分析

### タグ (`sidebar-sections.tsx` L234-289)

```
<div flex items-center>                      ← hover なし
  <Button variant="ghost" flex-1>            ← Button 自体に hover:bg-accent
    <Badge /> <span>{tag.name}</span>
  </Button>
  {showTagMenu ? (
    <div group/tag w-7 h-7>                  ← group はこの小さい div のみ
      <MoreHorizontal> (hover で表示)
      <span>{tag.count}</span> (hover で非表示)
    </div>
  ) : (
    <span>{tag.count}</span>                 ← hover 変化なし
  )}
</div>
```

### フォルダ (`sidebar-shared.tsx` L46-154)

```
<div group/folder flex items-center>         ← group/folder あり（アイコン切替用）
  <Button variant="ghost" flex-1>
    <FolderOpen> (hover で非表示) / <Chevron> (hover で表示)
    <span>{folder.name}</span>
  </Button>
  {showMenu ? (
    <div group/fmenu w-7 h-7>               ← group/fmenu（小さい div のみ）
      <MoreHorizontal> (hover で表示)
      <span>{folder.entryCount}</span> (hover で非表示)
    </div>
  ) : (
    <span>{folder.entryCount}</span>         ← hover 変化なし
  )}
</div>
```

### テーマトークン

- `--accent` = `oklch(0.97 0 0)` (light) / `oklch(0.269 0 0)` (dark)
- `--muted` = 同値 → 使い分け不可
- ghost Button hover: `hover:bg-accent dark:hover:bg-accent/50`

---

## 実装方針

### 共通パターン

1. **行全体の hover**: 外側 `<div>` に `group/tag` (タグ) または既存の `group/folder` (フォルダ) を設定し、`rounded-md transition-colors hover:bg-accent dark:hover:bg-accent/50` を追加
2. **Button hover 抑制**: Button の `className` に `hover:bg-transparent dark:hover:bg-transparent` を追加（`cn()` の twMerge で ghost variant の hover を上書き）
3. **カウント → 「…」切替**: `group-hover` でカウントを `opacity-0`、「…」を `opacity-100` にトグル
4. **「…」の濃い背景**: `bg-black/[0.06] dark:bg-white/[0.1]` — 半透明オーバーレイで行の accent より一段濃く見える

---

## 修正ファイル

### 1. `src/components/layout/sidebar-sections.tsx` — タグ行

**L238 の外側 `<div>`**: `group/tag` + hover bg を追加

```tsx
// Before
<div key={tag.id} className="flex items-center">

// After
<div key={tag.id} className="group/tag flex items-center rounded-md transition-colors hover:bg-accent dark:hover:bg-accent/50">
```

**L239-241 の Button**: ghost variant の hover を抑制

```tsx
// Before
className="flex-1 justify-start gap-2 min-w-0"

// After
className="flex-1 justify-start gap-2 min-w-0 hover:bg-transparent dark:hover:bg-transparent"
```

**L252-286 のカウント/メニュー部分**: 両分岐を統一構造に変更

`showTagMenu = true` の場合:
- `group/tag` を外側 div に移動したので、内側 div から削除
- MoreHorizontal アイコン → 「…」テキストに変更
- トリガーに `bg-black/[0.06] dark:bg-white/[0.1]` + `rounded` を追加
- `group-hover/tag` で count/「…」をトグル

`showTagMenu = false` の場合:
- 現在は `<span>{tag.count}</span>` のみ → `<div>` に変更し、count と「…」の切替構造を追加
- 「…」は `pointer-events-none` で非インタラクティブ

```tsx
{showTagMenu ? (
  <div className="shrink-0 relative flex items-center justify-center w-7 h-7">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="peer absolute inset-0 h-7 w-7 opacity-0 transition-opacity group-hover/tag:opacity-100 focus:opacity-100 rounded bg-black/[0.06] dark:bg-white/[0.1] hover:bg-black/[0.1] dark:hover:bg-white/[0.15]"
          aria-label={`${tag.name} menu`}
        >
          <span className="text-xs font-normal">…</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* 既存メニュー項目そのまま */}
      </DropdownMenuContent>
    </DropdownMenu>
    {tag.count > 0 && (
      <span className="text-xs text-muted-foreground transition-opacity group-hover/tag:opacity-0 peer-focus:opacity-0 pointer-events-none">
        {tag.count}
      </span>
    )}
  </div>
) : tag.count > 0 ? (
  <div className="shrink-0 relative flex items-center justify-center w-7 h-7">
    <span className="text-xs text-muted-foreground transition-opacity group-hover/tag:opacity-0 pointer-events-none">
      {tag.count}
    </span>
    <span className="absolute inset-0 flex items-center justify-center rounded opacity-0 transition-opacity group-hover/tag:opacity-100 bg-black/[0.06] dark:bg-white/[0.1] text-xs text-muted-foreground pointer-events-none">
      …
    </span>
  </div>
) : null}
```

### 2. `src/components/layout/sidebar-shared.tsx` — フォルダ行

**L70 の外側 `<div>`**: hover bg を追加（`group/folder` は既存）

```tsx
// Before
className="group/folder flex items-center"

// After
className="group/folder flex items-center rounded-md transition-colors hover:bg-accent dark:hover:bg-accent/50"
```

**L73 の Button**: ghost variant の hover を抑制

```tsx
// Before
className="flex-1 justify-start gap-2 min-w-0"

// After
className="flex-1 justify-start gap-2 min-w-0 hover:bg-transparent dark:hover:bg-transparent"
```

**L100-134 のカウント/メニュー部分**: `group-hover/fmenu` → `group-hover/folder` に変更 + 「…」構造

`showMenu !== false` の場合:
- `group/fmenu` → 削除（外側の `group/folder` を使用）
- `group-hover/fmenu` → `group-hover/folder` に変更
- MoreHorizontal → 「…」テキストに変更
- トリガーに `bg-black/[0.06] dark:bg-white/[0.1]` を追加

`showMenu === false` の場合:
- タグと同じ count/「…」切替構造を追加（`group-hover/folder` を使用）

```tsx
{showMenu !== false ? (
  <div className="shrink-0 relative flex items-center justify-center w-7 h-7">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="peer absolute inset-0 h-7 w-7 opacity-0 transition-opacity group-hover/folder:opacity-100 focus:opacity-100 rounded bg-black/[0.06] dark:bg-white/[0.1] hover:bg-black/[0.1] dark:hover:bg-white/[0.15]"
          aria-label={`${folder.name} menu`}
        >
          <span className="text-xs font-normal">…</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* 既存メニュー項目そのまま */}
      </DropdownMenuContent>
    </DropdownMenu>
    {folder.entryCount > 0 && (
      <span className="text-xs text-muted-foreground transition-opacity group-hover/folder:opacity-0 peer-focus:opacity-0 pointer-events-none">
        {folder.entryCount}
      </span>
    )}
  </div>
) : folder.entryCount > 0 ? (
  <div className="shrink-0 relative flex items-center justify-center w-7 h-7">
    <span className="text-xs text-muted-foreground transition-opacity group-hover/folder:opacity-0 pointer-events-none">
      {folder.entryCount}
    </span>
    <span className="absolute inset-0 flex items-center justify-center rounded opacity-0 transition-opacity group-hover/folder:opacity-100 bg-black/[0.06] dark:bg-white/[0.1] text-xs text-muted-foreground pointer-events-none">
      …
    </span>
  </div>
) : null}
```

**不要な import 削除**: `MoreHorizontal` をタグ・フォルダの両方で使わなくなるため、import を確認し不要なら削除。
- `sidebar-shared.tsx`: `MoreHorizontal` は FolderTreeNode のみで使用 → 削除
- `sidebar-sections.tsx`: `MoreHorizontal` はタグのみで使用 → 削除

---

## 検証

1. `npm run build` — TypeScript コンパイル通過
2. `npm run lint` — ESLint エラーなし
3. Manual (light mode):
   - タグ行 hover → 行全体（カウント含む）がハイライトされる
   - カウント数が「…」に切り替わる
   - 「…」部分は行のハイライトより濃い背景色
   - メニュー付きタグ: 「…」クリックでドロップダウンメニュー表示
4. Manual (dark mode): 同上の動作確認
5. Manual (フォルダ): タグと同様の hover 動作
6. Manual (フォルダ展開): 子フォルダあり → hover でフォルダアイコン→シェブロン切替が引き続き動作
7. Manual (アクティブ状態): 選択中のタグ/フォルダも hover 時に「…」が表示される
