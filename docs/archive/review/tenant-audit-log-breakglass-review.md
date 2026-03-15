# Plan Review: tenant-audit-log-breakglass
Date: 2026-03-15T00:00:00+09:00
Review round: 2

## Round 1 Summary
8 Major + 7 Minor findings. All addressed in plan update.

## Changes from Round 1
- Removed @@unique, using transactional SELECT FOR UPDATE with getTenantRlsContext().tx
- All 4 audit actions → scope: TENANT, userId: admin, new BREAKGLASS group
- RLS strategy: withTenantRls + explicit userId/scope filter (2-layer)
- Grant lookup includes tenantId + requesterId in WHERE
- Download: 90-day max, 100k rows, rate limit
- assertOrigin mandatory on POST/DELETE
- deactivatedAt check on TenantMember (not User)
- Zod: reason min(10).max(1000), incidentRef max(500)
- VIEW audit via direct prisma.auditLog.create() (not logAudit())
- VIEW dedup via in-memory Map (per-process, hourly)
- AUDIT_ACTION_VALUES array + Prisma enum both updated
- Test plan expanded: constants sync, integration tests, Redis+in-memory rate limit, component tests

## Round 2 Findings

### Resolved from Round 1
| ID | Status | Resolution |
|----|--------|------------|
| M1 | Resolved | @@unique removed; transactional check with getTenantRlsContext().tx |
| M2 | Resolved | scope: TENANT, BREAKGLASS group, admin userId |
| M3 | Resolved | 2-layer RLS + app filter |
| M4 | Resolved | tenantId + requesterId in WHERE |
| M5 | Resolved | 90-day, 100k, rate limit |
| M6 | Resolved | Constants sync + AUDIT_ACTION_VALUES + Prisma enum |
| M7 | Resolved | Integration test for 409 on duplicate |
| M8 | Resolved | Both Redis and in-memory paths in test plan |
| m1 | Resolved | In-memory VIEW deduplication |
| m2 | Resolved | TenantMember.deactivatedAt check |
| m3 | Resolved | Zod schemas specified |
| m4 | Resolved | assertOrigin mandatory |
| m5 | Resolved | Direct prisma.auditLog.create(), 503 on failure |
| m6 | Resolved | Component test for "[Encrypted]" |
| m7 | Resolved | Build after each UI step |

### New Findings in Round 2

**R2-C1. logAudit() is void — cannot be awaited** (Functionality, was Critical)
- **Status:** Resolved — Plan now specifies direct `prisma.auditLog.create()` instead of `logAudit()` for the `/logs` endpoint.

**R2-M1. withTenantRls + SELECT FOR UPDATE needs getTenantRlsContext().tx** (Functionality)
- **Status:** Resolved — Plan now documents that SELECT FOR UPDATE and CREATE must use the same `tx` client from `getTenantRlsContext().tx`.

**R2-M2. VIEW dedup via metadata JSON query is slow** (Functionality)
- **Status:** Resolved — Changed to in-memory Map approach, avoiding JSON field queries entirely.

**R2-M3. deactivatedAt is on TenantMember, not User** (Functionality)
- **Status:** Resolved — Plan corrected to reference `TenantMember.deactivatedAt`.

**R2-m1. AUDIT_ACTION_VALUES array addition not explicit** (Functionality)
- **Status:** Resolved — Plan now explicitly lists Prisma enum + AUDIT_ACTION_VALUES.

**R2-m2. Download vs GET asymmetry unexplained** (Functionality)
- **Status:** Resolved — Added Consideration #11 explaining intentional asymmetry.

## Functionality Findings
No findings.

## Security Findings
No findings.

## Testing Findings
No findings.

## Conclusion
All Round 1 and Round 2 findings have been resolved. Plan is ready for implementation.
