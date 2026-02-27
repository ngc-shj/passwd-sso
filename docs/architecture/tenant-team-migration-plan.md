# Tenant/Team Migration Plan (End-to-End)

## Objective

Migrate from current `Team`-centric model to:
- `Tenant` = company/account boundary
- `Team` = collaboration unit inside tenant (current Team behavior)

without service interruption.

## Current State — ✅ Migration Complete (2026-02-27)

All phases have been implemented and merged to `main` via PR #119.

## Target State — Achieved

1. ✅ Tenant-scoped identity lifecycle and SCIM token scope
2. ✅ Team-scoped collaboration and role assignment
3. ✅ Tenant-aware authorization and data constraints
4. ✅ PostgreSQL FORCE ROW LEVEL SECURITY on all 28 tenant-scoped tables

## Migration Principles

1. Additive first, destructive later
2. Backfill before behavior switch
3. Dual-read/compatibility during cutover
4. Tighten constraints only after runtime confidence

## Phases

### Phase 0: Design Freeze — ✅ Complete

Deliverables:
- ✅ tenant/team vocabulary and ownership matrix
- ✅ SCIM behavior contract (`Users` = tenant lifecycle, `Groups` = team/role mapping)
- ✅ rollout/rollback playbook draft

### Phase 1: Additive Schema — ✅ Complete

Deliverables:
- ✅ new tables: `tenants`, `tenant_members`
- ✅ nullable `tenant_id` on tenant-scoped tables
- ✅ additive indexes/FKs only

Reference:
- `tenant-team-migration-phase1.md`
- `tenant-team-phase1-additive.sql`

### Phase 2: Backfill + Validation — ✅ Complete

Deliverables:
- ✅ backfill script: initial `1 team -> 1 tenant`
- ✅ populate `tenant_id` on teams/scim tables
- ✅ validation SQL (null/orphan/duplicate checks)

### Phase 3: Application Cutover — ✅ Complete

Deliverables:
- ✅ tenant context resolver in auth/API layer
- ✅ SCIM context switched from team-scoped to tenant-scoped
- ✅ compatibility layer for existing team-era data paths

### Phase 4: Constraint Tightening — ✅ Complete

Deliverables:
- ✅ `tenant_id` required where intended
- ✅ tenant-aware uniqueness constraints
- ✅ transitional write paths removed

### Phase 5: RLS — ✅ Complete (FORCE RLS)

Deliverables:
- ✅ FORCE ROW LEVEL SECURITY on all 28 tenant-scoped tables
- ✅ session setting strategy (`SET LOCAL app.tenant_id = ...`)
- ✅ service-role bypass via `withBypassRls` (CI guard allowlist)
- ✅ CI guard scripts (`check-bypass-rls.mjs`, `check-team-auth-rls.mjs`)

### Phase 6: Cleanup + Terminology Alignment — ✅ Complete

Deliverables:
- ✅ org-to-team rename across DB schema, API routes, UI, i18n, tests
- ✅ DB table mapping updated (organizations → teams)
- ✅ docs and runtime terms aligned (`tenant`/`team`)

### Phase 7-9: Security Hardening — ✅ Complete (PR #119)

Additional deliverables beyond original plan:
- ✅ `externalId` column for IdP claim isolation (prevents tenant ID spoofing)
- ✅ `isBootstrap` flag replacing fragile slug-prefix detection
- ✅ Full C0/C1/DEL control character sanitization on tenant claims
- ✅ Reserved slug prefix collision prevention
- ✅ P2002 slug collision retry with random suffix fallback
- ✅ Bootstrap migration covers all 15 tenant-scoped tables

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
- feature flag rollback to team-era resolver paths

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

