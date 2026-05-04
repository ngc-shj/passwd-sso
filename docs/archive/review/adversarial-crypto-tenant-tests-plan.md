# Plan: Adversarial Tests — Ciphertext Swap, Tenant Swap, Token Rotation Race

Issue: [#435](https://github.com/ngc-shj/passwd-sso/issues/435)
Branch: `feature/adversarial-crypto-tenant-tests`
Date: 2026-05-04
Revision: Round 3 — contract-first rewrite

---

## Project context

- **Type**: web app (Next.js 16 + Prisma + PostgreSQL)
- **Test infrastructure**: unit (vitest, mocked Prisma) + integration (vitest, real DB with RLS, single-worker forks pool) + E2E (Playwright) + CI/CD (GitHub Actions, both `ci.yml` and `ci-integration.yml`)
- **Production-deployed**: yes. PR scope = tests + a security-tightening production fix (MCP refresh-token CAS race + fail-closed family revocation).

---

## Objective

Add three classes of adversarial tests called out in [issue #435](https://github.com/ngc-shj/passwd-sso/issues/435):

1. **Ciphertext-swap across keys** — encrypt under K1, attempt to decrypt under K2, prove rejection.
2. **Tenant-swap injection** — request as tenant A for resource owned by tenant B; prove RLS rejection.
3. **Token rotation race** — two concurrent refresh exchanges; prove exactly one succeeds, family is revoked unconditionally on race detection (fail-closed), subsequent access tokens rejected.

Tests must be greppable (filename contains `adversarial`).

---

## Requirements

### Functional

- Ciphertext-swap rejection: personal vault, team vault, account-token, admin-reset-token, attachment crypto.
- Tenant-swap injection: cross-tenant `findUnique` → null (RLS-enforced); positive control returns row when same tenant.
- Concurrent MCP refresh: family revoked unconditionally; winner's tokens also revoked under fail-closed; subsequent validation rejects.
- Tests in `*.adversarial.test.ts` (unit) and `*.adversarial.integration.test.ts` (integration).

### Non-functional

- N=50 race iterations (matches existing precedent at [admin-vault-reset-dual-approval.integration.test.ts:156-203](src/__tests__/db-integration/admin-vault-reset-dual-approval.integration.test.ts#L156-L203)).
- Production change limited to `oauth-server.ts` race fix + audit action enum addition.
- CI executes new tests on every PR; `ci-integration.yml` `paths:` extended.
- No real PII; placeholders only (RS4).

### Out of scope

- Property-based testing.
- Performance / load testing.
- Crypto module API refactoring.
- Concurrent JTI replay (Redis-required production posture documented separately).
- Share-links bypass-RLS sub-test (S4 Round 1 — endpoint is unauthenticated, no tenant context exists).

---

## Contracts (Phase 2 input — fix these BEFORE implementation)

This plan does NOT prescribe pseudocode. It defines 8 contracts that the implementation must satisfy. Pseudocode-level decisions belong to Phase 2 where TypeScript types catch them. Reviewer focus shifts from line-by-line code to contract conformance.

### Contract 1 — Transaction / RLS (F13)

**Principle**: RLS bypass and transaction boundary are established in the SAME context. Never nest a raw client's `$transaction` inside `withBypassRls(rawClient, ...)`.

- **Forbidden**: `withBypassRls(rawClient, () => rawClient.$transaction(...))`. The raw client bypasses the project's `prisma`-proxy interception that flattens nested transactions, causing GUCs to land on the wrong connection.
- **Required**: every transaction enters via the project's existing context helper (`withBypassRls` / `withTenantRls` from [tenant-rls.ts](src/lib/tenant-rls.ts)). The `tx` argument the helper provides is the transaction-scoped client used for all queries inside `fn`.
- **Test parity**: integration tests use the SAME helpers as production. Test injects an alternate `PrismaClient` only via a parameter the helper accepts (or by calling the helper with `ctx.app.prisma` as the first arg if the helper signature supports it). Tests do NOT bypass the helper to call `$transaction` directly on a raw client.

### Contract 2 — Fail-closed family revocation (S9, S12)

**Trigger**: ANY of (replay detected, CAS lost, family-state inconsistency).

**Behavior**:
1. The business transaction (token creation) MAY roll back.
2. **Family revocation MUST be committed in a transaction independent of the business transaction** so it persists regardless of business-tx outcome.
3. Response to the caller: `{ok: false, error: "invalid_grant", reason: ...}`. Status code: 400 (matches RFC 6749 §5.2 + existing replay path).
4. User/client MUST re-authenticate.

**Spec basis** — RFC 9700 §4.14.2, verbatim: *"The authorization server cannot determine which party submitted the invalid refresh token, but it will revoke the active refresh token."* The RFC discusses sequential replay; we extend conservatively to concurrent rotation. Family-wide revocation (vs only the most recent token) is a stronger interpretation than literal RFC text but matches Auth0/Okta production practice — once one token is suspect, the chain is suspect.

**Failure handling**: family-revocation transaction failure is NOT silent fail-open. Strategy (in Phase 2 priority order):
- Wrap revocation in its own try/catch with structured error logging (`logger.error` with `familyId`, `reason`).
- Return `{ok: false, error: "invalid_grant"}` to caller (Phase 1 has committed; semantic response is correct for the loser).
- Persist failure to a durable retry surface (audit_outbox or dedicated retry table) for background re-attempt. If retry plumbing is out of scope for this PR, document as a follow-up issue and ensure the structured log line is grep-able.

### Contract 3 — Token I/O (F18, F20, T17, S13)

**Required fields on success result of refresh exchange**:
- `accessToken: string` (plaintext bearer)
- `accessTokenId: string` (DB primary key — used for revocation queries / audit)
- `refreshToken: string` (plaintext bearer)
- `refreshTokenId: string` (DB primary key)
- `familyId: string`
- `tenantId: string`

**Required fields on failure result**:
- `error: "invalid_grant" | "invalid_client"` (OAuth wire values)
- `reason: "replay" | "concurrent_rotation_revoked" | "revoked" | "expired" | "not_found"` (project-internal — see Contract 5 reason union)
- `tenantId?: string` (carried back when `findUnique` succeeded; needed for audit dispatch)
- `familyId?: string` (carried back when known; needed for audit + family-revocation handler in route)

**Rationale**: monitoring / audit / revocation lookups must NOT depend on parsing/hashing bearer-token strings. Carrying IDs forward is the established pattern (see existing replay path at [oauth-server.ts:328](src/lib/mcp/oauth-server.ts#L328)).

### Contract 4 — Models / schema (T15, F16, T16)

**Correct Prisma model names** (verify before implementation):
- Personal vault: `passwordEntry` → table `password_entries`
- **Team vault: `teamPasswordEntry` → table `team_password_entries`** — DISTINCT from personal vault, NOT the same table.
- MCP token storage: `mcpAccessToken`, `mcpRefreshToken`, `mcpAuthorizationCode`, `mcpClient`
- Service account: `serviceAccount`, `serviceAccountToken`
- Delegation: `delegationSession`

**Schema migrations required BEFORE implementation**:
- Add `MCP_REFRESH_TOKEN_FAMILY_REVOKED` to `AuditAction` enum in [prisma/schema.prisma](prisma/schema.prisma).
- Run `npm run db:migrate` to issue `ALTER TYPE audit_action ADD VALUE`.
- Add the constant to [src/lib/constants/audit/audit.ts](src/lib/constants/audit/audit.ts) `AUDIT_ACTION` const-object AND to `AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.MCP_CLIENT]` (per existing pattern).

**Cleanup order in `deleteTestData` extension** (FK-safe; verified against schema):
1. `delegation_sessions` (cascade child of `mcp_access_tokens`)
2. `mcp_refresh_tokens` (cascade child of `mcp_access_tokens` + `mcp_clients`)
3. `mcp_access_tokens` (cascade child of `mcp_clients`)
4. `mcp_authorization_codes` (cascade child of `mcp_clients`)
5. `mcp_clients` (Restrict from `tenants`)
6. `service_account_tokens` (cascade child of `service_accounts`)
7. `service_accounts` (Restrict from `tenants`)
8. **`team_password_entries` (Restrict from `tenants`, cascade child of `teams`)**
9. **`teams` (Restrict from `tenants`)**
10. `password_entries` (Restrict from `tenants`)
11. (existing) `audit_*`, `tenant_members`, `users`, `tenants`

### Contract 5 — Audit (F17, F24, T20)

- **Audit emission lives in the route handler**, NOT in `oauth-server.ts`. Reason: `tenantAuditBase(req, userId, tenantId)` requires the `NextRequest` for IP / user-agent extraction; moving emission out of the route loses forensic context.
- The library function (`exchangeRefreshToken`) returns enough information for the route handler to emit the audit event (Contract 3 requires `tenantId`, `familyId`, `reason`).
- **Reason union (canonical)**: `"replay" | "concurrent_rotation_revoked" | "revoked" | "expired" | "not_found" | "invalid_client"`. Internal implementation MAY use a shorter discriminated union internally; the wire/return value uses this canonical form.
- **`MCP_REFRESH_TOKEN_FAMILY_REVOKED` audit fields** (mandatory): `event: action constant`, `tenantId`, `actorId` (when known), `clientId`, `familyId`, `reason: "replay" | "concurrent_rotation"`. (`reason` here is the audit metadata field — the response `reason` is per Contract 3.)
- **Route-handler audit branches**:
  - `result.reason === "replay"` → emit `MCP_REFRESH_TOKEN_REPLAY` (existing — no change)
  - `result.reason === "concurrent_rotation_revoked"` → emit NEW `MCP_REFRESH_TOKEN_FAMILY_REVOKED` with `reason: "concurrent_rotation"`
  - For unification: optionally emit `MCP_REFRESH_TOKEN_FAMILY_REVOKED` for both replay and concurrent cases with reason discriminator. Phase 2 implementer decides; preserve existing replay audit if unifying causes downstream alerting/dashboard regressions.

### Contract 6 — API / function signatures (F14, F15, F19)

- Every call to `withBypassRls` includes a third `purpose: BypassPurpose` argument. No two-argument variants (compile-time enforced once existing TypeScript signatures hold).
- **No fabricated function names**. Tests use existing exports of [oauth-server.ts](src/lib/mcp/oauth-server.ts) (`createAuthorizationCode`, `exchangeCodeForToken`, `createRefreshToken`, `exchangeRefreshToken`, `validateMcpToken`, `revokeToken`). Initial token-pair seeding for the race test uses one of:
  - Direct DB inserts via `ctx.su.prisma` (`mcpAccessToken.create` + `mcpRefreshToken.create`) — preferred for test isolation; documented in the test file.
  - Existing `createRefreshToken()` if it covers the full pair issuance.
  - A test-only helper (`seedTokenFamily(prisma, params)`) defined in the test file, NOT in `oauth-server.ts`.
- Per-iteration: **fresh `familyId`** (race loop MUST issue a new pair each iteration; baseline MUST NOT share `familyId` with race iterations).

### Contract 7 — Validation (T18)

- **Single validation entry point**: [`validateMcpToken(token)`](src/lib/mcp/oauth-server.ts) is THE function the test calls to verify token rejection after revocation.
- The test does NOT call route handlers via HTTP for token validation (avoids rate limiter interference, T2 from Round 1).
- `validateMcpToken` checks (existing): signature, revoked status, family status (transitively via FK), tenant integrity. Returns rejection when `revokedAt != null`.

### Contract 8 — Crypto keys (S10)

- Personal vault: keys go through `deriveEncryptionKey(secretKeyBytes)` HKDF chain. Tests do NOT bypass HKDF via raw `importKey("AES-GCM")`.
- Team vault: keys go through `deriveTeamEncryptionKey(teamKey)` HKDF chain.
- Account-token / admin-reset-token: tests stub `getMasterKeyByVersion` returning K1 on encrypt path, K2 on decrypt path (mirrors existing pattern at [account-token-crypto.test.ts:218-243](src/lib/crypto/account-token-crypto.test.ts#L218-L243)).
- All key bytes via `crypto.randomBytes(32)` (Node) or `crypto.getRandomValues(new Uint8Array(32))` (Web Crypto). No hardcoded values.

---

## Per-test design (referencing contracts; no pseudocode)

### Category 1 — Ciphertext-swap (unit tier)

| File | Module | Functions | Contract |
|------|--------|-----------|----------|
| `src/lib/crypto/crypto-client.adversarial.test.ts` | personal vault (E2E client-side) | `encryptData` / `decryptData` | Contract 8 (HKDF via `deriveEncryptionKey`) |
| `src/lib/crypto/crypto-team.adversarial.test.ts` | team vault | `encryptTeamEntry` / `decryptTeamEntry` | Contract 8 (HKDF via `deriveTeamEncryptionKey`) |
| `src/lib/crypto/account-token-crypto.adversarial.test.ts` | account-token | `encryptAccountToken` / `decryptAccountToken` | Contract 8 (spy on `getMasterKeyByVersion`) |
| `src/lib/vault/admin-reset-token-crypto.adversarial.test.ts` | admin-reset-token | `encryptResetToken` / `decryptResetToken` | Contract 8 (spy pattern) |
| `src/lib/crypto/crypto-team-attachment.adversarial.test.ts` | attachment | `encryptTeamAttachment` / `decryptTeamAttachment` | Contract 8 (HKDF via `deriveTeamEncryptionKey`) |

Test pattern per file: generate K1+K2 → encrypt(plaintext, K1) → decrypt(ciphertext, K2) asserts reject + decrypt(ciphertext, K1) asserts success (positive control) + sentinel-grep no plaintext in error.

Pre-implementation check: `node -e "console.log(typeof globalThis.crypto.subtle.encrypt)"` returns `function` (Node 20+ Web Crypto availability for Category 1 module 1).

### Category 2 — Tenant-swap (integration tier)

File: `src/__tests__/db-integration/adversarial/tenant-swap.adversarial.integration.test.ts`

Two scopes: personal vault (`passwordEntry`) AND team vault (`teamPasswordEntry` — Contract 4). For each scope:
1. Seed a row in tenant B via `ctx.su.prisma` (with team setup for team scope: `teams` + `team_members` + `team_password_entries`).
2. Attack: `withTenantRls(ctx.app.prisma, tenantA_id, tx => tx.<correctModel>.findUnique({ where: { id: tenantB_entryId } }))` → assert null.
3. Positive control: same query with `tenantB_id` RLS context → assert returns row.
4. Defense-in-depth: explicit `tenantId` filter check independent of RLS GUC.
5. `afterEach` cleans per Contract 4 cleanup order.

### Category 3 — MCP race (integration tier)

File: `src/__tests__/db-integration/adversarial/mcp-token-rotation-race.adversarial.integration.test.ts`

1. `beforeEach`: tenant + service-account + MCP client + initial token pair via Contract 6 (direct DB insert). Capture `familyId`, `refreshToken`, `clientId`, `clientSecretHash`.
2. Sequential baseline: ONE non-concurrent `exchangeRefreshToken` call. Assert success + old refresh token has `rotatedAt != null`. Use a SEPARATE `familyId` from race iterations (Contract 6).
3. Race loop N=50:
   - Issue fresh token pair (NEW `familyId` each iteration — Contract 6).
   - `raceTwoClients(clientA, clientB, opA, opB)` (4-arg signature) where `opA = (c) => exchangeRefreshToken({...}, {prisma: c})` — requires Contract 6 added `prisma` parameter to `exchangeRefreshToken`.
   - Assert exactly one `{ok: true}` (winner) and one `{ok: false, reason: "concurrent_rotation_revoked"}` (loser).
   - Family-revocation assertion: ALL `mcp_refresh_tokens` for `familyId` have `revokedAt != null`. ALL linked `mcp_access_tokens` revoked.
   - Winner's NEW access token revoked: `await ctx.su.prisma.mcpAccessToken.findUnique({where: {id: winner.accessTokenId}})` (Contract 3 — `accessTokenId` is on the success result). `revokedAt != null`.
   - Token-rejection assertion: `validateMcpToken(winner.accessToken)` → rejected (Contract 7).
   - Audit assertion: `auditLog` row with action `MCP_REFRESH_TOKEN_FAMILY_REVOKED` and `familyId` in metadata exists (Contract 5).
4. `afterEach` cleans per Contract 4 cleanup order.

Anti-flake: `Promise.all` true parallelism, separate pg.Pool per client, no wall-clock timing.

### Production fix scope

[oauth-server.ts](src/lib/mcp/oauth-server.ts) `exchangeRefreshToken`:
- Add optional `options?: {prisma?: PrismaClient}` parameter (Contract 6).
- Restructure per Contract 1 (transaction/RLS context discipline) + Contract 2 (fail-closed) + Contract 3 (return shape with IDs + tenantId + familyId).
- Phase 2 implementer chooses the concrete shape (single transaction with separate revocation tx, or two-phase with explicit error guard, or other approach satisfying contracts).

[token/route.ts](src/app/api/mcp/token/route.ts):
- Audit emission per Contract 5 (in-handler, with `req` context).
- Map `result.reason === "concurrent_rotation_revoked"` to NEW audit action.

---

## Implementation steps

1. **Contract documentation commit**: this plan file (the contracts above) committed to the branch.
2. **Schema migration commit**: add `MCP_REFRESH_TOKEN_FAMILY_REVOKED` to `AuditAction` enum, run `npm run db:migrate` (Contract 4).
3. **CI config commit**: extend `paths:` in [.github/workflows/ci-integration.yml](.github/workflows/ci-integration.yml) with `'src/lib/mcp/**'`, `'src/lib/vault/**'` (T9).
4. **Audit constants commit**: add `MCP_REFRESH_TOKEN_FAMILY_REVOKED` to [audit.ts](src/lib/constants/audit/audit.ts) `AUDIT_ACTION` and `AUDIT_ACTION_GROUPS_TENANT[MCP_CLIENT]` (Contract 5).
5. **Helpers extension commit**: extend [helpers.ts](src/__tests__/db-integration/helpers.ts) `deleteTestData` per Contract 4 cleanup order. Run integration suite — assert no regression.
6. **MCP fix commit**: implement Contracts 1+2+3+5+6 in [oauth-server.ts](src/lib/mcp/oauth-server.ts) and [token/route.ts](src/app/api/mcp/token/route.ts).
7. **Crypto adversarial tests** (5 files, parallelizable): per Category 1 + Contract 8.
8. **Tenant-swap test**: per Category 2 + Contract 4 + Contract 1.
9. **MCP race test**: per Category 3 + Contracts 1, 2, 3, 5, 6, 7.
10. **Mandatory checks**: `npx vitest run`, `npm run test:integration`, `npx next build`, `scripts/pre-pr.sh`.

Per CLAUDE.md PR-cadence: open ONE PR after step 10.

---

## Go / No-Go for Phase 2

**GO when ALL true**:
- [ ] Plan committed (this file).
- [ ] `MCP_REFRESH_TOKEN_FAMILY_REVOKED` enum migration applied to dev DB (`prisma migrate status` clean).
- [ ] Single transaction/RLS context helper confirmed (verify [tenant-rls.ts](src/lib/tenant-rls.ts) exports `withBypassRls` + `withTenantRls`; understand the `prisma` Proxy nesting behavior in [prisma.ts:145-174](src/lib/prisma.ts#L145-L174)).

**NO-GO conditions**:
- Any contract above is reinterpreted during implementation without explicit re-review.
- Pseudocode is added back to this plan (regression to the failure pattern).
- Implementation begins before the schema migration is applied.

---

## Testing strategy

The tests ARE the deliverable. Each test demonstrates non-vacuous passing:

- Crypto: positive control (K1 succeeds) + negative (K2 fails) + sentinel-grep.
- Tenant-swap: positive control (tenantB context returns row) + negative (tenantA context returns null) + correct model name per Contract 4.
- MCP race: cardinality assertions (`successes.length === 1`, `replays.length === 1`) + family-state assertions (all family tokens revoked, including winner's new token) + audit row assertion (Contract 5) + sequential baseline with separate `familyId`.

After implementation, hand-mutation: change one assertion at a time, re-run, confirm regression catch.

---

## Considerations & constraints

### Risks

- MCP race fix is security-sensitive (R34 carve-out). Required: R3 propagation check; security-relevant test path re-run; manual verification all callers handle new `concurrent_rotation_revoked` reason.
- Fail-closed posture invalidates legitimate double-submit (e.g., AI agent network retry). User decision (Round 2): acceptable trade-off vs. attacker-wins-then-victim-abandons window.
- `deleteTestData` extension may break existing tests. Mitigation: run integration suite IMMEDIATELY after step 5 commit, BEFORE adding new tests.
- Phase 1 → Phase 2 latency (Phase 2 = family revocation tx). Window is bounded by DB write latency (~ms). Acknowledged as inherent to out-of-band revocation; documented but not eliminated.

### Constraints

- Tests run as `passwd_app` (NOSUPERUSER, NOBYPASSRLS) in integration. RLS enforced.
- No PII; placeholders only.
- No hardcoded secrets; use `crypto.randomBytes(32)`.

---

## Round history summary

- **Round 1** (13 findings): personal-vault target switched from crypto-server.ts to crypto-client.ts (S1); MCP CAS-before-create restructure (F2); v1 route + makeTestSession dropped, direct Prisma + RLS (T5/F4); race test uses raceTwoClients (T1/T2); N=50 (T8); CI paths extended (T9); deleteTestData extension scoped (F5/T3); crypto-team HKDF derivation explicit (F1); spec citation reworded (S3).
- **Round 2** (11 findings): fail-closed adopted (S9 — user decision); RFC 9700 §4.14.2 verified verbatim; `prisma` parameter added to `exchangeRefreshToken` (T10/F9); winner-token assertion direction corrected (T13); `withTeamTenantRls` dropped (T11/F11); audit reason union extended (F12); throw-vs-return decided (S8 — return); RFC citation honesty (S3 follow-through).
- **Round 3** (12 findings): contract-first rewrite triggered. Pseudocode-driven plan iteration was the failure mode — every rewrite introduced new bugs in new pseudocode. Plan now defines 8 contracts (Transaction/RLS, Fail-closed, Token I/O, Schema, Audit, API, Validation, Crypto keys). Critical findings F13, F16, F20/S13/T17, T15 absorbed into contracts. Major findings F14/F15/F17/F18/F19/F24/S12/T16/T18/T19 absorbed into contracts. Minor findings F21/F22/F23/T14/T20 deferred to Phase 2 type-checker / implementation review.

Full review records (Round 1) in [adversarial-crypto-tenant-tests-review.md](./adversarial-crypto-tenant-tests-review.md). Round 2 + Round 3 findings preserved in this document's contract derivation (each contract cites the originating findings).
