# Drop `team_policies.max_session_duration_minutes` (post-unify-session-timeout-policy cleanup)

Issue: https://github.com/ngc-shj/passwd-sso/issues/385
Predecessor PR: #384 (unify-session-timeout-policy)
Branch: `refactor/drop-max-session-duration-minutes`

## Project context

- **Type**: web app (Next.js 16 App Router + Prisma 7 + PostgreSQL 16)
- **Test infrastructure**: unit + integration + E2E + CI/CD (`scripts/pre-pr.sh`, vitest, Playwright, GitHub Actions)
- **Risk level**: low — purely additive deletion. The code path that read this column was already removed in PR #384 (`getStrictestSessionDuration` deletion). The data has already been migrated by the additive backfill in `20260418042050_unify_session_timeout_policy/migration.sql` (lines 27-30), so this migration deletes only a now-unread column.

## Objective

Remove every remaining trace of the deprecated `team_policies.max_session_duration_minutes` column / `maxSessionDurationMinutes` field. After this PR ships, no schema, API surface, validation schema, UI state, i18n key, or documentation should reference it.

## Requirements

### Functional
- F1. The `max_session_duration_minutes` column is dropped from `team_policies`.
- F2. `GET /api/teams/[teamId]/policy` no longer includes `maxSessionDurationMinutes` in the response body.
- F3. `PUT /api/teams/[teamId]/policy` silently strips `maxSessionDurationMinutes` if a legacy client still sends it. Zod's `z.object()` default mode is `.strip()` (unchanged across v3 → v4 — verified by reviewing the existing schema's behavior on unknown keys), so the field never reaches Prisma. A new unit test in `validations.test.ts` asserts this stripping behavior explicitly to lock in the contract.
- F4. The Prisma client no longer types `maxSessionDurationMinutes` on `TeamPolicy`.
- F5. The team policy UI state shape no longer carries `maxSessionDurationMinutes`.
- F6. The i18n `TeamPolicy.json` files (en + ja) no longer contain `maxSessionDurationMinutes`, `maxSessionDurationHelp`, or `maxSessionDurationRange` keys.
- F7. The deprecated row in `docs/security/policy-enforcement.md` is removed.
- F8. (Bundled fix per Anti-Deferral 30-min rule) GET and PUT responses for `/api/teams/[teamId]/policy` include `passwordHistoryCount`, `inheritTenantCidrs`, `teamAllowedCidrs` — the three fields the validation schema accepts and the upsert writes but the responses currently omit. Without this, saved values appear to revert to defaults on page reload (silent UI data loss).

### Non-functional
- NF1. No data loss for live `sessionAbsoluteTimeoutMinutes` values (data already copied; this migration only drops a redundant column).
- NF2. Pre-PR checks (`scripts/pre-pr.sh`, all 9/9) and CI must pass on a tree that contains both this PR's migration and the predecessor migration (PR #384).
- NF3. All test files asserting on the removed field must be updated; no orphan references may remain.
- NF4. `npm run db:migrate` must be runnable against an existing dev DB (with the predecessor migration already applied) and produce no drift.

## Technical approach

### Migration design
Single destructive migration: `ALTER TABLE "team_policies" DROP COLUMN "max_session_duration_minutes";`

This is safe because:
- The data was already copied to `session_absolute_timeout_minutes` by the predecessor migration (verified in `prisma/migrations/20260418042050_unify_session_timeout_policy/migration.sql` lines 27-30).
- No production code reads the column anymore. The former reader (`getStrictestSessionDuration`) was deleted in PR #384 batch B; the current resolver (`resolveEffectiveSessionTimeouts`) reads only the new columns.
- The remaining read-through paths (`getTeamPolicy`, GET handler, PUT handler) carry the value through for shape compatibility — they are removed in lockstep with the migration.

No `current_database()` indirection is needed — the DDL is environment-agnostic (R15 N/A).

### Prisma schema
Remove the field block (`prisma/schema.prisma` line 1358-1359):
```prisma
/// @deprecated — use sessionAbsoluteTimeoutMinutes; retained for one release, dropped in post-release cleanup migration
maxSessionDurationMinutes Int?    @map("max_session_duration_minutes")
```

### Validation schema (`src/lib/validations/team.ts`, `src/lib/validations/common.ts`)
- Remove `maxSessionDurationMinutes` from `upsertTeamPolicySchema` (`team.ts` line 134-135).
- Remove imports `POLICY_SESSION_DURATION_MIN`, `POLICY_SESSION_DURATION_MAX` from `team.ts` (lines 16-17). Confirmed sole consumer.
- Remove the constants themselves from `common.ts` (lines 151-152). Confirmed sole consumer is `team.ts`. Their values (5, 43200) duplicate `SESSION_IDLE_TIMEOUT_MIN` / `SESSION_ABSOLUTE_TIMEOUT_MAX`; keeping them produces drift hazards (R2).

### Read-through paths
- `src/app/api/teams/[teamId]/policy/route.ts` — remove the line from both the GET response (line 60) and PUT response (line 155), including the `@deprecated` JSDoc. **Also (F8 bundled fix)**: add `passwordHistoryCount`, `inheritTenantCidrs`, `teamAllowedCidrs` to BOTH the GET response (after the existing fields) and PUT response. These fields are accepted by `upsertTeamPolicySchema` and written by the upsert, but the responses currently omit them — causing UI silent data loss. Codebase-wide horizontal-expansion scan (subagent verified) found this is the only such mismatch in the codebase; all other API routes either return complete shapes or intentionally hide secrets/encrypted fields.
- `src/lib/team/team-policy.ts` — remove from `TeamPolicyData` interface (line 18), `DEFAULT_POLICY` (line 36), and the `getTeamPolicy` field mapping (line 71).
- `src/components/team/security/team-policy-settings.tsx` — remove from `PolicyData` interface (line 39) and `DEFAULT_POLICY` (line 57). The UI no longer renders this field, so no JSX changes are needed.

### i18n
Remove three keys from each of `messages/en/TeamPolicy.json` and `messages/ja/TeamPolicy.json`:
- `maxSessionDurationMinutes`
- `maxSessionDurationHelp`
- `maxSessionDurationRange` (orphan; not referenced from code — confirmed by grep)

Both locale files must remain key-balanced (matching keys count between en and ja).

### Tests to update
| File | Lines | Change |
|------|-------|--------|
| `src/__tests__/api/teams/team-policy.test.ts` | 138, 217 | Remove from mocked-DB-row literal and PUT body literal |
| `src/lib/team/team-policy.test.ts` | 63, 89, 107, 202 | Remove from `fullPolicy` fixture, `restrictivePolicy` fixture, default-policy `toEqual` shape, and the `expect(policy.maxSessionDurationMinutes).toBe(60)` assertion |
| `src/app/api/teams/[teamId]/policy/route.test.ts` | 84, 127, 144, 248 | Remove `maxSessionDurationMinutes` from `DEFAULT_RESPONSE`, mocked-DB-row literal, the explicit assertion line, and the idempotent-PUT body literal. **Also (F8)**: add `passwordHistoryCount: 0`, `inheritTenantCidrs: true`, `teamAllowedCidrs: []` to `DEFAULT_RESPONSE` (locks in the new exact-shape contract), and add at least one assertion verifying the GET response surfaces `passwordHistoryCount` / `inheritTenantCidrs` / `teamAllowedCidrs` from the DB row (regression sentinel for F8). |
| `src/lib/validations/validations.test.ts` | 361, 384-389 | Remove from `valid` fixture; delete the two `it("rejects/accepts ... maxSessionDurationMinutes")` tests entirely; **add** a new test asserting `upsertTeamPolicySchema.parse({ ...valid, maxSessionDurationMinutes: 60 })` returns an object **without** `maxSessionDurationMinutes` (locks in the strip-on-unknown-key contract for legacy clients — F3) |

The issue's task list mentions `src/components/team/team-policy-settings.test.ts`, but the file does not contain any reference to `maxSessionDurationMinutes` (verified by grep). No change there.

### Documentation
- `docs/security/policy-enforcement.md` line 54 — delete the `| `maxSessionDurationMinutes` | — | — | — | **Deprecated.** ... |` row.
- `docs/security/session-timeout-design.md` — no change. The doc already describes `maxSessionDurationMinutes` as removed (line 56) and references it only in the historical "before" section (line 11) and the explicit "Removed" section (line 61). Keep these as historical context.
- `docs/archive/review/*.md` — no change. Archive docs are historical records of past plans/PRs; do not rewrite them.

## Implementation steps

1. **Branch**: `git checkout main && git pull && git checkout -b refactor/drop-max-session-duration-minutes`.
2. **Create migration directory**: `prisma/migrations/20260425190000_drop_team_policies_max_session_duration_minutes/migration.sql` containing the single `DROP COLUMN` statement.
3. **Run `npx prisma migrate dev --name drop_team_policies_max_session_duration_minutes`** against the local dev DB to confirm the migration applies cleanly. Verify `_prisma_migrations` records the new migration. Per memory `feedback_run_migration_on_dev_db.md`, this must be done on a real DB before PR.
4. **Update `prisma/schema.prisma`**: delete the deprecated field + its JSDoc comment.
5. **Run `npx prisma generate`** to refresh the client. Per memory `feedback_prisma_generate_branch_switch.md`, this is needed after any schema change to refresh the cached client.
6. **Run `npm run test:integration`** (T6) to verify Prisma client + DB schema consistency against the migrated dev DB. Conditional: requires reachable dev Postgres; if Postgres is unreachable, defer to CI's `ci-integration.yml` job. This step catches stale Prisma cache and migration mismatches that unit tests cannot detect.
7. **Update `src/lib/team/team-policy.ts`**: remove field from interface (line 18) **and the preceding `@deprecated` JSDoc on line 17**, from `DEFAULT_POLICY` (line 36), and from the `getTeamPolicy` mapping (line 71).
8. **Update `src/lib/validations/team.ts`**: remove field from `upsertTeamPolicySchema` (line 135) **and the preceding `@deprecated` JSDoc on line 134**; drop the now-unused imports (`POLICY_SESSION_DURATION_MIN`, `POLICY_SESSION_DURATION_MAX`).
9. **Update `src/lib/validations/common.ts`**: remove `POLICY_SESSION_DURATION_MIN` and `POLICY_SESSION_DURATION_MAX` constants.
10. **Update `src/app/api/teams/[teamId]/policy/route.ts`**: (a) remove `maxSessionDurationMinutes` from both responses (GET line 60 + PUT line 155), including the preceding `@deprecated` JSDoc on lines 59 and 154. (b) **F8 bundled fix**: add `passwordHistoryCount`, `inheritTenantCidrs`, `teamAllowedCidrs` to BOTH the GET response (with appropriate `?? defaultValue` fallbacks: `passwordHistoryCount ?? 0`, `inheritTenantCidrs ?? true`, `teamAllowedCidrs ?? []`) and PUT response (`policy.passwordHistoryCount`, `policy.inheritTenantCidrs`, `policy.teamAllowedCidrs`). Place them after the existing `requireSharePassword` field for consistency.
11. **Update `src/components/team/security/team-policy-settings.tsx`**: remove field from `PolicyData` interface (line 39) **and the preceding `@deprecated` JSDoc on line 38**, and from `DEFAULT_POLICY` (line 57).
12. **Update i18n files**: delete three keys from each of `messages/{en,ja}/TeamPolicy.json`. Verify key count parity.
13. **Update tests**: apply the table above (4 files), including the new strip-on-unknown-key test in `validations.test.ts` using the form below (T4):
    ```ts
    it("strips legacy maxSessionDurationMinutes (graceful degradation for old clients)", () => {
      const result = upsertTeamPolicySchema.safeParse({ ...valid, maxSessionDurationMinutes: 60 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect("maxSessionDurationMinutes" in result.data).toBe(false);
      }
    });
    ```
    Use the `in` operator (not `toBeUndefined`) — Zod `.strip()` removes the key entirely, not just sets it to undefined.
14. **Update `docs/security/policy-enforcement.md`**: delete the deprecated table row.
15. **Run `npx vitest run`** — all unit tests pass.
16. **Run `npx next build`** — production build succeeds (catches TypeScript errors that vitest does not, per CLAUDE.md mandatory check).
17. **Run `scripts/pre-pr.sh`** — all 9/9 checks pass (per memory `feedback_run_pre_pr_before_push.md`).
18. **Commit + push** with conventional commit message: `refactor: drop deprecated team_policies.max_session_duration_minutes (#385)`.

## Testing strategy

### Unit tests
- All four test files in the table above are updated to remove the field. No new tests are added — there is nothing new to test; this PR removes paths.

### Integration tests
- The migration's correctness is implicitly verified by step 3 (run on dev DB) and CI (which applies all migrations from a clean DB).
- `src/__tests__/db-integration/session-timeout.integration.test.ts` (referenced in PR #384's review) exists for the predecessor migration. No change needed — that test verifies the post-unify state, which already shows `sessionAbsoluteTimeoutMinutes` populated. Once the legacy column is gone, the post-unify assertions still hold.

### Manual smoke
- Open the team security policy page (`/[locale]/teams/[teamId]/settings/security`). Verify it loads without console errors and the "max session duration" field is absent (it was never rendered in the UI after PR #384 anyway, but the page must still hydrate cleanly).
- Submit a policy update (PUT). Verify it succeeds and the response body no longer contains `maxSessionDurationMinutes`.

### Build verification (mandatory per CLAUDE.md)
- `npx next build` must complete without TypeScript or bundling errors.

## Considerations & constraints

### Out of scope
- Renaming `POLICY_SESSION_DURATION_MIN/MAX` callers other than `team.ts` — there are none (verified: `grep -rn POLICY_SESSION_DURATION_MIN` returns only `common.ts` definition + `team.ts` import + the line being deleted).
- Renaming the new fields (`sessionIdleTimeoutMinutes` / `sessionAbsoluteTimeoutMinutes`) — they are the canonical names.
- Updating CLI / extension — neither references this column (verified by `grep -rn maxSessionDurationMinutes cli/ extension/`).
- Updating OpenAPI spec — verified no reference: `grep -n "team\|policy\|TeamPolicy\|maxSessionDurationMinutes" src/lib/openapi-spec.ts` returns nothing. The team-policy API is not part of the public REST API v1 (it is only at `/api/teams/[teamId]/policy`, internal use only).
- Adding an automated i18n key-parity test — the repo has no such generic test today. Out of scope for this cleanup PR; the manual verification step (counting keys in en + ja `TeamPolicy.json`) is sufficient because we are *removing* keys symmetrically from both files in the same diff.

### Bundled fix (F8)
- The GET/PUT responses for `/api/teams/[teamId]/policy` currently omit three fields (`passwordHistoryCount`, `inheritTenantCidrs`, `teamAllowedCidrs`) that the schema accepts and the upsert writes. The UI renders editable controls for all three; without echoing them in the response, the UI defaults them on every page load — silently losing the user's saved values from the user's perspective.
- This is a pre-existing bug in a file the cleanup PR already modifies. Per Anti-Deferral 30-min rule (under 30 min to fix, file is in scope), the fix is bundled into this PR rather than deferred.
- Horizontal expansion: a codebase-wide scan (Explore subagent) confirmed no other route handler exhibits this pattern — all other "validation-accepts but response-omits" cases in the codebase are intentional (secrets, encrypted blobs, server-side hashes).

### Risks
- **R1 (Shared utility reimplementation)**: N/A — pure deletion.
- **R2 (Constants hardcoded)**: addressed — `POLICY_SESSION_DURATION_MIN/MAX` constants are removed.
- **R3 (Pattern propagation)**: enumerated all references via `grep -rn maxSessionDurationMinutes max_session_duration_minutes` (results above). No instance is silently retained.
- **R7 (E2E selector breakage)**: N/A — the field has no UI control; no `data-testid` / `aria-label` is being removed.
- **R12 (i18n key parity)**: explicit obligation — verify en + ja have identical keys post-edit.
- **R15 (hardcoded env values)**: the migration uses the table name `team_policies` directly, which is universal across environments (Prisma maps the same name on dev/CI/prod). No `current_database()` template needed.
- **R19 (test mock alignment)**: addressed — the four test files are explicitly updated.
- **R24 (additive + strict in one migration)**: N/A — this is a single destructive `DROP COLUMN`. The two-step model required by R24 was already followed across PR #384 (additive) → this PR (strict drop).

### Rollback
- This migration is **not** safely reversible (column drop is destructive). If a regression is found post-deploy that requires the legacy column, the path is forward-fix (re-add column + re-deploy), not roll back. This is acceptable because:
  - The column has been unread for one release (PR #384 to current).
  - Data has been migrated to `session_absolute_timeout_minutes`.
  - The cleanup was deliberately deferred from PR #384 specifically to provide a one-release rollback window for #384 itself; that window has now passed.

### Database migration parity
- Per memory `feedback_run_migration_on_dev_db.md`: step 3 runs `npx prisma migrate dev` against the dev DB before opening the PR. CI re-applies it from a clean state.

## User operation scenarios

### Scenario A: Tenant admin opens team security policy page after the deploy
1. User navigates to `/ja/teams/{teamId}/settings/security`.
2. Page calls `GET /api/teams/[teamId]/policy`.
3. Response no longer contains `maxSessionDurationMinutes`. The UI ignores unknown keys (it never displayed this one).
4. UI renders the existing controls: minPasswordLength, requireUppercase/Lowercase/Numbers/Symbols, sessionIdleTimeoutMinutes, sessionAbsoluteTimeoutMinutes, requireRepromptForAll, allowExport, allowSharing, requireSharePassword, passwordHistoryCount, inheritTenantCidrs, teamAllowedCidrs.
5. Save policy → `PUT /api/teams/[teamId]/policy` with the new field set, no legacy field. 200 OK.
6. (F8) The PUT response now includes `passwordHistoryCount`, `inheritTenantCidrs`, `teamAllowedCidrs`, so subsequent GET (or page reload) surfaces the saved values correctly. Before this fix, those values were silently reset to defaults on reload.

### Scenario B: API consumer that still sends the legacy field
1. External script sends `PUT /api/teams/[teamId]/policy` with body `{ "maxSessionDurationMinutes": 60, ... }`.
2. The zod schema strips unknown keys by default (zod 4 default behavior — verify with a one-liner test).
3. Request succeeds; the legacy field is silently ignored. This is the intended graceful-degradation path.
4. Note: if the external consumer was *relying* on this field for enforcement, they were already broken since PR #384 (no enforcement reads it). No new break.

### Scenario C: Developer pulls this branch and runs the dev server
1. `git checkout refactor/drop-max-session-duration-minutes && npm install`.
2. `npm run db:migrate` — applies the new migration on the dev DB.
3. `npx prisma generate` — refreshes the client.
4. `npm run dev` — server starts. TypeScript compiles cleanly because all references were removed in lockstep.

### Scenario D: CI runs against a clean DB
1. CI creates a fresh DB.
2. Prisma applies all migrations in order: `…20260418042050_unify_session_timeout_policy` (which adds `session_absolute_timeout_minutes` and writes `UPDATE … SET session_absolute_timeout_minutes = max_session_duration_minutes WHERE …`), then `…20260425190000_drop_team_policies_max_session_duration_minutes` (which drops the column).
3. The data preservation logic is in the predecessor migration, which always runs first. The cleanup migration succeeds because the column exists.
4. Tests run against the post-cleanup schema.
