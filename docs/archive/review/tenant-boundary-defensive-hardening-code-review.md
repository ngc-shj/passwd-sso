# Code Review: tenant-boundary-defensive-hardening

Date: 2026-06-15
Review round: 1 (Phase 3 standalone — branch review, no plan file; review-driven work)
Branch: `fix/tenant-boundary-defensive-hardening`
Scope: `git diff main...HEAD` — 4 commits, 72 files (+398/−146)

## Changes reviewed
1. JIT approval TOCTOU CAS + SA-token tenant cross-check + SA composite FK + team password delete scoping.
2. Horizontal rollout: MCP auth-code single-use CAS, MCP token tenant cross-checks, AccessRequest composite FK, ~44 single-row mutations scoped by `{id, owner}`.
3. Attachment delete scoped by parent entry id.
4. Password-history trim deletes scoped by parent `entryId`.

## Functionality Findings
**No findings.** Composite-`where` mutations are all preceded by an ownership pre-check guaranteeing the scope value matches the row (no spurious P2025). deleteMany/updateMany+count→404 refactors, invitation-accept tx refactor, MCP auth-code CAS, and the `expiresAt:{gt}` transition all preserve correct happy-path behavior and response shapes. Composite-FK migrations are correctly ordered (unique index before FK), `onDelete: Cascade` preserved, schema matches SQL.
Recurring check: R5 OK / R9 OK / R19 OK / R24 — migrations intentionally strict (fail closed on pre-existing divergent rows), no mid-migration fail-open window.

## Security Findings
**No findings.** Each fix verified to close its gap and fail closed:
- All three CAS paths (MCP auth-code, invitation accept, JIT approval) claim the row BEFORE the side effect; the loser never mints/upserts. Claim-then-act ordering correct.
- Tenant cross-checks fail closed (parent tenantId selected; non-null token column makes both-null impossible; `null !== uuid` rejects).
- Composite FK migrations preserve onDelete semantics; make divergent rows impossible.
- ~15 mutation-scope additions spot-checked: correct owner column throughout (userId for personal — RLS is tenant-only; teamId/tenantId for team/tenant resources). Family-revoke tenantId additions match the rows' tenantId — no token escapes revocation.
- R35: auth/authz + migration changes — recommend an end-to-end post-migration manual/integration verification (see Deferred).

## Testing Findings
- **T1 (Major):** New MCP tenant-mismatch reject branches (`validateMcpToken`, `exchangeRefreshToken`) had no test — pass-branch mocks aligned but revert was invisible. → FIXED.
- **T2 (Major):** New `deleteTeamPassword` count!==1→404 race path untested. → FIXED.
- **T3 (Major):** New access-requests `sa.tenantId !== tenantId → SA_NOT_FOUND` branch untested. → FIXED.
- **T4 (Minor):** Composite-FK migrations have no integration test asserting the DB rejects a mismatched insert. → FIXED (real-DB integration test added via /test-gen).
- Confirmed sound: invitation-accept CAS test (executes callback, asserts upsert-not-called on race), MCP auth-code CAS test, JIT expiresAt-atomic test (captures transition where) — all load-bearing; R7 where-assertions use concrete matching literals; R19 mocks aligned.

## Resolution Status
### T1 [Major] MCP tenant-mismatch reject branches untested — FIXED
- Action: added `validateMcpToken` mismatch test (`mcpClient.tenantId: "tenant-OTHER"` → invalid_token) and `exchangeRefreshToken` mismatch test (divergent client tenantId → invalid_client, CAS not run).
- Files: src/lib/mcp/oauth-server.test.ts, src/__tests__/lib/mcp/refresh-token.test.ts

### T2 [Major] deleteTeamPassword count:0 path untested — FIXED
- Action: added permanent + soft-delete tests where the scoped mutation matches 0 rows → 404.
- File: src/app/api/teams/[teamId]/passwords/[id]/route.test.ts

### T3 [Major] access-requests SA tenant-mismatch untested — FIXED
- Action: added SA self-service test with `sa.tenantId: "tenant-OTHER"` → SA_NOT_FOUND (404), create not called.
- File: src/app/api/tenant/access-requests/route.test.ts

### T4 [Minor] Composite-FK integration test — FIXED
- Action: added a real-DB integration test (`src/__tests__/db-integration/service-account-tenant-fk.integration.test.ts`) using the existing `createTestContext` harness. It seeds an SA in tenant A and asserts the composite FK REJECTS inserting a `service_account_tokens` / `access_requests` row with tenant B (matcher `/service_account_id_tenant_id_fkey/`), and ACCEPTS the matching-tenant insert. 4 tests, all passing against the dev DB via `vitest --config vitest.integration.config.ts`.
- This supersedes the earlier deferral: the DB-level backstop is now covered, so a future schema edit dropping either composite FK fails CI.

## Recommendation (non-blocking, R35)
Before merge, run the two composite-FK migrations against a dev DB with existing SA/token/access-request rows and confirm a legitimate SA-token issuance + JIT approval + invitation accept still succeed end-to-end. (Migrations were applied to the local dev DB during implementation; a clean-DB rehearsal on a representative dataset is the residual step.)

## Outcome
Functionality + Security: clean. Testing: 3 Major fixed, 1 Minor deferred with justification. Full suite 11,332 passed / 1 skipped; lint 0 errors; production build succeeds.
