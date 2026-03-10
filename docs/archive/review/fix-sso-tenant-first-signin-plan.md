# Plan: fix-sso-tenant-first-signin

## Objective

Fix a bug where new OAuth users with a tenant claim (e.g. Google Workspace `hd`) are placed into a bootstrap tenant on their first sign-in, instead of being placed directly into the SSO tenant.

## Problem Analysis

### Current Flow (Broken)

Auth.js v5 OAuth sign-in flow for a new user:

1. `signIn` callback runs — user does NOT exist in DB yet
2. `signIn` looks up user by email → `null` → `return true` (skips `ensureTenantMembershipForSignIn`)
3. `createUser` adapter method runs — always creates a new bootstrap tenant
4. `linkAccount` adapter method runs — links OAuth account to user
5. `createSession` adapter method runs — creates session

The bug: In step 2, the tenant claim (`profile.hd`) is available but not used. In step 3, `createUser` has no access to `account`/`profile`, so it cannot determine the SSO tenant.

### Expected Flow (Fixed)

1. `signIn` callback runs — extracts tenant claim, stores in AsyncLocalStorage
2. `signIn` returns `true`
3. `createUser` reads tenant claim from AsyncLocalStorage
4. If tenant claim exists: find or create SSO tenant, place user there as MEMBER
5. If no tenant claim: create bootstrap tenant (existing behavior, unchanged)

### DB Evidence

| User | Email | Tenant | Type |
|------|-------|--------|------|
| User A (1st) | test_a@example.co.jp | `example.co.jp` (externalId) | SSO |
| User B (2nd) | test_b@example.co.jp | bootstrap (email-named) | Bootstrap |
| User C (3rd) | test_c@example.co.jp | bootstrap (email-named) | Bootstrap |

User A ended up in the SSO tenant only because they signed in a 2nd time, triggering bootstrap→SSO migration. Users B and C have not yet triggered this migration.

## Requirements

### Functional

- F1: New OAuth users with a tenant claim must be placed directly into the SSO tenant on first sign-in
- F2: New OAuth users without a tenant claim must continue to get a bootstrap tenant (no behavior change)
- F3: If the SSO tenant does not yet exist, it must be created (first user of a domain)
- F4: The first user to create an SSO tenant should be MEMBER (same as the existing 2nd-sign-in migration behavior)
- F5: Existing `ensureTenantMembershipForSignIn` (2nd+ sign-in, bootstrap migration) must remain unchanged
- F6: Race conditions (two users from same domain signing up simultaneously) must be handled

### Non-functional

- NF1: Follow the existing AsyncLocalStorage pattern used by `sessionMetaStorage`
- NF2: No circular module dependencies
- NF3: All existing tests must continue to pass
- NF4: Production build must succeed

## Technical Approach

### Architecture: AsyncLocalStorage for Cross-Function Data Passing

The same pattern as `sessionMetaStorage` (IP/UA from route handler to adapter):

```
route.ts                     auth.ts                      auth-adapter.ts
─────────                    ───────                      ───────────────
tenantClaimStorage.run()  →  signIn callback:             createUser:
  { tenantClaim: null }      store.tenantClaim = claim    read store.tenantClaim
```

### Why AsyncLocalStorage (Not Alternatives)

| Alternative | Problem |
|-------------|---------|
| Module-level variable | Not request-scoped; race conditions in concurrent requests |
| Pass via Auth.js config | `createUser` adapter method signature is fixed by Auth.js |
| Extract domain from email | Email domain ≠ tenant claim (SAML `tenant_id`, custom claim keys) |
| Do migration in `linkAccount` | `linkAccount` has `account` (provider) but not `profile` (no `hd` claim) |

### Extract Shared Tenant Find-or-Create Logic

The find-or-create-SSO-tenant logic (with P2002 race condition handling) currently lives inline in `ensureTenantMembershipForSignIn`. Extract it into a shared function `findOrCreateSsoTenant` in a new module `src/lib/tenant-management.ts` to avoid:
- Code duplication between `ensureTenantMembershipForSignIn` and `createUser`
- Circular dependency (`auth.ts` ↔ `auth-adapter.ts`)

## Implementation Steps

### Step 1: Create `src/lib/tenant-claim-storage.ts`

New file with AsyncLocalStorage for tenant claim:

```typescript
import { AsyncLocalStorage } from "node:async_hooks";

interface TenantClaimStore {
  tenantClaim: string | null;
}

export const tenantClaimStorage = new AsyncLocalStorage<TenantClaimStore>();
```

Uses a mutable object so `signIn` callback can write to it after `run()` is called.

Note: This store is used exclusively on the one-way path `signIn` → `createUser` for new OAuth users. Add a JSDoc comment documenting this usage scope to prevent misuse in future changes.

### Step 2: Create `src/lib/tenant-management.ts`

Extract the find-or-create logic from `ensureTenantMembershipForSignIn` (auth.ts L47-93) into:

```typescript
export async function findOrCreateSsoTenant(tenantClaim: string): Promise<{ id: string } | null>
```

This function:
- Validates slug via `slugifyTenant`
- Finds tenant by `externalId`
- Creates if not found, with P2002 retry logic (slug collision with random suffix)
- Does NOT call `withBypassRls` internally — caller is responsible for RLS context
- Both call sites (`ensureTenantMembershipForSignIn` and `createUser`) already wrap their logic in `withBypassRls`, so no nesting issues arise

### Step 3: Modify `src/auth.ts`

#### 3a: Import changes

- Add: `import { tenantClaimStorage } from "@/lib/tenant-claim-storage"`
- Add: `import { findOrCreateSsoTenant } from "@/lib/tenant-management"`
- Remove (now unused): `Prisma` from `@prisma/client`, `slugifyTenant` from tenant-claim, `randomBytes` from node:crypto

#### 3b: Refactor `ensureTenantMembershipForSignIn`

Replace inline tenant find-or-create block (L47-93) with call to `findOrCreateSsoTenant`. The function's external behavior is unchanged.

#### 3c: Modify `signIn` callback

Change the `if (!userId)` block (L284-286) to store the tenant claim before returning:

```typescript
if (!userId) {
  const claim = extractTenantClaimValue(
    params.account,
    (params.profile ?? null) as Record<string, unknown> | null,
  );
  const store = tenantClaimStorage.getStore();
  if (store && claim) {
    store.tenantClaim = claim;
  }
  return true;
}
```

### Step 4: Modify `src/app/api/auth/[...nextauth]/route.ts`

- Import `tenantClaimStorage`
- Nest `tenantClaimStorage.run({ tenantClaim: null }, ...)` inside `sessionMetaStorage.run()` in `withSessionMeta`

### Step 5: Modify `src/lib/auth-adapter.ts`

#### 5a: Import changes

- Add: `import { tenantClaimStorage } from "@/lib/tenant-claim-storage"`
- Add: `import { findOrCreateSsoTenant } from "@/lib/tenant-management"`

#### 5b: Modify `createUser`

Read the tenant claim from AsyncLocalStorage, then resolve the SSO tenant **inside** the existing `withBypassRls` block (but outside the `$transaction`, since `findOrCreateSsoTenant` uses the top-level `prisma` client). The `$transaction` handles user + membership atomically using the resolved tenant:

```typescript
async createUser(user: Omit<AdapterUser, "id">): Promise<AdapterUser> {
  // Read tenant claim stored by signIn callback
  const pendingClaim = tenantClaimStorage.getStore()?.tenantClaim ?? null;

  const created = await withBypassRls(prisma, async () => {
    // Resolve SSO tenant inside withBypassRls (no nesting — same RLS context)
    let ssoTenant: { id: string } | null = null;
    if (pendingClaim) {
      ssoTenant = await findOrCreateSsoTenant(pendingClaim);
    }

    return prisma.$transaction(async (tx) => {
      // Use SSO tenant if available, otherwise create bootstrap tenant
      const tenant = ssoTenant
        ?? await tx.tenant.create({
            data: {
              name: user.email ?? user.name ?? "User",
              slug: `bootstrap-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
              isBootstrap: true,
            },
            select: { id: true },
          });

      const createdUser = await tx.user.create({
        data: {
          name: user.name,
          email: user.email,
          image: user.image,
          emailVerified: user.emailVerified,
          tenantId: tenant.id,       // SSO or bootstrap tenant ID
        },
        select: { id: true, name: true, email: true, image: true, emailVerified: true },
      });

      await tx.tenantMember.create({
        data: {
          tenantId: tenant.id,
          userId: createdUser.id,
          role: ssoTenant ? "MEMBER" : "OWNER",  // SSO = MEMBER, bootstrap = OWNER
        },
      });

      return createdUser;
    });
  });
  // ...
}
```

Key design decisions:
- `findOrCreateSsoTenant` runs inside `withBypassRls` but outside `$transaction` — it may create the SSO tenant in a separate implicit transaction, which is acceptable (idempotent find-or-create)
- User + `tenantMember` creation remains atomic within `$transaction`
- If `findOrCreateSsoTenant` returns `null` (invalid slug), falls back to bootstrap tenant

### Step 6: Update tests

#### 6a: Update `src/auth.test.ts`

- Add mock for `tenantClaimStorage`
- Update "returns false when slugifyTenant returns empty string" test if `ensureTenantMembershipForSignIn` now delegates slug check to `findOrCreateSsoTenant`
- Add test: "stores tenant claim in tenantClaimStorage for new user" — wrap test body in `tenantClaimStorage.run({ tenantClaim: null }, ...)` and verify `getStore().tenantClaim` is set after signIn callback
- Verify existing signIn callback tests still pass

#### 6b: Add tests to `src/lib/auth-adapter.test.ts`

- Test: createUser with pending tenant claim places user in SSO tenant
  - Assert `tenant.create` (bootstrap) is NOT called
  - Assert `user.create` receives SSO tenant ID as `tenantId`
  - Assert `tenantMember.create` receives `role: "MEMBER"` and SSO tenant ID
- Test: createUser without pending tenant claim creates bootstrap tenant (existing behavior)
  - Assert `tenant.create` IS called with `isBootstrap: true`
  - Assert `tenantMember.create` receives `role: "OWNER"`
- Test: createUser with pending claim but `findOrCreateSsoTenant` returns null → falls back to bootstrap tenant

#### 6c: Add tests for `src/lib/tenant-management.ts`

- Test: findOrCreateSsoTenant finds existing tenant
- Test: findOrCreateSsoTenant creates new tenant
- Test: findOrCreateSsoTenant handles P2002 on externalId
- Test: findOrCreateSsoTenant handles P2002 on slug with fallback
- Test: findOrCreateSsoTenant returns null for empty slug

## Testing Strategy

### Unit Tests

1. `tenant-management.test.ts`: findOrCreateSsoTenant — all paths (find, create, P2002 retry)
2. `auth.test.ts`: Existing tests pass + new test for tenant claim storage in signIn
3. `auth-adapter.test.ts`: createUser with/without pending tenant claim

### Integration Verification

1. `npx vitest run` — all tests pass
2. `npx next build` — production build succeeds

### Manual Verification (Post-deploy)

1. Delete test users B and C from DB
2. Have them sign in again
3. Verify they are placed in the SSO tenant directly

## Considerations & Constraints

### Scope

- This fix only affects the first-sign-in path for OAuth providers with tenant claims
- Magic Link, Passkey, and SAML sign-in flows are unaffected (they don't go through `createUser` in the same way, or have their own tenant handling)
- The existing bootstrap→SSO migration in `ensureTenantMembershipForSignIn` remains as a fallback for edge cases

### Risk: AsyncLocalStorage Context Not Available

Auth.js executes `signIn` → `createUser` → `linkAccount` → `createSession` sequentially within the same request handler invocation, so the AsyncLocalStorage context established by `tenantClaimStorage.run()` in `withSessionMeta` is guaranteed to be available in both `signIn` and `createUser`.

If `tenantClaimStorage.getStore()` returns `undefined` for any unexpected reason (e.g., called outside the route handler context), the code falls back to `null` and creates a bootstrap tenant — safe degradation.

### Risk: Circular Dependency

Avoided by placing `findOrCreateSsoTenant` in `src/lib/tenant-management.ts` (imported by both `auth.ts` and `auth-adapter.ts`).

### Design Decision: SSO Tenant Members Are Always MEMBER Role

SSO tenant users are assigned `MEMBER` role, not `OWNER`. This is intentional:
- SSO tenants are managed by the IdP administrator, not by individual users
- The existing bootstrap→SSO migration (2nd sign-in path) also assigns `MEMBER`
- Bootstrap tenants assign `OWNER` because the single user must manage their own data
- This is consistent with enterprise SSO patterns where tenant administration is external

### Tenant Claim Trust Model

The tenant claim (e.g., Google `hd`, SAML `tenant_id`) is trusted because:
- Auth.js verifies the OAuth ID token signature before exposing `profile`
- SAML assertions are verified by Jackson (BoxyHQ) before reaching Auth.js
- The `profile` object is not user-controllable; it comes from the IdP's signed response
- Admin-configured `AUTH_TENANT_CLAIM_KEYS` determines which claims are used

### Out of Scope

- Cleanup of orphaned bootstrap tenants for existing users B and C (manual DB fix)
- Audit logging for tenant creation (existing `ensureTenantMembershipForSignIn` does not log either; can be added as a separate enhancement)
