# PR2 Skip Log

Tests deferred from PR2's component coverage with rationale.

## C1 — passwords/{shared,entry,detail,detail/sections}

| file | rationale | decision-rule | evidence | date |
|---|---|---|---|---|
| `src/components/passwords/shared/folder-like.ts` | pure-types | §Skip decision tree (pure types skip rule) | exports `FolderLike` interface only — no runtime code | 2026-05-04 |

## C3 — team/**

| file | rationale | decision-rule | evidence | date |
|---|---|---|---|---|
| `src/components/team/forms/team-entry-dialog-shell.tsx` | barrel re-export | §Skip decision tree (barrel re-export rule) | single-line re-export of `EntryDialogShell` from `@/components/passwords/entry/entry-dialog-shell` | 2026-05-04 |

## C2 — passwords/{personal,dialogs,import,export}

| file | rationale | decision-rule | evidence | date |
|---|---|---|---|---|
| `src/components/passwords/dialogs/personal-password-edit-dialog-types.ts` | pure-types | §Skip decision tree (pure types skip rule) | exports `PersonalPasswordEditData` interface only — no runtime code | 2026-05-04 |
| `src/components/passwords/import/password-import-types.ts` | pure-types | §Skip decision tree (pure types skip rule) | exports `ImportTranslator`, `ParsedEntry`, `CsvFormat` types only — no runtime code | 2026-05-04 |
| `src/components/passwords/personal/personal-login-form-types.ts` | pure-types | §Skip decision tree (pure types skip rule) | exports `PersonalLoginFormInitialData`, `PersonalLoginFormProps` interfaces only — no runtime code | 2026-05-04 |
| `src/components/passwords/import/password-import-utils.ts` | barrel re-export | §Skip decision tree (barrel re-export rule) | re-exports from `password-import-{parsers,tags,payload,types}.ts` only — those modules are tested in their own siblings | 2026-05-04 |
| `src/components/passwords/personal/personal-entry-dialog-shell.tsx` | barrel re-export | §Skip decision tree (barrel re-export rule) | single-line re-export of `EntryDialogShell` (already tested in `entry/entry-dialog-shell.test.tsx`) | 2026-05-04 |
| `src/components/passwords/dialogs/personal-password-edit-dialog.tsx` | consolidated-test | §Skip decision tree | covered exhaustively by `personal-entry-dialogs.test.tsx` (entry-type → form mapping table for create + edit; verifies dialog title and form selection for every entry type) | 2026-05-04 |
| `src/components/passwords/dialogs/personal-password-new-dialog.tsx` | consolidated-test | §Skip decision tree | covered exhaustively by `personal-entry-dialogs.test.tsx` (entry-type → form mapping table for create + edit) | 2026-05-04 |
| `src/components/passwords/personal/personal-login-form.tsx` | consolidated-test | §Skip decision tree | covered by `personal-login-form-folder.test.tsx` (folder integration, submit body, IME guard) | 2026-05-04 |

## C3 — team/** (consolidated-test entries — F100 follow-up)

| file | rationale | decision-rule | evidence | date |
|---|---|---|---|---|
| `src/components/team/forms/team-bank-account-form.tsx` | consolidated-test | §Skip decision tree | covered by `team/forms/team-form-variants.test.tsx` (entry-type→form mapping; smoke render + R26 + §Sec-3 across all 7 entry-type forms) | 2026-05-04 |
| `src/components/team/forms/team-credit-card-form.tsx` | consolidated-test | §Skip decision tree | same — `team-form-variants.test.tsx` | 2026-05-04 |
| `src/components/team/forms/team-identity-form.tsx` | consolidated-test | §Skip decision tree | same — `team-form-variants.test.tsx` | 2026-05-04 |
| `src/components/team/forms/team-passkey-form.tsx` | consolidated-test | §Skip decision tree | same — `team-form-variants.test.tsx` | 2026-05-04 |
| `src/components/team/forms/team-secure-note-form.tsx` | consolidated-test | §Skip decision tree | same — `team-form-variants.test.tsx` | 2026-05-04 |
| `src/components/team/forms/team-software-license-form.tsx` | consolidated-test | §Skip decision tree | same — `team-form-variants.test.tsx` | 2026-05-04 |
| `src/components/team/forms/team-ssh-key-form.tsx` | consolidated-test | §Skip decision tree | same — `team-form-variants.test.tsx` | 2026-05-04 |

## test-infra exclusion

| file | rationale | decision-rule | evidence | date |
|---|---|---|---|---|
| `src/components/__tests__/webhook-card-test-factory.tsx` | test-infra | §Skip decision tree (test-infra rule) | declared as shared test factory at line 1; consumed BY component tests (member-info webhook variants), not a test target | 2026-05-04 |

## C6 — vault, layout, breakglass, watchtower, tags, emergency-access, admin, sessions, providers, folders

No skips for this batch. All 22 files in scope have sibling tests added in C6.

Notes recorded during implementation:
- `src/components/vault/passphrase-strength.ts` — labelKey vocabulary in source is `strengthWeak / strengthFair / strengthGood / strengthStrong` (no `strengthVeryStrong`); tests assert exact source labels per RT3.
- `src/components/breakglass/breakglass-dialog.tsx` — §Sec-2 sentinel-in-DOM does NOT apply: dialog accepts a free-text `reason` and `incidentRef` only, no passphrase/secret material. Recorded as in-test comment.
- `src/components/emergency-access/create-grant-dialog.tsx` — §Sec-2 sentinel-in-DOM does NOT apply: dialog accepts `granteeEmail` (not a secret).
- `src/components/admin/admin-{header,shell}.tsx` — neither component reads `useTeamVault`. The §Sec-3 cross-tenant denial is verified via prop-based fallback: passing `adminTeams=[], hasTenantRole=false` to `AdminShell` produces a render that forwards those values to `AdminSidebar` (where the empty/fallback render lives) without crashing or exposing resource data.
