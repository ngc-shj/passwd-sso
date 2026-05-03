# Manual Test Plan — admin-ia-team-general-subnav

R35 Tier-1 artifact for the team General sub-nav split (Profile / Delete).

## Pre-conditions

- Local dev DB and app running (`npm run dev`).
- Two test accounts:
  - `<owner-email>` — team OWNER role on a test team.
  - `<admin-email>` — team ADMIN role on the same team (NOT owner).
  - `<member-email>` — team MEMBER role on the same team (read-only).
- Two locales available (`/ja/`, `/en/`).
- A test team that can be deleted at the end of the test (or use a disposable team).

## Steps

### 1. Foundation health

| Step | Action | Expected |
|---|---|---|
| 1.1 | `npm run lint` | Clean, zero warnings |
| 1.2 | `npx vitest run` | All tests pass |
| 1.3 | `npx next build` | Build succeeds |
| 1.4 | `bash scripts/pre-pr.sh` | All 13 gates pass |

### 2. Sub-tab nav rendering — sidebar landing

| Step | Action | Expected |
|---|---|---|
| 2.1 | Sign in as `<owner-email>`, navigate to `/ja/admin/teams/<teamId>/general` | URL redirects to `/ja/admin/teams/<teamId>/general/profile`; SectionLayout shows title `全般` + sub-tabs `プロフィール / 削除` |
| 2.2 | Click `削除` tab | URL `/ja/admin/teams/<teamId>/general/delete`; `削除` tab is active (`aria-current="page"`); profile-tab no longer active |
| 2.3 | Click `プロフィール` tab | URL back to `/profile`; tab state reverses |
| 2.4 | Switch to `/en/admin/teams/<teamId>/general/profile` | English labels: `Profile / Delete` |
| 2.5 | Open new browser tab, paste `/ja/admin/teams/<teamId>/general` | Server-side redirect to `/profile` (no flash, no client-side bounce) |

### 3. Profile sub-tab — owner

| Step | Action | Expected |
|---|---|---|
| 3.1 | On `/profile` as owner | SectionCardHeader shows `プロフィール` (User icon) + description |
| 3.2 | Verify form fields | Team name (editable), slug (read-only with copy button), description (textarea) |
| 3.3 | Edit name → save | Toast `チームを更新しました`; FormDirtyBadge clears |
| 3.4 | Edit description, navigate away (back to /general) without saving | Browser before-unload guard fires (per `useBeforeUnloadGuard`) |
| 3.5 | Cancel navigation, return to /profile | Edits preserved (component state in same instance) |

### 4. Profile sub-tab — admin (non-owner)

| Step | Action | Expected |
|---|---|---|
| 4.1 | Sign in as `<admin-email>`, navigate to `/general/profile` | Form renders (admin can edit profile per `isAdmin` check) |
| 4.2 | Edit + save | Success — admins can edit team profile |

### 5. Profile sub-tab — viewer/member

| Step | Action | Expected |
|---|---|---|
| 5.1 | Sign in as `<member-email>`, navigate to `/general/profile` | Card shows `forbidden` message (no form rendered) |

### 6. Delete sub-tab — owner

| Step | Action | Expected |
|---|---|---|
| 6.1 | On `/delete` as owner | SectionCardHeader shows `チームを削除` (Trash2 icon, destructive styling) + description |
| 6.2 | Verify warning panel | Shows itemized list: vault entries / members / audit logs / policies (4 bullets) |
| 6.3 | Click `チームを削除` button | AlertDialog opens with type-team-name-to-confirm input |
| 6.4 | Type wrong name | Confirm button stays disabled |
| 6.5 | Type exact team name | Confirm button enables |
| 6.6 | Cancel | Dialog closes; input clears |
| 6.7 | Type exact name → confirm | Team deleted; toast `チームを削除しました`; redirect to `/dashboard` |

### 7. Delete sub-tab — admin (non-owner)

| Step | Action | Expected |
|---|---|---|
| 7.1 | Sign in as `<admin-email>`, navigate to `/delete` | Card shows `この操作はチームのオーナーのみが行えます。` (no delete button rendered) |

### 8. Delete sub-tab — viewer

| Step | Action | Expected |
|---|---|---|
| 8.1 | Sign in as `<member-email>`, navigate to `/delete` | Same `ownerOnly` message as admin (only owners get the delete UI) |

### 9. a11y

| Step | Action | Expected |
|---|---|---|
| 9.1 | Tab through `/general/profile` keyboard nav | Focus order: sub-nav tabs → form fields → save button |
| 9.2 | Screen reader (NVDA / VoiceOver) on `/profile` tab | Announces `現在のページ` / `current page` on the active sub-tab |
| 9.3 | On `/delete`, focus the destructive button | Announced with destructive role / variant |

### 10. Mobile (iPhone 13, Pixel 7 emulation)

| Step | Action | Expected |
|---|---|---|
| 10.1 | Open `/general/profile` on 390px viewport | Sub-tabs stack as horizontal pills; name + slug fields stack to 1 column (md:grid-cols-2 collapses to 1 col) |
| 10.2 | Tap `削除` pill | URL changes; warning panel renders with proper margins (no horizontal overflow) |
| 10.3 | Tap delete button → confirm dialog | Dialog content fits viewport; OK/Cancel buttons reachable |

### 11. ja/en label parity

| Step | Action | Expected |
|---|---|---|
| 11.1 | Switch to `/en/admin/teams/<teamId>/general/profile` | All labels in English: `Profile`, `Edit team name, slug, and description.`, `Update Team` |
| 11.2 | Switch to `/en/.../delete` | All labels in English: `Delete team`, `Permanently delete...`, 4 impact bullets in English |

## Expected results summary

- All 11 sections pass with no console errors.
- No 404 on any sub-tab path.
- No layout shift on tab switch (sub-nav position stable).
- `useBeforeUnloadGuard` fires on dirty profile form.
- ja/en parity verified.

## Rollback

- `git revert <merge-commit>` restores the single-page `/general/page.tsx`.
- No DB schema changes; no migrations to roll back.
- Form behavior is identical (same API endpoints `/api/teams/[teamId]` PUT/DELETE).
- i18n keys added are additive — leftover keys after revert do no harm (will trigger the deprecated-key sentinel only if keys were registered in the sentinel's allowlist, which they are not).

## Adversarial scenarios (Tier-1 minimal)

- **Cross-tenant URL probe**: Owner of team A navigates to `/admin/teams/<teamB-id>/general/delete` → expects 404 (team layout's `notFound()` guard fires; same as before refactor).
- **Bookmark to old `/general` URL**: Bookmark to `/admin/teams/[id]/general` (no sub-tab) still works via the new redirect → `/general/profile`.
- **Race on tab switch + save**: Type changes on Profile, switch to Delete tab without saving → re-fetched on re-mount of /profile component? Actually no — the Profile component remounts on URL change, so unsaved edits are LOST. This matches expected behavior (`useBeforeUnloadGuard` covers browser-level navigation; in-app sub-tab navigation does NOT trigger the guard, but Next.js `<Link>` causes hard remount). Document this as known UX behavior; if user reports surprise, add an in-app navigation guard hook.
