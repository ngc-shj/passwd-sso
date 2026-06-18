# Code Review: retention-forensic-credentials (SC4)
Date: 2026-06-18
Review rounds: plan (1) + code (1), converged.

## Plan review — 3 findings, all fixed pre-implementation
- **S1 (Critical)**: my plan's premise "api_keys/extension_tokens lack tenant_id" was factually wrong — all 4 tables have NOT NULL tenant_id + FORCE RLS (verified). Corrected: all 4 set globalDelete:true; emit under the row's own tenant_id (not SYSTEM); added an EXPIRY_AUDIT_PROVENANCE validator branch (was missing).
- **S2 (High)**: emit provenance under the row's actual tenant_id so the forensic record lands in the owning tenant's audit log.
- **S3 (Medium)**: wire provenanceColumns into the boot validator + DMMF cross-check test.

## Code review — 3 findings (no security/correctness defect)
- **F2 (trivial)**: stale "FOR UPDATE SKIP LOCKED" text in the test name + 2 doc comments (the impl deliberately dropped FOR UPDATE — see below). Fixed.
- **F1 (low)**: metadata `last_used_user_agent` not length-capped like the dedicated userAgent field (no live risk — source capped on write). Fixed: cap in the metadata copy too (defense-in-depth).
- **F3 (trivial)**: stale plan-doc notes (SYSTEM_TENANT_ID, lack-tenant_id). Fixed.

All core areas verified clean: S1 SQL-injection containment (projection allowlist-validated at boot + sweep; DELETE binds id=ANY($1::uuid[]); only batchSize bound); atomicity (emit+delete one tx, rollback test asserts credential survives); per-row tenant emit; R14 grant (4 tables SELECT+DELETE, no UPDATE); R12 coverage; validator + DMMF test.

## Implementation note: dropped FOR UPDATE SKIP LOCKED
The plan specified `SELECT ... FOR UPDATE SKIP LOCKED` to avoid SELECT→DELETE races. During implementation the integration test revealed Postgres requires **UPDATE privilege** for a FOR UPDATE row lock (the GC role intentionally has only SELECT+DELETE). Granting UPDATE would over-privilege the role. Dropped the lock — verified safe by grep: the app never row-DELETEs these 4 tables (it revokes via `revokedAt` UPDATE), and only already-expired rows are captured, so the id list is stable between SELECT and DELETE. Plan + code comments updated.

## Verification
- Unit: 76 worker tests (incl. provenance SQL-shape pin: projection, no FOR UPDATE, id=ANY bind, per-row tenant emit). `tsc --noEmit` clean (retention-gc).
- Integration (real DB): provenance-emitted-under-own-tenant-then-delete; non-expired untouched; emit-failure-rolls-back-delete (atomicity/RT7); worker-role positive + cannot-delete-audit_logs negative.
- Full suite 11384+ unit tests pass; lint clean; `next build` green; `pre-pr.sh` 36/36; migrations applied to dev DB, grants verified via information_schema.

## Verdict
Converged. The emit-provenance-before-delete design preserves credential forensics (the user's chosen policy) while GC'ing expired credentials, under least privilege. delegation_sessions correctly excluded (SC5 owns it).
