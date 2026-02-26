# Tenant/Team Migration Plan (End-to-End)

## Objective

Migrate from current `Organization`-centric model to:
- `Tenant` = company/account boundary
- `Team` = collaboration unit inside tenant (current Organization behavior)

without service interruption.

## Current State

- Auth is IdP-driven (tenant/company contract boundary in practice)
- App domain is `Organization`-scoped
- SCIM is currently `org`-scoped

## Target State

1. Tenant-scoped identity lifecycle and SCIM token scope
2. Team-scoped collaboration and role assignment
3. Tenant-aware authorization and data constraints
4. Optional PostgreSQL RLS after tenant context is fully stable

## Migration Principles

1. Additive first, destructive later
2. Backfill before behavior switch
3. Dual-read/compatibility during cutover
4. Tighten constraints only after runtime confidence

## Phases

### Phase 0: Design Freeze

Deliverables:
- tenant/team vocabulary and ownership matrix
- SCIM behavior contract (`Users` = tenant lifecycle, `Groups` = team/role mapping)
- rollout/rollback playbook draft

Exit criteria:
- architecture docs approved

### Phase 1: Additive Schema

Deliverables:
- new tables: `tenants`, `tenant_members`
- nullable `tenant_id` on tenant-scoped tables
- additive indexes/FKs only

Reference:
- `tenant-team-migration-phase1.md`
- `tenant-team-phase1-additive.sql`

Exit criteria:
- migration applied in staging/prod without behavior change

### Phase 2: Backfill + Validation

Deliverables:
- backfill script: initial `1 organization -> 1 tenant`
- populate `tenant_id` on organizations/scim tables
- validation SQL (null/orphan/duplicate checks)

Exit criteria:
- 0 null `tenant_id` in backfill scope
- no orphan/duplicate violations

### Phase 3: Application Cutover

Deliverables:
- tenant context resolver in auth/API layer
- SCIM context switched from org-scoped to tenant-scoped
- compatibility layer for existing org-era data paths

Exit criteria:
- tenant-aware read/write paths stable in production
- no elevated 4xx/5xx on SCIM and org/team APIs

### Phase 4: Constraint Tightening

Deliverables:
- make `tenant_id` required where intended
- replace legacy uniqueness with tenant-aware uniqueness
- remove transitional write paths

Exit criteria:
- schema constraints aligned with target model
- compatibility flags removable

### Phase 5: RLS (Optional but Recommended)

Prerequisite:
- tenant context fully reliable in DB session context

Deliverables:
- RLS policies on tenant-scoped tables
- session setting strategy (e.g., `SET app.tenant_id = ...`)
- service-role bypass policy for trusted jobs

Exit criteria:
- RLS enabled in staging then prod
- policy tests and operational runbooks in place

### Phase 6: Cleanup + Terminology Alignment

Deliverables:
- deprecate org-era naming in API/docs/UI where appropriate
- keep DB table rename as optional final step (not required for correctness)

Exit criteria:
- docs and runtime terms aligned (`tenant`/`team`)

## RLS Positioning

RLS should **not** be enabled in Phase 1.

Why:
- before tenant backfill/cutover, RLS risks accidental data denial and operational breakage
- migration safety is higher with additive + app-level tenant guards first

Recommended timing:
- after Phase 4, when tenant IDs and constraints are already stable

## Data Safety and Rollback

Per phase rollback strategy:

1. Phase 1
- additive changes can remain; application behavior unchanged

2. Phase 2
- backfill changes reversible via recorded mapping table/snapshot

3. Phase 3
- feature flag rollback to org-era resolver paths

4. Phase 4+
- perform during low-traffic window with verified backups

## Operational Checklist

1. Pre-flight
- full DB backup
- migration dry-run in staging with production-like snapshot

2. During rollout
- monitor SCIM endpoints (`/Users`, `/Groups`) and auth failures
- monitor constraint violations and transaction retries

3. Post rollout
- run validation SQL pack
- keep compatibility flags for one release window

## Open Decisions

1. Default group mapping mode per tenant
- role-group vs team-group strategy

2. SCIM delete semantics
- deactivate-only vs policy-based hard delete

3. Global user model
- continue shared global `users` or introduce tenant-local shadow layer

