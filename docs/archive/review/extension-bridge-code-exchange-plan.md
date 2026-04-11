# Plan: extension-bridge-code-exchange

## Objective

Evolve the extension token postMessage bridge from sending a **bearer token** to sending a **one-time exchange code**, similar to OAuth 2.1 authorization code flow. This reduces the risk surface: a compromised page (e.g. via XSS in the dashboard) currently exposes a long-lived bearer token via `window.postMessage`; after this change, the same compromise yields only a short-lived single-use code that requires a separate exchange step to obtain a token.

## Background

Current flow (`harden-extension-token-bridge` baseline):
1. Web app calls `POST /api/extension/token` (Auth.js session) → receives bearer token
2. Web app calls `injectExtensionToken(token, expiresAt)` which posts `{ type: TOKEN_BRIDGE_MSG_TYPE, token, expiresAt }` to `window`
3. Extension content script (`token-bridge-lib.ts`) validates origin/source/type and forwards via `chrome.runtime.sendMessage`

The remaining attack surface: any MAIN-world JavaScript on the dashboard origin (XSS, supply-chain compromise, malicious browser extension injecting into MAIN world) can observe the `postMessage` and capture the bearer token directly. The 15-minute TTL limits damage but the captured token grants full extension scope.

## Requirements

### Functional Requirements

1. **One-time bridge code issuance** — Web app obtains a single-use, short-lived code (≤60s TTL) instead of a bearer token
2. **Server-side code exchange** — Extension content script (or background script) exchanges the code for a bearer token by calling a new endpoint directly
3. **Atomic single-use consumption** — A code can be redeemed at most once; concurrent redemption attempts must be detected and rejected
4. **Tenant binding** — A code is bound to the issuing tenant; cross-tenant redemption must be impossible
5. **User binding** — A code is bound to the issuing user; the exchange endpoint resolves `userId` from the code record, NEVER from client input
6. **Token equivalence** — The exchanged token must be functionally identical to one issued via the legacy `POST /api/extension/token` (same scope, same TTL, same DB model `ExtensionToken`)
7. **Audit logging** — Code issuance, successful exchange, and failed exchange (replay/expired/unknown) must each emit dedicated audit actions
8. **Rate limiting** — Both `bridge-code` and `token/exchange` endpoints must enforce per-user rate limits

### Non-Functional Requirements

- All new fields, endpoints, and constants must follow existing project naming conventions (`POLICY_*`, `EXTENSION_TOKEN_*`)
- Backward-compatible during transition: keep legacy `POST /api/extension/token` callable but mark for removal after extension v0.5.x
- Server-side enforcement (rate limits, atomic consume, tenant/user resolution) must NOT depend on client input
- Constants for message types and TTLs must live in `src/lib/constants/extension.ts` and be mirrored in `extension/src/lib/constants.ts`

### Architectural Constraints

**Web app trust boundary**: The web app's MAIN-world JavaScript context is **NOT** considered fully trusted (XSS / supply chain). The whole point of this change is to limit damage from a compromised web app. Therefore:

- Any value the web app generates and forwards to the server (e.g. a PKCE `code_challenge`) can be tampered with by an attacker who controls MAIN-world JS. Designs that rely on web-app-generated cryptographic material for trust are **out of scope** for this plan (see Considerations §5)
- The extension content script and background script run in **ISOLATED** worlds and are considered trusted relative to MAIN world

**Migration period**: Until the extension reaches a version that uses the exchange flow exclusively, the legacy `POST /api/extension/token` endpoint must keep working. Older extensions installed by users will continue to receive bearer tokens via the legacy postMessage payload until they update.

## Technical Approach

### Stage 1: Add new endpoints and DB table (no behavior change yet)

1. **New DB model `ExtensionBridgeCode`** — stores hashed codes with strict atomic-consume semantics
2. **New endpoint `POST /api/extension/bridge-code`** — Auth.js session required; issues a one-time code
3. **New endpoint `POST /api/extension/token/exchange`** — public endpoint (no session required); accepts a code, atomically consumes it, returns an `ExtensionToken`
4. **New audit actions** — `EXTENSION_BRIDGE_CODE_ISSUE`, `EXTENSION_TOKEN_EXCHANGE_SUCCESS`, `EXTENSION_TOKEN_EXCHANGE_FAILURE`

### Stage 2: Switch the postMessage payload

5. **Change `injectExtensionToken` signature** — receives a code, posts `{ type: BRIDGE_CODE_MSG_TYPE, code, expiresAt }` instead of token. The function rename clarifies intent: `injectExtensionBridgeCode`
6. **Web app caller migration** — every call site that previously called `POST /api/extension/token` followed by `injectExtensionToken` now calls `POST /api/extension/bridge-code` followed by `injectExtensionBridgeCode`
7. **Extension content script update** — `token-bridge-lib.ts` listens for the new message type, calls the exchange endpoint via `fetch()` directly from the content script (or via background script), forwards the resulting token to background

### Stage 3: Atomic consume with rigorous concurrency control

8. **Single UPDATE with affected-rows check** — `prisma.extensionBridgeCode.updateMany({ where: { codeHash, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } })`. If `count === 0`, the code is already consumed, expired, or invalid → return 401
9. **Constant-time hash comparison at the application layer** — even though Postgres `WHERE token_hash = ?` is acceptable for indexed lookup, any in-memory comparison must use `timingSafeEqual` (RS1)

### Stage 4 (OUT OF SCOPE for this plan)

PKCE-style `code_verifier` / `code_challenge` was reviewed but **deferred** because the web app cannot be trusted to forward the challenge faithfully. A meaningful PKCE design would require the extension to register the challenge with the server through an independent channel, which introduces a bootstrap problem (the extension has no session). This will be revisited when extension-initiated flow is feasible. See Considerations §5.

## Implementation Steps

### Step 1: Database Schema

**File: `prisma/schema.prisma`**

Add new model:

```prisma
model ExtensionBridgeCode {
  id        String    @id @default(uuid(4)) @db.Uuid
  codeHash  String    @unique @map("code_hash") @db.VarChar(64)
  userId    String    @map("user_id") @db.Uuid
  tenantId  String    @map("tenant_id") @db.Uuid
  scope     String    @db.VarChar(255)
  expiresAt DateTime  @map("expires_at")
  usedAt    DateTime? @map("used_at")
  createdAt DateTime  @default(now()) @map("created_at")
  ip        String?   @db.VarChar(64)
  userAgent String?   @map("user_agent") @db.VarChar(512)

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@index([userId, usedAt])
  @@index([expiresAt])
  @@map("extension_bridge_codes")
}
```

Add reverse relations:
- `User.extensionBridgeCodes ExtensionBridgeCode[]`
- `Tenant.extensionBridgeCodes ExtensionBridgeCode[]`

**Notes addressing review findings:**
- `tenant_id` is stored on the code record (P1-M1) — exchange resolves both `userId` and `tenantId` from the code, never from client input
- `code_hash` is `@unique` (SHA-256 hex, 64 chars) — direct lookup by hash, the plaintext code never touches the DB
- `usedAt` is nullable; atomic consume sets it via single UPDATE (P1-m1)
- No `nonce` field — deferred along with Stage 4 PKCE (P1-m2)
- `ip`/`userAgent` columns enable forensic correlation between issue and exchange events

**Migration:**
- Create `prisma/migrations/YYYYMMDDHHMMSS_add_extension_bridge_codes/migration.sql`
- Verify with `npm run db:migrate`

### Step 2: Constants

**File: `src/lib/constants/extension.ts`** (extend existing file, do NOT create a new one)

Add to the existing file (keep `TOKEN_BRIDGE_MSG_TYPE` for legacy compatibility during migration):

```typescript
// New bridge code flow (replaces TOKEN_BRIDGE_MSG_TYPE for non-legacy clients)
export const BRIDGE_CODE_MSG_TYPE = "PASSWD_SSO_BRIDGE_CODE";

// Bridge code TTL — short enough to limit replay window, long enough to survive
// extension wakeup latency on slow devices
export const BRIDGE_CODE_TTL_MS = 60 * 1000; // 60 seconds

// Maximum unused bridge codes per user (oldest auto-revoked when exceeded)
export const BRIDGE_CODE_MAX_ACTIVE = 3;
```

**File: `extension/src/lib/constants.ts`** (mirror — must stay in sync with web app)

Add identical constants. The existing test `token-bridge-js-sync.test.ts` validates JS bundle constants — extend it to cover the new ones.

**Note (P1-M7):** All literal values (TTL, message type, max active) MUST be imported from these files in both implementation and tests. RT3 violation if hardcoded in test assertions.

### Step 3: Audit Actions

**File: `prisma/schema.prisma` (AuditAction enum)**

Add three values:
- `EXTENSION_BRIDGE_CODE_ISSUE`
- `EXTENSION_TOKEN_EXCHANGE_SUCCESS`
- `EXTENSION_TOKEN_EXCHANGE_FAILURE`

**File: `src/lib/constants/audit.ts`**

For each new action:
1. Add to `AUDIT_ACTION` object (key + value)
2. Add to `AUDIT_ACTION_VALUES` array
3. Add to `AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.AUTH]` (extension token issuance is a per-user auth event, not tenant-admin)
4. **Do NOT add to `WEBHOOK_DISPATCH_SUPPRESS`** — these are normal events, not delivery-failure events (R13 not applicable)

**Note on Tenant webhook subscription (R11/R12):**
The new actions are scope `PERSONAL`. They should NOT be added to `AUDIT_ACTION_GROUPS_TENANT` and therefore will NOT be auto-included in `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS`. Verify this in `audit.test.ts` after implementation.

**File: `messages/en/AuditLog.json` and `messages/ja/AuditLog.json`**

Add i18n keys for all three new actions. The existing `audit-log-keys.test.ts` validates 1:1 key coverage — failing this test is a Critical issue.

### Step 4: New Endpoint — POST /api/extension/bridge-code

**File: `src/app/api/extension/bridge-code/route.ts`** (NEW)

Pattern: copy structure from `src/app/api/extension/token/route.ts`, modify token logic.

```typescript
// Pseudocode — actual implementation must use existing helpers
const bridgeCodeLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10, // same as tokenLimiter — issuance frequency should not change
});

async function handlePOST(req: NextRequest) {
  // 1. CSRF: Origin check (defense-in-depth, addresses P1-m3)
  const originError = assertOrigin(req);
  if (originError) return originError;

  // 2. Auth.js session
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  // 3. Rate limit (P1-M4)
  const rl = await bridgeCodeLimiter.check(`rl:ext_bridge:${session.user.id}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  // 4. Resolve tenant via existing RLS pattern
  //    NOTE: withUserTenantRls signature is (userId, fn) — 2 args, NOT (prisma, userId, fn)
  //    See src/lib/tenant-context.ts:38
  const userId = session.user.id;
  const userRecord = await withUserTenantRls(userId, () =>
    prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } })
  );
  if (!userRecord) return unauthorized();

  // 5. Generate code (P1-M2: reuse generateShareToken — 256-bit entropy)
  const code = generateShareToken();
  const codeHash = hashToken(code);
  const expiresAt = new Date(Date.now() + BRIDGE_CODE_TTL_MS);

  // 6. Enforce BRIDGE_CODE_MAX_ACTIVE per user (revoke oldest unused).
  //    All steps (findMany → updateMany → create) MUST run inside the same
  //    withBypassRls call to avoid TOCTOU between count check and create.
  //    withBypassRls wraps a $transaction internally (see tenant-rls.ts:40-52).
  await withBypassRls(prisma, async () => {
    // 6a. Find unused, unexpired codes for this user, ordered oldest-first
    const active = await prisma.extensionBridgeCode.findMany({
      where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    // 6b. If count + 1 > MAX, mark the oldest (count + 1 - MAX) as used
    const overflow = active.length + 1 - BRIDGE_CODE_MAX_ACTIVE;
    if (overflow > 0) {
      const toRevoke = active.slice(0, overflow).map((r) => r.id);
      await prisma.extensionBridgeCode.updateMany({
        where: { id: { in: toRevoke } },
        data: { usedAt: new Date() },
      });
    }
    // 6c. Create the new code.
    //     The default scope MUST match the legacy POST /api/extension/token default
    //     (defined in src/lib/constants/extension-token.ts:16).
    //     Note: EXTENSION_TOKEN_DEFAULT_SCOPES is an array; the DB column is a CSV string.
    return prisma.extensionBridgeCode.create({
      data: {
        codeHash,
        userId,
        tenantId: userRecord.tenantId,
        scope: EXTENSION_TOKEN_DEFAULT_SCOPES.join(","),
        expiresAt,
        ip: extractClientIp(req),  // import from "@/lib/ip-access" — NOT from "@/lib/audit"
        userAgent: req.headers.get("user-agent") ?? null,
      },
    });
  }, BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  // 7. Audit
  const meta = extractRequestMeta(req);
  logAudit({
    scope: "PERSONAL",
    action: "EXTENSION_BRIDGE_CODE_ISSUE",
    userId,
    tenantId: userRecord.tenantId,
    ...meta,
  });

  // 8. Response — return only the plaintext code and TTL
  return NextResponse.json({
    code,
    expiresAt: expiresAt.toISOString(),
  }, { status: 201 });
}

export const POST = withRequestLog(handlePOST);
```

**Findings addressed:**
- P1-M4: rate limiter with `tokenLimiter`-equivalent settings
- P1-m3: `assertOrigin()` defense-in-depth
- P1-M2: code generated via `generateShareToken()` (256-bit randomBytes)
- P1-M1: `tenant_id` stored on code record from server-resolved value
- Audit log emitted on success

### Step 5: New Endpoint — POST /api/extension/token/exchange

**File: `src/app/api/extension/token/exchange/route.ts`** (NEW)

```typescript
const exchangeLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10, // Stricter than refresh — exchange is the entry point, replay attempts should be throttled
});

const ExchangeRequestSchema = z.object({
  code: z.string().length(64).regex(/^[a-f0-9]+$/),
});

async function handlePOST(req: NextRequest) {
  // 1. NO Origin check — extension content scripts have a chrome-extension:// origin
  //    that legitimately differs from APP_URL. Origin check would break the flow.
  //    Compensating control: code is single-use + short-lived + 256-bit entropy.

  // 2. NO Auth.js session — the whole point is to bootstrap auth from a code

  // 3. Parse and validate request body
  const body = await req.json().catch(() => null);
  const parsed = ExchangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    // No user context — write to operational log only.
    // Do NOT call logAudit() here: AuditLog.userId is @db.Uuid and audit.ts
    // requires a resolvable tenantId (via userId.findUnique → user.tenantId).
    // Without a known user we cannot satisfy either constraint, and the
    // record would be silently dropped (audit.ts:127-134). See Considerations §7.
    getLogger().warn(
      {
        event: "extension_token_exchange_failure",
        reason: "invalid_request",
        ip: extractClientIp(req),
        userAgent: req.headers.get("user-agent"),
      },
      "extension token exchange failed: malformed body",
    );
    // Use existing helper from src/lib/api-response.ts (badRequest does not exist)
    return zodValidationError(parsed.error);
  }

  const { code } = parsed.data;

  // 4. Rate limit BEFORE DB lookup, keyed by client IP since we have no userId yet
  //    (prevents enumeration of valid codes).
  //    extractClientIp is exported from "@/lib/ip-access", NOT from "@/lib/audit".
  const ip = extractClientIp(req) ?? "unknown";
  const rl = await exchangeLimiter.check(`rl:ext_exchange:${ip}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  // 5. Hash the submitted code (codeHash is the lookup key)
  const codeHash = hashToken(code);

  // 6. Atomic consume (P1-m1): single UPDATE with affected-rows check
  //    This is the critical security boundary — race conditions here mean
  //    the same code can issue multiple tokens.
  const now = new Date();
  const result = await withBypassRls(prisma, async () => {
    return prisma.extensionBridgeCode.updateMany({
      where: {
        codeHash,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
  }, BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  if (result.count === 0) {
    // Either code unknown, already used, or expired — same response in all cases
    // (do not leak which one to the caller).
    // Pino-only logging here: we have no resolvable userId/tenantId for the
    // failure case (see Considerations §7).
    getLogger().warn(
      {
        event: "extension_token_exchange_failure",
        reason: "unknown_or_consumed",
        ip,
        userAgent: req.headers.get("user-agent"),
      },
      "extension token exchange failed: code unknown, expired, or already consumed",
    );
    return unauthorized();
  }

  // 7. Fetch the consumed code to resolve userId/tenantId/scope from server data
  //    (P1-M1: server-side resolution, never from client input)
  const consumed = await withBypassRls(prisma, async () => {
    return prisma.extensionBridgeCode.findUnique({
      where: { codeHash },
      select: { userId: true, tenantId: true, scope: true },
    });
  }, BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  if (!consumed) {
    // This should be impossible — the UPDATE above just succeeded.
    // If we hit this path, it's a system invariant violation: log it loudly
    // for debugging (the code was atomically marked used, so the user is
    // out a code, but we cannot proceed).
    getLogger().error(
      {
        event: "extension_token_exchange_invariant_violation",
        codeHash,
      },
      "consumed code not found after successful update — system invariant violated",
    );
    // Use existing helper; serverError does not exist in api-response.ts
    return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
  }

  // 8. Issue ExtensionToken (reuse the same logic as POST /api/extension/token)
  //    Extract this into a shared helper `issueExtensionToken({ userId, tenantId, scope })`
  //    if not already done — see Step 7.
  const { token, expiresAt } = await issueExtensionToken({
    userId: consumed.userId,
    tenantId: consumed.tenantId,
    scope: consumed.scope,
  });

  // 9. Audit success — userId and tenantId both come from the consumed
  //    code record (server-side resolution, P1-M1). The DB write succeeds
  //    because tenantId is provided up-front (audit.ts:119-120 short-circuit).
  logAudit({
    scope: "PERSONAL",
    action: "EXTENSION_TOKEN_EXCHANGE_SUCCESS",
    userId: consumed.userId,
    tenantId: consumed.tenantId,
    ip,
    userAgent: req.headers.get("user-agent"),
  });

  // 10. Response — same shape as POST /api/extension/token
  return NextResponse.json({
    token,
    expiresAt: expiresAt.toISOString(),
    scope: consumed.scope.split(","),
  }, { status: 201 });
}

export const POST = withRequestLog(handlePOST);
```

**Findings addressed:**
- P1-C2: 5 critical paths (success, used, expired, unknown, malformed) all explicit
- P1-M1: `userId` and `tenantId` resolved from DB record, never from client
- P1-M2: rate limit on exchange endpoint, 256-bit code via `generateShareToken`
- P1-m1: atomic consume via `updateMany` + `count === 0` check (proven pattern from refresh route)

### Step 6: Refactor — Extract Shared Token Issuance Helper

**File: `src/lib/extension-token.ts`** (extend)

The current `POST /api/extension/token` route handler contains the token-creation transaction inline. Extract it:

```typescript
export async function issueExtensionToken(params: {
  userId: string;
  tenantId: string;
  scope: string;
}): Promise<{ token: string; expiresAt: Date }> {
  // Logic currently inline at src/app/api/extension/token/route.ts lines 47-85
  // — generateShareToken
  // — hashToken
  // — enforce EXTENSION_TOKEN_MAX_ACTIVE
  // — create ExtensionToken record (within $transaction)
  // — return { token, expiresAt }
}
```

**Reuse scope (intentionally limited):**
- `POST /api/extension/token` (legacy) — replaced with a call to `issueExtensionToken()`
- `POST /api/extension/token/exchange` (new) — calls `issueExtensionToken()` after consuming the bridge code

**NOT refactored — `POST /api/extension/token/refresh` keeps its inline transaction.** Refresh requires `revoke(oldTokenId) + create(newToken)` to be atomic in a single `$transaction` (see `src/app/api/extension/token/refresh/route.ts:65-87`). Replacing this with a standalone `issueExtensionToken()` call would split the revoke and the create across separate transactions, introducing a TOCTOU window where the old token is briefly invalid before the new one exists. The simpler design is to leave refresh untouched. If we later need to deduplicate the create logic, we should add an optional `revokeTokenId` parameter to `issueExtensionToken()` and run the entire revoke+create inside one `$transaction`. **Out of scope for this plan.**

**Refactor safety for the legacy endpoint test:**
- `src/app/api/extension/token/route.test.ts` mocks `prisma.extensionToken.*` directly via `vi.mock("@/lib/prisma", ...)`. It does NOT mock `@/lib/extension-token`.
- After Step 6, the route handler calls `issueExtensionToken()`, which itself calls the same `prisma.extensionToken.*` methods inside the same `$transaction` callback.
- Because the mock boundary is at the Prisma layer (not at the helper), the existing mocks remain effective and the test should pass without changes.
- **Verify when implementing**: confirm that the `mockTransaction.mockImplementation(async (cb) => cb(mockPrismaWithMethods))` setup correctly forwards the transaction client into `issueExtensionToken()`. If the helper accesses `prisma.$transaction` directly instead of receiving a `tx` argument, the mock chain still works because the outer `$transaction` mock returns the same proxied prisma object.

**Test cases for `issueExtensionToken()`** (R3-T4 / R4-T4 — add to existing `src/lib/extension-token.test.ts`):

The existing file already tests `validateExtensionToken`, `parseScopes`, `hasScope`. **DO NOT remove or replace** existing test cases. **APPEND** a new `describe("issueExtensionToken", ...)` block with these minimum cases:

1. **Success path**: given valid `userId`/`tenantId`/`scope`, returns `{ token: 64-char hex string, expiresAt: Date }`. Assert the returned `token` matches `/^[a-f0-9]{64}$/`. Assert `expiresAt` is approximately `now + EXTENSION_TOKEN_TTL_MS`.
2. **Active count enforcement**: when there are already `EXTENSION_TOKEN_MAX_ACTIVE` (3) active tokens for the user, the oldest is revoked when a new one is issued. Assert `prisma.extensionToken.updateMany` is called with the oldest token's ID and `{ revokedAt: <Date> }`.
3. **Active count under limit**: when active count + 1 ≤ `EXTENSION_TOKEN_MAX_ACTIVE`, no revocation occurs. Assert `updateMany` is NOT called.
4. **Hash determinism**: the hash stored in the DB equals `hashToken(returnedToken)`. Assert by capturing `prisma.extensionToken.create` call args and comparing.
5. **Transaction wrapping**: assert `prisma.$transaction` is called exactly once per invocation. (This catches the case where the refactor accidentally splits the operation.)

Use the same `vi.hoisted` + `vi.mock("@/lib/prisma", ...)` + `vi.mock("@/lib/crypto-server", ...)` pattern as `src/app/api/extension/token/route.test.ts:49-66`. The crypto-server mock must return predictable values: `generateShareToken: () => "a".repeat(64)`, `hashToken: (t) => "h".repeat(64)`.

**Required additions to the existing `extension-token.test.ts` `vi.hoisted` block** (R5-T1):

The existing file's `vi.hoisted` declares only `mockFindUnique`, `mockUpdate`, `mockWithBypassRls`. Test case 5 (transaction wrapping) requires `prisma.$transaction` to be a vitest spy. **Append** the following to the existing hoisted blocks (do NOT replace):

```typescript
const {
  mockFindMany,
  mockCreate,
  mockUpdateMany,
  mockTransaction,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockTransaction: vi.fn(),
}));
```

Then **extend** the existing `vi.mock("@/lib/prisma", ...)` to add the new methods on `extensionToken` and the `$transaction` field:

```typescript
vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionToken: {
      findUnique: mockFindUnique,
      findMany: mockFindMany,
      create: mockCreate,
      update: mockUpdate,
      updateMany: mockUpdateMany,
    },
    $transaction: mockTransaction,
  },
}));
```

Default `mockTransaction` implementation in `beforeEach`: `mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ extensionToken: { findMany: mockFindMany, create: mockCreate, updateMany: mockUpdateMany } }))`. This matches how the legacy route's `$transaction` callback receives a `tx` proxy with the same Prisma model methods.

Test case 5 assertion: `expect(mockTransaction).toHaveBeenCalledTimes(1)`.

### Step 7: Update Web App Client — `inject-extension-token.ts`

**File: `src/lib/inject-extension-token.ts`**

Replace existing function. The old name and shape is removed; callers must migrate.

```typescript
import { BRIDGE_CODE_MSG_TYPE } from "@/lib/constants/extension";

export function injectExtensionBridgeCode(code: string, expiresAt: number): void {
  window.postMessage(
    { type: BRIDGE_CODE_MSG_TYPE, code, expiresAt },
    window.location.origin,
  );
}
```

**File: `src/lib/inject-extension-token.test.ts`** (P1-C1 — must update in same PR as Step 7)

- Rename test file to `inject-extension-bridge-code.test.ts`
- Update assertions: payload now contains `code` (not `token`) and the type is `BRIDGE_CODE_MSG_TYPE`
- Add an explicit assertion that `token` is NOT a property of the payload (regression guard against accidentally re-introducing the bearer token)
- Import `BRIDGE_CODE_MSG_TYPE` from constants — do NOT hardcode the string (RT3 / P1-M7)

### Step 8: Identify and Migrate All Web App Callers

This is the migration step. The legacy flow is:
1. Caller invokes `POST /api/extension/token` directly (e.g., via `fetchApi`)
2. Caller passes the resulting `token` to `injectExtensionToken(token, expiresAt)`

After Step 7, callers must instead:
1. Invoke `POST /api/extension/bridge-code`
2. Pass the resulting `code` to `injectExtensionBridgeCode(code, expiresAt)`

**Action:**
- Grep `injectExtensionToken` callers — every one is a migration site
- Grep `/api/extension/token` callers in `src/` (excluding `/refresh` and `/exchange` and the route handler itself) — every one is a migration site
- Each call site must change BOTH the API call AND the inject function call together
- The legacy `POST /api/extension/token` endpoint stays operational for older extensions (P1-m4) — see Step 11

### Step 9: Update Extension Content Script

**File: `extension/src/content/token-bridge-lib.ts`**

Replace the existing `handlePostMessage` to:
1. Listen for `BRIDGE_CODE_MSG_TYPE` (new) — accept the new code-based payload
2. ALSO listen for `TOKEN_BRIDGE_MSG_TYPE` (legacy) — keep working until web app migration completes (Step 8)
3. For new payloads: validate `code` field shape, then call the exchange endpoint

```typescript
async function handlePostMessage(event: MessageEvent): Promise<boolean> {
  // ... existing source/origin checks (unchanged)

  if (event.data?.type === BRIDGE_CODE_MSG_TYPE) {
    const { code, expiresAt } = event.data;
    if (typeof code !== "string" || code.length !== 64) return false;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return false;
    if (!isContextValid()) return false;

    // Exchange the code for a token via direct fetch.
    // The fetch is from the content script's isolated world — no MAIN-world JS can intercept.
    // Resolve serverUrl from extension storage (the established pattern, mirroring
    // extension/src/content/webauthn-bridge.ts:13 and extension/src/background/index.ts:506).
    // NOTE: getApiBase() does NOT exist in the extension codebase — use chrome.storage.local instead.
    try {
      const { serverUrl } = await chrome.storage.local.get("serverUrl");
      if (typeof serverUrl !== "string" || !serverUrl) return false;
      const response = await fetch(`${serverUrl}/api/extension/token/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!response.ok) return false;
      const { token, expiresAt: tokenExpiresAt } = await response.json();
      chrome.runtime.sendMessage({ type: "SET_TOKEN", token, expiresAt: Date.parse(tokenExpiresAt) });
      return true;
    } catch {
      return false;
    }
  }

  // Legacy path — kept for transition period only
  if (event.data?.type === TOKEN_BRIDGE_MSG_TYPE) {
    // ... existing logic unchanged ...
  }

  return false;
}
```

**Notes:**
- The fetch happens from the content script's **isolated world**, which MAIN-world JS cannot intercept. This is the critical property that justifies the architecture
- The legacy path is fenced off for removal in a future extension release. Add a `TODO: remove after web app migration completes` comment

**File: `extension/src/__tests__/content/token-bridge.test.ts`**

Add new test cases mirroring the existing 7 cases:
- forwards valid bridge code message → calls fetch with correct payload → forwards token to background
- rejects bridge code message from different source (iframe)
- rejects bridge code message with wrong type
- rejects bridge code message with missing/short code
- rejects bridge code message with NaN expiresAt
- exchange endpoint returns 401 → does not forward token
- exchange endpoint network failure → does not forward token

**Test environment and async handler updates (R2-T1):**

The new bridge code path requires `fetch()` from the content script. Vitest jsdom env does NOT include `fetch` natively, and `handlePostMessage` becomes `async`. Update the test file accordingly:

1. **Verify jsdom environment is applied**:
   - Check `extension/vitest.config.ts` → `environmentMatchGlobs` (or equivalent). If `token-bridge.test.ts` is not matched, add it explicitly. If the file's `/** @vitest-environment jsdom */` annotation is sufficient (Vitest ≥ 0.31), no config change needed.
   - Document the chosen approach in the test file's header comment.

2. **Mock `fetch`** in a `beforeEach` block:
   ```typescript
   const mockFetch = vi.fn();
   beforeEach(() => {
     vi.stubGlobal("fetch", mockFetch);
     mockFetch.mockReset();
   });
   afterEach(() => {
     vi.unstubAllGlobals();
   });
   ```

3. **Migrate existing 7 sync test cases to await**:
   - The signature changes from `handlePostMessage(event): boolean` to `handlePostMessage(event): Promise<boolean>`.
   - Existing pattern `const ok = handlePostMessage(...); expect(ok).toBe(true);` must become `const ok = await handlePostMessage(...); expect(ok).toBe(true);`.
   - Test functions become `async`.
   - This is a **breaking source change** for the test file — apply it in the same commit as the handler change, otherwise the existing 7 tests will assert against `Promise<boolean>` truthiness (always true) and silently pass with wrong semantics.

4. **New bridge code test cases mock fetch behavior:**
   - Success path: `mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ token: "abc...", expiresAt: "2026-04-11T..." }), { status: 201 }))` → assert `chrome.runtime.sendMessage` was called with `{ type: "SET_TOKEN", token: "abc...", expiresAt: <number> }`
   - 401 path: `mockFetch.mockResolvedValueOnce(new Response("", { status: 401 }))` → assert `chrome.runtime.sendMessage` was NOT called
   - Network error: `mockFetch.mockRejectedValueOnce(new Error("network"))` → assert `chrome.runtime.sendMessage` was NOT called

**File: `extension/src/__tests__/content/token-bridge-js-sync.test.ts`** (R4-T3: file already exists at this path — EXTEND it, do NOT create a new file)

The existing test validates that `token-bridge.js` (the legacy compiled JS bundle) contains the `TOKEN_BRIDGE_MSG_TYPE` constant value, using Vite's `?raw` import to read the bundle as a string. **Mirror this pattern** for the new constants — do NOT introduce a new approach (`fs.readFileSync`, `__dirname`, regex parsing all inappropriate here).

Existing test (preserved as-is):
```typescript
import { describe, expect, it } from "vitest";
import { TOKEN_BRIDGE_MSG_TYPE } from "../../lib/constants";

describe("token-bridge.js sync", () => {
  it("keeps hardcoded MSG_TYPE aligned with shared constants", async () => {
    const { default: file } = await import("../../content/token-bridge.js?raw");
    expect(file).toContain(`"${TOKEN_BRIDGE_MSG_TYPE}"`);
  });
});
```

Add a new `it(...)` block within the same `describe`:

```typescript
import {
  TOKEN_BRIDGE_MSG_TYPE,
  BRIDGE_CODE_MSG_TYPE,
  BRIDGE_CODE_TTL_MS,
  BRIDGE_CODE_MAX_ACTIVE,
} from "../../lib/constants";

it("keeps bridge code constants aligned with shared constants", async () => {
  const { default: file } = await import("../../content/token-bridge.js?raw");
  expect(file).toContain(`"${BRIDGE_CODE_MSG_TYPE}"`);
});
```

**Numeric constants drift detection** (R5-T2): The `?raw` bundle check is suitable for string constants (like `BRIDGE_CODE_MSG_TYPE`), but cannot reliably verify that numeric constants (`BRIDGE_CODE_TTL_MS`, `BRIDGE_CODE_MAX_ACTIVE`) hold the same value in both repos — TypeScript import success only proves the constant exists, not that the value equals the web app's value. To detect numeric drift, add a dedicated cross-repo equality test on the **web app side** (which has access to both files):

Add **`src/__tests__/i18n/extension-constants-sync.test.ts`** (NEW — web app side, in node env):

```typescript
import { describe, expect, it } from "vitest";
import * as appConstants from "@/lib/constants/extension";
// Use a relative path; the web app vitest can read files outside src/ since
// extension/ is a sibling within the repo. Verify the relative path resolves.
import * as extConstants from "../../../extension/src/lib/constants";

describe("extension constants sync", () => {
  it("BRIDGE_CODE_MSG_TYPE matches between web app and extension", () => {
    expect(extConstants.BRIDGE_CODE_MSG_TYPE).toBe(appConstants.BRIDGE_CODE_MSG_TYPE);
  });
  it("BRIDGE_CODE_TTL_MS matches between web app and extension", () => {
    expect(extConstants.BRIDGE_CODE_TTL_MS).toBe(appConstants.BRIDGE_CODE_TTL_MS);
  });
  it("BRIDGE_CODE_MAX_ACTIVE matches between web app and extension", () => {
    expect(extConstants.BRIDGE_CODE_MAX_ACTIVE).toBe(appConstants.BRIDGE_CODE_MAX_ACTIVE);
  });
  it("TOKEN_BRIDGE_MSG_TYPE matches between web app and extension (legacy)", () => {
    expect(extConstants.TOKEN_BRIDGE_MSG_TYPE).toBe(appConstants.TOKEN_BRIDGE_MSG_TYPE);
  });
});
```

If the relative import path does not resolve under the web app's `tsconfig.json` `paths` / `include` settings, fall back to a runtime read pattern: use `fs.readFileSync` with `__dirname`-relative paths and parse the constants via `eval` of the source (acceptable in test code) or via regex extraction.

The legacy `?raw` approach is preferred for the `MSG_TYPE` strings because it validates the actually-bundled output (post-Vite transformation). The cross-repo equality test in the web app catches numeric drift that the bundle check cannot.

### Step 10: Tests

**Files: `src/app/api/extension/bridge-code/route.test.ts`** (NEW — P1-M5)

Test cases (mirror `src/app/api/extension/token/route.test.ts` structure):
- No session → 401
- Session present, success → 201, response shape `{ code, expiresAt }`, `code` is 64-char hex; `mockLogAudit` called with `EXTENSION_BRIDGE_CODE_ISSUE`, valid `userId`, valid `tenantId`
- Rate limit exceeded → 429
- Origin missing/mismatched → 403
- BRIDGE_CODE_MAX_ACTIVE enforcement → oldest code marked used when limit exceeded
- Audit log emitted with `EXTENSION_BRIDGE_CODE_ISSUE` (assert via `mockLogAudit`, NOT `mockWarn` — bridge-code success uses `logAudit`)

Use `vi.hoisted` mock pattern from existing token route test. Mock `extensionBridgeCode.create`, `extensionBridgeCode.findMany`, `extensionBridgeCode.updateMany`, `$transaction`. Add `vi.mock("@/lib/audit", () => ({ logAudit: mockLogAudit, extractRequestMeta: () => ({ ip: "1.1.1.1", userAgent: "test" }) }))` and declare `mockLogAudit` in the `vi.hoisted` block. Reference `src/app/api/vault/reset/route.test.ts` (or any existing test that asserts `logAudit` calls) for the established mock declaration pattern. Include `beforeEach(() => vi.clearAllMocks())`.

**Files: `src/app/api/extension/token/exchange/route.test.ts`** (NEW — P1-C2)

**Mock setup pattern** (mirror `src/app/api/csp-report/route.test.ts:7-13` for the logger mock and `src/app/api/extension/token/route.test.ts` for the Prisma/audit/tenant-rls/crypto mocks):

```typescript
const {
  mockExtensionBridgeCodeUpdateMany,
  mockExtensionBridgeCodeFindUnique,
  mockExtensionTokenCreate,
  mockExtensionTokenFindMany,
  mockExtensionTokenUpdateMany,
  mockUserFindUnique,
  mockTransaction,
  mockLogAudit,
  mockWarn,
  mockError,
  mockWithBypassRls,
  mockWithUserTenantRls,
  mockCheck,
  mockExtractClientIp,
} = vi.hoisted(() => ({
  mockExtensionBridgeCodeUpdateMany: vi.fn(),
  mockExtensionBridgeCodeFindUnique: vi.fn(),
  mockExtensionTokenCreate: vi.fn(),
  mockExtensionTokenFindMany: vi.fn(),
  mockExtensionTokenUpdateMany: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockLogAudit: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  // withBypassRls/withUserTenantRls invoked by Step 5; mock to bypass internal $transaction
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  // exchangeLimiter check — defaults to allowed; override per test
  mockCheck: vi.fn(async () => ({ allowed: true })),
  mockExtractClientIp: vi.fn(() => "1.2.3.4"),
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: mockWarn, info: vi.fn(), error: mockError }),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: "1.2.3.4", userAgent: "test" }),
}));

vi.mock("@/lib/ip-access", () => ({
  extractClientIp: mockExtractClientIp,
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  withUserTenantRls: mockWithUserTenantRls,
}));

vi.mock("@/lib/crypto-server", () => ({
  // Predictable values so tests can assert on hash/token shape without real crypto
  generateShareToken: () => "a".repeat(64),
  hashToken: (t: string) => "h".repeat(64),
}));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionBridgeCode: {
      updateMany: mockExtensionBridgeCodeUpdateMany,
      findUnique: mockExtensionBridgeCodeFindUnique,
    },
    extensionToken: {
      create: mockExtensionTokenCreate,
      findMany: mockExtensionTokenFindMany,
      updateMany: mockExtensionTokenUpdateMany,
    },
    user: {
      findUnique: mockUserFindUnique,
    },
    $transaction: mockTransaction,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();  // REQUIRED — item 7 uses mockResolvedValueOnce chain
                       // and stale queue entries must not leak between tests
  // Re-set defaults that beforeEach should reset to (clearAllMocks zeroes them)
  mockCheck.mockResolvedValue({ allowed: true });
  mockExtractClientIp.mockReturnValue("1.2.3.4");
  mockWithBypassRls.mockImplementation(async (_p, fn) => fn());
  mockWithUserTenantRls.mockImplementation(async (_u, fn) => fn());
});
```

**Note on item 6 (rate limit test):** override `mockCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 60_000 })` for that test only. Use a valid 64-char hex `code` in the request body so the request progresses past the schema validation and reaches the rate limit check (rate limit is checked after parse — see §Step 5).

The 5 critical paths from the security review (note: failures are pino-only — assert via `mockWarn`, NOT `mockLogAudit`):

1. **Code unused, valid** → 201, token returned, `usedAt` set, `mockLogAudit` called with `EXTENSION_TOKEN_EXCHANGE_SUCCESS`, valid `userId`, valid `tenantId`
2. **Code already used (concurrent exchange race — P1-M6)** → `mockExtensionBridgeCodeUpdateMany.mockResolvedValueOnce({ count: 0 })` → 401, `mockWarn` called with `reason: "unknown_or_consumed"`. **Also assert `expect(mockLogAudit).not.toHaveBeenCalled()`** (verify pino-only design from Considerations §7). (unit test only — simulates handler behavior when `count === 0`, not the concurrent write race itself; see §Testing Strategy X-M1)
3. **Code expired** → mock `updateMany` to return `{ count: 0 }` (since `expiresAt > now` filters it out) → 401, `mockWarn` called. **Also assert `expect(mockLogAudit).not.toHaveBeenCalled()`**.
4. **Code unknown / hash mismatch** → 401, `mockWarn` called. **Also assert `expect(mockLogAudit).not.toHaveBeenCalled()`**.
5. **Malformed request body** (missing code / wrong length / non-hex / not JSON) → 400, `mockWarn` called with `reason: "invalid_request"`. **Also assert `expect(mockLogAudit).not.toHaveBeenCalled()`**.
6. **Rate limit exceeded** → 429, neither `mockLogAudit` nor `mockWarn` called for the rate-limited request
7. **Replay protection (2-call sequence)** — explicit per-call mock chain:
   ```typescript
   mockExtensionBridgeCodeUpdateMany
     .mockResolvedValueOnce({ count: 1 })   // first call: success
     .mockResolvedValueOnce({ count: 0 });  // second call: already consumed
   // ... call exchange endpoint twice with the same code ...
   expect(firstResponse.status).toBe(201);
   expect(secondResponse.status).toBe(401);
   ```
   The distinction from item 2: item 2 tests a single failed call in isolation; item 7 tests the full replay scenario across two sequential calls. Both are required to ensure the per-call mock semantics are correct.

**Mock-reality consistency (RT1):**
- Prisma `updateMany` returns `Prisma.BatchPayload = { count: number }` — match this exactly.
- The mock `findUnique` after successful update must return a record with valid UUIDs for `userId`/`tenantId` and a valid scope CSV string.
- Type the mock returns explicitly. **Verify the correct Prisma 7 generic syntax** by reading the generated type after `npx prisma generate`. The form `Prisma.ExtensionBridgeCodeGetPayload<{}>` may not be valid in Prisma 7; if not, use `Prisma.ExtensionBridgeCode` (model type alias) or `Prisma.ExtensionBridgeCodeGetPayload<Prisma.ExtensionBridgeCodeDefaultArgs>` per the generated types.

**File: `src/lib/inject-extension-token.test.ts`** → rename to `inject-extension-bridge-code.test.ts`

P1-C1 — must be updated in the same PR as Step 7. See Step 7 notes.

**File: `extension/src/__tests__/content/token-bridge.test.ts`**

See Step 9 — extend with new bridge code test cases.

**Files: existing tests that may break:**
- `src/lib/inject-extension-token.test.ts` — renamed and rewritten
- `src/app/api/extension/token/route.test.ts` — should still pass after Step 6 refactor; verify
- `extension/src/__tests__/content/token-bridge-js-sync.test.ts` — extend to include `BRIDGE_CODE_MSG_TYPE` JS bundle sync check (correct path is `content/`, NOT `lib/`)

### Step 11: Migration Strategy and Legacy Endpoint Lifecycle (P1-m4)

The legacy endpoint `POST /api/extension/token` and the legacy postMessage flow must remain operational during the transition. This plan does NOT remove them. The deprecation lifecycle:

| Phase | Web app | Extension | Legacy endpoint | Legacy postMessage path |
|-------|---------|-----------|----------------|------------------------|
| Phase 1 (this plan) | Switches to new code flow only. **Old extensions will be unable to receive a token until users update.** Release notes must be published before deploying. | Both old and new (transition) | Kept alive (no new caller in web app, but reachable for direct API consumers) | Kept alive in extension as a fallback path |
| Phase 2 (extension v0.5.x release) | New code flow only | New flow only | Kept alive for older extensions still in use | Removed from extension |
| Phase 3 (after telemetry shows zero legacy traffic for 30 days) | Same | Same | **Remove** | Already gone |

The criteria for Phase 3 removal will be tracked in a follow-up issue. This plan only delivers Phase 1.

**Add audit/metric for the legacy endpoint:** during Phase 1, the legacy `POST /api/extension/token` should emit a counter or audit metadata field indicating it was called. This lets us measure migration completeness.

### Step 12: Documentation

**File: `docs/security/extension-token-bridge.md`** (likely exists — extend; if not, create)

Document:
- The new bridge code flow with sequence diagram
- The trust boundary analysis (web app MAIN world vs extension isolated world)
- Why PKCE Stage 4 was deferred (link to Considerations §5)
- The deprecation timeline for the legacy flow

## Phase 2 Impact Analysis Findings

Added during Phase 2 Step 2-1 impact analysis. These are deviations/additions that emerged from investigating the actual codebase before implementing.

### IA-1: `proxy.ts` requires modification (NOT in original plan)

**Discovery**: `src/proxy.ts:259` includes `pathname.startsWith(API_PATH.EXTENSION)` in the session-required block, which means **all** `/api/extension/*` routes require an Auth.js session by default.

**Impact**:
- `/api/extension/bridge-code` — fine (this endpoint requires a session)
- `/api/extension/token/exchange` — **broken without an explicit bypass** (this endpoint must be callable without a session)

**Resolution**: Add `/api/extension/token/exchange` to a new public-bypass block in `src/proxy.ts`, modeled after the share-link verify-access pattern (`src/proxy.ts:232-241`). The exchange endpoint must:
1. Bypass session check entirely
2. Allow chrome-extension:// origins in CORS preflight (`handlePreflight(request, { allowExtension: true })`)
3. Apply CORS headers via `applyCorsHeaders(request, res, { allowExtension: true })`

**Required test additions** in `src/__tests__/proxy.test.ts`:
- Exchange endpoint without session/Bearer → bypassed (no 401)
- Exchange endpoint OPTIONS preflight from chrome-extension origin → 204 with CORS headers
- bridge-code endpoint without session → 401 (existing EXTENSION prefix behavior preserved)

### IA-2: API_PATH constant additions

**`src/lib/constants/api-path.ts`** — add:
- `EXTENSION_BRIDGE_CODE: "/api/extension/bridge-code"`
- `EXTENSION_TOKEN_EXCHANGE: "/api/extension/token/exchange"`

**`extension/src/lib/api-paths.ts`** — add:
- `EXTENSION_TOKEN_EXCHANGE: "/api/extension/token/exchange"`

**Test files to update for path constants**:
- `src/lib/constants/api-path.test.ts` — assert new constants
- `extension/src/__tests__/lib/api-paths.test.ts` — assert new constant

### IA-3: Web app caller migration sites (single site)

**Only one web app caller of the legacy flow exists**: `src/components/extension/auto-extension-connect.tsx:43-49`. The caller pattern is:
```typescript
const res = await fetchApi(API_PATH.EXTENSION_TOKEN, { method: "POST" });
const json = await res.json();
injectExtensionToken(json.token, Date.parse(json.expiresAt));
```

To migrate, change to:
```typescript
const res = await fetchApi(API_PATH.EXTENSION_BRIDGE_CODE, { method: "POST" });
const json = await res.json();
injectExtensionBridgeCode(json.code, Date.parse(json.expiresAt));
```

Test file: `src/components/extension/auto-extension-connect.test.tsx` — update assertions for the new endpoint and inject function.

### IA-4: `getLogger()` test mocking — log return shape

The plan §Step 5 uses `getLogger().warn(...)` and `getLogger().error(...)`. The existing `csp-report/route.test.ts:7-13` pattern is the reference. The mock pattern from §Step 10 is correct, but verify when implementing that `mockError` is wired into the returned logger object alongside `mockWarn`.

### IA-5: Existing `inject-extension-token.test.ts` rename verification

The file currently exists at `src/lib/inject-extension-token.test.ts`. Use `git mv` to rename it to `inject-extension-bridge-code.test.ts`. Note: the rewrite will replace nearly all content, so git rename detection may treat it as delete+create — note this in the PR description.

---

## Implementation Checklist

### Files to modify
- [ ] `prisma/schema.prisma` — add `ExtensionBridgeCode` model + reverse relations on User/Tenant + 3 new `AuditAction` enum values
- [ ] `prisma/migrations/YYYYMMDDHHMMSS_add_extension_bridge_codes/migration.sql` — NEW
- [ ] `src/lib/constants/extension.ts` — add `BRIDGE_CODE_MSG_TYPE`, `BRIDGE_CODE_TTL_MS`, `BRIDGE_CODE_MAX_ACTIVE`
- [ ] `extension/src/lib/constants.ts` — mirror the same constants
- [ ] `src/lib/constants/audit.ts` — add 3 new actions to `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUPS_PERSONAL[AUTH]`
- [ ] `messages/en/AuditLog.json` + `messages/ja/AuditLog.json` — i18n keys for 3 new actions
- [ ] `src/lib/extension-token.ts` — extract `issueExtensionToken()` helper (Step 6)
- [ ] `src/app/api/extension/token/route.ts` — refactor to call `issueExtensionToken()`; add migration metric
- [ ] `src/app/api/extension/token/refresh/route.ts` — **DO NOT refactor** (see §Step 6 — inline atomic revoke+create transaction must be preserved)
- [ ] `src/lib/extension-token.test.ts` — **EXTEND** (file already exists with `validateExtensionToken`/`parseScopes`/`hasScope` tests; add `issueExtensionToken()` test cases — see §Step 6 "Test cases for `issueExtensionToken()`")
- [ ] `src/app/api/extension/bridge-code/route.ts` — NEW (Step 4)
- [ ] `src/app/api/extension/token/exchange/route.ts` — NEW (Step 5)
- [ ] `src/lib/inject-extension-token.ts` — rename function to `injectExtensionBridgeCode`, change payload
- [ ] `src/lib/inject-extension-token.test.ts` → rename to `inject-extension-bridge-code.test.ts`
- [ ] All web app callers of `injectExtensionToken` (Step 8 — grep result determines list)
- [ ] All web app callers of `POST /api/extension/token` (Step 8)
- [ ] `extension/src/content/token-bridge-lib.ts` — handle both old and new message types (Step 9)
- [ ] `extension/src/__tests__/content/token-bridge.test.ts` — **REQUIRED in two parts**: (1) migrate all 7 existing sync tests to `await handlePostMessage(...)` BEFORE adding new cases (skipping this risks false-positive tests asserting on `Promise<boolean>` truthiness), (2) add new bridge code test cases per §Step 9
- [ ] `extension/src/__tests__/content/token-bridge-js-sync.test.ts` — **EXTEND** (R4-T3: file already exists at `content/`, NOT `lib/`; uses Vite `?raw` import pattern, NOT `fs.readFileSync` — see §Step 9 for the corrected approach)
- [ ] `src/__tests__/i18n/extension-constants-sync.test.ts` — **NEW** (R5-T2: cross-repo numeric constant equality test on the web app side; see §Step 9)
- [ ] `src/app/api/extension/bridge-code/route.test.ts` — NEW (P1-M5)
- [ ] `src/app/api/extension/token/exchange/route.test.ts` — NEW (P1-C2, P1-T7 replay sequence)
- [ ] `vitest.config.ts` — verify `coverage.include` covers `src/lib/extension-token.ts` (R2-T6); add it explicitly if not already matched by the existing patterns
- [ ] `extension/vitest.config.ts` — verify `token-bridge.test.ts` is matched by jsdom env (R2-T1); add explicit `environmentMatchGlobs` entry if needed
- [ ] `docs/security/extension-token-bridge.md` — extend or create

### Shared utilities to reuse (NOT reimplement)
- `generateShareToken` from `src/lib/crypto-server.ts` — 256-bit code generation (P1-M2)
- `hashToken` from `src/lib/crypto-server.ts` — SHA-256 hashing of codes
- `timingSafeEqual` from `node:crypto` — any in-memory hash comparison (RS1)
- `createRateLimiter` from `src/lib/rate-limit.ts` — for both new endpoints
- `assertOrigin` from `src/lib/csrf.ts` — defense-in-depth on `bridge-code` endpoint
- `logAudit` + `extractRequestMeta` from `src/lib/audit.ts` — audit emission for **success path only** (failure path uses pino directly per Considerations §7)
- `extractClientIp` from `src/lib/ip-access.ts` — client IP extraction (NOT exported from `audit.ts`)
- `getLogger` from `src/lib/logger.ts` — pino-based operational logging for failure paths
- `zodValidationError` from `src/lib/api-response.ts` — for Zod validation failures (replaces non-existent `badRequest()`)
- `errorResponse` from `src/lib/api-response.ts` — for structured error responses with specific codes (replaces non-existent `serverError()`)
- `API_ERROR` from `src/lib/api-error-codes.ts` — error code constants (`API_ERROR.INTERNAL_ERROR`, etc.)
- `NIL_UUID` from `src/lib/constants/app.ts` — only if a sentinel UUID is needed elsewhere; the failure paths use pino instead and do NOT call `logAudit`
- `withBypassRls` + `BYPASS_PURPOSE.TOKEN_LIFECYCLE` from `src/lib/tenant-rls.ts` — DB writes for code lifecycle (already exists, do NOT add a new purpose)
- `withUserTenantRls` from `src/lib/tenant-context.ts` — for tenant resolution
- `withRequestLog` wrapper for handler export
- `vi.hoisted` mock pattern from existing `route.test.ts` files

### Existing test files to verify (must continue to pass)
- `src/app/api/extension/token/route.test.ts` — after Step 6 refactor
- `src/app/api/extension/token/refresh/route.test.ts` — after Step 6 refactor
- `src/lib/audit.test.ts` — `AUDIT_ACTION_VALUES` length and group membership assertions
- `src/__tests__/i18n/audit-log-keys.test.ts` — 1:1 i18n key coverage

## Testing Strategy

- **Unit tests**: All new route handlers, the extracted `issueExtensionToken` helper, the rewritten inject function
- **Mock-reality consistency**: All Prisma mocks for `extensionBridgeCode` must match the actual generated `Prisma.ExtensionBridgeCodeGetPayload` shape
- **Critical-path coverage**: The 5 exchange paths from P1-C2 are mandatory; missing any one is a Critical test gap
- **Concurrency simulation**: P1-M6 — `mockUpdateMany.mockResolvedValue({ count: 0 })` to simulate concurrent consumption
- **Rate limiter coverage**: 429 path on both endpoints
- **Origin check**: 403 path on `bridge-code` endpoint
- **Build verification**: `npx next build` after all changes
- **Manual verification**: Install the updated extension in a real browser, log into the dashboard, verify token is delivered to the background script. Confirm with browser DevTools Network tab that `/api/extension/token/exchange` is called from the content script (not from the main page)
- **Integration test gap acknowledgement (X-M1)**: Atomic consume is verified via mocked Prisma in unit tests. A real DB integration test for the race condition would be ideal but is out of scope here per existing project test infrastructure (see `project_integration_test_gap.md`)

## Considerations & Constraints

1. **Code TTL trade-off**: 60s is short enough to limit replay window but long enough to survive extension wakeup latency on slow devices (Service Worker cold start can take 1-3s on low-end Chromebooks). Do NOT lower below 30s without measuring extension wakeup time.

2. **Single-use is enforced server-side, not client-side**: The web app/extension cannot bypass it because the atomic UPDATE is the source of truth. This is a deliberate property — even malicious browsers cannot replay codes.

3. **Origin check on `bridge-code` only**: The `exchange` endpoint must NOT have `assertOrigin()` because the extension content script's effective origin in fetch headers may be `chrome-extension://...` or the page origin depending on Chrome version. Compensating control: 256-bit single-use short-lived code.

4. **Rate limit key strategy**:
   - `bridge-code`: keyed by `userId` (we have a session)
   - `exchange`: keyed by client IP (no session yet) — this is intentional to prevent enumeration; it accepts the trade-off that NAT'd users share a quota

5. **PKCE Stage 4 deferred (P1-M3)**: The reviewed PKCE design relies on the web app to forward the extension's `code_challenge` honestly. A compromised web app can substitute its own challenge, making PKCE useless. A meaningful PKCE design requires the extension to register the challenge with the server through a channel the web app does not touch — this requires the extension to already have some form of session/auth, creating a bootstrap problem. Revisit when we have a credible bootstrap mechanism (e.g. passkey-bound device key, Chrome enterprise policy, etc.).

6. **Legacy flow coexistence (P1-m4)**: For the duration of Phase 1 and Phase 2 (see Step 11), the legacy bearer-token postMessage path remains live. This is unavoidable because already-installed extensions cannot be force-updated. The migration metric collected on the legacy endpoint determines when removal is safe.

7. **Failed exchanges use pino-only logging, NOT `logAudit`** (R2-S1, F-05): When an exchange fails on a path with no resolvable user (invalid code, malformed body, replay), the handler uses `getLogger().warn(...)` directly instead of `logAudit()`. Rationale:
   - `AuditLog.userId` is `@db.Uuid` (`prisma/schema.prisma:899`) — non-UUID strings like `"system"` would cause Prisma to throw on the `findUnique` lookup inside `audit.ts:128-132`.
   - Even using `NIL_UUID` (`src/lib/constants/app.ts:17`), `audit.ts:127-134` requires a resolvable `tenantId`, and the fallback path queries `prisma.user.findUnique({ where: { id: NIL_UUID } })` which returns null. The function then returns early on line 134 (`if (!resolvedTenantId) return;`), silently dropping the audit record — pino still emits the structured log because that path runs unconditionally at line 193+, but the DB `audit_logs` table gets no row.
   - Conclusion: for unattributable failures we ONLY have pino. Calling `logAudit()` would be misleading because the developer expects a DB row.
   - The successful exchange path uses `logAudit()` with `userId` and `tenantId` resolved from the consumed code record — DB write succeeds because `tenantId` is provided up-front (the `audit.ts:119-120` short-circuit).
   - Operational logs and DB audit logs are forwarded to the same downstream pipeline (Fluent Bit / SIEM) in production, so this does not create a coverage gap for SIEM-based detection.

8. **Request cleanup**: Expired bridge codes accumulate in the table. Add a periodic cleanup task (or rely on TTL-based deletion in the existing maintenance routes — investigate `src/app/api/maintenance/*` for prior art). This is **NOT** a security issue (used codes cannot be reused) but a housekeeping item.

9. **No new BYPASS_PURPOSE needed**: `BYPASS_PURPOSE.TOKEN_LIFECYCLE` already exists and is used by `validateExtensionToken()`. The bridge code lifecycle is conceptually identical and reuses this purpose. Do NOT add a new bypass purpose.

10. **Scope handling**: The bridge code stores the `scope` string at issuance time, and the exchange endpoint passes it through to `issueExtensionToken()`. The default scope for bridge code issuance should match the legacy `POST /api/extension/token` default — verify the constant and reuse it.

11. **Rate limiter Redis fallback in multi-instance deployments** (R2-S4 — known project-wide limitation): `createRateLimiter` falls back to in-memory state if Redis is unavailable (`src/lib/rate-limit.ts:41-69`). In a multi-instance deployment with Redis down or partitioned, the configured `max` becomes per-instance, multiplying the effective rate limit by the number of app instances. This affects both `bridgeCodeLimiter` and `exchangeLimiter`. The 256-bit code entropy makes brute-force exchange infeasible regardless, so the security impact is bounded to weakened DoS protection. **Out of scope for this plan to fix** — track as a global rate-limiter improvement.

12. **`X-Forwarded-For` spoofing risk on the exchange rate limit** (R2-S3): `exchangeLimiter` is keyed by client IP because no session is available. `extractClientIp()` (`src/lib/ip-access.ts:259`) follows the rightmost-untrusted pattern, but in environments where the socket IP is not a trusted proxy, the entire XFF chain is treated as untrusted. An attacker can spoof XFF headers to rotate apparent IPs and bypass the per-IP rate limit. The 256-bit code entropy makes brute-force exchange infeasible regardless, so the practical impact is limited to weakened DoS protection at the exchange endpoint. Document this in the deployment guide; ensure operators configure `TRUSTED_PROXIES` correctly.

## User Operation Scenarios

### Scenario 1: Normal extension token bootstrap

1. User logs into the dashboard at `https://example.passwd-sso.local/dashboard`
2. Web app calls `POST /api/extension/bridge-code` (Auth.js session cookie)
3. Server returns `{ code: "abc...64-hex...", expiresAt: "..." }`
4. Web app calls `injectExtensionBridgeCode(code, expiresAtMs)` which posts `{ type: "PASSWD_SSO_BRIDGE_CODE", code, expiresAt }` to `window`
5. Extension content script (isolated world) receives the message, validates origin/source/type
6. Content script calls `POST /api/extension/token/exchange` with `{ code }`
7. Server atomically consumes the code, issues an `ExtensionToken`, returns it
8. Content script forwards the token to the background script via `chrome.runtime.sendMessage({ type: "SET_TOKEN", token, expiresAt })`
9. Background stores the token; extension is ready

### Scenario 2: XSS on the dashboard captures the postMessage

1. Attacker injects JS into the dashboard via XSS
2. Attacker installs `window.addEventListener("message", e => exfiltrate(e.data))`
3. User triggers the bridge flow (Scenario 1, steps 1-4)
4. Attacker captures `{ type: "PASSWD_SSO_BRIDGE_CODE", code: "abc..." }`
5. Attacker tries to call `POST /api/extension/token/exchange` from the page's MAIN world with the captured code
6. **Race**: the legitimate content script (isolated world) and the attacker (main world) both try to consume the code
7. **Outcome**:
   - One of them wins the atomic UPDATE (`count === 1`)
   - The other gets `count === 0` → 401
   - Telemetry shows `EXTENSION_TOKEN_EXCHANGE_FAILURE` indicating tampering
8. **Worst case**: attacker wins the race → attacker gets a token with the same scope and TTL the legitimate user would have received. This is no worse than today's bearer-token postMessage attack, but the window for capture is now ≤60s instead of 15min, AND the attacker must succeed in beating the content script's local fetch to the same origin (very narrow timing window because the content script has zero RTT to the message dispatch).

### Scenario 3: Replay attempt

1. Attacker captures a code via XSS (Scenario 2)
2. Attacker waits for the legitimate content script to consume it
3. Attacker tries to exchange the captured code
4. Server: `updateMany` returns `count === 0` → 401
5. Audit log: `EXTENSION_TOKEN_EXCHANGE_FAILURE` with `reason: unknown_or_consumed`

### Scenario 4: Code expired before exchange

1. Web app issues a bridge code at `t=0`
2. User closes the tab; content script never picks up the message
3. At `t=61s` (after `BRIDGE_CODE_TTL_MS`), the code is functionally dead
4. If the content script later tries to exchange it: `updateMany` returns 0 (because `expiresAt > now` filters it out) → 401

### Scenario 5: Rate-limited issuance

1. A buggy web app keeps calling `POST /api/extension/bridge-code` in a loop
2. After 10 calls in 15 minutes, the rate limiter returns `allowed: false`
3. Server returns 429 with `Retry-After`

### Scenario 6: Legacy extension (during migration)

1. User has the old extension version that only knows `TOKEN_BRIDGE_MSG_TYPE`
2. Web app calls `POST /api/extension/bridge-code` (the new flow)
3. Web app posts `{ type: BRIDGE_CODE_MSG_TYPE, code }` — old extension does not recognize this type and ignores it
4. **Result**: extension never gets a token until the user updates the extension
5. **Mitigation**: during Phase 1 (Step 11), the web app could detect old extensions via a feature negotiation handshake and fall back to the legacy `POST /api/extension/token` flow. **Decision**: this mitigation is OUT OF SCOPE for this plan; users will be advised to update the extension via release notes
