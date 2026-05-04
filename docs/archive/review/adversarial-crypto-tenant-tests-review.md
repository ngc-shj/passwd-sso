# Plan Review: adversarial-crypto-tenant-tests
Date: 2026-05-04
Review round: 1

## Changes from Previous Round

Initial review.

## Functionality Findings

### F1 [Major]: crypto-team adversarial test must call deriveTeamEncryptionKey() — not generateKey directly

- File: [crypto-team.ts:390-406](src/lib/crypto/crypto-team.ts#L390-L406)
- Evidence: `encryptTeamEntry(plaintext, teamEncryptionKey: CryptoKey, ...)` — the parameter is a *derived* CryptoKey, not raw bytes. Direct `crypto.subtle.generateKey("AES-GCM", ...)` would bypass the HKDF derivation chain.
- Problem: Plan's "32 random bytes / Web Crypto generateKey" wording could lead an implementer to bypass the HKDF derivation path.
- Impact: Test would pass for the wrong reason (key-format mismatch, not GCM auth-tag mismatch from cross-key decrypt).
- Fix: Plan should specify: generate two random `Uint8Array` keys via `generateTeamSymmetricKey()`, then call `deriveTeamEncryptionKey(k1)` / `deriveTeamEncryptionKey(k2)` to obtain two distinct derived `CryptoKey` objects.

### F2 [Major]: CAS fix structural ordering error — new tokens are created BEFORE the updateMany check

- File: [oauth-server.ts:357-388](src/lib/mcp/oauth-server.ts#L357-L388)
- Evidence: New `mcpAccessToken.create` (line 357-367) and `mcpRefreshToken.create` (line 370-382) execute BEFORE the rotated-mark `update` at line 385.
- Problem: Plan's `updateMany WHERE rotatedAt IS NULL` CAS happens AFTER new tokens are already created. If `count===0`, the loser's two new token rows are already inserted in its transaction.
- Impact: Both concurrent callers create new `McpAccessToken`/`McpRefreshToken` rows. Loser's CAS fails but rows persist → orphaned rows in the family that the revocation `updateMany` (filtered by `familyId = rt.familyId`) does not catch (loser's new tokens have a different chain link until the row is committed).
- Fix: Restructure so the `updateMany` CAS check comes first (immediately after validating the refresh token, before creating any new tokens). Only on `count===1` proceed to create new tokens. On `count===0`, **throw a sentinel error** to force Prisma transaction rollback (do NOT just `return` — Prisma commits a normally-returned transaction).

### F3 [Minor]: Clarify whether race test calls POST(request) or exchangeRefreshToken() directly

- File: [src/app/api/mcp/token/route.ts:154](src/app/api/mcp/token/route.ts#L154)
- Evidence: `POST = withRequestLog(handlePOST)`. Existing DB integration tests call library functions directly, not HTTP handlers.
- Problem: Plan uses HTTP-request language ambiguously.
- Fix: Specify: call `exchangeRefreshToken(params)` directly with DB-seeded client credentials. (Resolved by T1/T2 fix.)

### F4 [Major]: GET /api/v1/passwords/[id] uses API key auth (validateV1Auth), NOT session — makeTestSession useless

- File: [src/app/api/v1/passwords/[id]/route.ts:7-29](src/app/api/v1/passwords/[id]/route.ts#L7-L29)
- Evidence: Imports `validateV1Auth`; checks `Authorization: Bearer` header.
- Problem: The plan's `makeTestSession` proposal would not authenticate against this v1 route.
- Impact: v1 tenant-swap test would always 401 (vacuous "pass").
- Fix: Either replace v1 route with `/api/passwords/[id]` (session-aware), OR replace handler-invocation approach entirely (see T5).

### F5 [Major]: deleteTestData does NOT clean password_entries, mcp_clients, mcp_*_tokens — FK violations on teardown

- File: [src/__tests__/db-integration/helpers.ts:152-196](src/__tests__/db-integration/helpers.ts#L152-L196)
- Evidence: Helper deletes only `audit_*`, `tenant_members`, `users`, `tenants`. `password_entries.tenant` has `onDelete: Restrict` (schema line 379). `mcp_clients.tenant` has `onDelete: Restrict` (schema line 1785).
- Problem: New test files seed `password_entries` and `mcp_*` rows; tenant deletion fails.
- Impact: `afterEach`/`afterAll` cleanup throws FK violations; subsequent tests see corrupt state.
- Fix: Extend `deleteTestData` to cover the new tables in FK-safe order, OR add per-test explicit teardown.

### F8 [Minor]: Introductory wording conflates Buffer vs CryptoKey across modules

- File: [adversarial-crypto-tenant-tests-plan.md:80](docs/archive/review/adversarial-crypto-tenant-tests-plan.md#L80)
- Evidence: `crypto-server.ts` uses `node:crypto` `randomBytes(32)` → `Buffer`; `crypto-team.ts` uses Web Crypto `CryptoKey`.
- Problem: Single intro line conflates two different key types.
- Fix: Per-module guidance in the introduction.

## Security Findings

### S1 [Major]: crypto-server.ts is NOT used for personal vault — test target selection is wrong

- File: [crypto-server.ts:1-12](src/lib/crypto/crypto-server.ts#L1-L12) (header), various callers
- Evidence: Header comment: "Used for share links, sends, and passphrase verification. Team vault encryption is fully E2E (client-side) via crypto-team.ts." Callers: `webhook-dispatcher`, `delegation`, `tenant/webhooks`, `audit-delivery-targets` — all share/send/webhook/delegation, NOT personal vault.
- Problem: Personal vault is fully E2E. Server never decrypts personal vault entries. `crypto-server.ts` is for server-side share/send/webhook secrets.
- Impact: Plan claim "ciphertext-swap test for personal vault via crypto-server.ts" is structurally wrong. Issue #435 acceptance criterion not actually met.
- Fix: Switch personal-vault target to `crypto-client.ts` (the actual personal vault path). Node 20+ has native Web Crypto via `globalThis.crypto.subtle`, so vitest's `node` environment can run client-crypto tests directly without JSDOM.

### S2 [Major]: CAS fix needs explicit throw — Prisma must rollback on count===0

- File: [oauth-server.ts:384-388](src/lib/mcp/oauth-server.ts#L384-L388)
- Evidence: `updateMany` returns `{ count }`, not row. `count===0` path must explicitly throw to trigger transaction rollback.
- Problem: Plan recommends "treat as replay, revoke family, return invalid_grant" without specifying rollback path. Returning normally from `prisma.$transaction(async tx => ...)` commits the transaction, including any new-token INSERTs from earlier in the function.
- Impact: Loser leaves orphaned new-token rows committed.
- Fix: On `count===0`, throw a sentinel error (e.g., `RaceLostError`) caught by the outer handler and converted to `invalid_grant`. Cleanest combined with F2's restructure (CAS first, then conditional create).
- escalate: true → **SKIPPED** (F2 from independent expert corroborates same orchestration concern; Opus re-run unlikely to add value)

### S3 [Major]: "OAuth 2.1 invariant" is unverified spec citation (R29)

- File: [adversarial-crypto-tenant-tests-plan.md:146,152,256](docs/archive/review/adversarial-crypto-tenant-tests-plan.md#L146)
- Evidence: OAuth 2.1 (draft-ietf-oauth-v2-1) recommends rotation but does not mandate family-revocation.
- Problem: Plan presents family-revocation as OAuth 2.1 spec mandate; it's a project-specific implementation choice.
- Fix: Reword as "the project's refresh-token replay invariant" (or cite OAuth 2.0 Security BCP RFC 9700 §4.13.2 only after verifying the section exists and matches).

### S4 [Minor]: share-links bypass-RLS test design is conceptually wrong

- File: [src/app/api/share-links/[id]/content/route.ts](src/app/api/share-links/[id]/content/route.ts)
- Evidence: Uses `withBypassRls`; share link is unauth public endpoint; tenant context is irrelevant (no requesting tenant exists).
- Problem: Test "tenant A can't access tenant B share link" tests something with no security meaning.
- Fix: Drop this test from scope OR reframe as "access token for share link in tenant B cannot be reused on share link in tenant A" (HMAC token-validation boundary).

### S5 [Minor]: Concurrent JTI replay gap (multi-process / Redis-fallback) — out of scope but worth noting

- File: [src/lib/auth/dpop/jti-cache.ts](src/lib/auth/dpop/jti-cache.ts)
- Evidence: Redis path is atomic SET NX. In-memory fallback is process-local; multi-process deploys with Redis down = vulnerability window.
- Problem: Issue #435 doesn't include this, but same threat-model class.
- Fix: Document in plan as out-of-scope; note Redis-required production posture.

### S6 [Minor]: makeTestSession DB Session record requirement is undefined

- File: [check-auth.ts:103](src/lib/auth/session/check-auth.ts#L103)
- Evidence: Auth.js v5 database strategy: cookie value = sessionToken; `auth()` does DB lookup.
- Problem: Plan doesn't specify how `makeTestSession` constructs the cookie or seeds the DB row.
- Fix: Specify if used, OR drop entirely if T5 fix avoids handler invocation. (Resolved by T5 fix → drop helper.)

## Testing Findings

### T1 [Major]: MCP race test uses single Prisma singleton — race window cannot open

- File: [oauth-server.ts:291-404](src/lib/mcp/oauth-server.ts#L291-L404); plan §Category 3
- Evidence: `prisma` singleton uses single `pg.Pool`. Existing `raceTwoClients` ([helpers.ts:238-251](src/__tests__/db-integration/helpers.ts#L238-L251)) uses two SEPARATE `pg.Pool` instances.
- Problem: Two `POST(req)` on the same singleton may serialize at pool level; race window doesn't open.
- Impact: 5 iterations give false confidence; invariant not actually exercised.
- Fix: Use `createPrismaForRole("app")` × 2 + `raceTwoClients` helper. Call `exchangeRefreshToken` directly (not via route handler). Pattern at [admin-vault-reset-dual-approval.integration.test.ts:166](src/__tests__/db-integration/admin-vault-reset-dual-approval.integration.test.ts#L166).

### T2 [Major]: Rate limiter (10/min on tokenRateLimiter) will 429 the second concurrent POST

- File: [token/route.ts:105-112](src/app/api/mcp/token/route.ts#L105-L112)
- Evidence: `tokenRateLimiter.check(`mcp:token:${clientIdValue}`)` max 10/min.
- Problem: Two concurrent POST with same `client_id` share one rate-limit key.
- Impact: Second request 429s; assertion fails spuriously.
- Fix: Call `exchangeRefreshToken` directly (bypasses HTTP layer + rate limiter) — addresses T1 and T2 together.

### T3 [Major]: deleteTestData does not cover MCP tables — overlaps F5

- File: [helpers.ts:152-195](src/__tests__/db-integration/helpers.ts#L152-L195)
- Evidence: Helper omits `mcp_access_tokens`, `mcp_refresh_tokens`, `mcp_authorization_codes`, `mcp_clients`, `service_accounts`.
- Fix: Extend `deleteTestData` OR add explicit per-test cleanup before generic helper runs.

### T4 [Minor]: MCP race test missing negative control (positive baseline)

- File: plan §Category 3, §Testing strategy
- Evidence: Plan describes race assertion but no single sequential-exchange success baseline.
- Problem: Setup bug indistinguishable from race violation.
- Fix: Add `beforeEach` single-exchange verification step before the race loop.

### T5 [Major]: Tenant-swap test using checkAuth → auth() will 401 unless valid signed cookie provided

- File: [check-auth.ts:103](src/lib/auth/session/check-auth.ts#L103); plan §Category 2 step 4
- Evidence: `auth()` reads session cookie from real `NextRequest`; Auth.js v5 database strategy needs both cookie AND DB Session row.
- Problem: Plan doesn't specify HOW to mint a valid signed cookie; no helper exists.
- Impact: Tests 401 instead of 404; vacuous "pass".
- Fix: Don't invoke the route handler at all. Call `ctx.app.prisma.passwordEntry.findUnique` within `withTenantRls(ctx.app.prisma, tenantA, ...)`, assert returns null. Direct RLS test focused on the actual security boundary.

### T6 [Minor]: Line reference :72-120 misleading; correct is :218-243

- File: [account-token-crypto.test.ts:218-243](src/lib/crypto/account-token-crypto.test.ts#L218-L243)
- Evidence: Lines 72-120 are AAD-mismatch tests, not key-swap.
- Fix: Update plan citation.

### T8 [Major]: 5-iteration loop statistically insufficient for race test

- File: [admin-vault-reset-dual-approval.integration.test.ts:156-203](src/__tests__/db-integration/admin-vault-reset-dual-approval.integration.test.ts#L156-L203)
- Evidence: Existing precedent uses N=50.
- Problem: 5 iterations → ~3.1% false-green probability per CI run.
- Fix: Use N=50 to match existing precedent; document statistical reasoning.

### T9 [Major]: ci-integration.yml paths filter omits src/lib/mcp/** and src/lib/vault/**

- File: [.github/workflows/ci-integration.yml:10-21](.github/workflows/ci-integration.yml#L10-L21)
- Evidence: `paths` covers `auth`/`prisma`/`redis`/`tenant-rls`/`tenant`/`workers`/`db-integration`+`schema`. Does NOT cover `mcp` or `vault`.
- Problem: Race-fix change to `oauth-server.ts` won't trigger CI integration job in future PRs.
- Fix: Add `'src/lib/mcp/**'` and `'src/lib/vault/**'` to `paths` filter.

## Adjacent Findings

None explicitly tagged.

## Quality Warnings

None — all findings include file/line evidence and actionable fix.

## Recurring Issue Check

### Functionality expert
- R1: PASS (helpers reused)
- R2: N/A
- R3: PASS (additive)
- R4-R15: N/A
- R16: PASS (passwd_app + RLS enforced in integration)
- R17: PASS (no new shared helper introduced beyond helpers.ts addition)
- R18: N/A
- R19: PASS (helpers.ts addition would not affect existing mocks; F5 covers exact-shape gap)
- R20-R23: N/A
- R22: PASS (deleteTestData inverted check found F5)
- R24-R36: N/A or PASS

### Security expert
- R1-R28: PASS or N/A
- R29: FAIL — S3
- R30-R36: PASS or N/A
- RS1: PASS
- RS2: N/A
- RS3: N/A
- RS4: PASS (no PII in plan)

### Testing expert
- R1: PASS
- R2-R32: PASS or N/A
- R33: FLAGGED — T9
- R34-R36: N/A
- RT1: PASS
- RT2: PARTIAL FAIL — T5 (session-handler not directly testable)
- RT3: MINOR (OAuth wire-protocol values are spec-mandated literal strings, acceptable)

---

# Plan Review: adversarial-crypto-tenant-tests
Date: 2026-05-04
Review round: 2

## Changes from Previous Round

Round 1 fixes applied: personal vault target switched to crypto-client.ts (S1); MCP CAS-before-create restructure with throw-from-transaction (F2); v1 route and makeTestSession dropped (T5/F4); race test uses raceTwoClients with separate pools (T1/T2); N=50 iterations (T8); CI paths extended for mcp/vault (T9); deleteTestData extension scoped (F5/T3); crypto-team HKDF derivation explicit (F1); spec citation reworded as project-specific invariant (S3).

## Round 2 Findings (Major + Critical only — full output preserved in /tmp/tri-l6QoU8 backups)

### F9 / T10 [Critical] — exchangeRefreshToken lacks `prisma` param + raceTwoClients arity mismatch
Plan called `raceTwoClients(async (clientA, clientB) => Promise.all([...]))` — but actual signature is `(clientA, clientB, opA, opB)` (4 args). `exchangeRefreshToken({prisma: clientA, ...})` would fail because the function doesn't accept a `prisma` field. Resolution: add optional `prisma` param to exchangeRefreshToken; correct invocation to 4-arg form.

### F11 / T11 [Critical] — withTeamTenantRls API mismatch
Plan called `withTeamTenantRls(ctx.app.prisma, tenantA_team_id, fn)` but actual signature is `(teamId, fn)` — uses module singleton, not injected client. Resolution: drop `withTeamTenantRls`; use `withTenantRls(ctx.app.prisma, tenantA_id, fn)` directly for both vault types.

### S7 [Major] — Internal contradiction: "replay" vs "concurrent_rotation"
Plan text contradicted itself between assertion and pseudocode. Resolution: canonical reason values fixed — `"replay"` for sequential rotated-token reuse, `"concurrent_rotation_revoked"` for race-loser.

### S8 [Major] — Route handler missing try/catch for RaceLostError → 500
Plan threw RaceLostError but route handler had no try/catch. Resolution: function returns typed result instead of throwing; no try/catch needed.

### S9 [Critical, escalate=true → SKIPPED per user decision] — concurrent_rotation rollback creates session-hijacking window
The proposed CAS-with-throw fix would roll back the loser's family-revocation alongside its other state. Attacker who wins race + victim who abandons retry = attacker holds tokens until expiry. Resolution: fail-closed adopted (user decision). Family revocation moved to separate transaction that commits unconditionally (`revokeFamilyOutOfBand`). Spec basis: RFC 9700 §4.14.2 verbatim quote (verified against live RFC) + conservative extension to concurrent case. Escalation skipped: F2/Round 2 corroborates orchestration concern; fix path concrete and RFC-grounded.

### T13 [Critical] — Winner-token-revoked assertion semantically inverted
Plan asserted `winner.accessToken.id` has `revokedAt != null` — but `accessToken` is a string, not an object. Resolution: under fail-closed, the WINNER's new access token IS revoked too (entire family). Test queries DB by `winner.accessTokenId` — requires Contract 3 (Token I/O) to include `accessTokenId` on success result.

### F12 [Major] — concurrent_rotation_revoked not in TypeScript union; no audit
Resolution: extend return type union; emit `MCP_REFRESH_TOKEN_FAMILY_REVOKED` audit action (NEW constant — requires schema migration per Contract 4).

### S10 / S11 / F10 [Minor] — Personal vault function names + HKDF chain
Plan said `encryptEntry`/`decryptEntry` (don't exist) and used raw `importKey` (bypasses HKDF). Resolution: actual exports `encryptData`/`decryptData`; use `deriveEncryptionKey(secretKey)` for HKDF chain.

### T12 [Major] — DelegationSession in cleanup chain
Resolution: documented FK-safe order including delegation_sessions.

---

# Plan Review: adversarial-crypto-tenant-tests
Date: 2026-05-04
Review round: 3

## Changes from Previous Round

Round 2 reworked the plan with detailed Phase1/Phase2 pseudocode. Round 3 surfaced 12 new findings — predominantly bugs in the new pseudocode (RLS bypass nesting, missing function args, fabricated function names, schema migration omitted, wrong Prisma model for team vault, undefined fields on success result). The pattern: pseudocode-driven plan iteration was producing diminishing returns — each rewrite introduced new bugs in new pseudocode, while underlying conceptual contracts remained underspecified.

## Decision (user, Round 3)

Adopt **contract-first rewrite (Option B)**. The plan defines 8 contracts that the implementation MUST satisfy; pseudocode is removed entirely. Reviewer focus moves from line-by-line code to contract conformance. Critical and Major findings are absorbed into the contracts; pseudocode-level Minor findings (e.g., dead `FamilyCompromiseDetected` class, unspecified Prisma role for raceTwoClients, missing audit assertion) are deferred to Phase 2 where TypeScript types and the actual test harness will surface them naturally.

## Round 3 Findings (mapped to contracts)

| ID | Severity | Contract / disposition |
|----|----------|------------------------|
| F13 | Critical | Contract 1 (Transaction/RLS) — forbids nested $transaction on raw client |
| F14, F15 | Major | Contract 6 — `withBypassRls` purpose param mandatory |
| F16 | Critical | Contract 4 + implementation step 2 — schema migration BEFORE other commits |
| F17 | Major | Contract 5 — audit emission stays in route handler |
| F18 | Major | Contract 3 — return type carries tenantId, familyId |
| F19 / S14 | Major | Contract 6 — no fabricated function names; test seeds via existing exports or direct DB insert |
| F20 / S13 / T17 | Critical | Contract 3 — success result includes `accessTokenId` |
| F21 | Minor | Deferred — TypeScript will flag dead class; no contract change |
| F22 | Minor | Documented in Considerations & constraints (Phase 1→2 latency window) |
| F23 | Minor | Deferred — implementer follows existing client-validation pattern |
| F24 | Major | Contract 5 — canonical reason union includes `"not_found"` |
| S12 | Major | Contract 2 — fail-closed handling on Phase 2 DB failure (try/catch + log; durable retry as follow-up) |
| S15 | Minor | Contract 2 wording corrected — "bounded ms-scale window" not "before attacker can use" |
| T14 | Minor | Deferred — implementer chooses `passwd_app` role, documented in test |
| T15 | Critical | Contract 4 — `teamPasswordEntry` model name explicit |
| T16 | Major | Contract 4 cleanup order — `team_password_entries` + `teams` added |
| T18 | Major | Contract 7 — `validateMcpToken` is the single validation entry point (no HTTP) |
| T19 | Major | Contract 6 — fresh familyId per iteration mandated |
| T20 | Minor | Per-test design Category 3 — audit assertion explicitly listed |

## Recurring Issue Check

R29: PASS — RFC 9700 §4.14.2 verbatim citation verified against live RFC; extension to concurrent case explicitly noted as stronger interpretation than literal text. No other unverified citations.

R34 (security carve-out): PASS — production fix is identified, contracts enforce all known safety properties (transaction/RLS context, fail-closed, audit emission with context, validation single-entry).

R36: N/A — no static-analysis suppressions.
