# PR2 Skip Log

Tests deferred from PR2's component coverage with rationale.

## C1 — passwords/{shared,entry,detail,detail/sections}

| file | rationale | decision-rule | evidence | date |
|---|---|---|---|---|
| `src/components/passwords/shared/folder-like.ts` | pure-types | §Skip decision tree (pure types skip rule) | exports `FolderLike` interface only — no runtime code | 2026-05-04 |

## C2 — passwords/{personal,dialogs,import,export}

| file | rationale | decision-rule | evidence | date |
|---|---|---|---|---|
| `src/components/passwords/dialogs/personal-password-edit-dialog-types.ts` | pure-types | §Skip decision tree (pure types skip rule) | exports `PersonalPasswordEditData` interface only — no runtime code | 2026-05-04 |
| `src/components/passwords/import/password-import-types.ts` | pure-types | §Skip decision tree (pure types skip rule) | exports `ImportTranslator`, `ParsedEntry`, `CsvFormat` types only — no runtime code | 2026-05-04 |
| `src/components/passwords/personal/personal-login-form-types.ts` | pure-types | §Skip decision tree (pure types skip rule) | exports `PersonalLoginFormInitialData`, `PersonalLoginFormProps` interfaces only — no runtime code | 2026-05-04 |
| `src/components/passwords/import/password-import-utils.ts` | barrel re-export | §Skip decision tree (barrel re-export rule) | re-exports from `password-import-{parsers,tags,payload,types}.ts` only — those modules are tested in their own siblings | 2026-05-04 |
| `src/components/passwords/personal/personal-entry-dialog-shell.tsx` | barrel re-export | §Skip decision tree (barrel re-export rule) | single-line re-export of `EntryDialogShell` (already tested in `entry/entry-dialog-shell.test.tsx`) | 2026-05-04 |
| `src/components/passwords/dialogs/personal-password-edit-dialog.tsx` | already covered | §Skip decision tree | covered exhaustively by `personal-entry-dialogs.test.tsx` (entry-type → form mapping table for create + edit; verifies dialog title and form selection for every entry type) | 2026-05-04 |
| `src/components/passwords/dialogs/personal-password-new-dialog.tsx` | already covered | §Skip decision tree | covered exhaustively by `personal-entry-dialogs.test.tsx` (entry-type → form mapping table for create + edit) | 2026-05-04 |
| `src/components/passwords/personal/personal-login-form.tsx` | already covered | §Skip decision tree | covered by `personal-login-form-folder.test.tsx` (folder integration, submit body, IME guard) | 2026-05-04 |
