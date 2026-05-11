# Code Review: proxy-tailscale-port-leak

Date: 2026-05-11
Review round: 1
Branch: fix/proxy-normalize-host-port

Background: ad-hoc fix branch (no formal Phase 1/2 plan). Fixes port-leak from
`tailscale serve` setting `X-Forwarded-Port: <backend-port>` which next-intl
trusts when constructing locale-prefix redirect Location URLs.

Diff: 3 files / 365 lines (1 modified, 2 new).

## Changes from Previous Round

Initial review.

## Functionality Findings

### Seed Finding Disposition
- F-seed-1 (Major: X-Forwarded-Host should be hostname-only) — Rejected. RFC / de facto standard preserves Host with non-default port; next-intl extracts port from XFH itself.
- F-seed-2 (Minor: env reset per-key) — Rejected. afterEach restores from snapshot; per-key delete is only setup-side.
- F-seed-3 (Minor: comment about URL unchanged) — Rejected. next-intl reads from headers; no observable inconsistency.

### Findings

**[F-1] [Minor]: Duplicates existing canonical-URL helper instead of reusing `getAppOrigin()`**
- File: src/lib/proxy/forwarded-headers.ts:31
- Evidence: `const canonicalRaw = process.env.APP_URL || process.env.AUTH_URL;` duplicates getAppOrigin() in src/lib/url-helpers.ts:12-14.
- Problem: Two sources of truth for "canonical app origin"; precedence change (e.g. NEXTAUTH_URL fallback) would drift.
- Impact: Future drift / inconsistency hazard.
- Fix: `import { getAppOrigin } from "@/lib/url-helpers"; const canonicalRaw = getAppOrigin();`

**[F-2] [Minor]: `.toUpperCase()` on `request.method` is redundant per Fetch spec**
- File: src/lib/proxy/forwarded-headers.ts:96
- Evidence: `if (!BODYLESS_METHODS.has(request.method.toUpperCase()))`
- Problem: Defensive but redundant; Request.method is already normalized to uppercase per Fetch spec.
- Impact: None functional.
- Fix: Drop `.toUpperCase()`.

## Security Findings

### Seed Finding Disposition
- S-seed-1 (Major: Tailscale-* headers spoofable, attacker triggers override) — Rejected. Override writes ONLY env-derived values (no client input). Pre-condition gate at forwarded-headers.ts:54 (externalHostname must equal canonical.hostname) prevents pivoting to attacker-controlled hostname. CSRF/CORS/IP-access read other headers and are unaffected. The change REDUCES downstream trust in client headers (next-intl now uses canonical env values) — strictly safer than the pre-fix state.

### Findings

No security findings.

## Testing Findings

### Seed Finding Disposition
- T-seed-1 (Minor: env reassignment in afterEach) — Verified — adopted as T-1.
- T-seed-2 (Major: no proxy-orchestrator integration test) — Verified — adopted as T-2.

### Findings

**[T-1] [Minor]: env-restore style diverges from prevailing proxy-test pattern**
- File: src/lib/proxy/forwarded-headers.test.ts:5-31
- Evidence: snapshots ORIGINAL_ENV, reassigns `process.env = { ...ORIGINAL_ENV }` in afterEach. Sibling tests (cors-gate.test.ts:80-86, __tests__/proxy.test.ts:386-394) use vi.stubEnv + vi.unstubAllEnvs.
- Problem: Two divergent env-mocking idioms in same directory; reassigning process.env bypasses Vitest's stub tracking.
- Impact: Low-grade test-suite inconsistency.
- Fix: Replace resetEnv() + ORIGINAL_ENV with `vi.stubEnv("APP_URL", ...)` per test + `afterEach(() => vi.unstubAllEnvs())`.

**[T-2] [Major]: no integration test exercises proxy.ts wire-in (normalize → handleApiAuth/handlePageRoute)**
- File: src/__tests__/proxy.test.ts (absent test) vs src/proxy.ts:11-22
- Evidence: `grep -n "normalizeForwardedHeaders\|tailscale\|x-forwarded-port" src/__tests__/proxy.test.ts` returns nothing.
- Problem: Unit test exercises function in isolation; orchestrator test never proves the rewritten request reaches both dispatch branches with new headers visible to downstream gates.
- Impact: Major. Tailscale was the actual bug source; future refactors of src/proxy.ts could silently bypass the fix.
- Fix: Add `describe("proxy — Tailscale forwarded-header normalization")` to src/__tests__/proxy.test.ts.

**[T-3] [Major]: missing assertion that `nextConfig.basePath` survives the new-NextRequest reconstruction**
- File: src/lib/proxy/forwarded-headers.test.ts (no test) vs src/lib/proxy/forwarded-headers.ts:82-94
- Evidence: production code carries `nextConfig: { basePath: request.nextUrl.basePath || undefined }`; docblock declares this prevents the basePath/locale-order regression.
- Problem: Dropping the nextConfig field would compile, pass all 13 tests, and reintroduce the next-intl redirect bug the docblock warns about.
- Impact: Major. False-negative gap on a load-bearing field.
- Fix: Add a test asserting `out.nextUrl.basePath === request.nextUrl.basePath` after normalization.

**[T-4] [Minor]: TAILSCALE_HEADERS test fixture duplicates production string literals**
- File: src/lib/proxy/forwarded-headers.test.ts:20-23 vs src/lib/proxy/forwarded-headers.ts:113-117
- Evidence: header names "tailscale-headers-info" / "tailscale-user-login" duplicated as string literals.
- Problem: typo-fix or rename in production won't break tests (RT3).
- Impact: Minor; risk of drift on future rename.
- Fix: Export `TAILSCALE_DETECTION_HEADERS = ["tailscale-headers-info", "tailscale-user-login"] as const` from forwarded-headers.ts; consume from both.

## Adjacent Findings

**[F-A1] [Adjacent — Minor / Functionality]: Pre-existing direct AUTH_URL reads in unrelated files**
- File: src/app/api/sessions/helpers.ts:10, src/lib/auth/webauthn/webauthn-server.ts:69
- Pre-existing, not introduced by this PR. Routing: separate cleanup PR.

**[S-A1] [Adjacent — Minor / Security hardening]: Optionally gate isViaTailscaleServe on tailnet IP**
- File: src/lib/proxy/forwarded-headers.ts:113-118
- isTailscaleIp() exported from src/lib/auth/policy/ip-access.ts:394. Defense-in-depth nicety, ~5 LOC. Today's trigger is benign (security expert verified).

**[S-A2] [Adjacent — Minor / Documentation]: Add docblock note about URL parser quirk**
- File: src/lib/proxy/forwarded-headers.ts:50
- `new URL(\`http://\${externalHostRaw}\`).hostname` accepts inputs like `@app.example.com` (parses to `app.example.com`). Equality check at line 54 makes this safe; one-line docblock would document the rationale.

## Quality Warnings

None — all findings contain specific file references, evidence, and concrete remediation.

## Recurring Issue Check

### Functionality expert
- R1-R37: scoped to changed module + cross-cutting greps. Highlights: PASS on R8 (no other proxy XFH mutation sites), PASS on R12 (basePath explicitly carried), PASS on R20 (CSRF gate compat), PASS on R22 (signal coalesce), FAIL on R10 (env access pattern consistency — see F-1), MINOR on R10 (BODYLESS_METHODS .toUpperCase redundant — F-2). Other rules N/A or PASS.

### Security expert
- R1-R37 PASS or N/A. RS1-RS4 PASS. Highlights: R6/R7/R8 (CSRF/open-redirect/SSRF) all PASS — override values are env-derived and the pre-condition gate prevents hostname pivots. R29 PASS (cited https://tailscale.com/s/serve-headers in docblock). R36 PASS (zero suppression markers in new files).

### Testing expert
- R1-R37: most N/A (scope is one new module + 1-line wire-in). RT1 PASS (uses real NextRequest, no mock). RT2 noted (basePath testability friction acknowledged — see T-3). RT3 hit — see T-4. RT4 N/A (no concurrency). RT5 partial fail — see T-2 (production caller in proxy.ts not exercised end-to-end).

## Resolution Status

### F-1 Minor — Duplicates getAppOrigin()
- Action: replaced manual env lookup with `getAppOrigin()` import.
- Modified file: src/lib/proxy/forwarded-headers.ts:2 (import), :32 (call site)

### F-2 Minor — Redundant `.toUpperCase()` on request.method
- Action: dropped `.toUpperCase()` and added one-line comment citing the Fetch spec normalization guarantee.
- Modified file: src/lib/proxy/forwarded-headers.ts:104-108

### T-1 Minor — env-restore style diverged from sibling proxy tests
- Action: replaced `ORIGINAL_ENV` snapshot + `process.env = {...}` reset with `vi.stubEnv` per test + `vi.unstubAllEnvs()` in afterEach. Aligns with cors-gate.test.ts and __tests__/proxy.test.ts.
- Modified file: src/lib/proxy/forwarded-headers.test.ts (top-level setup + 13 stub call sites)

### T-2 Major — no integration test exercised proxy.ts wire-in
- Action: added `describe("proxy — Tailscale forwarded-header normalization wire-in")` with 3 tests covering (a) API route Bearer-bypass branch, (b) page-route security-headers branch, (c) non-Tailscale no-op smoke. Uses existing `vi.stubEnv("APP_URL", ...)` + fetch spy pattern from sibling describe blocks.
- Modified file: src/__tests__/proxy.test.ts:961-1043 (new describe block)

### T-3 Major — missing assertion that nextConfig.basePath survives reconstruction
- Action: added `describe("normalizeForwardedHeaders — basePath propagation")` with 2 tests: (a) basePath preserved when input has one (`/passwd-sso`), (b) no basePath invented when input has none. Locks in the load-bearing `nextConfig: { basePath }` field that the docblock identifies as preventing the `/ja/passwd-sso/...` regression.
- Modified file: src/lib/proxy/forwarded-headers.test.ts:201-243 (new describe block)

### T-4 Minor — TAILSCALE_HEADERS literals duplicated across prod and tests
- Action: exported `TAILSCALE_DETECTION_HEADERS` const-tuple from forwarded-headers.ts; tests destructure into `TS_INFO_HEADER` / `TS_LOGIN_HEADER`; production `isViaTailscaleServe` uses `.some(h => request.headers.has(h))` over the same constant.
- Modified file: src/lib/proxy/forwarded-headers.ts:9-17 (export), :115-121 (consumer); src/lib/proxy/forwarded-headers.test.ts:3-12 (import + destructure)

### S-A2 Adjacent Minor — URL parser quirk doc-note
- Action: added 5-line comment above the URL-parse block explaining that the parser is permissive but the equality check on the next line prevents pivoting to an unintended hostname.
- Modified file: src/lib/proxy/forwarded-headers.ts:50-54

### S-A1 Adjacent Minor — Optional tailnet IP gate (defense-in-depth)
- Decision: Accepted (deferred). Anti-Deferral check: acceptable risk.
  - **Worst case**: an external attacker who can reach the proxy AND can spoof Tailscale-* headers triggers the override. Override only writes env-derived canonical values — there is no input-injection vector. The pre-condition gate (forwarded-headers.ts:54) further rejects requests whose forwarded hostname does not already match canonical.
  - **Likelihood**: Low. Requires either (a) external network reachability to the dev-only `*:3001` listener — not exposed in production deployments fronted by nginx/Cloudflare/ALB where the Tailscale gate naturally short-circuits — or (b) an attacker already inside the tailnet, which is a separate trust-boundary breach.
  - **Cost to fix**: ~5 LOC + cross-module coupling between forwarded-headers and ip-access. Adds runtime call to `extractClientIp`. Both reviewer (Security expert) and the project author judged the coupling not worth the marginal hardening for a benign trigger.
- TODO: revisit if forwarded-headers ever gains side effects that depend on client trust. (No grep TODO marker added — tracked here only.)

### F-A1 Adjacent Minor — Pre-existing direct AUTH_URL reads in unrelated files
- Decision: Out of scope (different feature). [Adjacent] routing: separate cleanup PR.
  - Files: src/app/api/sessions/helpers.ts:10, src/lib/auth/webauthn/webauthn-server.ts:69
  - **Anti-Deferral check**: out of scope (different feature). These files are NOT in `git diff main...HEAD` for this PR, so the "pre-existing in changed file" rule does not apply.
  - TODO: file a follow-up PR titled `refactor: route remaining process.env.AUTH_URL reads through getAppOrigin()`.

## Tightening-only skip eligibility (Round 2 decision)

All 6 in-scope findings (F-1, F-2, T-1, T-2, T-3, T-4) and the adopted Adjacent S-A2 were addressed in Round 1. Adjacent S-A1 was deferred with quantified cost-justification. Adjacent F-A1 was routed to a separate PR.

Round 2 termination criteria:
- All Major findings resolved? ✅ (T-2, T-3)
- All Minor findings resolved or deferred-with-justification? ✅
- pre-pr.sh pass? ✅ (16/16)
- Live verification of original symptom? ✅ (curl: no `:3001`, basePath order correct)

Decision: **Round 1 closed.** No Round 2 required — the only adjacent items are documented deferrals, not unresolved findings.

