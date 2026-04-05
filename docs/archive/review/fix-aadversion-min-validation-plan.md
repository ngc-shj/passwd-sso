# Plan: fix-aadversion-min-validation

## Objective

Close a server-side validation gap where `aadVersion: 0` can be explicitly sent to
`/api/passwords` (POST), `/api/v1/passwords` (POST), and `/api/passwords/[id]` (PUT),
bypassing the AAD-binding requirement.

## Background

- `createTeamE2EPasswordSchema` already enforces `min(1)` — this fix aligns the
  personal-entry schemas to the same standard.
- All client-side code (`personal-entry-save.ts`, `password-import-importer.ts`,
  `extension/login-save.ts`) already sends `aadVersion: 1`. No client breakage expected.
- Legacy entries with `aadVersion: 0` exist in the DB but are never re-created;
  they are only read. DB data is not affected by input validation.

## Requirements

1. `createE2EPasswordSchema.aadVersion` must reject values below 1
2. `updateE2EPasswordSchema.aadVersion` must reject values below 1
3. Existing tests that assert `aadVersion: 0` is accepted must be updated
4. No regression in normal create/update flows

## Technical Approach

### Schema changes (`src/lib/validations/entry.ts`)

- Line 45: `min(0)` → `min(1)`
- Line 61: `min(0)` → `min(1)`
- The refine on line 53 remains valid: with default(1), omitting `aadVersion` yields 1,
  so `(1 < 1) = false` and `!!d.id` must be true — correct behavior.

### Test updates

| File | Change |
|------|--------|
| `src/lib/validations.test.ts:90-93` | "id is optional when aadVersion=0" → test that aadVersion=0 is **rejected** |
| `src/lib/validations/validations.test.ts:698-701` | "accepts aadVersion=0 without id" → test that aadVersion=0 is **rejected** |
| `src/app/api/passwords/route.test.ts:460-484` | "creates entry without id (legacy aadVersion=0)" → remove or change to expect 400 |

### Files NOT changed

- Route handler tests with `aadVersion: 0` in **mock DB responses** (e.g., history, attachments,
  rotate-key) — these don't go through input validation
- `createTeamE2EPasswordSchema` — already has `min(1)`

## Testing Strategy

1. `npx vitest run` — all tests pass
2. `npx next build` — production build succeeds

## Considerations

- The refine condition `(d.aadVersion ?? 0) < 1 || !!d.id` becomes slightly redundant
  since `aadVersion` can't be 0 with `min(1)` + `default(1)`. However, keeping it
  provides defense-in-depth and serves as documentation. No change needed.
