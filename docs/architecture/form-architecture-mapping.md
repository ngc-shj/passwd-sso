# Form Architecture Mapping

This document fixes the current correspondence between Team Vault and Personal Vault form code.

## Goals

- Keep Team and Personal entry flows structurally aligned.
- Make corresponding files discoverable from their names alone.
- Keep data loading, dialog routing, and per-entry form logic separated.

## Current Correspondence

### Dialog Flow

| Responsibility | Team Vault | Personal Vault |
| --- | --- | --- |
| New dialog router | `src/components/team/team-new-dialog.tsx` | `src/components/passwords/personal-password-new-dialog.tsx` |
| Edit data loader | `src/app/[locale]/dashboard/teams/[teamId]/page.tsx` | `src/components/passwords/personal-password-edit-dialog-loader.tsx` |
| Edit dialog router | `src/components/team/team-edit-dialog.tsx` | `src/components/passwords/personal-password-edit-dialog.tsx` |

### Login Entry

| Responsibility | Team Vault | Personal Vault |
| --- | --- | --- |
| Login form component | `src/components/team/team-password-form.tsx` | `src/components/passwords/personal-password-form.tsx` |
| Login form model | `src/hooks/use-team-base-form-model.ts` + team password actions | `src/hooks/use-personal-login-form-model.ts` |
| Login state | `src/hooks/use-team-base-form-model.ts` + `src/hooks/use-team-password-form-ui-state.ts` | `src/hooks/use-personal-login-form-state.ts` |
| Login presenter | inline in Team-side model composition | `src/hooks/personal-login-form-presenter.ts` |
| Login controller | team password actions + submit flow | `src/hooks/personal-login-form-controller.ts` |
| Login derived state | team password form helpers | `src/hooks/personal-login-form-derived.ts` |
| Login initial values | `src/hooks/team-password-form-initial-values.ts` | `src/hooks/personal-login-form-initial-values.ts` |

### Shared Entry Sections

| Responsibility | Team Vault | Personal Vault |
| --- | --- | --- |
| Base form model | `src/hooks/use-team-base-form-model.ts` | `src/hooks/use-personal-base-form-model.ts` |
| Shared section props | `src/hooks/team-form-sections-props.ts` | `src/hooks/personal-form-sections-props.ts` |
| Tags and folder section | `src/components/team/team-tags-and-folder-section.tsx` | `src/components/passwords/entry-tags-and-folder-section.tsx` |

### Non-Login Entry Forms

| Team Vault | Personal Vault |
| --- | --- |
| `src/components/team/team-secure-note-form.tsx` | `src/components/passwords/personal-secure-note-form.tsx` |
| `src/components/team/team-credit-card-form.tsx` | `src/components/passwords/personal-credit-card-form.tsx` |
| `src/components/team/team-identity-form.tsx` | `src/components/passwords/personal-identity-form.tsx` |
| `src/components/team/team-passkey-form.tsx` | `src/components/passwords/personal-passkey-form.tsx` |
| `src/components/team/team-bank-account-form.tsx` | `src/components/passwords/personal-bank-account-form.tsx` |
| `src/components/team/team-software-license-form.tsx` | `src/components/passwords/personal-software-license-form.tsx` |

## Structural Rules

### Naming

- Team Vault files use the `team-` prefix.
- Personal Vault files use the `personal-` prefix.
- Personal login-specific hooks use the `personal-login-` or `use-personal-login-` prefix.
- Shared Personal non-login form state uses `use-personal-base-form-model.ts`.

### Responsibility Split

- Data fetch, decrypt, and normalization belong in a loader or page-level loader.
- Dialog components should be thin routers that switch by entry type.
- Per-entry form components should focus on rendering and form wiring.
- Derived state, submit args, and controller logic should live in hooks/helpers, not in dialog components.

### Expected Flow

- Team edit flow: `page -> team-edit-dialog -> team-* form`
- Personal edit flow: `personal-password-edit-dialog-loader -> personal-password-edit-dialog -> personal-* form`

## Rules For Future Changes

- When adding a Team form file, add the matching Personal form file with the same responsibility boundary.
- When renaming one side, rename the corresponding file on the other side in the same change when practical.
- Do not move fetch/decrypt logic back into thin dialog components.
- Prefer matching suffixes across Team and Personal files so grep-based lookup stays predictable.
