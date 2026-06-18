# Plan: retention-security-records (SC6)

## Project context
- Service (Next.js + Prisma 7 + PostgreSQL, multi-tenant RLS, least-privilege roles) + retention-GC worker (engine + SC5/SC4/SC2/SC3/SC7 merged/in-flight). SC4 added the `EXPIRY_AUDIT_PROVENANCE` kind (capture provenance → audit → delete, atomically).

## Objective
GC the seven security-record tables #571 deferred (SC6): `emergency_access_grants`, `access_requests`, `admin_vault_resets`, `master_key_rotations`, `personal_log_access_grants`, `password_shares`, `team_invitations`. These are records of security actions with forensic value — deleting them on expiry erases incident-investigation evidence. Per the user-confirmed policy (**emit provenance to audit before delete**, same as SC4), each expired record's provenance is recorded in `audit_logs` immediately before deletion, atomically.

## Background facts (verified — corrected per plan review F1/F2)
**Scope narrowed to 6 tables** (was 7). `emergency_access_grants` is DEFERRED to a follow-up (SC6b): its `token_expires_at` is the 7-day *invitation-acceptance window*, NOT a "record is dead" signal — an ACCEPTED/ACTIVATED grant stays live with `token_expires_at` long past (the post-accept lifecycle never re-checks it). GCing by `token_expires_at < now()` would delete LIVE grants. It needs a status-aware guard (`status IN ('REVOKED','REJECTED') OR (status='PENDING' AND token_expires_at < now())`), which EXPIRY_AUDIT_PROVENANCE does not support (no predicate). Deferred to SC6b `retention-emergency-access` (a guarded variant).

The 6 SC6 tables: each has `tenant_id` + `created_at` + `expires_at` as a clean death signal (verified: for all 6, including admin_vault_resets/master_key_rotations, the execute/action paths gate on `expiresAt > now`, so an expired record is non-actionable — GC after expiry cannot delete an in-flight action). Exact physical (@map) provenance columns:

| Table | cutoffColumn | provenanceColumns (exact @map names) |
|-------|--------------|-------------------------------------|
| `access_requests` | `expires_at` | tenant_id, service_account_id, requester_user_id, requester_service_account_id, status, approved_at, created_at |
| `admin_vault_resets` | `expires_at` | tenant_id, target_user_id, approved_at, executed_at, revoked_at, created_at |
| `master_key_rotations` | `expires_at` | tenant_id, target_version, approved_at, executed_at, revoked_at, created_at |
| `personal_log_access_grants` | `expires_at` | tenant_id, requester_id, target_user_id, revoked_at, created_at |
| `password_shares` | `expires_at` | tenant_id, created_by_id, share_type, entry_type, revoked_at, created_at |
| `team_invitations` | `expires_at` | tenant_id, invited_by_id, email, status, created_at |

(`email` on team_invitations is PII in audit metadata — acceptable for forensic provenance, conscious decision. Verify each column's exact @map name against schema during impl.)

## Technical approach
Reuse the SC4 `EXPIRY_AUDIT_PROVENANCE` kind: per batch in one tx, SELECT expired rows + provenance, emit a `SECURITY_RECORD_RETENTION_PURGED` audit per row (under the row's own tenant), then DELETE. Atomic (failed emit rolls back). 7 registry entries.

NOTE: EXPIRY_AUDIT_PROVENANCE currently hardcodes `action: CREDENTIAL_RETENTION_PURGED` in sweepAuditProvenanceEntry. Like SC7 did for PER_TENANT_AGE, parameterize the audit action: add an `auditAction` field to AuditProvenanceEntry (default/SC4 = CREDENTIAL_RETENTION_PURGED; SC6 = SECURITY_RECORD_RETENTION_PURGED). Small contained change.

## Contracts

### C1 — registry kind change + entries — locked
- Add an `auditAction` field to `AuditProvenanceEntry` (`"CREDENTIAL_RETENTION_PURGED" | "SECURITY_RECORD_RETENTION_PURGED"`); set it on the 4 existing SC4 entries (CREDENTIAL_RETENTION_PURGED) and the 7 new SC6 entries (SECURITY_RECORD_RETENTION_PURGED).
- Set `auditAction` on the 4 existing SC4 entries (CREDENTIAL_RETENTION_PURGED) and the 6 new SC6 entries (SECURITY_RECORD_RETENTION_PURGED).
- Add 6 EXPIRY_AUDIT_PROVENANCE entries (the table above; tenant_id required in each). globalDelete: true (all 6 RLS-enabled — verified).
- The validator's EXPIRY_AUDIT_PROVENANCE branch (SC4) already validates table/cutoffColumn/provenanceColumns + globalDelete + tenant_id-required — covers these.

### C2 — sweepAuditProvenanceEntry parameterization — locked
- Change `action: AUDIT_ACTION.CREDENTIAL_RETENTION_PURGED` → `action: AUDIT_ACTION[entry.auditAction]`.

### C3 — audit action — locked
- Add `AUDIT_ACTION.SECURITY_RECORD_RETENTION_PURGED` (const + VALUES + MAINTENANCE group + en/ja + Prisma enum + separate enum migration).

### C4 — DB role grant — locked
- Grant `passwd_retention_gc_worker` `SELECT, DELETE` on the 6 tables. **R6 cascade reach (VERIFIED against live DB)**: only 1 of the 6 has an inbound cascade child:
  - `password_shares` → `share_access_logs` (ON DELETE CASCADE) — deleting an expired share removes its access logs (acceptable; a deleted share's access history has no standalone value — SC7 handles share_access_logs independently for non-deleted shares; the SC7 grant already gives DELETE on share_access_logs, and cascade RI needs no child grant anyway).
  - The other 5 have NO inbound cascade children — clean leaves. No inbound RESTRICT FK that would block a delete.
  Per the SC5/SC2 R14 lesson, cascade-target children need NO child DELETE grant (RI runs internally). The worker needs SELECT (provenance) + DELETE on the 6 parents only.
  - (emergency_access_grants → emergency_access_key_pairs cascade is part of the deferred SC6b.)
  - **Special: password_shares** — SC2 already SetNulls password_shares.password_entry_id when an entry is purged; here we DELETE the share itself. Its child share_access_logs (cascade) goes too — but SC7 also GCs share_access_logs by age. Deleting an expired share cascades its access logs immediately; that's fine (the share is gone, its access history goes with it — OR is the access history wanted independently? Confirm: SC7 keeps share_access_logs per its own retention; SC6 deleting the parent share cascades them early. Decide: acceptable — a deleted share's access logs have no standalone value).

### C5 — tests — locked
- registry.test: count (+6 EXPIRY_AUDIT_PROVENANCE → 10 total); DMMF block auto-covers (table + cutoffColumn + provenanceColumns). The DMMF check enforces F2's exact @map names — a wrong column name fails the test.
- Unit: sweep-sql provenance test already covers the shape; add an assertion that auditAction parameterization emits SECURITY_RECORD_RETENTION_PURGED for an SC6 entry.
- Integration (real DB): 1-2 representative tables (e.g. team_invitations simplest; admin_vault_resets highest-sensitivity) — expired record → provenance in audit_outbox under own tenant + record deleted; non-expired kept; emit-failure rolls back; role-grant positive+negative; cascade child removed (for a table with a cascade child).

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | auditAction field + 7 entries | locked |
| C2 | sweepAuditProvenanceEntry action parameterization | locked |
| C3 | SECURITY_RECORD_RETENTION_PURGED action | locked |
| C4 | DB role grant + cascade-reach enumeration | locked |
| C5 | tests | locked |

## Considerations
- **Cutoff semantics**: using the expiry column means a record past its expiry is GC-eligible. A still-PENDING-but-expired request is dead (its expiry passed) — correct to GC with provenance. A revoked-before-expiry record: its expiry may still be in the future, so it lingers until expiry — acceptable (it's revoked, harmless; GC'd when expiry passes). Document this.
- **Highest-sensitivity tables** (admin_vault_resets, master_key_rotations): the provenance audit (target user/version, approved/executed/revoked markers) is the forensic record that survives. The expiry cutoff for these is typically short (the reset/rotation grant window), so the records GC reasonably soon after the action completes — but the audit trail persists ≥ the tenant's audit retention.
- Out of scope: policy for a configurable security-record retention (uses the record's own expiry as cutoff, not a tenant retention field — simpler; a tenant field could be a follow-up).

## Scope contract
After this PR: SC1(engine)/SC4/SC5/SC2/SC3/SC7 + 6-of-7 SC6 tables complete. Two documented follow-ups remain:
- **SC6b** (`retention-emergency-access`): emergency_access_grants needs a status-aware guard (not bare token_expires_at), which requires adding predicate support to EXPIRY_AUDIT_PROVENANCE. Deferred because token_expires_at is the invite window, not a death signal (would delete live grants).
- Policy API/UI for the per-tenant retention fields added across SC2/SC3/SC7 (the worker + columns exist; UI wiring deferred).
