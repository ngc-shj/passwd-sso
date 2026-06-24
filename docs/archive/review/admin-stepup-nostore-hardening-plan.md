# Plan: Admin step-up + one-time-secret no-store hardening

## Project context

- **Type**: web app / service (Next.js 16 App Router + Prisma + TypeScript)
- **Test infrastructure**: unit (Vitest, mocked Prisma) + integration (`npm run test:integration`, real Postgres) + CI
- **Verification environment constraints**:
  - `VC1` — Bridge-code consume/network-restriction ordering (C4) cannot be exercised end-to-end in the mocked unit suite: `mockMobileBridgeCodeUpdateMany` returns a canned `{ count: 1 }` and does not model the `usedAt` column. The "code left unconsumed → allowed-network retry succeeds" property is **`blocked-deferred`** for the unit suite. Anti-Deferral justification: the load-bearing regression (denial path must not call the CAS) IS `verifiable-local` via a `not.toHaveBeenCalled()` spy assertion (see C4 acceptance); the full real-DB retry property is `verifiable-integration` only and is added there only if a mobile/token integration test already exists. Cost of forcing a real-DB unit test: rewrite the suite's Prisma mock into a stateful fake — out of proportion to the Low-severity bug. Recorded against VC1.

## Objective

Close a **systemic, documented** authorization-hardening gap and a **one-time-secret caching** gap surfaced by security review:

1. **Step-up reauth is applied inconsistently** across tenant-admin routes: secret-*minting* POST handlers were retrofitted with `requireRecentCurrentAuthMethod`, but the **config-mutating / destructive sibling** handlers (PUT / PATCH / DELETE) on the same resources were not. A hijacked-but-not-step-up admin session can mutate or delete security-relevant config.
2. **One-time-secret POST responses** (plaintext tokens, client secrets, share-link access passwords, OAuth `access_token`/`refresh_token`) lack `Cache-Control: no-store`, while the established in-repo convention sets it on comparable routes.

## Requirements

### Functional
- Every tenant-admin mutating handler that manages security-relevant config requires a recent auth ceremony (step-up) **after** authorization and **before** the mutation, matching the existing POST pattern.
- Every POST response that returns a one-time plaintext secret sets `Cache-Control: no-store`.
- A single shared helper centralizes the no-store header so future secret-returning responses are greppable and cannot silently drift.

### Non-functional
- No change to the happy path: a step-up-verified admin session continues to succeed.
- No regression to the bridge-code timing-uniformity design (S7) in `mobile/token`.
- Helper adoption is **all-or-nothing for the secret-bearing class** — no half-inline/half-helper split.

## Technical approach

- **Step-up**: reuse the existing `requireRecentCurrentAuthMethod(req)` chooser (`src/lib/auth/session/recent-current-auth-method.ts`). It returns a short-circuit `Response` (step-up required / unauthorized) or `undefined` (pass). Insert `const stepUpError = await requireRecentCurrentAuthMethod(req); if (stepUpError) return stepUpError;` after the route's `requireTenantPermission(...)` authorization check (and after any existence `notFound()` check), before the mutation. This mirrors `mcp-clients/route.ts:128` exactly.
- **no-store helper**: add a tiny helper in `src/lib/http/` and adopt it at the secret-bearing sites. Infra sites (health probes, `.well-known`, `openapi.json`'s conditional `private, no-store`) are NOT secret-bearing and are out of scope for the helper (mixing them dilutes the helper's meaning — see SC3).
- **Bridge-code reorder**: move `enforceAccessRestriction(...)` to run before the CAS-consume. Boundary-first placement (immediately after the `if (!stored)` guard) is preferred — secret-independent, fail-closed, and avoids spending DPoP verification on off-network requests.

## Contracts

### C1 — Shared no-store helper
- **Signature**: `export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;` in `src/lib/http/cache-headers.ts` (new file). Optionally a thin `jsonNoStore(body, init?)` wrapper — **decision: ship the const only**, not the wrapper. Rationale: call sites pass varying `status` (200 / 201) and some merge other headers (`Deprecation`, `Retry-After`); a const spread `headers: { ...NO_STORE_HEADERS }` composes cleanly with those, whereas a `jsonNoStore` wrapper would need an `init` passthrough that adds no clarity over the spread. (YAGNI — do not add the wrapper.)
- **Invariants** (app-enforced): every one-time-secret POST response spreads `NO_STORE_HEADERS` into its `NextResponse.json` `headers`. There is no schema-level enforcement available for HTTP headers; the grep-able forbidden-pattern below is the closest structural guard.
- **Forbidden patterns**:
  - `pattern: headers: { "Cache-Control": "no-store" }` (literal inline, in a secret-bearing route file) — reason: after C1, secret-bearing sites use `NO_STORE_HEADERS`; a fresh inline literal signals a missed adoption. (Infra sites are exempt — see SC3.)
- **Acceptance**: `grep -rn "NO_STORE_HEADERS" src/app/api` enumerates exactly the secret-bearing set (C2 list); `import` resolves; build passes.
- **Consumer-flow walkthrough**: N/A (the const is consumed only by producer route handlers; no cross-process shape).

### C2 — no-store adoption at one-time-secret POST responses
- **Sites** (7 new + existing secret-bearing migrations):
  - New (currently missing): `api-keys/route.ts` (token), `tenant/mcp-clients/route.ts` (clientSecret), `share-links/route.ts` (token + accessPassword), `sends/route.ts`, `sends/file/route.ts`, `mcp/token/route.ts` ×2 (`access_token`+`refresh_token`, lines ~132 & ~217 — authorization_code and refresh_token grants).
  - Migrate-to-helper (already set inline, secret-bearing — adopt `NO_STORE_HEADERS` for consistency): `tenant/scim-tokens/route.ts`, `tenant/service-accounts/[id]/tokens/route.ts`, `tenant/operator-tokens/route.ts`, `tenant/access-requests/[id]/approve/route.ts`, `tenant/audit-delivery-targets/route.ts`, `mobile/token/route.ts`, `mobile/token/refresh/route.ts`, `mobile/autofill-token/route.ts`, `extension/token/route.ts` (preserve its `Deprecation` header via spread).
  - **Audit resolved (verified)**: `extension/bridge-code` does NOT exist — dropped. `mobile/authorize` returns the code via a **302 `Location` redirect** (not a `NextResponse.json` body) and already sets `no-store` inline on the redirect — left as-is, not a helper-adoption site.
- **Out of scope (NOT migrated)**: `health/live`, `health/ready`, `.well-known/apple-app-site-association`, `v1/openapi.json` (uses conditional `private, no-store` — different semantics). See SC3.
- **Invariants** (app-enforced): the directive is exactly `no-store` (not `no-cache` / `private` / `must-revalidate`) for one-time secrets.
- **Acceptance**: each listed response, when invoked, returns header `Cache-Control: no-store`; existing non-cache headers (`Deprecation`, `Retry-After`, `status`) preserved.

### C3 — Step-up on tenant-admin mutating handlers
- **Sites** (all 7 routes confirmed lacking `requireRecentCurrentAuthMethod`):
  - `tenant/mcp-clients/[id]/route.ts` — PUT, DELETE (the original finding)
  - `tenant/service-accounts/[id]/route.ts` — PUT, DELETE
  - `tenant/service-accounts/[id]/tokens/[tokenId]/route.ts` — DELETE
  - `tenant/scim-tokens/[tokenId]/route.ts` — DELETE
  - `tenant/webhooks/route.ts` — POST; `tenant/webhooks/[webhookId]/route.ts` — DELETE (verified: no PUT exported)
  - `directory-sync/route.ts` — POST; `directory-sync/[id]/route.ts` — PUT, DELETE (verified present)
  - `tenant/policy/route.ts` — PATCH
- **Signature** (per handler): insert after the existing `requireTenantPermission(...)` call and after any `findFirst → notFound()` existence check, before `parseBody` / the mutation:
  ```
  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) return stepUpError;
  ```
- **Invariants** (app-enforced):
  - Step-up runs strictly after authorization (never leak a step-up challenge to a non-authorized caller) and strictly before any DB write.
  - `req: NextRequest` is in scope in every target handler (verify each — some handlers name the first arg `_req`; rename to `req` where the gate needs it).
- **Forbidden patterns**:
  - `pattern: export const (PUT|DELETE|PATCH|POST) = withRequestLog\(` in a C3 route file whose handler body lacks `requireRecentCurrentAuthMethod` — reason: a mutating tenant-admin handler in the C3 set without the gate is the bug this contract closes. (Manual cross-check; not a clean single grep.)
- **Acceptance**: for each handler, a request with a non-recent session → step-up `Response` (no mutation); a request with a recent session → existing success behavior unchanged. The KNOWN GAP comment at `mcp-clients/route.ts:113-117` is removed/trimmed (it no longer describes reality).
- **Consumer-flow walkthrough**: N/A (no response-shape change; the gate only adds an early-return error path already used elsewhere).

### C4 — Bridge-code: enforce network restriction before consuming the code
- **File**: `src/app/api/mobile/token/route.ts`
- **Change**: move the `enforceAccessRestriction(req, stored.userId, stored.tenantId)` call + `if (denied) return denied;` to run **before** the CAS-consume `updateMany` (currently after). Preferred placement: immediately after the `if (!stored) { ... return ... }` guard, before step 4 (device_jkt). Renumber the step comments accordingly and update the step-3 doc comment to note the network gate now precedes binding checks.
- **Invariants** (app-enforced):
  - A denied-network request returns 403 (`ACCESS_DENIED`) **without** calling the CAS-consume `updateMany` (the one-time code is left with `usedAt === null`).
  - `stored.userId` and `stored.tenantId` are non-nullable (verified against `prisma/schema.prisma`) — safe to pass pre-consume.
  - The S7 timing-uniformity property is preserved: the network gate is IP/CIDR-based and secret-independent, and already returns a distinct `ACCESS_DENIED` error outside the uniform `MOBILE_BRIDGE_CODE_INVALID` set, so its position does not leak bridge-code validity.
- **Acceptance**: denial path → 403 + `mockMobileBridgeCodeUpdateMany` NOT called + `mockIssueIosToken` NOT called. Happy path unchanged.

## Go/No-Go Gate

| ID  | Subject                                                        | Status |
|-----|---------------------------------------------------------------|--------|
| C1  | Shared `NO_STORE_HEADERS` const in `src/lib/http/cache-headers.ts` | locked |
| C2  | no-store adoption across one-time-secret POST responses (incl. mcp/token) | locked |
| C3  | Step-up gate on all 7 tenant-admin mutating route families    | locked |
| C4  | Bridge-code: enforceAccessRestriction before CAS-consume       | locked |

## Testing strategy

- **C3 step-up** (per route, mocked unit suite): add `vi.mock("@/lib/auth/session/recent-current-auth-method", ...)` returning a hoisted spy; `beforeEach` default `mockResolvedValue(undefined)` (pass-through, so existing happy-path tests stay green and prove the gate does not break them). Add a reject case per mutating handler: non-recent session → step-up `Response`, asserting the mutation mock (`mockMcpClientUpdate` / `...Delete` / etc.) is `not.toHaveBeenCalled()`. Mirror the sibling pattern at `tenant/mcp-clients/route.test.ts:328-348` + mock block at `:82-84`.
- **C4 bridge-code** (mocked unit suite — the highest-value regression): strengthen the existing access-restriction test (`mobile/token/route.test.ts:338`) or add a sibling asserting `mockMobileBridgeCodeUpdateMany` is `not.toHaveBeenCalled()` on the denial path. This assertion **fails on current code** (CAS runs first) and passes after the reorder → a true regression guard. Do NOT add a mocked "retry succeeds" test (R5 vacuous-pass — the mock has no `usedAt` state); defer that property to the integration suite per VC1.
- **C2 no-store** (mocked unit suite): add `expect(res.headers.get("Cache-Control")).toBe("no-store")` to each existing create-success test. Mirror `extension/token/route.test.ts:118`. NOTE: `share-links/route.test.ts` and `sends/route.test.ts` **do not exist** — either create a minimal create-success test for each (mirror `sends/file/route.test.ts` scaffold) or record them as a tracked Minor follow-up (SC4) with the header otherwise shipping unverified there. **Decision: create the two minimal test files** (the header is security-relevant; a no-store on a one-time secret with zero asserting test is a real gap).
- **Mandatory checks** (CLAUDE.md): `npx vitest run` + `npx next build` before reporting complete.

## Considerations & constraints

### Scope contract
- `SC1` — **webhooks / directory-sync step-up**: INCLUDED in C3 (user chose "all 7"). Listed here only to note they have the highest config-exfil risk profile (webhook URL is an exfiltration sink) and so are not deferrable.
- `SC2` — **Centralized operation-sensitivity step-up guard** (a single guard keyed on operation class instead of hand-applied per handler) is OUT of scope — a larger refactor. This PR does enumerate-and-cover; the structural SSoT improvement is a future issue. Tracked: `TODO(admin-stepup-nostore-hardening): consider operation-sensitivity-keyed step-up guard (SC2)`.
- `SC3` — **Infra no-store sites** (`health/live`, `health/ready`, `.well-known/apple-app-site-association`, `v1/openapi.json`) are NOT migrated to `NO_STORE_HEADERS`. They set `no-store` for non-secret reasons (liveness freshness, conditional public/private); folding them into the secret-bearing helper would dilute its meaning. Owned by: this contract's explicit exclusion.
- `SC4` — If creating the two missing test files (`share-links`, `sends`) proves disproportionate, the header ships but its assertion is deferred. **Default per Testing strategy: create them.** Only invoke SC4 with an Anti-Deferral cost-justification.

### Known risks
- C3 touches 7 route families; each handler's first-arg naming (`req` vs `_req`) must be verified so the gate compiles. ESLint may flag a now-used `_req` — rename to `req` (do not suppress; per `feedback_no_suppress_warnings`).
- C2 helper migration must be all-or-nothing for the secret-bearing class to avoid a half-inline/half-helper split.
- R19: each C3 route's test file must add the `recent-current-auth-method` mock or the new gate hits the real helper and 401s on the missing session token (vacuous failure).

## User operation scenarios

1. **Hijacked admin session, no recent ceremony** edits an MCP client's `redirectUris` → step-up required `Response`, no mutation. (C3)
2. **Legit admin, recently re-authenticated** deletes a service account → succeeds. (C3 happy path)
3. **Legit iOS device on a disallowed network** exchanges its bridge code → 403 `ACCESS_DENIED`, code NOT consumed; the same device retries from an allowed network → succeeds. (C4 — retry leg verified in integration suite per VC1)
4. **Operator mints an API key** → response carries `Cache-Control: no-store`; the plaintext token is not written to any intermediary cache. (C2)
