# Code Review: docs-readme-security-update
Date: 2026-03-16
Review rounds: 2

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Minor] `/api/sends` HTTP methods incorrect
- **Problem:** CLAUDE.md lists `/api/sends` as `GET, POST` but only `POST` is implemented. List retrieval is via `/api/share-links/mine?shareType=send`.
- **Impact:** Developers calling `GET /api/sends` would receive 405 Method Not Allowed.
- **Recommended action:** Change to `POST` only. Add note about list retrieval path.

### F2 [Minor] Protected routes list mixes middleware and route-handler auth
- **Problem:** `/api/v1/*`, `/api/vault/*`, `/api/folders/*` are listed as "Protected routes" in CLAUDE.md but are not guarded by the proxy middleware's session check in `src/proxy.ts`. They use route-handler-level auth instead.
- **Impact:** Developers may misunderstand where auth enforcement occurs.
- **Recommended action:** Distinguish middleware-enforced vs route-handler-enforced auth in the protected routes description.
- **Note:** Also flagged by Testing expert (Finding T2).

## Security Findings

### S1 [Minor] SECURITY.md missing WebAuthn best practices
- **Problem:** `WEBAUTHN_PRF_SECRET`, `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_ORIGIN` are not mentioned in SECURITY.md Best Practices despite being security-critical for passkey functionality.
- **Impact:** Deployment configuration oversight risk.
- **Recommended action:** Add WebAuthn variables to Best Practices section.

### S2 [Minor] DIRECTORY_SYNC_MASTER_KEY fallback description misleading
- **Problem:** SECURITY.md says "falls back to SHARE_MASTER_KEY in dev" but actual implementation falls back through `SHARE_MASTER_KEY_V1` → `SHARE_MASTER_KEY`, and production throws an exception (no fallback).
- **Impact:** Admins may skip setting it, causing production crash.
- **Recommended action:** Clarify: "mandatory in production; dev-only fallback to SHARE_MASTER_KEY".

### S3 [Minor] `/api/admin/rotate-master-key` endpoint exposed in CLAUDE.md
- **Problem:** Admin endpoint name visible in public repo documentation, potentially aiding attack surface mapping.
- **Impact:** Low immediate risk (rate-limited, timing-safe comparison) but unnecessary exposure.
- **Recommended action:** Add "admin-only, bearer token protected" annotation.

### S4 [Minor] OPENAPI_PUBLIC default not in SECURITY.md Best Practices
- **Problem:** Default allows unauthenticated access to full OpenAPI spec in production.
- **Impact:** Attack surface mapping via spec exposure.
- **Recommended action:** Add `OPENAPI_PUBLIC=false` recommendation to Best Practices.

## Testing Findings

### T1 [Minor] CLAUDE.md uses `npx vitest run` vs README's `npm test`
- **Problem:** Inconsistent test command documentation (functionally equivalent but confusing).
- **Impact:** Minor contributor confusion.
- **Recommended action:** Pre-existing issue, not introduced by this diff. Low priority.

### T2 [Minor] Protected routes list discrepancy (duplicate of F2)
- Merged with Functionality Finding F2.

### T3 [Minor] Load test scripts lack prerequisite note
- **Problem:** `test:load:*` scripts require k6 binary but README doesn't indicate this.
- **Impact:** Failed CI integration if someone adds these without k6.
- **Recommended action:** Add "(requires k6)" annotation to load test script descriptions.

## Adjacent Findings
None.

## Resolution Status

### F1 [Minor] `/api/sends` HTTP methods incorrect
- Action: Changed to `POST` only with note about list retrieval via share-links/mine
- Modified file: CLAUDE.md

### F2 [Minor] Protected routes list mixes auth levels
- Action: Split into three categories: proxy middleware, route-handler, API key auth
- Modified file: CLAUDE.md

### S1 [Minor] Missing WebAuthn best practices
- Action: Added WEBAUTHN_RP_ID, RP_ORIGIN, PRF_SECRET to Best Practices
- Modified file: SECURITY.md

### S2 [Minor] DIRECTORY_SYNC_MASTER_KEY fallback misleading
- Action: Clarified "mandatory; dev-only fallback not available in production"
- Modified file: SECURITY.md

### S3 [Minor] Admin endpoint exposed
- Action: Added "(admin-only, bearer token)" annotation
- Modified file: CLAUDE.md

### S4 [Minor] OPENAPI_PUBLIC not in Best Practices
- Action: Added OPENAPI_PUBLIC=false recommendation
- Modified file: SECURITY.md

### T1 [Minor] npx vitest run vs npm test inconsistency
- Action: Skipped — pre-existing issue not introduced by this diff

### T3 [Minor] Load test scripts lack prerequisite note
- Action: Added "(requires k6)" / "（要 k6）" annotations
- Modified files: README.md, README.ja.md

## Round 2 Findings

### N1 [Minor] `/api/user/locale` missing from proxy protected routes list
- Action: Added `/api/user/*` to proxy middleware session check list
- Modified file: CLAUDE.md

### S5 [Minor] OPENAPI_PUBLIC Cache-Control header issue (out of scope)
- Action: Out of scope for docs update — code change required
- Note: When OPENAPI_PUBLIC=false, response uses `Cache-Control: public` which could be cached by CDN

### S6 [Minor] OPENAPI_PUBLIC evaluated at module scope (out of scope)
- Action: Out of scope for docs update — code change required
- Note: Environment variable evaluated once at module init, requires redeploy to take effect

## Round 3: S5/S6 Code Fix Review

### S5 [Minor] Cache-Control: public when OPENAPI_PUBLIC=false
- Action: Fixed — use `private, no-store` when auth required, `public, max-age=3600` when public
- Modified file: src/app/api/v1/openapi.json/route.ts

### S6 [Minor] Module-scope isPublic evaluation
- Action: Fixed — moved into handler function for per-request evaluation
- Modified file: src/app/api/v1/openapi.json/route.ts

### S1-new [Minor] Missing Vary: Authorization on public responses
- Action: Fixed — added `Vary: Authorization` header when isPublic=true
- Modified file: src/app/api/v1/openapi.json/route.ts

### S2-new [Minor] 401 response missing Cache-Control
- Action: Fixed — added `Cache-Control: no-store` to 401 response, removed unused unauthorized import
- Modified file: src/app/api/v1/openapi.json/route.ts

### T1-new [Critical] No tests for OpenAPI route
- Action: Fixed — created openapi-json.test.ts with 4 tests (public 200, private 401, private 200, headers)
- Modified file: src/__tests__/api/v1/openapi-json.test.ts

### TF1 [Major] Missing vi.resetModules() in test
- Action: Fixed — added vi.resetModules() to beforeEach, moved vi.unstubAllEnvs() to afterEach
- Modified file: src/__tests__/api/v1/openapi-json.test.ts

### TF2 [Minor] vi.unstubAllEnvs() in beforeEach instead of afterEach
- Action: Fixed — moved to afterEach per project convention
- Modified file: src/__tests__/api/v1/openapi-json.test.ts

## Round 4: Proxy Cache-Control Horizontal Rollout Review

### PF1 [Minor] 401/403 uses `no-store` vs default `private, no-store` inconsistency
- Action: Skipped — both prevent caching; `no-store` alone is correct for error responses

### PF2 [Minor] `/api/v1/*` has `private` but uses API key auth (non-browser)
- Action: Skipped — `private` is harmless, provides consistent defense-in-depth

### PT1 [Major] Proxy tests lack Cache-Control assertions
- Action: Fixed — added 7 Cache-Control assertions covering all return paths
- Modified file: src/__tests__/proxy.test.ts
