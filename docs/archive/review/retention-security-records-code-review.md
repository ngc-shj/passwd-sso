# Code Review: retention-security-records (SC6)
Date: 2026-06-18
Review rounds: plan (1) + code (1), converged.

## Plan review — 2 findings, fixed pre-implementation
- **F1 (Critical)**: `emergency_access_grants.token_expires_at` is the 7-day INVITATION-acceptance window, NOT a "record is dead" signal — an ACCEPTED/ACTIVATED grant stays live with token_expires_at long past (the post-accept lifecycle never re-checks it). GCing by it would DELETE LIVE grants. Verified by tracing the lifecycle. **Fix**: deferred emergency_access_grants to SC6b (needs a status-aware guard + predicate support in EXPIRY_AUDIT_PROVENANCE, which doesn't exist yet). SC6 ships the 6 tables where expires_at IS a clean death signal.
- **F2 (Medium)**: pinned provenanceColumns to exact @map names (two requester columns on access_requests; invited_by_id; share_type/entry_type).

## Code review — SC6 OK (no findings)
All 10 focus areas verified clean:
- emergency_access_grants correctly EXCLUDED (grep confirms absent) — F1 honored.
- All 6 entries' provenanceColumns are real @map physical columns incl. enum columns; all contain tenant_id.
- DMMF builder change (now includes field.kind === "enum") is a STRENGTHENING — enum columns are real physical columns; relation fields still excluded; the cross-check now validates the enum-column entries that would otherwise have falsely failed.
- auditAction parameterization: 4 SC4 entries got CREDENTIAL_RETENTION_PURGED, 6 SC6 entries SECURITY_RECORD_RETENTION_PURGED; unit test asserts both.
- cutoff = expires_at: for admin_vault_resets/master_key_rotations, the execute paths gate on expires_at > now, so an expired record is non-actionable — GC-after-expiry can't delete an in-flight action; provenance captures approved/executed/revoked markers.
- R14: 6 tables SELECT+DELETE, password_shares→share_access_logs cascade needs no child grant, other 5 leaves, no over-grant.
- R12: SECURITY_RECORD_RETENTION_PURGED all sites + separate enum migration + MAINTENANCE group; coverage tests pass.
- Integration cascade test non-vacuous (asserts both parent share AND its share_access_logs child deleted).
- PII (team_invitations.email) in provenance acceptable — consistent with SC4's lastUsedIp, lands in audit_logs under the row's own tenant, conscious decision.
- Atomic emit-before-delete preserves the forensic record (failed emit rolls back the delete) — correct for these high-value records.

## Verification
- Unit: 98 worker tests (incl. auditAction parameterization both ways). tsc clean for SC6 files.
- Integration (real DB): team_invitations (leaf) + password_shares (cascade child) — expired→provenance-under-own-tenant+delete; non-expired kept; worker-role least-privilege; cascade child removed.
- Full worker suite + audit coverage pass; lint clean; pre-pr.sh 36/36; migrations applied to dev DB, grants verified via information_schema.

## Verdict
Converged. The retention-GC follow-up series is COMPLETE except the SC6b carve-out (emergency_access_grants, deferred for a status-aware guard). All 6 SC6 security-record tables emit forensic provenance to audit before deletion, under least privilege.

## Remaining follow-ups (documented, not in this series)
- **SC6b** (`retention-emergency-access`): emergency_access_grants with a status-aware guard (requires adding predicate support to EXPIRY_AUDIT_PROVENANCE).
- Policy API/UI for the per-tenant retention fields added across SC2/SC3/SC7.
