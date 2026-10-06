# Coding Deviation Log: sso-drop-tenant-external-id

## D-1 — Two forbidden-pattern hits are descriptions of the removal (C1/C6)

`tenants.external_id` matches in `scripts/checks/destructive-migration-baseline.txt`
(the baseline entry's reason) and in the new integration case's `describe` title
("tenants.external_id removed (C1 — drop migration)"). Both name the column in
order to say it is gone; neither reads or writes it. The pattern's intent — no
code path touching the column — holds. Kept as is.

## D-2 — Integration fixtures used `externalId` as a lookup handle (side-fix)

Four cases in `tenant-claim.integration.test.ts` under `findOrCreateTenantForClaim
(C4)` used `tenant.externalId` only to find the row they created (concurrency,
nested-insert failure, atomicity, the RT10 allow/deny pair). They now look the row
up by `tenant.name`, which `findOrCreateTenantForClaim` still sets to the raw
claim. The cases' assertions are unchanged.

## D-3 — `NON_PRINTABLE_ASCII_SQL_CLASS` has no runtime consumer

Its only runtime reader was `cmdPreflight`. C5 keeps it as the anchor that pins
the `tenant_claims_claim_normalized` CHECK to `storableClaimSchema` in
`tenant-claim-registry.test.ts`; its JSDoc now says that, and names the CHECK
correctly (`tenant_claims_claim_normalized` — the earlier text named no constraint).

## D-4 — Bucket-conflict test re-anchored on a pair that still exists

`tenant-domain-buckets.test.ts`'s "refuses a reason that two arms give different
buckets" used `claim_taken` / `claim_collision` (both `tenant_claim_unmapped`).
With `claim_collision` gone that pair no longer exists; the fixture now uses
`claim_invalid` / `claim_malformed`, which share `tenant_mismatch` today, so the
throw-on-conflict behaviour is still proven against real members.

## D-5 — `npm run db:migrate` did not return

`prisma migrate dev` applied the migration (column gone, `_prisma_migrations`
row finished) but never exited in this non-interactive shell; it was stopped.
`prisma migrate status` → "Database schema is up to date", and
`check:migration-drift` → consistent.

## D-6 — Plan-review artefact paths

`scripts/lib/tenant-domain-flags.ts` needed no change (no `preflight` flags), as
round-1 Func noted.
