# Plan Review: drop-max-session-duration-minutes
Date: 2026-04-25
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings

### F1 [Minor]: Line-number imprecisions in plan
- Plan's documented line numbers slightly off in places. validations.test.ts: claim "361, 384-389" — actual: 361 (valid fixture), 384-386 (reject test), 388-390 (accept test, ends at 390). team-policy.test.ts ordering of bullets misstated.
- Impact: Implementer momentarily confused; zero functional impact.
- Fix: Update with exact ranges (or skip — implementer can find via grep).

### F2 [Minor]: Wording about "third assertion site"
- The phrase in `Tests to update` table for `team-policy.test.ts` could be clarified — no third assertion site to update.
- Impact: None.
- Fix: Optional clarification.

### F4 [Major]: Pre-existing bug in changed file — GET/PUT responses omit 3 fields the UI fully edits
- File: `src/app/api/teams/[teamId]/policy/route.ts:53-67` and `route.ts:148-162`
- Evidence: This PR modifies the same response objects to remove `maxSessionDurationMinutes`. The same response objects also omit `passwordHistoryCount`, `inheritTenantCidrs`, `teamAllowedCidrs` while the UI (`team-policy-settings.tsx:376-412`) renders editable controls for all three. The component does `setPolicy({ ...DEFAULT_POLICY, ...data })`, so missing keys silently fall back to defaults.
- Problem: Pre-existing — the route handler omits 3 fields from both GET and PUT responses while the UI fully supports editing them. The DB persists the values (validation accepts them, upsert writes them), but the API response shape never exposes them.
- Impact: Users editing these fields see correct values in the same session, but on the next page load the GET response returns no value for them, defaulting them in the UI. Their actual saved values are silently invisible.
- Fix: Either (a) add the three missing fields to both GET and PUT responses (< 10 LOC, < 30 min); OR (b) defer with explicit Anti-Deferral routing + TODO marker.

### F5 [Minor]: Plan does not mention `@deprecated` JSDoc removal on UI types
- Files: `src/components/team/security/team-policy-settings.tsx:38`, `src/lib/team/team-policy.ts:17`, `src/lib/validations/team.ts:134`
- Plan steps 6, 7, 10 mention removing the field but not the JSDoc one line above.
- Fix: Update plan steps to explicitly mention "and the preceding `@deprecated` JSDoc comment."

### F3, F6-F9: Verification findings — claims accurate, no issues.

## Security Findings

No findings.

### Verification summary
1. `getStrictestSessionDuration` deletion confirmed.
2. `resolveEffectiveSessionTimeouts` reads only the new columns (`src/lib/auth/session/session-timeout.ts:71-83`). Session-lifetime enforcement does not regress.
3. Predecessor migration backfills data (verified at `prisma/migrations/20260418042050_unify_session_timeout_policy/migration.sql:27-30`).
4. Migration is irreversible by design and adequately documented.
5. Audit-trail check: `metadata: result.data` after Zod strips will simply omit the legacy key. Historical JSONB rows remain valid. No audit-trail break.
6. R3 propagation sweep enumerated all 25 references — plan covers all in-scope sites; the two SQL migration files correctly excluded from change set.

## Testing Findings

### T4 [Minor]: Suggested concrete form for new strip-on-unknown-key test
- Use `expect("maxSessionDurationMinutes" in result.data).toBe(false)` rather than `toBeUndefined()` — Zod `.strip()` removes the key entirely, not just sets it to undefined. The `in` operator is the precise contract assertion.
- Concrete form:
  ```ts
  it("strips legacy maxSessionDurationMinutes (graceful degradation for old clients)", () => {
    const result = upsertTeamPolicySchema.safeParse({ ...valid, maxSessionDurationMinutes: 60 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("maxSessionDurationMinutes" in result.data).toBe(false);
    }
  });
  ```

### T6 [Minor]: Add `npm run test:integration` to implementation steps
- Plan step 14 says `npx vitest run` but does not mention `npm run test:integration`. The integration test exercises real Prisma client + real DB schema and is the only check that detects schema/Prisma-client/DB drift before CI.
- Fix: Insert a step between current steps 5 and 6 (after `npx prisma generate`): "Run `npm run test:integration` to verify Prisma client + DB schema consistency. Conditional: requires reachable dev Postgres."

### T1, T2, T3, T5, T7, T8: Verification findings — claims accurate.

### T9 [Adjacent → Functionality]: `@deprecated` JSDoc removal — overlaps with F5 (merged).

## Adjacent Findings

- T9 → merged into F5 (Functionality scope: complete `@deprecated` JSDoc removal across all locations).
- F4 [Major] → **Resolution: Option A (bundled fix)**. Per Anti-Deferral 30-min rule, the fix is included in this PR as F8 in the plan's Requirements. Horizontal-expansion scan via Explore subagent confirmed no other API route in the codebase exhibits the same "validation-accepts but response-omits user-editable field" pattern — all other cases are intentional (server-side secrets, encrypted blobs).

## Quality Warnings

No quality warnings.

## Recurring Issue Check

### Functionality expert
- R1: N/A — pure deletion
- R2: Checked — POLICY_SESSION_DURATION_MIN/MAX removed in lockstep
- R3: Checked — all references enumerated; F4 flags a related propagation gap on adjacent fields
- R4: N/A
- R5: N/A
- R6: N/A — DROP COLUMN only
- R7: N/A
- R8: N/A
- R9: N/A
- R10: N/A
- R11: N/A
- R12: N/A
- R13: N/A
- R14: N/A
- R15: N/A — universal table name
- R16: Checked
- R17: N/A
- R18: N/A
- R19: Checked — exact-shape sites: route.test.ts:117, team-policy.test.ts:83
- R20: N/A
- R21: N/A — plan requires vitest + next build + pre-pr.sh
- R22: N/A
- R23: N/A
- R24: Checked — second step of two-step pattern
- R25: N/A
- R26: N/A
- R27: Checked — orphan i18n key being removed
- R28: N/A
- R29: N/A
- R30: Checked

### Security expert
- R1: N/A
- R2: Checked
- R3: Checked
- R4-R13: N/A
- R14: N/A — passwd_user (SUPERUSER) runs DROP COLUMN cleanly
- R15: Checked — universal across environments
- R16: Checked
- R17, R18: N/A
- R19: Checked
- R20: N/A
- R21: N/A at plan stage
- R22, R23: N/A
- R24: Checked — second step
- R25-R30: N/A or Checked
- RS1: N/A
- RS2: N/A
- RS3: Checked — Zod default `.strip()` enforces graceful degradation

### Testing expert
- R1-R18: N/A or Checked (no relevant patterns triggered)
- R19: Checked — exact-shape assertion sites enumerated
- R20: N/A
- R21: N/A — plan covers vitest + next build + pre-pr.sh; T6 recommends adding integration test
- R22-R30: N/A or Checked
- RT1: Checked — mocks align with post-drop schema after plan's edits
- RT2: Checked — new test is testable
- RT3: Checked — bare string literal correct (no shared constant exists)
