# Plan: auth-session-improvements

## Objective

Fix two issues related to authentication and session management:

1. **Audit log IP/UA gaps**: Ensure all `logAudit()` calls include IP address and User-Agent where a request context exists
2. **OIDC re-auth spinner bug**: Fix infinite spinner after session expiry and OIDC re-authentication

## Requirements

### Functional Requirements

- FR-1: All user-initiated audit events must record IP address and User-Agent
- FR-2: System-initiated events (directory-sync engine, webhook dispatcher) are exempt from IP/UA requirement
- FR-3: After session expiry + OIDC re-authentication, the vault unlock screen must appear without requiring a page reload
- FR-4: LOADING state in VaultGate must not persist indefinitely

### Non-functional Requirements

- NFR-1: No breaking changes to existing audit log API or database schema (ip/userAgent columns already exist)
- NFR-2: Audit logging must remain async/non-blocking
- NFR-3: Session refresh must not cause unnecessary re-renders or API calls

## Technical Approach

### Issue 1: Audit Log IP/UA Gaps

**Root cause**: Three categories of missing IP/UA:

| Category | Files | Approach |
|----------|-------|----------|
| Auth.js events (`signIn`, `signOut`) | `src/auth.ts` | Read from `sessionMetaStorage` (AsyncLocalStorage), already populated by `withSessionMeta` wrapper in `[...nextauth]/route.ts` |
| Passkey verify route | `src/app/api/auth/passkey/verify/route.ts` | `meta` is already extracted (line 106-110); pass `ip`/`userAgent` to `logAudit()` |
| Admin rotate-master-key | `src/app/api/admin/rotate-master-key/route.ts` | Fix `ip` duplication in `metadata`; do NOT add `userAgent` (Bearer token endpoint, UA is spoofable and low forensic value) |

**Key insight**: The `[...nextauth]/route.ts` already wraps handlers with `withSessionMeta()`, which calls `sessionMetaStorage.run(meta, ...)`. This means inside `events.signIn` and `events.signOut`, we can read `sessionMetaStorage.getStore()` to get IP/UA without needing a `NextRequest` reference.

### Issue 2: OIDC Re-auth Spinner Bug

**Root cause**: Race condition between `SessionSync.update()` (async, fire-and-forget) and `VaultProvider`'s `useEffect` that depends on `[session, sessionStatus]`.

After OIDC callback redirect to `/dashboard`:
1. `SessionSync` detects pathname change, calls `update()` (not awaited)
2. `VaultProvider` may evaluate with stale `sessionStatus` = `"loading"`
3. Since `sessionStatus !== "authenticated"`, it returns early without calling `checkVaultStatus()`
4. If `sessionStatus` never transitions properly, `vaultStatus` stays `LOADING` forever

**Fix approach**: Add a timeout-based fallback with session refresh retry in `VaultProvider`. If `vaultStatus` remains `LOADING` for more than 10 seconds while `sessionStatus` is still `"loading"`, call `update()` to force a session refresh. If still stuck after a second timeout, fall back to `LOCKED` state.

This is the simplest and most robust solution because:
- It doesn't require changing the `SessionSync` / `useSession` contract
- It handles all edge cases (network issues, slow OIDC callbacks, etc.)
- The retry gives slow OIDC flows a second chance before falling back
- Worst case: user sees the lock screen after ~15s delay (vs infinite spinner)

## Implementation Steps

### Step 1: Fix auth.ts signIn/signOut events

File: `src/auth.ts`

```typescript
// In events.signIn:
async signIn({ user }) {
  if (user.id) {
    const meta = sessionMetaStorage.getStore();
    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: user.id,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
  }
},

// In events.signOut:
async signOut(message) {
  if ("session" in message && message.session?.userId) {
    const meta = sessionMetaStorage.getStore();
    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGOUT,
      userId: message.session.userId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
  }
},
```

Import: Add `import { sessionMetaStorage } from "@/lib/session-meta";`

### Step 2: Fix passkey verify route

File: `src/app/api/auth/passkey/verify/route.ts`

The `meta` object is already constructed at line 106-110. Pass `ip` and `userAgent` to `logAudit()`:

```typescript
logAudit({
  scope: AUDIT_SCOPE.PERSONAL,
  action: AUDIT_ACTION.AUTH_LOGIN,
  userId: user.id,
  ip: meta.ip,
  userAgent: meta.userAgent,
});
```

### Step 3: Fix admin rotate-master-key route

File: `src/app/api/admin/rotate-master-key/route.ts`

Remove `ip` from `metadata` (it's already passed as a top-level field). Do NOT add `userAgent` — this is a Bearer token endpoint typically called from CI/CD or scripts where UA is spoofable and has low forensic value.

```typescript
const { ip } = extractRequestMeta(req);
logAudit({
  scope: AUDIT_SCOPE.TEAM,
  action: AUDIT_ACTION.MASTER_KEY_ROTATION,
  userId: operatorId,
  metadata: {
    targetVersion,
    revokedShares,
  },
  ip,
});
```

### Step 4: Fix VaultProvider LOADING timeout

File: `src/lib/vault-context.tsx`

Modify the existing `useSession()` destructure to include `update`, and add a `useRef` to stabilize the reference (same pattern as `SessionSync`). Then add a new `useEffect` for the timeout:

```typescript
// Change existing line 155 from:
const { data: session, status: sessionStatus } = useSession();
// To:
const { data: session, status: sessionStatus, update } = useSession();
const updateRef = useRef(update);
useEffect(() => { updateRef.current = update; }, [update]);

// Add new useEffect for LOADING timeout:
useEffect(() => {
  if (vaultStatus !== VAULT_STATUS.LOADING) return;

  // First timeout: force a session refresh after 10s
  const retryTimer = setTimeout(() => {
    updateRef.current(); // Trigger session re-fetch via stable ref
  }, 10_000);

  // Second timeout: if still LOADING after 15s, give up and show lock screen
  const fallbackTimer = setTimeout(() => {
    setVaultStatus((prev) =>
      prev === VAULT_STATUS.LOADING ? VAULT_STATUS.LOCKED : prev,
    );
  }, 15_000);

  return () => {
    clearTimeout(retryTimer);
    clearTimeout(fallbackTimer);
  };
}, [vaultStatus]); // No `update` in deps — uses stable ref
```

**Important**: Do NOT call `useSession()` twice. The `update` function must come from the same hook call. Use `useRef` to avoid dependency array instability (same pattern as `SessionSync.updateRef`).

This ensures:
- Normal flow: `checkVaultStatus()` completes well before 10s, timers are cleared
- Slow OIDC flow: at 10s, session refresh is retried, giving a second chance
- Bug scenario: after 15s of LOADING, user sees the lock screen instead of infinite spinner
- After re-auth: user can enter passphrase on the lock screen

### Step 5: Update existing tests and add new tests

- **Update** existing `passkey/verify/route.test.ts` assertion (line ~171-176) to expect `ip` and `userAgent` fields in `logAudit` call
- **Update** existing `rotate-master-key/route.test.ts` assertion (line ~173-182) to verify `ip` duplication is removed from `metadata`
- **Add** unit test for `auth.ts` signIn/signOut events to verify IP/UA are read from sessionMetaStorage (requires mocking `NextAuth` internals — consider testing via the `[...nextauth]/route.test.ts` integration path if direct unit testing is impractical)
- **Add** unit test for VaultProvider LOADING timeout behavior (requires `@testing-library/react` + jsdom — verify vitest config supports this first)
- **Verify** all existing tests still pass with `npx vitest run`

## Testing Strategy

1. **Unit tests**: Test that sessionMetaStorage values are read in signIn/signOut events
2. **Unit tests**: Test VaultProvider LOADING timeout (mock timers)
3. **Integration verification**: `npx vitest run` — all tests pass
4. **Build verification**: `npx next build` — production build succeeds
5. **Manual verification** (recommended):
   - Sign in via Google OIDC → verify audit log has IP/UA
   - Wait for session expiry → re-authenticate → verify unlock screen appears without reload

## Considerations & Constraints

- **Out of scope**: System-initiated events (`directory-sync/engine.ts`, `webhook-dispatcher.ts`) intentionally have no IP/UA — they run from background jobs without HTTP request context
- **AsyncLocalStorage availability**: `sessionMetaStorage.getStore()` returns `undefined` if called outside a `run()` context. The `?? null` fallback handles this safely.
- **Timeout trade-off**: 10s retry + 15s fallback chosen as balance between UX and reliability. Normal flow completes in <1s. The retry at 10s handles slow OIDC; the 15s fallback is a safety net.
- **Privacy/GDPR**: IP/UA columns already exist in the `AuditLog` table and are already populated in 86 other callsites. This change fills gaps, not introduces new PII collection. Retention/access-control policies are out of scope (existing operational concern).
- **No schema changes needed**: `ip` and `userAgent` columns already exist in the `AuditLog` table
- **Passkey login path**: Passkey verify route (`/api/auth/passkey/verify`) creates sessions directly without going through Auth.js `events.signIn`. IP/UA for passkey login is handled separately in Step 2.
- **rotate-master-key UA exclusion**: This Bearer token endpoint is typically called from CI/CD or scripts. `userAgent` is trivially spoofable in this context and provides low forensic value, so only `ip` is recorded.
