# Plan: p4-security-hardening

## Objective

Address 4 verified security findings from the external security assessment, plus 3 GitHub Code Scanning alerts:

1. Webhook DNS rebinding TOCTOU — IP pinning to close the gap between DNS check and fetch
2. Password API rate limiting for extension tokens — prevent bulk enumeration on token leak
3. Sends encryption model transparency — document server-side encryption clearly
4. Passkey session invalidation — defense-in-depth session rotation on passkey auth
5. Code Scanning: Remove unused `API_ERROR` imports in 3 files

## Requirements

### Functional Requirements

1. **Webhook IP pinning**: `deliverWithRetry()` must connect to the exact IP validated by `assertPublicHostname()`, eliminating the DNS rebinding window
2. **Password API rate limits**: `GET /api/passwords`, `POST /api/passwords`, `GET/PUT/DELETE /api/passwords/[id]` must enforce per-user rate limits
3. **Sends encryption documentation**: Add minimal JSDoc explaining server-side master key encryption model
4. **Passkey session rotation**: On successful passkey authentication, atomically delete all existing sessions and create the new one within a single transaction
5. **Code Scanning fixes**: Remove unused `API_ERROR` imports from `watchtower/alert/route.ts`, `tenant/members/[userId]/reset-vault/route.ts`, `auth/passkey/verify/route.ts`

### Non-Functional Requirements

- No breaking API changes
- All existing tests must continue to pass
- Production build must succeed

## Technical Approach

### 1. Webhook DNS Rebinding Fix (webhook-dispatcher.ts)

**Problem**: `assertPublicHostname()` resolves DNS, validates IPs, then discards the results. `fetch()` performs independent DNS resolution, creating a TOCTOU window.

**Solution**: Modify `assertPublicHostname()` to return the validated IPs. In `deliverWithRetry()`, use `undici.Agent` with a custom `connect.lookup` that returns the pre-validated IP, passed via `fetch(url, { dispatcher })`.

**Important**: Node.js global `fetch` uses undici internally. `https.Agent` from `node:https` is NOT compatible with `fetch()`. Must use `undici.Agent` with `dispatcher` option.

```typescript
import { Agent } from "undici";

function createPinnedDispatcher(hostname: string, validatedIps: string[]): Agent {
  let index = 0;
  return new Agent({
    connect: {
      // Preserve TLS certificate validation via SNI
      servername: hostname,
      lookup: (_origin, _opts, cb) => {
        const ip = validatedIps[index % validatedIps.length];
        index++;
        cb(null, [{ address: ip, family: ip.includes(":") ? 6 : 4 }]);
      },
    },
  });
}
```

Additionally, add `::ffff:0:0/96` (IPv4-mapped IPv6 addresses) to BLOCKED_CIDRS to prevent bypass via `::ffff:127.0.0.1` etc.

Key considerations:
- Webhook URLs are always HTTPS (enforced at registration), redirect is already blocked (`redirect: "error"`)
- `servername` option preserves TLS SNI so certificate validation works correctly with IP pinning
- All validated IPs are tried in order (handles IPv4/IPv6 mixed resolvers and multi-IP hosts)
- For retries, re-resolve DNS each time (the validated IP may legitimately change) but still pin the result
- IPv4-mapped IPv6 addresses normalized before CIDR check

### 2. Password API Rate Limiting

**Problem**: `GET /api/passwords`, `POST /api/passwords`, `GET/PUT/DELETE /api/passwords/[id]` accept extension tokens and API keys but have no rate limits, enabling bulk enumeration on token leak.

**Solution**: Add per-user rate limiters to password CRUD endpoints:

| Endpoint | Rate Limit | Rationale |
|----------|-----------|-----------|
| `GET /api/passwords` | 60 req/min | List calls; generous for sync but limits enumeration |
| `POST /api/passwords` | 30 req/min | Create; allows bulk import but rate-limited |
| `GET /api/passwords/[id]` | 60 req/min | Single entry fetch; lowered from initial 120 per security review |
| `PUT /api/passwords/[id]` | 30 req/min | Update; same as create |
| `DELETE /api/passwords/[id]` | 30 req/min | Delete; same as create |

Rate limit keys: `rl:passwords_list:{userId}`, `rl:passwords_create:{userId}`, `rl:passwords_get:{userId}`, `rl:passwords_update:{userId}`, `rl:passwords_delete:{userId}`.

### 3. Sends Encryption Documentation

**Problem**: Sends use `encryptShareData()` (server-side master key encryption) but this isn't clearly documented.

**Solution**: Add minimal JSDoc to:
- `encryptShareData()` / `encryptShareBinary()` in `crypto-server.ts` — one-line clarification that these use server-side master key, not client E2E
- `POST /api/sends` route — brief comment on the encryption model
- No code behavior change; documentation-only
- Keep JSDoc minimal to avoid duplication with existing file header comments

### 4. Passkey Session Rotation

**Problem**: `/api/auth/passkey/verify` creates a new session without invalidating existing sessions for the same user.

**Solution**: Wrap session deletion and creation in a single Prisma transaction to ensure atomicity:

```typescript
// Atomic session rotation: delete all existing + create new in one transaction
const { sessionToken, evictedCount } = await withBypassRls(prisma, async () =>
  prisma.$transaction(async (tx) => {
    const deleted = await tx.session.deleteMany({
      where: { userId: user.id },
    });
    const newSession = await tx.session.create({
      data: {
        sessionToken,
        userId: user.id,
        tenantId,
        expires,
        ipAddress: meta?.ip ?? null,
        userAgent: meta?.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
      },
    });
    return { sessionToken: newSession.sessionToken, evictedCount: deleted.count };
  }),
);

// Audit log the session eviction (fire-and-forget)
if (evictedCount > 0) {
  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.SESSION_REVOKE_ALL,
    userId: user.id,
    metadata: { trigger: "passkey_signin", evictedCount },
    ...meta,
  });
}
```

This replaces the current flow of calling `adapter.createSession()` (which has its own Serializable transaction for maxConcurrentSessions). By using a direct transaction, we guarantee no window between deletion and creation.

### 5. Code Scanning Fixes

Remove unused `API_ERROR` imports from:
- `src/app/api/watchtower/alert/route.ts:5`
- `src/app/api/tenant/members/[userId]/reset-vault/route.ts:5`
- `src/app/api/auth/passkey/verify/route.ts:4`

## Implementation Steps

1. **Webhook IP pinning** — Modify `assertPublicHostname()` to return IPs, add `::ffff:0:0/96` to BLOCKED_CIDRS, create `createPinnedDispatcher()` using undici, use in `deliverWithRetry()`
2. **Password API rate limits** — Add `createRateLimiter()` calls to `src/app/api/passwords/route.ts` and `src/app/api/passwords/[id]/route.ts`
3. **Sends encryption docs** — Add minimal JSDoc to `crypto-server.ts` and `sends/route.ts`
4. **Passkey session rotation** — Replace `adapter.createSession()` with atomic `prisma.$transaction` for delete+create in `passkey/verify/route.ts`
5. **Code scanning fixes** — Remove unused `API_ERROR` imports from 3 files

## Testing Strategy

### Webhook IP pinning
- Update `webhook-dispatcher.test.ts`:
  - Test `assertPublicHostname` returns validated IP array
  - Test private IP rejection (192.168.x.x, 10.x.x.x, 169.254.169.254, ::ffff:127.0.0.1)
  - Test DNS resolution failure (empty results)
  - Test that fetch is called with `dispatcher` option containing pinned agent
  - Test retries re-resolve DNS (mockResolve4 called multiple times)
  - Test IPv4-mapped IPv6 blocking

### Password API rate limits
- Add rate limit tests to both `passwords/route.test.ts` and `passwords/[id]/route.test.ts`:
  - Verify 429 response when rate limit exceeded for each endpoint
  - Verify rate limit key uses userId (not IP)

### Passkey session rotation
- Update `passkey/verify/route.test.ts`:
  - Add `prisma.session` and `prisma.$transaction` mocks
  - Verify `session.deleteMany` is called with correct userId
  - Verify call order: deleteMany before session.create (within transaction)
  - Verify `SESSION_REVOKE_ALL` audit log is emitted with correct metadata
  - Verify no audit log when evictedCount is 0

### Sends encryption docs
- No test changes (documentation only)

## Considerations & Constraints

- **Scope**: Audit log DLP (#5 from original assessment) is already addressed with `AUDIT_LOG_MAX_ROWS=100,000`, `AUDIT_LOG_MAX_RANGE_DAYS=90`, and 2 req/min rate limit. Excluded from this plan.
- **Sends E2E migration**: Full client-side encryption for Sends is a larger feature (needs URL fragment key distribution, client crypto, UI changes). This plan only addresses documentation. E2E migration should be a separate plan if desired.
- **Session rotation aggressiveness**: Deleting all sessions on passkey sign-in is intentionally strict for a password manager. Passkey sign-in requires physical device possession, so DoS via forced logout requires the attacker to already have the passkey.
- **Rate limit values**: Chosen to be generous enough for normal use (including bulk import) but restrictive enough to slow down automated enumeration. Can be tuned post-deployment.
- **undici dependency**: Confirmed available via `require('undici')`. Node.js bundles undici internally. Use `import { Agent } from "undici"` directly.
- **Redirect protection**: Already handled by existing `redirect: "error"` in fetch options. No additional work needed.
- **Agent lifecycle**: Each `createPinnedDispatcher()` creates a new undici Agent with connection pool. Must call `agent.close()` after fetch completes (in a finally block) to prevent connection pool leaks in high-frequency webhook environments.
