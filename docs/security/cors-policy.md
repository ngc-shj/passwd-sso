# CORS Policy

## Policy: Same-Origin Only

All API endpoints (`/api/*`) enforce a **same-origin only** CORS policy.
Cross-origin requests receive no CORS headers, causing the browser to block the response.

### Why Same-Origin Only?

passwd-sso is a self-hosted password manager. All browser-based API access originates from the same domain as the application. There is no legitimate cross-origin use case for browser clients.

### Defense Layers

CORS is one of several overlapping protections:

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| **CORS headers** | `Access-Control-Allow-Origin` reflects same-origin only | Browser clients |
| **CSP** | `connect-src 'self'` blocks cross-origin fetch/XHR | Browser clients |
| **SameSite cookie** | `SameSite=lax` prevents cross-origin POST from sending session cookie | Browser clients |
| **`csrf-gate` (proxy)** | Baseline Origin assertion fires whenever request has session cookie + mutating method | All cookie-auth API routes |
| **Auth** | Session cookie or Bearer token required for protected routes | All clients |

CORS is a **browser-enforced constraint only**. Non-browser clients (curl, scripts) are not affected by CORS. Server-side auth and the proxy CSRF gate provide the actual access control.

### Where Origin is enforced

1. **Proxy CSRF gate** (`src/lib/proxy/csrf-gate.ts`): Baseline enforcement. Fires on any request that carries a session cookie and uses a mutating HTTP method (POST, PUT, PATCH, DELETE), regardless of route classification. This is the primary structural defense for all cookie-authenticated API routes.

2. **Three KEEP-inline pre-auth exceptions** (cookieless; proxy gate does not apply because no session cookie is present on inbound request):
   - `src/app/api/auth/passkey/options/route.ts` — discoverable challenge generation
   - `src/app/api/auth/passkey/options/email/route.ts` — non-discoverable challenge generation
   - `src/app/api/auth/passkey/verify/route.ts` — pre-auth verification (creates session as output; WebAuthn `expectedOrigin` provides primary defense; inline `assertOrigin` is defense-in-depth)

3. **Stricter post-baseline guard** (`src/app/api/vault/admin-reset/route.ts`): Keeps `if (!getAppOrigin()) return 500` check. The proxy CSRF gate uses Host-header fallback when `APP_URL` is unset; admin-reset intentionally disallows this fallback.

## Browser Extension

The browser extension communicates with the API via its **Background Service Worker** using **Bearer token** authentication. Chrome extension service workers are not subject to browser CORS restrictions, so no cross-origin CORS headers are needed for extension access.

Communication flow:
1. Extension obtains a Bearer token via the token bridge (`window.postMessage` with strict origin and schema validation)
2. Background Service Worker makes `fetch()` calls with `Authorization: Bearer <token>`
3. Service Worker network requests bypass browser CORS checks entirely

## OPTIONS Preflight Handling

All `OPTIONS` requests to `/api/*` are treated as **CORS preflight** and return `204 No Content`:

- **Same-origin**: 204 with full CORS headers
- **Cross-origin**: 204 without CORS headers (browser blocks the actual request)

If a future API route needs `OPTIONS` for business logic (e.g., WebDAV), add an exclusion in `src/lib/proxy/api-route.ts` before the preflight handler.

## Implementation

- **`src/lib/http/cors.ts`** — CORS helper functions (`handlePreflight`, `applyCorsHeaders`)
- **`src/lib/proxy/cors-gate.ts`** — Bearer-bypass route detection and preflight wiring for all `/api/*` routes
- **`src/lib/proxy/csrf-gate.ts`** — Baseline Origin assertion for cookie-bearing mutating requests
- **`src/lib/auth/session/csrf.ts`** — `assertOrigin` helper used by KEEP-inline pre-auth exception routes
- **`src/lib/proxy/api-route.ts`** — API route handler integrating CORS, CSRF, and auth gates
- **`src/proxy.ts`** — 16-line orchestrator; delegates to `src/lib/proxy/api-route.ts`

> **Cross-reference**: The `localhost` allowance in `CSP form-action` (OAuth consent form) is a deliberate RFC 8252 accommodation. See threat-model.md §3.5 D7 for the threat analysis and residual risk acceptance.

## Extending to Cross-Origin (Future)

If cross-origin access is needed in the future:

1. Add `CORS_ALLOWED_ORIGINS` environment variable (comma-separated origins)
2. Update `getAppOrigin()` in `cors.ts` to return an array of allowed origins
3. Match request `Origin` against the allowlist
4. Add tests for each allowed origin
5. Update this document with the new policy
