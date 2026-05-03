# Plan: Audit Log Download — actorType Filter Parity + SectionLayout Indent

## Project context

- **Type**: web app (Next.js 16 App Router)
- **Test infrastructure**: unit + integration + E2E + CI/CD
  - Vitest for unit tests; Playwright for E2E; CI runs `npx vitest run` + `npx next build` + lint
- **Origin**: revives stash@{0} from a now-deleted `fix/release-please-patch-bump` branch (review round 3 of `unify-audit-log-consistency`). The same fix must be re-implemented against the current source structure (`@/lib/audit/audit-query` path, `parseActionsCsvParam`-based where-clause builder).

## Objective

Restore filter parity across the three audit log download endpoints (personal / tenant / team) and remove a UI indentation regression in the team audit-log admin page.

Two independent but topically related fixes ship in one PR because they are the round-3 carry-over from the same `unify-audit-log-consistency` review:

1. **R3-F1 [Major]** — `/api/audit-logs/download` and `/api/tenant/audit-logs/download` ignore the `actorType` query parameter that the UI sends. The team download endpoint (`/api/teams/[teamId]/audit-logs/download`) already honors it. As a result, the personal and tenant download buttons silently return data inconsistent with the UI's `actorType` filter selection.
2. **R3-F2 [Minor]** — `src/app/[locale]/admin/teams/[teamId]/audit-logs/page.tsx` has stale 4-space indentation under `<SectionLayout>` (Card and children sit at column 5 instead of column 7). Other admin pages that wrap their return body in `<SectionLayout>` indent inner content one extra level (e.g. `tenant/members/page.tsx:17` — `<TenantMembersCard />` at col 7).

## Requirements

### Functional

1. `GET /api/audit-logs/download?actorType=<HUMAN|SERVICE_ACCOUNT|MCP_AGENT|SYSTEM|ANONYMOUS>` MUST narrow the result set to that actorType. Other valid combinations (no `actorType` param, unknown `actorType` value) MUST behave as today (return all rows).
2. `GET /api/tenant/audit-logs/download?actorType=…` MUST narrow the result set in the same way.
3. The `actorType` param contract is exactly `parseActorType` (`src/lib/audit/audit-query.ts:14`): valid set is `["HUMAN", "SERVICE_ACCOUNT", "MCP_AGENT", "SYSTEM", "ANONYMOUS"]`. Unknown / case-mismatched / empty values are silently ignored (no 400) — this matches the existing list endpoints and the team download endpoint, so behavior is consistent across all six routes.
4. The team audit-log admin page MUST render with consistent JSX indentation matching the SectionLayout-wrapped pattern used elsewhere in `src/app/[locale]/admin/`.

### Non-functional

- No new dependencies; reuse `parseActorType` from `@/lib/audit/audit-query`.
- No DB schema, migration, env-var, or DB-role changes.
- No public API contract change beyond honoring an already-documented and already-sent query parameter.
- Build (`npx next build`), test (`npx vitest run`), and lint MUST pass before commit.

## Technical approach

### Pattern reference: existing team download endpoint

`src/app/api/teams/[teamId]/audit-logs/download/route.ts` is the canonical pattern:

```ts
import { parseActionsCsvParam, parseActorType } from "@/lib/audit/audit-query";
// ...
const validActorType = parseActorType(searchParams);
// ...
const where: Prisma.AuditLogWhereInput = {
  teamId,
  scope: AUDIT_SCOPE.TEAM,
  ...(validActorType ? { actorType: validActorType } : {}),
};
```

The personal and tenant download endpoints adopt the same shape. No new helper, no schema changes.

### File-by-file change set

| File | Change |
|---|---|
| `src/app/api/audit-logs/download/route.ts` | Add `parseActorType` to the existing `@/lib/audit/audit-query` import. Call `parseActorType(searchParams)` after the other `searchParams.get(...)` calls. Spread `...(validActorType ? { actorType: validActorType } : {})` into the `where` literal. |
| `src/app/api/tenant/audit-logs/download/route.ts` | Same as above. The where clause is typed as `Record<string, unknown>` (not `Prisma.AuditLogWhereInput`) here — keep the existing typing rather than tightening it; spread works the same way. |
| `src/app/[locale]/admin/teams/[teamId]/audit-logs/page.tsx` | Re-indent the JSX block from `<Card>` at line 207 down through its closing `</Card>` so each line gains 2 extra leading spaces. No semantic change; no new imports. |
| `src/app/api/audit-logs/download/route.test.ts` | Add unit tests verifying actorType is reflected in the Prisma `where` clause: (a) valid value → `actorType: "<value>"` present in `where`; (b) absent param → no `actorType` key; (c) invalid value → no `actorType` key (silent ignore). |
| `src/app/api/tenant/audit-logs/download/route.test.ts` | Same three-case test set; mirror the existing patterns for the team download test. |

### Out of scope (deliberately deferred)

These items were considered and explicitly excluded — they would expand blast radius without addressing the round-3 finding:

- **Personal download `OR` clause for `EMERGENCY_VAULT_ACCESS`** — the personal *list* endpoint (`audit-logs/route.ts:44-57`) includes an `OR` branch that surfaces emergency-vault-access events targeting `session.user.id` even when `userId` is not the session user. The personal *download* endpoint (`audit-logs/download/route.ts:62-65`) lacks this branch and only filters by `userId`. This is a pre-existing list-vs-download inconsistency, NOT introduced by R3-F1, and is broader than the actorType question. Tracked as a separate follow-up. **Anti-Deferral check**: pre-existing in unchanged file → routed to a separate plan. Cost-to-fix > 30 min (requires understanding emergency-access semantics, audit log schema for emergency events, and updating download tests). Filed as `TODO(audit-log-download-emergency-access-or-clause)` for a future task.
- **CSV column for `actorType`** — already deferred in R2 of the parent review (out of scope; all three download endpoints consistently omit it from CSV output). Re-deferring.
- **Strict 400 on unknown `actorType`** — would diverge from the list endpoints' lenient behavior. Deferred to a separate "tighten audit log param validation" plan if/when the team chooses to harden lenient parsing globally.
- **`buildAuditLogDateFilter` strict-validation gap** in list routes — pre-existing R3-S2 finding; download routes already validate. Out of scope.
- **Zod migration of `parseActorType`** — pre-existing R3-S1 finding; consistent with existing `parseActionsCsvParam` pattern. Out of scope.

## Implementation steps

1. Create branch from latest `origin/main`: `git fetch origin main && git checkout -b fix/audit-log-download-actor-type-filter origin/main`.
2. Edit `src/app/api/audit-logs/download/route.ts`:
   - Update the import on line 14 to `import { parseActionsCsvParam, parseActorType } from "@/lib/audit/audit-query";`.
   - **After the `to` extraction (line 41), and BEFORE the date validation block (line 44)** — matching the team route's canonical position at `teams/[teamId]/audit-logs/download/route.ts:66` (parseActorType is grouped with the other `searchParams.get(...)` calls and placed BEFORE date validation). Add `const validActorType = parseActorType(searchParams);` at this position.
   - In the `where` literal (lines 62-65), add the spread `...(validActorType ? { actorType: validActorType } : {})`.
3. Edit `src/app/api/tenant/audit-logs/download/route.ts`:
   - Update the import on line 12 the same way.
   - **After the `to` extraction (line 46), and BEFORE the `if (!from && !to)` early return (line 49)** — matching the team route's canonical position. Add `const validActorType = parseActorType(searchParams);` at this position.
   - In the `where` literal (lines 70-73), add the same spread (or `if (validActorType) where.actorType = validActorType;` to match the looser typing).
4. Edit `src/app/[locale]/admin/teams/[teamId]/audit-logs/page.tsx`:
   - Re-indent the block from `<Card>` (currently line 207) through its matching `</Card>` so each affected line gains 2 leading spaces. The block is purely JSX inside a single return — no logic change. Verify the closing tag at the SectionLayout boundary still aligns.
5. Add tests to `src/app/api/audit-logs/download/route.test.ts`:
   - **MANDATORY pre-assertion step**: each new test MUST consume the response stream via `await parseStreamResponse(res)` BEFORE asserting on `mockPrismaAuditLog.findMany.mock.calls`. The download route returns a lazy `ReadableStream` from `buildAuditLogStream`; `findMany` is only invoked from inside the stream's pull callback. The existing pagination test at `route.test.ts:228-238` is the reference pattern. Without this consume-first step, `findMany.mock.calls[0]` is `undefined` at assertion time and the test silently throws (or vacuously passes if the throw is swallowed).
   - `it("filters by actorType when provided", …)`:
     ```ts
     const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download", {
       searchParams: { actorType: "SERVICE_ACCOUNT" },
     });
     const res = await GET(req);
     await parseStreamResponse(res); // REQUIRED: triggers lazy fetchBatch
     expect(mockPrismaAuditLog.findMany.mock.calls[0][0]).toEqual(
       expect.objectContaining({
         where: expect.objectContaining({ actorType: "SERVICE_ACCOUNT" }),
       }),
     );
     ```
   - `it("omits actorType filter when param absent", …)`:
     ```ts
     const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download");
     const res = await GET(req);
     await parseStreamResponse(res);
     const calledWith = mockPrismaAuditLog.findMany.mock.calls[0][0];
     expect(calledWith.where).not.toHaveProperty("actorType");
     ```
     Note: `not.toHaveProperty("actorType")` is preferred over `not.objectContaining({ actorType: "value" })` because the latter only refutes a specific value and would pass even if `where` contained a different valid actorType (e.g., a regression where `parseActorType` always returns `"HUMAN"`).
   - `it("ignores unknown actorType silently", …)`:
     ```ts
     const req = createRequest("GET", "http://localhost:3000/api/audit-logs/download", {
       searchParams: { actorType: "NOT_REAL" },
     });
     const res = await GET(req);
     await parseStreamResponse(res);
     const calledWith = mockPrismaAuditLog.findMany.mock.calls[0][0];
     expect(calledWith.where).not.toHaveProperty("actorType");
     ```
6. Add equivalent tests to `src/app/api/tenant/audit-logs/download/route.test.ts`. **Same MANDATORY pre-assertion step** — use the existing `await streamToString(res)` helper (already used in the file) before asserting on `findMany.mock.calls`. The route also returns a lazy `ReadableStream`. **EQUALLY MANDATORY**: every tenant test request MUST include `from` and `to` searchParams or the route returns 400 at the `if (!from && !to)` early-return guard before `findMany` is ever called — making `findMany.mock.calls` empty. Pattern (apply to all three cases — present / absent / invalid actorType):
   ```ts
   const req = createRequest("GET", "http://localhost:3000/api/tenant/audit-logs/download", {
     searchParams: { from: "2026-01-01", to: "2026-01-31", actorType: "SERVICE_ACCOUNT" /* or omit / "NOT_REAL" */ },
   });
   const res = await GET(req);
   await streamToString(res);  // REQUIRED: triggers lazy fetchBatch
   const calledWith = mockPrismaAuditLog.findMany.mock.calls[0][0];
   // Then either:
   expect(calledWith.where).toEqual(expect.objectContaining({ actorType: "SERVICE_ACCOUNT" }));
   // OR for absent/invalid cases:
   expect(calledWith.where).not.toHaveProperty("actorType");
   ```
7. Run `npx vitest run` — all suites green.
8. Run `npx next build` — production build succeeds.
9. Run `npm run lint` — no new warnings.
10. Commit with message `fix(audit): honor actorType filter in personal/tenant download + indent team audit page`.
11. Open one PR (no per-step PRs — see memory: PR cadence aggregate).

## Testing strategy

### Unit tests (vitest)

- **R3-F1 functional verification**: per the table above, three new tests per endpoint — six new tests total.
- **Pattern reference for assertion shape**: existing tests in `src/app/api/audit-logs/download/route.test.ts:202-279` already mock `mockPrismaAuditLog.findMany` and inspect `mock.calls[N][0]`. The new tests reuse this pattern — assert on `where` shape via `expect.objectContaining({ actorType: ... })` for the present case, and `not.toHaveProperty("actorType")` for absent/invalid cases (see step 5 snippets and the assertion-form preference note below).
- **Existing coverage preserved**: all 13 existing tests in the personal download test file and all corresponding tests in the tenant download test file MUST continue to pass unchanged. The R3-F1 change is additive — no existing assertion is loosened.
- **`parseActorType` itself is already covered** by `src/lib/audit/audit-query.test.ts:48-69` (5 cases). No new tests needed for the parser.
- **Lazy-stream consumption (mandatory)**: both download routes return a `ReadableStream` from `buildAuditLogStream`. `prisma.auditLog.findMany` is invoked from inside the stream's pull callback, NOT synchronously at `GET(req)` time. Every new test that asserts on `mockPrismaAuditLog.findMany.mock.calls` MUST first consume the stream (`await parseStreamResponse(res)` for personal, `await streamToString(res)` for tenant). The existing pagination test in the personal route file (`route.test.ts:228-238`) is the reference pattern. Tests that skip the consume-first step will see `findMany.mock.calls[0] === undefined` and either silently throw or vacuously pass.
- **Assertion-form preference**: for "absent param" and "invalid param" cases, prefer `expect(calledWith.where).not.toHaveProperty("actorType")` over `not.toEqual(expect.objectContaining({ actorType: "value" }))`. The latter only refutes a specific value and would pass if `where` contained a different valid actorType (e.g., a regression where `parseActorType` always returns `"HUMAN"`). The `not.toHaveProperty` form refutes the key's presence entirely, which is the actual invariant.

### Integration / E2E

- No new integration test required for this PR. The route-level integration test gap for actorType filter reflection (R3-T1 in the parent review) is the same gap that exists for `action`/`from`/`to` params. Closing it is a separate, larger task that affects all six audit log routes (3 list + 3 download) and is filed as `TODO(audit-log-route-integration-tests)`.
- E2E coverage exists for the audit log download UI flow — no new E2E test required since the only change is honoring an already-documented param. The hook (`src/hooks/vault/use-audit-logs.ts:127`) already adds `actorType` to the download URL when the filter selection is non-`ALL`; that path was already exercised by the team download flow. The personal/tenant flows now match.

### Build / lint

- `npx next build` is mandatory after the change. The personal download test file mocks `@/lib/audit/audit` and `@/lib/security/rate-limit` — no mock-shape drift expected since we are only adding a where-clause spread, but verify the build does not error on type narrowing for the new `actorType` field.
- `npm run lint` — no new ESLint suppressions, no underscore-prefixed unused vars (per repo memory: `feedback_no_suppress_warnings`).

## User operation scenarios

1. **Personal audit log download with HUMAN filter**: User opens `/dashboard/account/audit-logs`, sets the actor type dropdown to "HUMAN", clicks Download → JSONL. Expected: only logs with `actorType: "HUMAN"` are downloaded. Today: ALL logs are downloaded regardless of dropdown selection.
2. **Tenant audit log download with SERVICE_ACCOUNT filter**: Tenant admin opens `/admin/tenant/audit-logs`, sets the dropdown to "SERVICE_ACCOUNT", picks a date range, clicks Download → CSV. Expected: only SA-actor rows. Today: all rows.
3. **Default (ALL) flow unchanged**: User leaves the dropdown at "ALL". The hook does not append the `actorType` query param (`use-audit-logs.ts:127`). The download endpoint sees no `actorType` param, `parseActorType` returns `undefined`, the spread injects nothing, and `where` is identical to today's behavior.
4. **Crafted invalid actorType (manual API call)**: A power user calls `GET /api/audit-logs/download?actorType=ADMIN&from=…&to=…`. `parseActorType` returns `undefined`, the spread injects nothing, and the user receives all logs (silent ignore). This matches the team download endpoint and the list endpoints — no special-case 400.
5. **Team audit log admin page render**: A team admin opens `/admin/teams/<id>/audit-logs`. Expected: page renders with consistent indentation. The visual output is unchanged — this is a JSX whitespace-only change.

## Considerations & constraints

### Risks

- **TypeScript narrowing on `Prisma.AuditLogWhereInput`** (personal download): the spread `...(validActorType ? { actorType: validActorType } : {})` produces a discriminated union that TypeScript collapses. The team download endpoint uses the exact same shape and compiles, so the same shape is expected to compile here. If the build flags it, fall back to `if (validActorType) where.actorType = validActorType;` (used by the tenant list endpoint at `tenant/audit-logs/route.ts:97`).
- **Loose-typed where in tenant download** (`Record<string, unknown>`): less type-safe; the imperative `if (validActorType) where.actorType = validActorType;` form is preferred to keep the additive change visible.
- **R34 (adjacent pre-existing bug)**: the personal download endpoint's missing `OR` branch for `EMERGENCY_VAULT_ACCESS` (vs the personal list endpoint) is an adjacent bug in the same file. It is in-scope for R34 per the rule that adjacent bugs in the same diff must be fixed OR cost-justified for deferral. Justification per Anti-Deferral Rules:
  - **Worst case**: a user who has been granted emergency access to another user's vault sees those events in the personal *list* view but cannot include them in a personal *download*. The events still exist in `audit_logs`, just not in the downloaded file. No data loss, no security regression — only UX gap.
  - **Likelihood**: low (emergency access is a rare flow; users who use it rarely download audit logs from the personal view because tenant admins typically use the tenant download view for cross-user audit needs).
  - **Cost to fix**: > 30 minutes — requires (a) updating the personal download where clause to mirror the list endpoint's OR pattern, (b) adding tests for the emergency-access branch in the download path, (c) cross-checking that the streaming pagination cursor still works correctly with the `OR` clause (cursor on `id` ordered by `createdAt: asc` may interact with OR differently than with a single `userId` filter), (d) verifying no RLS policy boundary is crossed. The 30-minute exemption does NOT apply to security-list bugs; this is on the edge — it touches audit-log filtering for emergency-access (an authorization-adjacent surface), so impact analysis is required before deferring. Impact analysis: the missing OR is symmetric to the list endpoint, which has been live for several releases without security incident. The download endpoint is read-only with the same RLS scope (`withUserTenantRls`) as the list. No new authorization boundary is crossed by the deferral. Routed as `TODO(audit-log-download-emergency-access-or-clause)`.
  - **Cursor-OR concern is scoped to the deferred fix only**: the cost-to-fix item (c) above describes a concern specific to the deferred OR-clause fix. **It does NOT apply to the actorType filter being added in this plan.** The actorType filter is a top-level equality predicate spread into the existing `where` literal; the cursor (`id` unique, `createdAt: asc` ordering) remains stable regardless of additional equality filters in `where`. Adding the actorType filter does not interact with cursor pagination in any new way.
- **Stash-origin caveat**: the original stash was based on a different repo state where the audit-query helpers lived at `@/lib/audit-query` (not `@/lib/audit/audit-query`) and the where clause used `VALID_ACTIONS` directly. We are NOT applying the stash mechanically — the changes are re-derived from the current source.

### Dependencies

- None. No new packages, no schema migrations, no env vars.

### Backward compatibility

- Fully backward compatible. The `actorType` query param was already documented (UI sends it). Existing clients that did not send it see no change. Clients that did send it now get the filtered result they expected.

### Rollback

- Single commit; revert is `git revert <sha>`. No data migration to undo.

## Recurring Issue Check (plan-time)

(Filled in detail by review experts in Step 1-4. Listed here so the plan declares which checks apply.)

- **R1 / R17 / R22 (helper reuse)**: `parseActorType` is the existing helper. Forward perspective — both routes adopt it. Inverted perspective — no syntactically-different equivalent (e.g. inline `searchParams.get("actorType")` with manual validation) exists in the changed files.
- **R3 (pattern propagation)**: enumerated all six audit-log routes (`audit-logs/route.ts`, `tenant/audit-logs/route.ts`, `teams/[teamId]/audit-logs/route.ts`, plus the three download counterparts). Five already use `parseActorType`; the two download routes are the gap this plan closes.
- **R7 (E2E selector breakage)**: no JSX role/aria/data-testid/data-slot change. Indentation-only edit on the team page; selectors unchanged.
- **R8 (UI pattern inconsistency)**: R3-F2 is itself a pattern-inconsistency fix.
- **R12 (enum/action group coverage gap)**: no new audit action; no group definition change.
- **R19 (test mock alignment + exact-shape assertion obligation)**: new tests use `expect.objectContaining` for the positive case (asserting `actorType` IS in `where`) and `not.toHaveProperty("actorType")` for the negative cases (asserting `actorType` is NOT in `where`). The negative form (`not.toHaveProperty`) is intentionally stronger than `not.objectContaining({ actorType: "value" })` so that a regression where `parseActorType` always returns a fixed valid value would still be caught. No exact-shape `toEqual` assertions on `where` exist currently; nothing to update.
- **R21 (subagent verification)**: tests + lint + build re-run by orchestrator after sub-agent edits. Security-relevant test path — audit log filtering is access-control-adjacent — completed.
- **R23 (mid-stroke input mutation)**: N/A — no input handler changes.
- **R29 / R30 (citations / autolink)**: no external standard cited; no PR body autolink risk in plan text.
- **R31 (destructive ops)**: none in this plan or in the verification scripts.
- **R34 (adjacent pre-existing bug deferred)**: addressed above — emergency-access OR branch deferred with full Worst case / Likelihood / Cost-to-fix justification and TODO marker.
- **R35 (manual test plan for production-deployed components)**: diff matches NO deployment-artifact list pattern (no Dockerfile, no compose, no manifests, no Helm, no Terraform, no IAM/TLS/IdP material). Tier-1/Tier-2 do not fire. No `*-manual-test.md` artifact required.
