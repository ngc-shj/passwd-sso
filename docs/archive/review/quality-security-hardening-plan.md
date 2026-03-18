# Plan: quality-security-hardening

## Context

8 open issues (#37, #27, #54, #38, #51, #56, #55, #32) remain from the production-readiness backlog. These span test quality, CI security, documentation, and technical debt. Most are partially done or need small targeted work. This batch resolves them all.

## Objective

Close issues #37, #27, #54, #38, #51, #56, #55, #32 by completing their remaining DoD items.

## Requirements

### Functional
- F1: ESLint rule forbids `if (...) { expect(...) }` patterns in e2e tests (#37)
- F2: password-crud tests use `test.step` to make chain explicit (#27)
- F3: vault-reset "wrong confirmation" test uses dedicated user (#27)
- F4: vitest coverage includes component layer; coverage policy documented (#54)
- F5: Extension token API responses validated with Zod schemas (#38)
- F6: CI triage policy and procedures documented (#51)
- F7: Key material memory handling user-facing docs completed (#56)
- F8: Redis HA failover test procedure documented; incident runbook updated (#55)
- F9: Debt ledger issue #32 reviewed and closed with child issues tracked (#32)

### Non-functional
- All existing tests pass
- Production build succeeds
- No new lint warnings

## Technical Approach

### Step 1: ESLint rule for conditional assertion skip (#37)

**File**: `eslint.config.mjs`

Add a **separate** config block with `files: ["e2e/**/*.spec.ts"]` containing `no-restricted-syntax` rule:
- Selector: `IfStatement > BlockStatement > ExpressionStatement > CallExpression[callee.object.name='expect']`
- Also catch: `IfStatement > ExpressionStatement > CallExpression[callee.object.name='expect']`
- Message: "Do not wrap expect() in conditionals — this silently skips assertions."

Must be an independent block (not merged into the existing component-scoped block).

Verify: `npx eslint e2e/tests/` passes, and `npx eslint src/components/` still works.

### Step 2: E2E test isolation — password-crud (#27)

**File**: `e2e/tests/password-crud.spec.ts`

Consolidate 4 chained tests (create → view → edit → delete) into a single test with `test.step`:
```ts
test("CRUD lifecycle", async ({ page }) => {
  await test.step("create", async () => { ... });
  await test.step("view", async () => { ... });
  await test.step("edit", async () => { ... });
  await test.step("delete", async () => { ... });
});
```
Move `beforeEach` vault unlock logic into the test body (setup before first step). Remove `IMPROVE(#27)` comment and the `describe` wrapper (single test needs no describe).

### Step 3: E2E test isolation — vault-reset (#27)

**Files**: `e2e/helpers/fixtures.ts`, `e2e/helpers/db.ts`, `e2e/global-setup.ts`, `e2e/tests/vault-reset.spec.ts`

Add `resetValidation` user to:
1. `e2e/helpers/db.ts` — add to `TEST_USERS` constant
2. `e2e/helpers/fixtures.ts` — add to `AuthState` interface
3. `e2e/global-setup.ts` — seed the 5th user and include in `.auth-state.json`
4. `e2e/tests/vault-reset.spec.ts` — use `resetValidation` instead of `vaultReady`

Remove `IMPROVE(#27)` comment.

### Step 4: Coverage expansion (#54)

**File**: `vitest.config.ts`

Add component paths to `coverage.include`:
```
"src/components/**/*.{ts,tsx}"
```
Add to `coverage.exclude`:
```
"src/components/**/*.test.{ts,tsx}"
```

**Pre-check**: Run `npx vitest run --coverage` after adding to verify global 60% threshold is still met. If not, adjust threshold downward with a note to incrementally raise it.

Update `docs/architecture/production-readiness.md`:
- Item 4.2: Status → "Done"
- Note: "Component and crypto layers included in coverage targets. Coverage threshold: 60% lines (global), 80% for critical crypto/auth modules."

### Step 5: Extension response runtime validation (#38)

**Files**: `src/app/api/extension/token/route.ts`, `src/app/api/extension/token/refresh/route.ts`

Add Zod schemas in a shared location (e.g. inline or `src/lib/extension-token-schema.ts`) for POST and DELETE responses. Apply to both `/token` and `/token/refresh` endpoints (same response shape):
```ts
const TokenIssueResponse = z.object({
  token: z.string(),
  expiresAt: z.string().datetime(),
  scope: z.array(z.string()),
});

const TokenRevokeResponse = z.object({
  ok: z.literal(true),
});
```

Parse response data through schemas before returning. On validation failure, log error and return 500.

Add test cases in existing `route.test.ts` to verify full response shape (use `toMatchObject` or Zod `safeParse` assertion).

### Step 6: CI security scan triage documentation (#51)

**File**: `docs/security/vulnerability-triage.md` (new)

Content:
- Severity mapping (Critical/High/Medium/Low → action timeline)
- Triage workflow (who reviews, how to suppress false positives)
- npm audit vs Trivy scope differences
- Escalation path for Critical findings
- Extension token scope-based severity classification (e.g. `vault:unlock-data` → High/Critical)

Update `docs/architecture/production-readiness.md`:
- Item 4.4: Status → "Done"

### Step 7: Key material memory management documentation (#56)

**File**: `docs/security/considerations/en.md` (update existing Section 1.5)

Update existing Sections 1.5, 14.2, and 14.4 (do NOT duplicate — extend in place):
- Section 1.5: Add Web Crypto API constraints note (non-extractable CryptoKey, GC-managed lifetime)
- Section 14.4: Expand risk acceptance with user-facing explanation of residual risks and compensating controls
- Cross-reference security-review.md Section 4 for technical details

**File**: `docs/security/considerations/ja.md` — mirror updates in Japanese

Update `docs/architecture/production-readiness.md`:
- Item 2.6: Status → "Done"

### Step 8: Redis HA documentation completion (#55)

**File**: `docs/operations/redis-ha.md` (update)

Add sections:
- "Failover Test Procedure" — step-by-step manual test using docker compose
- "Verification Checklist" — what to observe during failover

**File**: `docs/operations/incident-runbook.md` (update)

Expand Section 3a "Redis Down" with Sentinel-specific procedures:
- Sentinel failover verification commands
- Manual failover trigger if needed
- Reference to `docs/operations/redis-ha.md`

Update `docs/architecture/production-readiness.md`:
- Item 3.4: Status → "Done"

### Step 9: Debt ledger review (#32)

Review #32 and its child issues:
- #37 → resolved in Step 1
- #38 → resolved in Step 5
- Other items from issue body (audit metadata, health assertion, Redis strict) → already done

Close #32 with summary comment listing all resolved items.

## Implementation Steps

1. Create branch `feature/quality-security-hardening` from `main`
2. Step 1: ESLint rule (#37)
3. Step 2: password-crud test.step consolidation (#27)
4. Step 3: vault-reset dedicated user (#27)
5. Step 4: Coverage config expansion (#54)
6. Step 5: Extension response Zod validation (#38)
7. Step 6: Vulnerability triage doc (#51)
8. Step 7: Key material docs update (#56)
9. Step 8: Redis HA docs completion (#55)
10. Step 9: Close #32
11. Run lint + tests + build verification
12. Update production-readiness.md statuses

## Testing Strategy

- `npx eslint e2e/tests/` — verify new rule works (no violations in existing code)
- `npx vitest run` — all unit/integration tests pass
- `npx next build` — production build succeeds
- Manual: temporarily add `if (true) { expect(1).toBe(1); }` in an e2e test → ESLint should error

## Considerations & Constraints

- Step 3 (vault-reset dedicated user) requires a new user in e2e global-setup. This is a seeded test user, not a production concern.
- Step 5 (Zod validation) adds runtime overhead to extension token endpoint — negligible for this low-traffic endpoint.
- Documentation steps (6, 7, 8) are self-contained and don't affect code behavior.
- #32 is a meta-issue; closing it requires all child issues to be resolved first.

## Key Files

- `eslint.config.mjs`
- `e2e/tests/password-crud.spec.ts`
- `e2e/tests/vault-reset.spec.ts`
- `e2e/helpers/fixtures.ts`
- `vitest.config.ts`
- `src/app/api/extension/token/route.ts`
- `docs/architecture/production-readiness.md`
- `docs/security/considerations/en.md`
- `docs/security/considerations/ja.md`
- `docs/operations/redis-ha.md`
- `docs/operations/incident-runbook.md`
- `e2e/helpers/db.ts`
- `e2e/global-setup.ts`
- `src/app/api/extension/token/refresh/route.ts`
