# Design: User.email Uniqueness Model (ADR)

**Status**: Accepted (codifies existing design)
**Date**: 2026-04-28
**Trigger**: External review questioned whether `User.email @unique` is consistent with `User.tenantId` multi-tenant scoping.

## Context

### Current schema

```prisma
model User {
  id        String  @id @default(uuid(4)) @db.Uuid
  tenantId  String  @map("tenant_id") @db.Uuid   // home tenant
  email     String? @unique                       // GLOBAL unique
  ...
}

model TenantMember {
  tenantId  String
  userId    String
  role      TenantRole
  @@unique([tenantId, userId])
}
```

The pairing of `User.email @unique` with `User.tenantId` looks like a contradiction at first glance: if email is globally unique, why does each User carry a tenant id?

### What the code actually does

1. **First sign-in (`createUser` in `src/lib/auth/session/auth-adapter.ts:144-208`)**:
   - If a tenant claim is present (Google `hd`, SAML `tenant_id`), `findOrCreateSsoTenant(claim)` resolves to the SSO tenant and the user is created as `tenantId = ssoTenant.id` with `TenantMember(role=MEMBER)`.
   - If no tenant claim is present, a brand-new bootstrap tenant is created and the user is placed there as `OWNER`.

2. **Second+ sign-in into a different tenant (`ensureTenantMembershipForSignIn` in `src/lib/auth.ts`)**:
   - When a user already on a bootstrap tenant signs in via SSO with a tenant claim, **all per-user tables are migrated** (`User.tenantId`, sessions, vault keys, password entries, audit logs, etc.) from the bootstrap tenant id to the SSO tenant id. The bootstrap tenant is effectively merged into the SSO tenant.
   - The migration is gated on `expected 1 active member` (only the owner of a bootstrap tenant can migrate it).

3. **`User.tenantId` semantics**:
   - It is **the user's currently active tenant**, not a denormalized read-cache.
   - It IS migrated by the bootstrap → SSO flow (auth-adapter.ts:90-195 references show 20+ table updates wrapped in `User.tenantId` change).
   - All tenant-scoped tables have RLS that filter on `current_setting('app.tenant_id')`, set per-request from the session — not from `User.tenantId` directly.

## Decision

**Adopt the existing design as Status: Accepted.** Document it explicitly here so future contributors don't mistake it for a bug.

### The product model is "global identity, one active tenant at a time"

| Property | Value |
|---|---|
| Identity unit | One User row per email, globally unique |
| Tenant residency | One active tenant per user (`User.tenantId`) |
| Multi-tenant access | Via `TenantMember` rows; scopes are switched at the session/RLS layer, not by spawning duplicate Users |
| Cross-tenant move | Bootstrap → SSO migration; otherwise admin operation (out of scope here) |

### Why this is the right shape for this product

1. **Vault is keyed to one identity**: A user's vault (encrypted master key, recovery key, passphrase verifier, ECDH key pair) is on the User row. Splitting into per-tenant Users would mean per-tenant vaults — multiplying the user's password-reset / passkey re-enrollment burden by N tenants.
2. **Passkey / WebAuthn credentials are user-bound**, not tenant-bound. Browsers register credentials against an RP id, not against a tenant. Per-tenant Users would force re-enrollment in every tenant.
3. **Auth.js v5 default adapter expects email-keyed Users**. Choosing per-tenant emails would require a custom adapter and a re-design of OAuth account linking semantics.
4. **SSO-first multi-tenancy**: customers who require strict tenant separation use the SSO claim path — their tenant is determined by the IdP, and the same email at a different IdP is a different real person (impersonation requires breaching the IdP, not the app).

## Consequences

### What the current model rules OUT

- A single email cannot be **independently** signed up in two SSO tenants as separate identities. If `alice@example.com` exists in tenant A's SSO, and tenant B's SSO emits the same email, sign-in into B will resolve to the same User and trigger a migration check (or be rejected if the user already has membership elsewhere).
- This is not a bug; it is the chosen identity boundary. The mitigating fact is that SSO tenant claims come from the IdP — if the IdP says `alice@example.com` is in `example.com`, that mapping is authoritative.

### What it does NOT prevent

- Multi-tenant access for the same user is fully supported via `TenantMember`: a user can be added to multiple tenants by tenant admins. Active tenant is selected per session. The schema already has `tenantMemberships  TenantMember[]` on User.

### Risks and mitigations

| Risk | Status | Mitigation |
|---|---|---|
| Stale `User.tenantId` after bootstrap migration causes cross-tenant query mis-resolution | Mitigated | RLS uses `current_setting('app.tenant_id')` from session, not `User.tenantId`. Sessions are migrated atomically with `User.tenantId` (auth-adapter.ts cache invalidation). |
| Direct `where: { tenantId: user.tenantId }` queries bypass session-scoped tenant | Low impact | Reviewed code uses `withTenantRls` / `withUserTenantRls` consistently. Direct reads of `User.tenantId` are confined to auth bootstrap and admin-token issuance. |
| User wants two unrelated identities at two unrelated SSO tenants | Out of model | They must use two emails. This matches Google Workspace / Microsoft 365 behavior and is the product's working assumption. |

## Alternatives considered

### Alt 1: `@@unique([tenantId, email])`, drop global `@unique`

- **Implementation cost**: ~2 weeks (custom Auth.js adapter, vault re-key per tenant, passkey re-enrollment per tenant, OAuth account linking per tenant, migration of every existing User row, breaking change for all clients).
- **Why rejected**: This would split a single human into N Users with N vaults and N passkey credentials — operationally hostile to the user. The only scenario it serves is "I want to be Alice@CompanyA and Alice@CompanyB simultaneously with no link between them," which is achievable today by using two email addresses.

### Alt 2: Make `User.email` `@@unique([tenantId, email])` AND keep one global User

- Internally inconsistent — global identity with tenant-scoped email key contradicts itself.
- **Why rejected**: Not a coherent model.

### Alt 3: Keep current schema (Accepted)

- Document the design intent so future reviewers do not mistake `email @unique` for a multi-tenant bug.
- **Why accepted**: Matches the implementation, matches industry SSO practice (Auth0, WorkOS, Okta-on-app), and minimizes operational cost for the user.

## Action items

- [x] Codify this ADR (this document).
- [ ] Add a comment block to `prisma/schema.prisma` near the `User.email @unique` declaration referencing this ADR.
- [ ] Update `CLAUDE.md` "Authentication Flow" section with a one-line pointer: "Identity model: see docs/archive/review/email-uniqueness-design.md".

## References

- `src/lib/auth/session/auth-adapter.ts:144-208` — `createUser` SSO/bootstrap branching.
- `src/lib/auth.ts` — bootstrap → SSO migration entry (`ensureTenantMembershipForSignIn`).
- `src/lib/tenant/tenant-management.ts` — `findOrCreateSsoTenant` race-safe upsert.
- `docs/archive/review/fix-sso-tenant-first-signin-plan.md` — prior plan that established the tenant claim flow.
