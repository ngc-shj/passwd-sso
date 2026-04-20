# Code Review: api-key-ip-bypass-and-share-toctou

Date: 2026-04-20T12:45Z
Review round: 1
Branch: fix/api-key-ip-bypass-and-share-toctou
Base commit: 408803e7

## Changes from Previous Round
Initial review.

## Diff summary
- src/app/api/api-keys/[id]/route.ts — drop `skipAccessRestriction: true`
- src/app/api/api-keys/route.ts — drop `skipAccessRestriction: true` on GET + POST
- src/app/api/api-keys/[id]/route.test.ts — assertion drops `skipAccessRestriction: true`
- src/app/api/api-keys/route.test.ts — two assertions updated
- src/app/api/share-links/[id]/content/route.ts — add `revoked_at IS NULL AND expires_at > NOW()` to UPDATE WHERE; FILE path adds no-op conditional UPDATE
- src/app/api/share-links/[id]/content/route.test.ts — rewrite FILE non-increment assertion, mock 0 for max-views test, +2 TOCTOU tests

## Functionality Findings

### F1 [Major]: TOCTOU pattern unfixed in /s/[token]/download/route.ts
- File: src/app/s/[token]/download/route.ts:91-106
- Evidence: both the password-protected and non-protected UPDATE branches only re-assert `id` and `max_views` (same pre-fix pattern).
- Problem: The JS-level revoked/expired check at line 58 is not re-asserted in the UPDATE. A share revoked/expired between findUnique and the UPDATE still has `view_count` incremented and the decrypted file streamed.
- Impact: Revoked/expired FILE Send content can be exfiltrated during the race window — higher-impact sibling of the content fix since binary payloads are larger.
- Fix: Add `AND "revoked_at" IS NULL AND "expires_at" > NOW()` to both UPDATE WHERE clauses.

### F2 [Major]: TOCTOU pattern unfixed in /s/[token]/page.tsx
- File: src/app/s/[token]/page.tsx:93-97
- Evidence: public server component for non-protected (no access password) shares has the same UPDATE pattern.
- Problem: Same TOCTOU for non-protected public shares (broader audience since no password gate).
- Impact: Non-protected shares can leak decrypted entry data after revocation/expiry.
- Fix: Same additive predicates in the UPDATE WHERE.

### F3 [Minor]: Inconsistent expiry strictness between JS and SQL checks
- File: src/app/api/share-links/[id]/content/route.ts:75 vs 93,110
- Evidence: JS uses `<` (valid if `expiresAt == now`); SQL uses `>` (invalid if `expires_at == NOW()`).
- Problem: SQL stricter than JS — at the microsecond boundary a share accepted by JS may be rejected by SQL. Fail-safe direction, no correctness/security regression.
- Fix: Document the asymmetry (optional) or align boundaries.

### F4 [Minor]: No-op UPDATE on FILE path creates WAL / autovacuum overhead
- File: src/app/api/share-links/[id]/content/route.ts:105-111
- Evidence: PostgreSQL writes a new heap tuple for every UPDATE regardless of value equality; BEFORE UPDATE trigger `trg_enforce_tenant_id_password_shares` fires (short-circuits via `app.bypass_rls` fast-path).
- Problem: Per-request tuple churn on active shares.
- Fix: Consider `SELECT 1 FROM password_shares WHERE ... FOR UPDATE` to take a row lock without heap write. Trade-off: current approach is uniform with the non-FILE branch.

### F5 [Minor, Adjacent → Testing]: FILE no-op regression coverage is loose
- See T2 below. Flagged by Functionality expert; dedup target is Testing T2.

## Security Findings

### S1 [Major]: Tenant IP restriction NOT enforced on POST /api/extension/token/refresh
- File: src/app/api/extension/token/refresh/route.ts:28-141
- Evidence: route listed as Bearer-bypass in proxy.ts:190, but handler calls `validateExtensionToken(req)` directly — no `enforceAccessRestriction` invocation.
- Problem: Same root cause class as Finding 1 (now fixed for /api/api-keys) — bearer-bypass route that does not enforce tenant CIDR/Tailscale at the handler.
- Attack vector: Attacker exfiltrates an extension bearer inside the tenant network, relocates off-network, rotates via refresh once per idleTimeout window to keep the token live indefinitely until family absolute cap (default 30 days).
- Impact: Tenant network-boundary bypassed for extension token lifecycle. Same severity as Finding 1.
- Fix: Call `enforceAccessRestriction(req, result.data.userId, activeSession.tenantId)` after `validateExtensionToken` success, before rotation. `tenantId` already resolved from activeSession.

### S2 [Major]: TOCTOU in FILE Send /s/[token]/download/route.ts (duplicate of F1)
- See F1. Security angle: FILE payloads are typically higher-sensitivity binary content.

### S3 [Minor]: Tenant IP not enforced on /api/tenant/access-requests (SA JIT)
- File: src/app/api/tenant/access-requests/route.ts:97-214
- Evidence: `handlePOST` calls `authOrToken(req)` directly (line 98); no `enforceAccessRestriction`.
- Problem: `sa_` token with `access-request:create` can queue JIT requests from any IP. No token is issued without admin approval, so no privilege escalation — but DoS / audit noise vector from off-network.
- Fix: Add `enforceAccessRestriction(req, userId, tenantId)` after tenant resolution in each branch, or migrate to `checkAuth`.

### S4 [Minor]: Tenant IP not enforced on GET /api/vault/delegation/check
- File: src/app/api/vault/delegation/check/route.ts:27-103
- Evidence: handler calls `authOrToken(request)` directly, no IP check. Reachable via Bearer per proxy.ts:193.
- Problem: CLI agent using an extension bearer from outside the tenant network can probe delegation authorization for arbitrary entryIds. Reconnaissance risk; no plaintext returned.
- Fix: Add `enforceAccessRestriction` after `hasUserId(authResult)`.

### S5 [Minor]: Tenant IP not enforced on DELETE /api/extension/token
- File: src/app/api/extension/token/route.ts:80-108
- Evidence: handleDELETE calls `validateExtensionToken(req)` only.
- Problem: Consistency-only; revoking one's own token from off-network is not a privilege escalation.
- Fix: Optional — add enforceAccessRestriction for policy consistency across the extension-token lifecycle.

## Testing Findings

### T1 [Major]: TOCTOU tests do not verify SQL predicates — only the 410 branch
- File: src/app/api/share-links/[id]/content/route.test.ts:223-238 (and the FILE variant)
- Evidence: `mockPrismaExecuteRaw.mockResolvedValue(0)` → handler returns 410. The tagged-template SQL body is opaque to the mock — a predicate-dropping regression would still return 0 rows in the mocked world and still pass.
- Problem: Tests named "TOCTOU" do not exercise TOCTOU-specific SQL state; they only prove "when $executeRaw returns 0, handler returns 410."
- Impact: The exact regression class the fix targets (missing `revoked_at IS NULL` / `expires_at > NOW()`) is not guarded by these tests.
- Fix: Capture the tagged-template `strings` array from the mock and assert each predicate appears in the SQL body.

### T2 [Minor]: "does not increment viewCount for FILE shares" lost its no-write proof
- File: src/app/api/share-links/[id]/content/route.test.ts:192-204
- Evidence: previous assertion `expect(mockPrismaExecuteRaw).not.toHaveBeenCalled()` replaced with `expect(json.viewCount).toBe(MOCK_SHARE.viewCount)`.
- Problem: New assertion checks only the response field, which is computed as `share.viewCount + viewCountDelta` from the pre-UPDATE snapshot. An accidental `+ 1` in the FILE SET clause would still pass because the response reads the cached value.
- Fix: Add structural assertion: the SQL body contains `SET "view_count" = "view_count"` (not `+ 1`) and `$executeRaw` was called exactly once.

### T3 [Minor]: Two FILE 410 tests are indistinguishable at the handler level
- File: src/app/api/share-links/[id]/content/route.test.ts:206-238 (max_views vs TOCTOU)
- Evidence: both mock `$executeRaw → 0`; handler reads neither `maxViews` nor `revokedAt` after the JS pre-check, so the two scenarios are functionally identical to the handler.
- Fix: Merge or combine with T1's predicate assertions so each test verifies a distinct predicate matched 0 rows.

## Adjacent Findings
- F5 (Functionality) routes to Testing — dedup to T2.

## Quality Warnings
None — all findings include file:line evidence and concrete fix recommendations.

## Seed Finding Dispositions

### Functionality seed
- F-seed-1 (`expires_at > NOW()` fails for NULL at line 86) — **Rejected**: `PasswordShare.expiresAt` is `DateTime` (NOT NULL) in prisma/schema.prisma:733. Never-expiring shares are not modeled. Pre-existing JS comparison `share.expiresAt < new Date()` confirms non-null runtime invariant.
- F-seed-2 (same claim at line 96 FILE branch) — **Rejected**: same reason.

### Security seed
- Empty (returned "No findings") — performed full R1-R30 check independently per seed-trust advisory. Discovered S1-S5.

### Testing seed
- T-seed-1 (api-keys IP enforcement not tested) — **Rejected**: split-responsibility coverage is intentional. `check-auth.test.ts:247-366` covers `skipAccessRestriction` branch under `describe("skipAccessRestriction option")` and `describe("allowTokens + skipAccessRestriction")`. Route tests assert `checkAuth` receives strict `{ allowTokens: true }` (exact-shape match) so a regression reintroducing `skipAccessRestriction: true` would fail.
- T-seed-2 (assertion title too vague) — **Rejected**: behavior-based titles beat argument-shape titles. Regression would be stylistic.

## Recurring Issue Check

### Functionality expert
- R1: Checked — no issue
- R2: Checked — no issue
- R3: Finding F1, F2 (TOCTOU propagation gap)
- R4: Checked — no issue
- R5: Checked — no issue (single-statement UPDATE is atomic; tx wrapping intact)
- R6: Checked — no issue
- R7: Addressed for target files; F1/F2 for siblings
- R8: Checked — no issue (non-null column)
- R9: Checked — no issue
- R10: N/A
- R11: Checked — no issue
- R12: Checked — no issue
- R13: N/A
- R14: Finding F3 (boundary strictness asymmetry)
- R15: Checked — no issue
- R16: Checked — no issue
- R17: Checked — helper extraction deferred until F1/F2 fix
- R18: Checked — no issue
- R19: Finding F5 → Adjacent → T2
- R20: Checked — no issue
- R21: N/A
- R22: N/A
- R23: N/A
- R24: N/A
- R25: N/A
- R26: N/A
- R27: Finding F4 (trigger overhead on no-op UPDATE, short-circuits)
- R28: Checked — no issue
- R29: N/A
- R30: Checked — no issue

### Security expert
- R1: Finding 1 fixed; S1/S3/S4/S5 remain
- R2: Checked — no issue
- R3: Finding S2 (TOCTOU propagation)
- R4: Checked — no issue (fail-closed behavior preserved)
- R5: Checked — no issue
- R6: N/A
- R7: N/A
- R8: Checked — no issue
- R9: N/A
- R10: N/A
- R11: Checked — HMAC-verified payload
- R12: N/A
- R13: N/A
- R14: Checked — `passwd_app` has SELECT on tenants (verified infra/postgres/initdb/02-create-app-role.sql:31)
- R15: Checked — rate limiters preserved
- R16: Checked — ACCESS_DENIED audit emitted on denial
- R17: Checked — covered by RS1
- R18: Addressed in fix target files; S2 remaining
- R19: Checked — api_key/mcp_token rejected post-checkAuth
- R20: Checked — no change
- R21: Checked — no change
- R22: Checked — no change
- R23: N/A
- R24: Checked — NOT NULL column
- R25: Checked — server time
- R26: Checked — all methods updated
- R27: Checked — explicit 403 on denial
- R28: N/A
- R29: Checked — citations verified
- R30: Checked — no drift
- RS1: Checked — `verifyShareAccessToken` uses `crypto.timingSafeEqual`
- RS2: Checked — rate limiters preserved
- RS3: Checked — no new inputs

### Testing expert
- R1-R30: All checked; no additional hits beyond T1-T3
- R7: N/A
- R19: Finding T1, T2 (exact-shape for SQL body)
- R21: Vacuous-equivalent pair → Finding T3
- RT1: Mock alignment OK (Postgres returns matched row count for no-op UPDATE)
- RT2: Proposed SQL-text assertions feasible in vitest
- RT3: Checked — no issue

## Proposed Resolution Map

| Finding | Severity | Disposition |
|---|---|---|
| F1 / S2 (/s/[token]/download TOCTOU) | Major | **FIX in this PR** — same class as Finding 2 scope |
| F2 (/s/[token]/page.tsx TOCTOU) | Major | **FIX in this PR** — same class |
| S1 (/api/extension/token/refresh IP bypass) | Major | **FIX in this PR** — same class as Finding 1 scope |
| T1 (TOCTOU SQL predicate test) | Major | **FIX in this PR** — required to guard the fix |
| T2 (FILE no-op proof) | Minor | **FIX in this PR** — minor cost |
| T3 (vacuous-equivalent pair) | Minor | **FIX in this PR** — fold into T1 |
| F5 | Minor (Adjacent) | Dedup to T2 — same fix |
| F3 (expiry strictness asymmetry) | Minor | **Accept** — fail-safe direction, add one-line comment |
| F4 (no-op UPDATE WAL) | Minor | **Accept** — trade-off against consistency with non-FILE branch; document |
| S3 (/api/tenant/access-requests IP bypass) | Minor | **DEFER to separate PR** (pending user decision) |
| S4 (/api/vault/delegation/check IP bypass) | Minor | **DEFER to separate PR** (pending user decision) |
| S5 (DELETE /api/extension/token IP bypass) | Minor | **DEFER to separate PR** (pending user decision) |

## Resolution Status

### Round 1 → Round 2 (commit 4bf64257)

#### F1/S2 Major /s/[token]/download TOCTOU — Fixed
- Action: Added `AND "revoked_at" IS NULL AND "expires_at" > NOW()` to both password-protected and non-protected UPDATE branches.
- Modified files: [src/app/s/[token]/download/route.ts:91-106](src/app/s/[token]/download/route.ts#L91-L106), [src/__tests__/api/s/download.test.ts](src/__tests__/api/s/download.test.ts) (added 3 tests incl. SQL predicate assertion).

#### F2 Major /s/[token]/page.tsx TOCTOU — Fixed
- Action: Non-FILE branch gains the same atomic predicates; FILE branch gets a no-op conditional UPDATE (`SET view_count = view_count`) to atomically recheck revocation/expiry/max-views.
- Modified files: [src/app/s/[token]/page.tsx:92-124](src/app/s/[token]/page.tsx#L92-L124).

#### S1 Major /api/extension/token/refresh IP bypass — Fixed
- Action: Added `enforceAccessRestriction` after session check. Round 3 promoted it to before rate limit (see R2-F2 below).
- Modified files: [src/app/api/extension/token/refresh/route.ts](src/app/api/extension/token/refresh/route.ts).

#### S3 Minor /api/tenant/access-requests IP bypass — Fixed
- Action: Added `enforceAccessRestriction` on SA and non-session admin branches; session path left to middleware. Round 3 moved SA IP check before rate limit (see N1 below).
- Modified files: [src/app/api/tenant/access-requests/route.ts](src/app/api/tenant/access-requests/route.ts).

#### S4 Minor /api/vault/delegation/check IP bypass — Fixed
- Action: Added `enforceAccessRestriction` for non-session auth types with tenantIdOverride for api_key/mcp_token.
- Modified files: [src/app/api/vault/delegation/check/route.ts](src/app/api/vault/delegation/check/route.ts).

#### S5 Minor /api/extension/token DELETE IP bypass — Fixed
- Action: Added `enforceAccessRestriction` after validateExtensionToken. Round 3 made it pass tenantId explicitly (see N4 below).
- Modified files: [src/app/api/extension/token/route.ts](src/app/api/extension/token/route.ts).

#### T1 Major TOCTOU tests don't verify SQL predicates — Fixed
- Action: Added `sqlBodyOf` helper to collapse tagged-template args; new tests regex-assert `revoked_at IS NULL`, `expires_at > NOW()`, `max_views`, and `view_count` SET shape.
- Modified files: [src/app/api/share-links/[id]/content/route.test.ts](src/app/api/share-links/[id]/content/route.test.ts), [src/__tests__/api/s/download.test.ts](src/__tests__/api/s/download.test.ts).

#### T2 Minor FILE no-op regression coverage — Fixed
- Action: Test now asserts the SQL body contains `"view_count" = "view_count"` (no-op) and NOT `+ 1`.

#### T3 Minor Duplicate 410 tests — Fixed
- Action: Merged the old "max views exceeded" test with the TOCTOU test ("returns 410 when atomic UPDATE matches 0 rows"). No coverage lost — both drove the same code path.

### Round 2 → Round 3 (commit b16a27f1)

#### N2 Critical session+Bearer IP bypass — Fixed
- Action: `proxy.ts` now requires `!hasSessionCookie` for the bearer-bypass branch. Requests carrying both a session cookie and a Bearer header fall through to the session-authenticated path where middleware enforces tenant IP. Legitimate Bearer-only clients (chrome-extension origin, API key, SA/MCP tokens) do not ship the Auth.js session cookie so the bypass still applies to them.
- Verification: 3 new tests in [src/__tests__/proxy.test.ts](src/__tests__/proxy.test.ts) cover `/api/passwords`, `/api/api-keys`, and `/api/vault/delegation/check` with the session+Bearer combo — each asserts middleware-level 401 (proves fall-through to session path) and that session lookup ran.
- Modified files: [src/proxy.ts:227-245](src/proxy.ts#L227-L245).

#### N1 Medium SA path IP check after rate limit — Fixed
- Action: Moved `enforceAccessRestriction` ahead of the per-SA rate limiter so an off-network stolen-bearer attacker cannot burn the legitimate SA's hourly request budget. userId is `SYSTEM_ACTOR_ID` since `sa.createdById` is not resolved yet; `actorType: SERVICE_ACCOUNT` and `tenantId` are passed for correct audit.
- Modified files: [src/app/api/tenant/access-requests/route.ts:122-134](src/app/api/tenant/access-requests/route.ts#L122-L134).

#### N4 Low extension/token DELETE fail-open on orphaned user — Fixed
- Action: Extended `ValidatedExtensionToken` with `tenantId`; DELETE handler now passes it explicitly instead of relying on `resolveUserTenantId(userId)` which returns null for users without tenant mapping.
- Modified files: [src/lib/extension-token.ts:18-25,88,120](src/lib/extension-token.ts), [src/app/api/extension/token/route.ts](src/app/api/extension/token/route.ts).

#### R2-F1 Minor delegation/check test literal — Fixed
- Action: Changed `type: "extension"` to `type: "token", scopes: []` to match the real `AuthResult` discriminated union defined in [src/lib/auth-or-token.ts:23](src/lib/auth-or-token.ts#L23).
- Modified files: [src/app/api/vault/delegation/check/route.test.ts](src/app/api/vault/delegation/check/route.test.ts).

#### R2-F2 Minor IP-enforcement placement inconsistent — Fixed
- Action: Moved IP check ahead of rate limiter in refresh (mirrors N1 for the extension-token-refresh budget).
- Modified files: [src/app/api/extension/token/refresh/route.ts:35-42](src/app/api/extension/token/refresh/route.ts#L35-L42).

#### R2-F4 Info stale refresh session mocks — Fixed
- Action: Added `tenantId: "tenant-1"` to 4 pre-existing session-findFirst mocks so the mock data matches the production row shape.
- Modified files: [src/app/api/extension/token/refresh/route.test.ts](src/app/api/extension/token/refresh/route.test.ts).

### Accepted (not fixed in this PR)

#### F3 Minor Expiry strictness asymmetry JS `<` vs SQL `>` — Accepted
- **Anti-Deferral check**: Acceptable risk.
  - Worst case: a share whose `expiresAt == now` within microseconds of the request is accepted by the JS check but rejected by the SQL atomic UPDATE → user sees 410.
  - Likelihood: vanishingly low — requires microsecond-accurate coincidence. Fail-safe direction (rejects when ambiguous).
  - Cost to fix: trivial (align operators) but tests need updating across multiple files. No security impact.
- **Orchestrator sign-off**: Accepted — fail-safe direction means no security or data-integrity regression.

#### F4 Minor No-op UPDATE WAL overhead on FILE path — Accepted
- **Anti-Deferral check**: Acceptable risk.
  - Worst case: every share content API call on a FILE share writes a heap tuple + WAL record; autovacuum load scales with share traffic.
  - Likelihood: WAL bloat only when FILE shares are viewed heavily via the content API (download route handles actual download). Low-traffic in practice.
  - Cost to fix: moderate — would require `SELECT ... FOR UPDATE` + transaction wrapping for equivalent atomicity without heap write. Trade-off against consistency with non-FILE branch.
- **Orchestrator sign-off**: Accepted — consistency benefit outweighs marginal WAL cost; revisit if hot share shows up in production telemetry.

#### N3 Low extension/token DELETE validity timing oracle — Accepted
- **Anti-Deferral check**: Acceptable risk.
  - Worst case: attacker holding a stolen token can distinguish live (403 after IP check) vs. revoked/expired (400 before IP check) without being on-network.
  - Likelihood: attacker must already have the raw 256-bit token. Oracle is equivalent to what they could learn by attempting a normal password read.
  - Cost to fix: moderate — would require swapping auth+IP order or unifying error codes. Readability cost.
- **Orchestrator sign-off**: Accepted — oracle does not add to an attacker who already holds the token.

#### R2-F3 Minor enforceAccessRestriction duplication — Accepted
- **Anti-Deferral check**: Out of scope (different feature).
- **Justification**: Refactor tracked in [docs/archive/review/refactoring-plan-plan.md](docs/archive/review/refactoring-plan-plan.md) which proposes migrating route handlers to `checkAuth({ allowTokens: true })`. Expanding this PR into that refactor would break the focused security-fix scope.
- **Orchestrator sign-off**: Accepted — cross-referenced existing plan.

#### T4 Low extension-token DELETE test — Accepted
- **Anti-Deferral check**: Acceptable risk.
- **Justification**: Current assertion (`for...of` loop checking no `revokedAt` in update data) is correct. Alternative `expect.objectContaining` form is subjective style preference.
- **Orchestrator sign-off**: Accepted.

#### T5 Info `expect.anything()` for req arg — Accepted
- **Anti-Deferral check**: Acceptable risk.
- **Justification**: The load-bearing assertion is on tenantId forwarding; req shape is not part of the contract being tested.
- **Orchestrator sign-off**: Accepted.

#### T6 Low Mock `Response` vs `NextResponse` type — Accepted
- **Anti-Deferral check**: Acceptable risk.
- **Justification**: `NextResponse extends Response`; the `if (denied) return denied;` pattern accepts either at runtime. No observable behavior difference.
- **Orchestrator sign-off**: Accepted.

#### N5 Info access-requests GET same class as N2 — Resolved by N2 fix
- **Anti-Deferral check**: Covered by the same middleware change.
- **Orchestrator sign-off**: Resolved (no code change needed in the handler — middleware now blocks session+Bearer before the handler runs).
