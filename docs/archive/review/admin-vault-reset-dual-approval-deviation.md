# Coding Deviation Log: admin-vault-reset-dual-approval

## Minor additive deviations from the plan

### D1 — GET history response shape adds `id` to nested user objects
- Files: `src/app/api/tenant/members/[userId]/reset-vault/route.ts` (GET handler), `src/components/settings/security/tenant-reset-history-dialog.tsx`
- Plan §"Schema for status response" lists `initiatedBy: { name, email }` and `approvedBy: { name, email } | null` (no `id`).
- Implementation also returns `id` on both nested objects so the history dialog can compare against `currentUser.id` for FR10/R26 (Approve button visibility / disabled-cue rule).
- Forward-compatible additive change. No security implication (member ids are already visible to admins via existing `/api/tenant/members` listings).

### D2 — Approve audit metadata adds `newExpiresAt`
- File: `src/app/api/tenant/members/[userId]/reset-vault/[resetId]/approve/route.ts`
- Plan §"Approve endpoint" step 10 specifies metadata `{ resetId, initiatedById, targetUserId }`.
- Implementation also adds `newExpiresAt: ISO-string` so audit readers can reconstruct the post-approval expiry without a follow-up DB read.
- Additive; no PII; helps incident-response timelines.

### D3 — `notification-messages.test.ts` exhaustive coverage scoped to "types with localized messages"
- File: `src/lib/notification/notification-messages.test.ts`
- Plan T8 directs the test to "iterate `NOTIFICATION_TYPE_VALUES`".
- Implementation iterates a hardcoded `KEYS` array of the 6 types that have entries in `notification-messages.ts` (the other 6 NOTIFICATION_TYPE values are async-only / not surfaced through this function).
- Trade-off: a future NOTIFICATION_TYPE addition that lacks a message entry will not be caught here; it will surface at runtime (no message rendered). Acceptable as Minor — added entry for `ADMIN_VAULT_RESET_PENDING_APPROVAL` is correctly covered.
- Anti-Deferral: Worst case = developer adds NOTIFICATION_TYPE without message; surfaces in dev manual smoke test. Likelihood = low (notification work always touches both files). Cost-to-fix later = 5 min.

## No structural deviations

Schema, migration, endpoint logic, CAS guards, encryption, session invalidation, UI behavior, manual test artifact, and integration tests all match the plan exactly. Round-3 review revisions (S10 AAD invariant, S11/S17 backfill, S14/S16 oracle, F24/T13 propagation gap) are all reflected in the implementation.
