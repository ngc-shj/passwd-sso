# Tenant/Team SCIM Specification

## Purpose

Define the target model where:
- `Tenant` = company/account boundary
- `Team` = department/group inside a tenant (current `Organization` concept)
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

### 1) Users API (`/Users`)

Responsibility:
- synchronize tenant-level user lifecycle
- create/reactivate/deactivate tenant users

Mapping:
- `userName` -> canonical login email
- `active` -> tenant membership active state (not direct hard-delete)
- `externalId` -> tenant-scoped mapping key

Rules:
- user provisioning is tenant-scoped
- deprovision defaults to deactivate (soft)
- hard delete is optional and policy-controlled

### 2) Groups API (`/Groups`)

Responsibility:
- synchronize team assignment and team role mapping
- map IdP groups to passwd-sso team/role targets

Mapping options (choose per tenant policy):
1. Role Groups mode
- IdP groups map to predefined roles (`ADMIN`, `MEMBER`, `VIEWER`) within target team

2. Team Groups mode
- IdP groups map directly to team identity, then role is fixed or derived

Rules:
- all group operations are validated within tenant boundary
- owner-protected constraints apply (cannot demote/remove protected owner by SCIM)

## Identity and Authorization Boundaries

1. Authentication
- delegated to IdP (OIDC/SAML)
- IdP registration is tenant-level

2. Authorization
- tenant-level role (e.g., tenant owner/admin/member)
- team-level role (owner/admin/member/viewer)
- effective permission = tenant policy + team role

## SCIM Token Model

1. Token scope
- token belongs to a single tenant
- never crosses tenant boundary

2. Token operations
- create/revoke/list under tenant settings
- hash-at-rest, one-time plaintext reveal, expirations supported

3. Operational controls
- per-tenant token count limit
- rate limit keyed by tenant

## Data Constraints (Target)

1. Every team has `tenant_id` (required after migration)
2. SCIM tables carry `tenant_id` (required after migration)
3. SCIM external mapping uniqueness is tenant-scoped
- unique(`tenant_id`, `external_id`, `resource_type`)
- unique(`tenant_id`, `internal_id`, `resource_type`)

## Migration Strategy (High Level)

1. Phase 1 (Additive)
- add `tenants`, `tenant_members`, nullable `tenant_id` columns
- no breaking behavior change

2. Phase 2 (Backfill)
- initial mapping: 1 current org -> 1 tenant
- populate tenant_id on team/scim records

3. Phase 3 (Application Cutover)
- shift SCIM context from org to tenant
- route/permission checks become tenant-aware

4. Phase 4 (Constraint Tightening)
- make `tenant_id` required
- switch unique/index constraints to tenant-centric forms
- remove transitional compatibility logic

## Non-Goals (This Spec)

- detailed UI design
- final URL naming decision (`org` vs `team` path names)
- billing/plan model

## Open Decisions

1. Group mapping mode default per tenant
- role groups vs team groups

2. SCIM delete semantics
- deactivate-only vs configurable hard-delete

3. User record strategy
- keep globally shared `users` row vs tenant-local shadow user model

