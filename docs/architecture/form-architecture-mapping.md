# Form Architecture Mapping

This document fixes the current correspondence between Team Vault and Personal Vault form code.

## Goals

- Keep Team and Personal entry flows structurally aligned.
- Make corresponding files discoverable from their names alone.
- Keep data loading, dialog routing, and per-entry form logic separated.

## Current Correspondence

This document distinguishes between:

- current aligned areas
- current mismatches that still need refactoring

### Dialog Flow

| Responsibility | Team Vault | Personal Vault |
| --- | --- | --- |
| New dialog router | `src/components/team/team-new-dialog.tsx` | `src/components/passwords/personal-password-new-dialog.tsx` |
| Edit data loader | `src/app/[locale]/dashboard/teams/[teamId]/page.tsx` | `src/components/passwords/personal-password-edit-dialog-loader.tsx` |
| Edit dialog router | `src/components/team/team-edit-dialog.tsx` | `src/components/passwords/personal-password-edit-dialog.tsx` |

### Dialog Flow Mismatch

- Team entry forms are now rendered inside `team-new-dialog.tsx` and `team-edit-dialog.tsx` through a shared dialog shell.
- Personal entry forms are rendered inside `personal-password-new-dialog.tsx` and `personal-password-edit-dialog.tsx`.
- Team edit data is loaded at page level, while Personal edit data is loaded in `personal-password-edit-dialog-loader.tsx`.
- `src/components/team/team-create-dialog.tsx` is a team creation dialog, not an entry form dialog, and should not be treated as a Team Vault entry-flow counterpart.

### Target Dialog Flow

- Team new flow: `team-new-dialog -> team-entry-dialog-shell -> team-* form body`
- Personal new flow: `personal-password-new-dialog -> personal-* form`
- Team edit flow: `page -> team-edit-dialog -> team-entry-dialog-shell -> team-* form body`
- Personal edit flow: `personal-password-edit-dialog-loader -> personal-password-edit-dialog -> personal-* form`

The target state is to make these boundaries more directly corresponding. At minimum:

- thin dialog router
- optional loader before edit
- per-entry form component focused on form state/rendering rather than shell orchestration

### Login Entry

| Responsibility | Team Vault | Personal Vault |
| --- | --- | --- |
| Login form component | `src/components/team/team-login-form.tsx` | `src/components/passwords/personal-login-form.tsx` |
| Login form types | `src/components/team/team-login-form-types.ts` | `src/components/passwords/personal-login-form-types.ts` |
| Login form model | `src/hooks/use-team-login-form-model.ts` | `src/hooks/use-personal-login-form-model.ts` |
| Login state | `src/hooks/use-team-login-form-state.ts` | `src/hooks/use-personal-login-form-state.ts` |
| Login presenter | `src/hooks/team-login-form-presenter.ts` | `src/hooks/personal-login-form-presenter.ts` |
| Login controller | `src/hooks/team-login-form-controller.ts` | `src/hooks/personal-login-form-controller.ts` |
| Login derived state | `src/hooks/team-login-form-derived.ts` | `src/hooks/personal-login-form-derived.ts` |
| Login field props | `src/hooks/team-login-fields-props.ts` | `src/hooks/personal-login-fields-props.ts` |
| Login initial values | `src/hooks/team-login-form-initial-values.ts` | `src/hooks/personal-login-form-initial-values.ts` |
| Login submit helper | `src/components/team/team-login-form-actions.ts` | `src/components/passwords/personal-login-submit.ts` |

### Login Entry Mismatch

- Personal login code is split into `model / state / presenter / controller / derived / fields`.
- Team login code now has matching `model / state / presenter / controller / derived / fields` helpers.
- Team login still shares common entry state through `use-team-base-form-model.ts`, while Personal keeps more of that composition inside the login model hook.

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
- Login-specific components and helpers should use the `*-login-*` infix where practical.
- Personal login-specific hooks use the `personal-login-` or `use-personal-login-` prefix.
- Team login-specific hooks use the `team-login-` or `use-team-login-` prefix.
- Shared Personal non-login form state uses `use-personal-base-form-model.ts`.

### Responsibility Split

- Data fetch, decrypt, and normalization belong in a loader or page-level loader.
- Dialog components should be thin routers that switch by entry type.
- Per-entry form components should focus on rendering and form wiring.
- Derived state, submit args, and controller logic should live in hooks/helpers, not in dialog components.

### Expected Flow

- Team edit flow today: `page -> team-edit-dialog -> team-entry-dialog-shell -> team-* form`
- Personal edit flow today: `personal-password-edit-dialog-loader -> personal-password-edit-dialog -> personal-* form`

## Refactor Targets

- Decide whether Team non-login flows should also gain per-entry model hooks, or continue to share `use-team-base-form-model.ts` directly.
- Keep Team creation flow separate from Team Vault entry flow.

## Rules For Future Changes

- When adding a Team form file, add the matching Personal form file with the same responsibility boundary.
- When renaming one side, rename the corresponding file on the other side in the same change when practical.
- Do not move fetch/decrypt logic back into thin dialog components.
- Prefer matching suffixes across Team and Personal files so grep-based lookup stays predictable.
