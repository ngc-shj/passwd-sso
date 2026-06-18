# Plan: retention-emergency-access (SC6b)

## Project context
- Service (Next.js + Prisma 7 + PostgreSQL, multi-tenant RLS, least-privilege roles) + retention-GC worker with all SC2-SC7 kinds merged (EXPIRY, EXPIRY_GUARDED w/ GUARD_SQL, EXPIRY_AUDIT_PROVENANCE, PER_TENANT_FN, PER_TENANT_TRASH, PER_TENANT_AGE).

## Objective
GC `emergency_access_grants` — deferred from SC6 because its `token_expires_at` is the 7-day INVITATION-acceptance window, NOT a "record is dead" signal: an ACCEPTED/IDLE/ACTIVATED grant stays live with `token_expires_at` long past (verified: the post-accept lifecycle in `[id]/vault`, `[id]/request`, `[id]/approve` never re-checks token_expires_at; the live window is governed by `wait_expires_at`/`waitDays`). GCing by token_expires_at would delete LIVE grants.

A grant is GC-eligible only when **terminal**: `status IN ('REVOKED','REJECTED')`, OR a **never-accepted expired invite**: `status = 'PENDING' AND token_expires_at < now()`. This is an OR of two conditions — the AND-joined PredicateClause[] cannot express it.

These records carry forensic value (who granted emergency access to whom), so — consistent with SC6 — capture provenance to audit before delete.

## Background facts (verified)
- `emergency_access_grants`: status enum {PENDING, ACCEPTED, IDLE, STALE, REQUESTED, ACTIVATED, REVOKED, REJECTED}; columns tenant_id, owner_id, grantee_id (nullable), status, token_expires_at, wait_expires_at, revoked_at, created_at; RLS-enabled; id PK.
- Cascade child: `emergency_access_key_pairs.grant_id → emergency_access_grants ON DELETE CASCADE` (deleting a dead grant removes its key pairs — intended).
- The SC5 `EXPIRY_GUARDED` kind already has a `GUARD_SQL` map of compile-time-literal SQL fragments keyed by a closed `GuardName` enum (S1-safe). SC6b reuses that mechanism for the provenance path.

## Technical approach
Extend `EXPIRY_AUDIT_PROVENANCE` with an optional `guard` field (the same `GuardName` enum used by EXPIRY_GUARDED). Add a new guard `EMERGENCY_GRANT_DEAD` to GUARD_SQL whose fragment is the OR-condition above. `sweepAuditProvenanceEntry` appends the guard SQL (when present) to its SELECT WHERE, exactly like sweepGuardedExpiryEntry does.

The cutoff for this entry: since the death condition is status-based (not a single timestamp), use `created_at` as the cutoffColumn for a forensic grace (delete dead grants older than... actually the guard already restricts to dead rows; the cutoffColumn still applies as `created_at < now()` which is always true). **Decision**: keep `cutoffColumn: created_at` (the engine requires a cutoffColumn; `created_at < now()` is a tautology that lets the guard be the real filter). The guard is the death predicate; no separate age grace (a REVOKED/REJECTED grant or an expired-unaccepted invite is already dead — no value in keeping it, and its provenance is captured to audit). If a grace is wanted later, tighten the cutoff.

### Guard SQL (compile-time literal in sweep.ts GUARD_SQL)
```
EMERGENCY_GRANT_DEAD: (parent) =>
  `AND (
     ${parent}.status IN ('REVOKED', 'REJECTED')
     OR (${parent}.status = 'PENDING' AND ${parent}.token_expires_at < now())
   )`
```
(parent = entry.table, assertIdentifier-validated. The status literals are compile-time constants in this file — S1-safe, no registry/user data.)

## Contracts

### C1 — guard field on AuditProvenanceEntry + new guard — locked
- Add optional `guard?: GuardName` to `AuditProvenanceEntry` (import GuardName from registry — it's already exported for EXPIRY_GUARDED).
- Add `EMERGENCY_GRANT_DEAD` to the `GuardName` union and to GUARD_SQL (sweep.ts).
- Add 1 EXPIRY_AUDIT_PROVENANCE entry: emergency_access_grants / cutoffColumn created_at / provenanceColumns [tenant_id, owner_id, grantee_id, status, token_expires_at, wait_expires_at, revoked_at, created_at] / auditAction SECURITY_RECORD_RETENTION_PURGED / guard EMERGENCY_GRANT_DEAD / globalDelete true.

### C2 — sweepAuditProvenanceEntry guard application — locked
- When entry.guard is set, append `GUARD_SQL[entry.guard](entry.table)` to the SELECT WHERE (after `cutoffColumn < now()`), mirroring sweepGuardedExpiryEntry. No guard → unchanged (SC4/SC6 entries).
- Invariant: guard SQL is a compile-time literal (GUARD_SQL), never registry data — S1 boundary preserved.

### C3 — validator — locked
- The EXPIRY_AUDIT_PROVENANCE validator branch needs no change for `guard` (it's a closed GuardName enum, compile-time checked, like EXPIRY_GUARDED). Confirm.

### C4 — DB role grant — locked
- Grant `passwd_retention_gc_worker` SELECT, DELETE on `emergency_access_grants`. Cascade child emergency_access_key_pairs needs no grant (RI internal). Verify live DB.

### C5 — tests — locked
- registry.test: count (+1 EXPIRY_AUDIT_PROVENANCE → 11); DMMF covers the new entry's columns (incl. enum `status`).
- Unit: sweep-sql provenance test — assert the guard SQL is appended for the emergency entry (both OR-branches present: status IN (...) and PENDING+token_expires_at).
- Integration (real DB): seed grants in each state:
  - REVOKED (any age) → deleted + provenance emitted
  - REJECTED → deleted
  - PENDING + token_expires_at < now() (expired unaccepted invite) → deleted
  - PENDING + token_expires_at > now() (live pending invite) → KEPT (guard holds)
  - ACCEPTED / ACTIVATED with token_expires_at < now() (LIVE grant past its invite window) → **KEPT** (the critical case — guard must NOT delete it; RT7: removing the guard would delete this live grant)
  - cascade: a deleted grant's emergency_access_key_pairs child removed
  - role-grant positive + cannot-delete-audit_logs negative

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | guard field + EMERGENCY_GRANT_DEAD + entry | locked |
| C2 | sweepAuditProvenanceEntry guard application | locked |
| C3 | validator (no change needed) | locked |
| C4 | DB role grant | locked |
| C5 | tests incl. the live-grant-KEPT critical case | locked |

## Considerations
- **The critical test (RT7)**: ACCEPTED/ACTIVATED grant with token_expires_at in the past must be KEPT. This is the exact bug SC6 deferral avoided. The test must assert this row survives; removing the guard makes it delete-eligible → test goes red.
- **No age grace**: a terminal (REVOKED/REJECTED) grant or expired-unaccepted invite is already dead; provenance is captured to audit, so immediate GC is fine. (A future grace could tighten cutoffColumn.)
- Out of scope: policy field for emergency-grant retention (uses the status guard, not a tenant retention field).

## Scope contract
This completes the retention-GC series for all expiry/security tables. Only the policy API/UI follow-up remains (per-tenant retention fields from SC2/SC3/SC7).
