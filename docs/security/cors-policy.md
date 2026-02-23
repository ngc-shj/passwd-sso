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
| **Origin validation** | `assertOrigin()` rejects destructive operations from foreign origins | All clients |
| **Auth** | Session cookie or Bearer token required for protected routes | All clients |

CORS is a **browser-enforced constraint only**. Non-browser clients (curl, scripts) are not affected by CORS. Server-side auth and `assertOrigin()` provide the actual access control.

## Browser Extension

The browser extension communicates with the API via its **Background Service Worker** using **Bearer token** authentication. Chrome extension service workers are not subject to browser CORS restrictions, so no cross-origin CORS headers are needed for extension access.

Communication flow:
1. Extension obtains a Bearer token via the token bridge (same-origin DOM injection)
2. Background Service Worker makes `fetch()` calls with `Authorization: Bearer <token>`
3. Service Worker network requests bypass browser CORS checks entirely

## OPTIONS Preflight Handling

All `OPTIONS` requests to `/api/*` are treated as **CORS preflight** and return `204 No Content`:

- **Same-origin**: 204 with full CORS headers
- **Cross-origin**: 204 without CORS headers (browser blocks the actual request)

If a future API route needs `OPTIONS` for business logic (e.g., WebDAV), add an exclusion in `src/proxy.ts` `handleApiAuth()` before the preflight handler.

## Implementation

- **`src/lib/cors.ts`** — CORS helper functions (`handlePreflight`, `applyCorsHeaders`)
- **`src/proxy.ts`** — Integrates CORS into the proxy layer for all `/api/*` routes
- **`src/lib/csrf.ts`** — Complementary Origin validation for destructive endpoints

## Extending to Cross-Origin (Future)

If cross-origin access is needed in the future:

1. Add `CORS_ALLOWED_ORIGINS` environment variable (comma-separated origins)
2. Update `getAppOrigin()` in `cors.ts` to return an array of allowed origins
3. Match request `Origin` against the allowlist
4. Add tests for each allowed origin
5. Update this document with the new policy
