# Coding Deviation Log: fail-closed-tranche3

## D1 — ssh/sign-authorize uses a custom 503 envelope, not canonical

**Plan said**: per-route table #13 and the `expectation` bullet classified all 15
cases as `{ envelope: "canonical" }`.

**Reality (verified route.ts:80-91)**: `vault/ssh/sign-authorize` passes a bespoke
`envelope` callback to `checkRateLimitOrFail` returning
`NextResponse.json({ authorized: false, reason: "service_unavailable" }, { status:
503, headers: { "Retry-After": "30" } })`. It is a custom envelope (matching the
route's `{ authorized, reason }` response shape), not the canonical
`{ error: "SERVICE_UNAVAILABLE" }`.

**Applied**: #13's `assertRedisFailClosed` call uses
`expectation: { envelope: "custom", status: 503, body: { authorized: false, reason:
"service_unavailable" }, retryAfter: "required" }`. All other 14 cases remain
canonical. Plan per-route table + expectation bullet corrected to reflect this.

**Why non-Critical**: the fail-closed guarantee is identical (503, no mutation,
Retry-After present); only the response body shape differs, and the helper's custom
envelope tier exists precisely for this. No security weakening.

## D2 — auth/[...nextauth] dedicated fail-closed describe block (dynamic-import topology)

**Plan said** (C1 #1 exception): capture + snapshot the two limiters after a
post-import, in a dedicated block, because the auth test uses dynamic `await
import()` + `resetModules()`.

**Applied**: added a `describe("fail-closed contract (Redis unavailable → 503)")`
block that (a) `vi.resetModules()` + `mockCreateRateLimiter.mockClear()`, (b) imports
the route once (both `createRateLimiter` calls fire in creation order), (c) captures
`mock.results[0]/[1].value` and snapshots each. The factory was converted to a
recording `vi.fn()` returning two distinct objects, both delegating to the shared
`mockRateLimitCheck` so the ~14 existing wrapper tests (which assert only on
`mockRateLimitCheck`) are unchanged. The two former status-only direct-503 cases
(callback + magic-link) were removed as superseded by the stronger helper contract.
Classifier confirms `calls=2 mock=0 distinct=2`.

## D3 — reset-vault distinct-limiter split

**Applied** (C1 M-refactor, as planned): split the shared `mockRateLimiterCheck` into
`mockAdminLimiterCheck` / `mockTargetLimiterCheck` behind a recording
`mockCreateRateLimiter` with two `mockImplementationOnce` returning distinct objects
(creation order adminResetLimiter then targetResetLimiter). Removed the
`vi.mock("@/lib/security/rate-limit-audit")` partial stub; the real
`emitRateLimitFailClosed` now runs (tenantId passed directly → no `resolveUserTenantId`
DB hit; `@/lib/audit/audit` already mocked). Added `__resetThrottleForTests()` to
`beforeEach`. The two direct-503 cases became `assertRedisFailClosed` calls; the two
429 cases were rewired to the distinct mocks. Classifier confirms
`calls=2 mock=0 distinct=2`.
