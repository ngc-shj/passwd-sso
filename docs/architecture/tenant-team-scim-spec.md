# Tenant/Team SCIM Specification

## Purpose

Define the target model where:

- `Tenant` = company/account boundary
- `Team` = department/group inside a tenant (current `Team` concept)
- SCIM is used to synchronize identity lifecycle and team membership from IdP

## Domain Model

1. Tenant

- top-level isolation boundary for data, policy, and provisioning
- one SCIM integration is configured per tenant (can have multiple tokens)

2. Team

- child of tenant
- collaboration and vault-sharing boundary inside tenant
- users belong to teams with team-scoped role

3. User

- global user identity record (shared row), but authorization is tenant/team scoped

## SCIM Scope

### 1) Users API (`/api/scim/v2/Users`)

Responsibility:

- synchronize tenant-level user lifecycle
- create/reactivate/deactivate/delete tenant users

Mapping:

| SCIM attribute | Internal model | Notes |
|----------------|----------------|-------|
| `userName` | `User.email` | canonical login email (lowercase normalized) |
| `active` | `TenantMember.deactivatedAt` | `false` → soft deactivate, `true` → reactivate |
| `externalId` | `ScimExternalMapping` | tenant-scoped mapping key (`tenantId` + `externalId` + `resourceType`) |
| `id` | `TenantMember.userId` | internal user ID, also resolvable via `ScimExternalMapping.internalId` |
| `name.formatted` | `User.name` | display name (read-only in SCIM context) |

Identity resolution (`resolveUserId`):

1. Direct lookup: `TenantMember` by `tenantId` + `userId`
2. Fallback: `ScimExternalMapping` by `tenantId` + `externalId` + `resourceType: "User"`
3. Input limit: `scimId.length > 255` → reject

Rules:

- user provisioning is tenant-scoped
- deprovision defaults to deactivate (soft) via `PUT active=false` or `PATCH active=false`
- hard delete supported via `DELETE` (removes `TenantMember`, `TeamMember`, `TeamMemberKey`, `ScimExternalMapping`)
- OWNER is protected: cannot deactivate/delete tenant OWNER via SCIM (403)
- `externalId` conflict detection: 409 if mapped to a different user

### 2) Groups API (`/api/scim/v2/Groups`)

Responsibility:

- synchronize team assignment and team role mapping
- map IdP groups to passwd-sso team/role targets

Mapping:

| SCIM attribute | Internal model | Notes |
|----------------|----------------|-------|
| `externalId` | `ScimGroupMapping.externalGroupId` | tenant-scoped mapping key |
| `displayName` | `<teamSlug>:<ROLE>` | e.g. `core:ADMIN` |
| `members[].value` | `TeamMember.userId` | team membership |
| `id` | `ScimGroupMapping.externalGroupId` | same as `externalId` |

Team resolution (Groups POST):

1. Parse `displayName` → extract `slugPart` (before `:`) and `rolePart` (after `:`)
2. Lookup: `prisma.team.findFirst({ where: { slug: slugPart, tenantId } })`
3. Validate: `rolePart` must match one of `SCIM_GROUP_ROLES` (case-insensitive)
4. Reject: `separator < 1` (no colon or empty slug) → 400

Supported roles: `ADMIN`, `MEMBER`, `VIEWER` (OWNER is excluded from SCIM group management)

Rules:

- all group operations are validated within tenant boundary
- one token can manage groups across multiple teams within the same tenant
- owner-protected constraints apply (cannot demote/remove OWNER by SCIM, 403)
- member add: if user exists in tenant but not in team, auto-creates `TeamMember` with `scimManaged: true`
- member remove: downgrades role to `MEMBER` (does not remove from team)
- DELETE is not supported (405) — role-based groups are configuration, not ephemeral resources

## Identity and Authorization Boundaries

1. Authentication

- delegated to IdP (OIDC/SAML)
- IdP registration is tenant-level

2. Authorization

- tenant-level role (OWNER/ADMIN/MEMBER)
- team-level role (OWNER/ADMIN/MEMBER/VIEWER)
- effective permission = tenant policy + team role

3. SCIM token management

- requires `TENANT_PERMISSION.SCIM_MANAGE` (granted to tenant OWNER and ADMIN)
- management API: `GET/POST /api/tenant/scim-tokens`, `DELETE /api/tenant/scim-tokens/[tokenId]`

## SCIM Token Model

1. Token scope

- token belongs to a single tenant
- never crosses tenant boundary
- no team affiliation (`ScimToken.teamId` removed)

2. Token operations

- create/revoke/list under tenant settings (`/api/tenant/scim-tokens`)
- hash-at-rest (SHA-256), one-time plaintext reveal with `Cache-Control: no-store`
- expiration: 1–3650 days or `null` (permanent)
- `scim_` prefix for secret scanner compatibility

3. Operational controls

- per-tenant active token count limit: 10
- rate limit: 200 req/60s keyed by tenant
- `lastUsedAt` throttled at 5-minute intervals

## Data Model

### ScimToken

- `tenantId` (required) — tenant boundary
- `tokenHash` — SHA-256 hash of plaintext token
- `revokedAt` — soft revoke timestamp
- `expiresAt` — expiration timestamp (nullable for permanent tokens)
- `createdById` — user who created the token
- `tenant` relation: `onDelete: Restrict` (tenant deletion requires explicit token cleanup)

### ScimExternalMapping

- `tenantId` (required) — tenant boundary
- `externalId` — IdP-provided identifier
- `internalId` — passwd-sso user ID
- `resourceType` — `"User"` (extensible)
- Unique constraints: `(tenantId, externalId, resourceType)`, `(tenantId, internalId, resourceType)`
- No `teamId` — mapping is tenant-scoped

### ScimGroupMapping

- `tenantId` (required) — tenant boundary
- `teamId` (required) — target team for role assignment
- `externalGroupId` — IdP-provided group identifier
- `role` — target team role (`ADMIN`, `MEMBER`, `VIEWER`)
- Unique constraint: `(tenantId, externalGroupId)`

## Audit

- All SCIM operations are logged with `scope: AUDIT_SCOPE.TENANT`
- Actions: `SCIM_TOKEN_CREATE`, `SCIM_TOKEN_REVOKE`, `SCIM_USER_CREATE`, `SCIM_USER_UPDATE`, `SCIM_USER_DEACTIVATE`, `SCIM_USER_REACTIVATE`, `SCIM_USER_DELETE`, `SCIM_GROUP_UPDATE`
- `AUDIT_ACTION_GROUPS_TEAM` retains SCIM group for backward compatibility (historical log display + team webhook delivery)
- Audit user: token creator's ID, with `SCIM_SYSTEM_USER_ID` fallback if creator no longer exists

## Migration Status

1. Phase 1 (Additive) — **Complete**

- added `tenants`, `tenant_members`, `tenant_id` columns

2. Phase 2 (Backfill) — **Complete**

- initial mapping: 1 current team → 1 tenant
- populated `tenant_id` on team/scim records

3. Phase 3 (Application Cutover) — **Complete** (`refactor/scim-tenant-scope`)

- SCIM token management moved from `/api/teams/[teamId]/scim-tokens` to `/api/tenant/scim-tokens`
- Permission model: `TEAM_PERMISSION.SCIM_MANAGE` → `TENANT_PERMISSION.SCIM_MANAGE`
- `validateScimToken()` returns `tenantId` only (no `teamId`)
- `ScimToken.teamId` and `ScimExternalMapping.teamId` removed from schema
- Groups POST resolves team by slug from `displayName` (not from token's team scope)
- Old team-scoped API routes deleted

4. Phase 4 (Constraint Tightening) — **Complete**

- `tenant_id` required on all SCIM tables
- unique/index constraints are tenant-centric

## Decided Items

1. SCIM delete semantics — **Decided**: deactivate by default (PUT/PATCH `active=false`), hard delete via `DELETE` endpoint
2. User record strategy — **Decided**: globally shared `users` row with tenant/team-scoped authorization
