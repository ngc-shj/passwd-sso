# import/export コンポーネントファイルのリネーム

## Context

`src/components/passwords/` 内の import/export 関連ファイルが `import-dialog-*` / `export-dialog` という命名になっているが、実際にはダイアログではなくページパネルコンポーネントである。同ディレクトリ内の `password-list`, `password-card`, `password-form` 等の命名規則に合わせ、`password-import-*` / `password-export` にリネームする。

## リネーム対象

### `src/components/passwords/` (11ファイル)

| 現在 | 変更後 |
|------|--------|
| `import-dialog.tsx` | `password-import.tsx` |
| `import-dialog-importer.ts` | `password-import-importer.ts` |
| `import-dialog-importer.test.ts` | `password-import-importer.test.ts` |
| `import-dialog-parsers.ts` | `password-import-parsers.ts` |
| `import-dialog-parsers.test.ts` | `password-import-parsers.test.ts` |
| `import-dialog-payload.ts` | `password-import-payload.ts` |
| `import-dialog-steps.tsx` | `password-import-steps.tsx` |
| `import-dialog-tags.ts` | `password-import-tags.ts` |
| `import-dialog-tags.test.ts` | `password-import-tags.test.ts` |
| `import-dialog-types.ts` | `password-import-types.ts` |
| `import-dialog-utils.ts` | `password-import-utils.ts` |
| `export-dialog.tsx` | `password-export.tsx` |

### `src/components/org/` (1ファイル)

| 現在 | 変更後 |
|------|--------|
| `org-export-dialog.tsx` | `org-export.tsx` |

## import パス更新が必要なファイル

### 外部からの参照 (ページコンポーネント)

| ファイル | 更新内容 |
|---------|---------|
| `src/app/[locale]/dashboard/import/page.tsx` | `import-dialog` → `password-import` |
| `src/app/[locale]/dashboard/orgs/[orgId]/import/page.tsx` | `import-dialog` → `password-import` |
| `src/app/[locale]/dashboard/export/page.tsx` | `export-dialog` → `password-export` |
| `src/app/[locale]/dashboard/orgs/[orgId]/export/page.tsx` | `org-export-dialog` → `org-export` |

### 内部相互参照 (リネーム対象同士)

| ファイル | 参照先 |
|---------|--------|
| `password-import.tsx` | `password-import-steps` |
| `password-import-importer.ts` | `password-import-utils` |
| `password-import-parsers.ts` | `password-import-types` |
| `password-import-payload.ts` | `password-import-types` |
| `password-import-steps.tsx` | `password-import-utils`, `password-import-types` |
| `password-import-tags.ts` | `password-import-types` |
| `password-import-utils.ts` | `password-import-parsers`, `password-import-tags`, `password-import-payload`, `password-import-types` |

### テストファイルの mock/import パス

| テストファイル | 更新内容 |
|-------------|---------|
| `password-import-importer.test.ts` | `./import-dialog-importer` → `./password-import-importer` 等 |
| `password-import-parsers.test.ts` | `./import-dialog-parsers` → `./password-import-parsers` |
| `password-import-tags.test.ts` | `./import-dialog-utils` → `./password-import-utils` |
| `use-import-execution.test.ts` | `vi.mock` パスの `import-dialog-importer` → `password-import-importer`, `import-dialog-steps` → `password-import-steps` |
| `use-import-file-flow.test.ts` | `vi.mock` パスの `import-dialog-utils` → `password-import-utils` |
| `import-export-format.test.ts` | `./import-dialog-utils` → `./password-import-utils` |

### hooks (リネーム対象外だが参照更新が必要)

| ファイル | 更新内容 |
|---------|---------|
| `use-import-execution.ts` | `import-dialog-importer` → `password-import-importer`, `import-dialog-steps` → `password-import-steps` |
| `use-import-file-flow.ts` | `import-dialog-utils` → `password-import-utils` |

## 実行手順

1. `git mv` で全13ファイルをリネーム
2. 全ファイルの import/vi.mock パスを一括置換（**長い文字列から先に実行**、部分一致の誤変換を防止）:
   - `org-export-dialog` → `org-export` (**先に実行**: `export-dialog` の部分一致を防止)
   - `import-dialog-importer` → `password-import-importer`
   - `import-dialog-parsers` → `password-import-parsers`
   - `import-dialog-payload` → `password-import-payload`
   - `import-dialog-steps` → `password-import-steps`
   - `import-dialog-tags` → `password-import-tags`
   - `import-dialog-types` → `password-import-types`
   - `import-dialog-utils` → `password-import-utils`
   - `import-dialog` → `password-import` (**最後に実行**: 上記サブモジュール名との部分一致を防止)
   - `export-dialog` → `password-export` (`org-export-dialog` 処理済みのため安全)
3. 旧ファイル名の残存確認: `grep -r "import-dialog\|export-dialog" src/` でコメント等に旧名が残っていないか検証
4. テスト実行: `npx vitest run`
5. lint: `npm run lint`
6. ビルド: `npm run build`

## 検証

- `npx vitest run` — 全テスト通過
- `npm run lint` — エラー0
- `npm run build` — ビルド成功
