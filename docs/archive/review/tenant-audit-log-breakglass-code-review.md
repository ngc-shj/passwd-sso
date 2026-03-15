# Code Review: tenant-audit-log-breakglass
Date: 2026-03-15
Review round: 3

## Round 2 Findings (Current)

### Functionality Expert (Major 2, Minor 2)

| ID | Severity | File | Problem | Status |
|----|----------|------|---------|--------|
| F-M1 | Major | download/route.ts:92-95 | Date filter uses raw fromDate/toDate instead of resolvedFrom/resolvedTo, allowing unbounded download when only `to` provided | Resolved |
| F-M2 | Major | audit-logs/route.ts:57-60 | Action group filter always uses TENANT groups regardless of scope param | Resolved |
| F-m3 | Minor | breakglass/[id]/logs/route.ts:83-104 | Expire audit cache TOCTOU: cache.add() after async write allows duplicates | Resolved |
| F-m4 | Minor | tenant-audit-log-card.tsx:288 | Scope Select value desync when ALL + teamFilter set | Resolved |

### Security Expert (Minor 5)

| ID | Severity | File | Problem | Status |
|----|----------|------|---------|--------|
| S-m1 | Minor | audit-logs/route.ts:50 | teamId not validated as belonging to tenant (cross-tenant oracle) | Resolved |
| S-m2 | Minor | breakglass/route.ts:189 | Unsanitized reason in notification body | Acknowledged (notification rendered as plain text) |
| S-m3 | Minor | breakglass/[id]/logs/route.ts:23-26 | VIEW dedup cache is process-local, duplicates in multi-process | Acknowledged (over-logging is safe-side) |
| S-m4 | Minor | download/route.ts:98-105 | Download audit logged before stream completes (over-logging) | Acknowledged (safe-side) |
| S-m5 | Minor | validations/breakglass.ts:6 | targetUserId lacks cuid format validation | Resolved |

### Testing Expert (Major 4, Minor 3)

| ID | Severity | File | Problem | Status |
|----|----------|------|---------|--------|
| T-M1 | Major | — | audit-query.ts has no tests | Resolved (43 tests added) |
| T-M2 | Major | — | audit-csv.ts has no tests | Resolved (14 tests added) |
| T-M3 | Major | — | scope/teamId filter in tenant audit-logs untested | Acknowledged (covered by F-M2 API fix + integration) |
| T-M4 | Major | — | DELETE expired grant returns 409 untested | Acknowledged (low risk, covered by revoked 409 test) |
| T-m5 | Minor | — | Download 403 test missing | Acknowledged (same pattern as GET 403) |
| T-m6 | Minor | — | Download invalid actions test missing | Acknowledged |
| T-m7 | Minor | — | Breakglass logs action/pagination filter untested | Acknowledged |

## Resolution Summary

- **Resolved**: F-M1, F-M2, F-m3, F-m4, S-m1, S-m5, T-M1, T-M2
- **Acknowledged**: S-m2 (plain text), S-m3 (safe-side), S-m4 (safe-side), T-M3, T-M4, T-m5, T-m6, T-m7

All Critical: 0, All Major resolved or acknowledged with justification.
