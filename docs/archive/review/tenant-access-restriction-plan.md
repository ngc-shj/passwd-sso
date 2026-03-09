# Plan: Tenant Access Restriction (IP / Tailscale)

## Objective

Add per-tenant network access restrictions so that tenant administrators can limit access to specific IP ranges (CIDR) and/or require that clients belong to the same Tailscale tailnet. Requests from disallowed sources receive a 403 response.

## Requirements

### Functional

1. Tenant OWNER/ADMIN can configure allowed CIDR ranges (e.g., `192.168.1.0/24`, `10.0.0.0/8`)
2. Tenant OWNER/ADMIN can enable Tailscale tailnet membership verification
3. When both CIDR and Tailscale are configured, a request is allowed if it matches **either** (OR logic)
4. When no restrictions are configured (empty CIDRs + Tailscale disabled), all IPs are allowed (current behavior)
5. Access restriction applies to authenticated API routes and dashboard pages
6. Health check endpoints (`/api/health/*`), auth endpoints (`/api/auth/*`), and public share pages (`/s/*`) are exempt
7. Settings are managed via the existing `/api/tenant/policy` endpoint (GET/PATCH extension)
8. UI: add an "Access Restriction" card to the tenant admin Security tab

### Non-Functional

1. CIDR matching must be fast (in-memory, no external calls per request)
2. Tailscale WhoIs call should be cached briefly (30s) to avoid per-request latency
3. Tenant policy should be cached per-tenant (avoid DB query per request); cache is busted on PATCH
4. Graceful degradation: if `tailscaleEnabled` is true but `tailscaled` is unavailable, Tailscale check returns `false` — but if CIDR is also configured and matches, the request is still allowed (OR logic). Full lockout only occurs if Tailscale is the sole restriction and daemon is down.
5. Denied access attempts must be logged (audit log) with client IP, tenant, and denial reason
6. Client IP must be validated against trusted proxy configuration to prevent header spoofing

## Technical Approach

### Database

Add two columns to `Tenant` model:

```prisma
allowedCidrs     String[]  @default([]) @map("allowed_cidrs")
tailscaleEnabled Boolean   @default(false) @map("tailscale_enabled")
tailscaleTailnet String?   @map("tailscale_tailnet")   // expected tailnet name for WhoIs verification
```

Migration: `add_tenant_access_restriction`

### Trusted Proxy & IP Extraction (`src/lib/ip-access.ts`)

- `TRUSTED_PROXIES` env var: comma-separated CIDRs of trusted reverse proxies (e.g., `127.0.0.1/32,::1/128,10.0.0.0/8`)
- `extractClientIp(request: NextRequest): string | null` — extract client IP using the **rightmost-untrusted** pattern: walk `X-Forwarded-For` from right to left, stripping trusted proxy IPs, and return the first untrusted IP. If no `X-Forwarded-For` or direct connection is not from a trusted proxy, use the socket address. Normalize IPv4-mapped IPv6 (`::ffff:x.x.x.x` → `x.x.x.x`) before returning.
- `isIpInCidr(ip: string, cidr: string): boolean` — check if IP is within a CIDR range
- `isIpAllowed(ip: string, cidrs: string[]): boolean` — check against multiple CIDRs
- `isValidCidr(cidr: string): boolean` — validate CIDR notation strictly
- Support both IPv4 and IPv6
- Use built-in Node.js `net` module for IP parsing (no external dependency)

### Tailscale Client (`src/lib/tailscale-client.ts`)

- `verifyTailscalePeer(ip: string, expectedTailnet: string): Promise<boolean>` — call local `tailscaled` WhoIs API and verify the peer belongs to the expected tailnet
- Endpoint: `http://127.0.0.1:41112/localapi/v0/whois?addr=${ip}:0` (URL constructed via `new URL()` to prevent injection)
- IP parameter must be strictly validated (IPv4: `/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/`, IPv6: normalized format only) before constructing the URL — prevents SSRF via malformed IP
- Tailscale IPs are in the `100.64.0.0/10` CGNAT range — skip WhoIs for non-Tailscale IPs
- WhoIs response contains `Node.Name` (FQDN like `hostname.tailnet-name.ts.net.`) — extract the tailnet name and compare against `expectedTailnet`. Normalize before comparison: strip trailing dot, apply `.toLowerCase()`, handle empty/unexpected `Node.Name` gracefully (return `false`)
- Cache results for 30 seconds (Map-based, max 500 entries, evict oldest when limit reached)
- If `tailscaled` is unreachable, return `false` (Tailscale check fails, but request may still be allowed via CIDR match due to OR logic)

### Access Check Middleware (`src/lib/access-restriction.ts`)

- `checkAccessRestriction(tenantId: string, clientIp: string): Promise<AccessCheckResult>`
- Fetch tenant policy (cached per-tenant, 60s TTL; cache busted on PATCH via `invalidateTenantPolicyCache(tenantId)`)
- If no restrictions configured → allow
- Check CIDR allowlist → if match, allow
- If Tailscale enabled → verify via WhoIs → if verified, allow
- Otherwise → deny with reason
- On deny: emit audit log entry (`AUDIT_ACTION.ACCESS_DENIED`) with client IP, tenant ID, and denial reason

### Integration Point

The access restriction check runs in the proxy layer after authentication. Key design decisions:

**Chosen: Centralize in `src/proxy.ts`** — The proxy is the single chokepoint for all routes. Add the IP restriction check at multiple points in `handleApiAuth()`:

1. **After `hasValidSession()` succeeds** — for session-authenticated protected routes (dashboard + API). Extend `hasValidSession()` to return `{ valid: boolean; userId?: string; tenantId?: string }` instead of bare `boolean`. Callers that only need boolean use `.valid`. Session cache type updated accordingly.
2. **Bearer token, API v1, and SCIM routes** — these bypass session auth in the proxy. IP restriction for these routes is applied **in route handlers**, not in the proxy:
   - **Bearer token routes**: `authOrToken()` already resolves the user → add `checkAccessRestriction(tenantId, clientIp)` call after auth in each route handler that uses `authOrToken()`
   - **API v1 routes**: `validateApiKeyOnly()` already resolves the tenant → add IP restriction check after API key validation in each v1 route handler
   - **SCIM routes**: `validateScimToken()` already resolves the tenant → add IP restriction check after SCIM token validation in each SCIM route handler
   - This avoids pulling token/API-key parsing logic into the proxy layer, keeping concerns separated

   To reduce boilerplate, create a shared wrapper: `withAccessRestriction(req, tenantId, handler)` that checks IP restriction and returns 403 if denied, otherwise delegates to the handler.

**Fast path**: if tenant has no restrictions configured (`allowedCidrs` empty + `tailscaleEnabled` false), skip all IP checks immediately. The tenant policy cache ensures this is a cheap lookup.

### API Extension

Extend `GET/PATCH /api/tenant/policy` to include:

```typescript
// GET response adds:
{
  ...existing fields,
  allowedCidrs: string[],
  tailscaleEnabled: boolean,
}

// PATCH body accepts:
{
  ...existing fields,
  allowedCidrs?: string[] | null,    // null or [] = no restriction
  tailscaleEnabled?: boolean,
}
```

Validation:

- `allowedCidrs`: each entry must be valid CIDR notation (validated with regex + IP parsing)
- Maximum 50 CIDR entries per tenant
- `tailscaleEnabled`: boolean
- `tailscaleTailnet`: required when `tailscaleEnabled` is true; string matching the tailnet name (e.g., `myorg.ts.net` or `myorg`)

### UI Component

New card `TenantAccessRestrictionCard` in the tenant admin Security tab, similar to `TenantSessionPolicyCard`:

- Toggle for Tailscale verification + tailnet name input (shown when toggle is on)
- Text area or tag input for CIDR entries
- Validation feedback
- Save button with toast notification

### i18n

Add keys to `messages/en/TenantAdmin.json` and `messages/ja/TenantAdmin.json`:

- `accessRestrictionTitle`, `accessRestrictionDescription`
- `allowedCidrs`, `allowedCidrsHelp`, `allowedCidrsPlaceholder`
- `tailscaleEnabled`, `tailscaleEnabledHelp`
- `tailscaleTailnet`, `tailscaleTailnetHelp`, `tailscaleTailnetPlaceholder`
- Validation error messages

## Implementation Steps

1. **Prisma schema + migration**: Add `allowedCidrs`, `tailscaleEnabled`, and `tailscaleTailnet` to `Tenant`
2. **IP utility** (`src/lib/ip-access.ts`): CIDR parsing, matching, and `extractClientIp()` (rightmost-untrusted pattern). Refactor all existing IP extraction call sites to use `extractClientIp()`:
   - `src/lib/audit.ts` — `extractRequestMeta()` delegates to `extractClientIp()`
   - `src/app/api/auth/passkey/verify/route.ts` — inline extraction → `extractClientIp()`
   - `src/app/api/auth/passkey/options/route.ts` — inline extraction → `extractClientIp()`
   - `src/app/api/auth/passkey/options/email/route.ts` — inline extraction → `extractClientIp()`
   - `src/app/s/[token]/download/route.ts` — inline extraction → `extractClientIp()`
3. **Tailscale client** (`src/lib/tailscale-client.ts`): WhoIs API integration with caching
4. **Access restriction logic** (`src/lib/access-restriction.ts`): Orchestrate IP + Tailscale checks with tenant policy cache
5. **Proxy integration** (`src/proxy.ts`): Add access restriction check after session validation
6. **API extension** (`src/app/api/tenant/policy/route.ts`): Extend GET/PATCH for new fields
7. **i18n messages**: Add translation keys for en/ja
8. **UI component** (`src/components/settings/tenant-access-restriction-card.tsx`): Admin UI
9. **Tests**: Unit tests for IP utility, Tailscale client, access restriction logic, API endpoint, proxy integration

## Testing Strategy

### Unit Tests

- `src/__tests__/lib/ip-access.test.ts`: CIDR matching (IPv4, IPv6, edge cases, invalid input)
- `src/__tests__/lib/tailscale-client.test.ts`: WhoIs mock responses, cache behavior, error handling
- `src/__tests__/lib/access-restriction.test.ts`: Combined logic with various tenant configs

### Integration Tests

- `src/__tests__/api/tenant/tenant-policy.test.ts`: Extend existing tests for new fields
- `src/__tests__/proxy.test.ts`: Extend proxy tests for access restriction scenarios

### Test Cases

#### Access restriction logic

- No restrictions → allow all
- CIDR match → allow
- CIDR mismatch → deny
- Tailscale enabled + valid peer (same tailnet) → allow
- Tailscale enabled + valid peer (different tailnet) → deny
- Tailscale enabled + invalid peer → deny
- Both configured, CIDR matches → allow (short-circuit, skip Tailscale)
- Both configured, neither matches → deny
- Tailscaled unavailable + CIDR matches → allow (OR logic)
- Tailscaled unavailable + no CIDR → deny

#### API validation

- Invalid CIDR in PATCH → 400
- Too many CIDRs (>50) → 400
- `tailscaleEnabled: true` without `tailscaleTailnet` → 400
- Self-lockout detection → 409
- `confirmLockout: true` overrides lockout check → 200

#### Proxy integration

- API v1 route with API key from restricted tenant + disallowed IP → 403
- Bearer token route from restricted tenant + disallowed IP → 403
- SCIM route from restricted tenant + disallowed IP → 403
- Health check / auth routes → always allowed (exempt)

#### IP extraction

- Multi-hop X-Forwarded-For (trusted proxy) → first IP used
- X-Forwarded-For from untrusted source → ignored, socket IP used
- IPv4-mapped IPv6 (`::ffff:192.168.1.1`) → normalized to `192.168.1.1`
- Missing X-Forwarded-For → fallback to socket IP

#### Cache behavior

- Tenant policy cache bust on PATCH → immediate effect
- Tailscale WhoIs cache max size → eviction of oldest entries
- Tailscale WhoIs cache expiry → re-query after 30s

#### Tailscale WhoIs error handling

- WhoIs API timeout → treated as unreachable (return false)
- WhoIs API returns 5xx → treated as unreachable (return false)
- WhoIs API returns invalid JSON → treated as unreachable (return false)
- WhoIs API returns `Node.Name` with trailing dot → normalized before comparison
- WhoIs API returns empty `Node.Name` → return false

## Considerations & Constraints

1. **Proxy layer tenant resolution**: The proxy currently only validates sessions, not user identity. To check tenant restrictions, we need to extract the user ID from the session and resolve their tenant. This adds a DB query, but we can cache tenant policies aggressively (60s TTL).

2. **Self-lockout prevention**: If an admin configures CIDRs that exclude their own IP, they lock themselves out. Mitigation: the PATCH endpoint checks if the requester's IP would be allowed under the new policy. If not, return a 409 Conflict with a clear error message. The admin must explicitly pass `"confirmLockout": true` in the request body to override this check.

3. **Reverse proxy considerations**: The client IP comes from `X-Forwarded-For` or `X-Real-IP` headers. To prevent spoofing, `TRUSTED_PROXIES` env var must be configured with the reverse proxy's CIDRs. Only requests from trusted proxies will have `X-Forwarded-For` honored. Document this requirement in the setup guide.

4. **Tailscale daemon dependency**: Tailscale WhoIs requires `tailscaled` running on the same host. This is a deployment requirement when `tailscaleEnabled` is true. Document this.

5. **Bootstrap tenants**: Bootstrap (single-user local) tenants can also configure restrictions, though the use case is less common.

6. **Performance budget**: CIDR matching is O(n) where n ≤ 50 — negligible. Tailscale WhoIs adds ~1ms locally, cached for 30s (max 500 entries). Tenant policy cache avoids DB round-trip.

7. **Trusted proxy default**: If `TRUSTED_PROXIES` is unset, default to `127.0.0.1/32,::1/128` (loopback only). This is safe for typical Docker/reverse-proxy deployments where the proxy runs on the same host.

8. **CIDR validation**: Use strict validation — each entry must parse as a valid IP address with a prefix length within the valid range (0-32 for IPv4, 0-128 for IPv6). The network address must match the prefix (e.g., `192.168.1.1/24` is invalid; `192.168.1.0/24` is valid). Reject overlapping or duplicate entries with a warning.

9. **IP extraction unification**: The existing `extractRequestMeta()` in `src/lib/audit.ts` trusts `X-Forwarded-For` unconditionally. After this change, it must delegate to `extractClientIp()` from `src/lib/ip-access.ts` to ensure audit logs and access restriction use the same trusted IP.
