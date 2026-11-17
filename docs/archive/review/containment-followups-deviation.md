# Coding Deviation Log: containment-followups (#1069)

Deviations from `containment-followups-plan.md` made during Phase 2.

## D1 — `<delegate>.fields` exempt in the foothold member-set test

The shareLinks live predicate compares `viewCount` with `maxViews` through a
Prisma field reference (`tx.passwordShare.fields.maxViews`, C5). The ts-morph
writer scan in `src/__tests__/foothold-member-set.test.ts` read that access as a
delegate use outside the gate. The scan now skips `tx.<model>.fields` only (the
exact property name; the object exposes column references, no method that
writes) and a fixture `tx.scimToken.fields.b` inside a `findMany` pins that the
exemption does not hide the surrounding call.

## D2 — No separate validation test file for the two new containment kinds

`memberContainmentSchema` gained `shareLinkIds` and `auditDeliveryTargetIds`.
The 400-on-unknown-key and max-ids behaviour is covered through the passkeys
route test rather than a new `validations/member-containment.test.ts`.

## D3 — share-links POST gates on the callback tenant

The gate receives the `withUserTenantRls` callback `tenantId`; the create keeps
the entry's `tenantId`. Under RLS the entry is only visible in that tenant, so
the two are equal.

## D4 — Removing `auditDeliveryTarget` from OUTBOX_DELIVERY_EXPIRY fails loudly

The plan's red-proof expected the expiry to leave rows PENDING with the target
table unreadable. The bypass guard instead raises "RLS bypass reached tables
outside its grant: audit_delivery_targets", so the cell fails with an error.
The defect class (a grant too narrow) is still caught; the NOT EXISTS (active)
variant the positive join guards against cannot be reached while the grant is
correct.

## D5 — Outbox test fixtures renumbered

`purgeRetention` opens one more transaction (the expiry runs first), which
shifts the tx-indexed fixtures in `audit-outbox-worker.test.ts` and
`audit-outbox-retention-purge-audit-atomicity.integration.test.ts` by one. The
assertions are unchanged.

## D6 — Stale tenant group table regenerated

`docs/operations/audit-log-reference.md`'s Tenant Scope table lagged the code
(`group:admin` and `group:mcpClient` members, no `group:maintenance` /
`group:auditDeliveryTarget`). The rows were regenerated from
`AUDIT_ACTION_GROUPS_TENANT` alongside the new `group:share` / `group:send`
rows, and the containment kind list gained the two kinds #1070 had left out
(`tenantWebhooks`, `vaultResets`) together with their per-row metadata.

## D7 — `delivery.expired_inactive_target` note in alerts.md

The catch-all `delivery\..*` query in `docs/operations/alerts.md` has no level
filter, so the new info line would match it; the new section says to filter on
level or exclude the `_logType`.

## D8 — Unique tiebreak on every cursor-paginated query (class closed)

The download tiebreak red-proof (drop `{ id: "asc" }`) left the 520-tied-row
integration cell green. The emitted SQL explains it: with `orderBy` on
`createdAt` only, Prisma 7 sends `created_at >= (cursor's)` with no LIMIT and
locates the cursor row in memory, so the page is right only while PostgreSQL
happens to return ties in the same order, and every page reads the rest of the
table. With `[createdAt, id]` it sends a keyset comparison with a LIMIT. The
difference is in the query shape, not reproducibly in the rows, so the route
unit test pinning `orderBy` is the red-proof for the download.

Nine pre-existing cursor queries had the same shape (personal and team audit-log
list and download, notifications, break-glass logs, share-link access logs,
`share-links/mine`, directory-sync logs). All now end `orderBy` with
`{ id: <dir> }`, and `src/__tests__/cursor-pagination-tiebreak.test.ts` (AST,
default-deny) refuses a cursor query whose `orderBy` is not an array literal
ending in `{ id }`, or an object-literal cursor outside a query argument.

## D9 — Download audit row records only the filters applied

C7 recorded `teamId` in the `AUDIT_LOG_DOWNLOAD` metadata whenever the
parameter was present, but `scope=TENANT` drops the team from the query: the
row claimed a team-filtered export of tenant-wide rows.
`appliedTenantAuditFilters(scope, teamId)` in `tenant-audit-filter.ts` now
derives the applied scope and team once; `buildTenantAuditWhere` and the
download metadata both read it. Pinned by a route test with
`scope=TENANT&teamId=…` that fails against the previous metadata.

## D10 — share-departure A7 seeds a session

The share-link POST now takes the foothold write gate, which re-reads the
request's own session row, so A7 (which mocked `auth()` only) answered 401. The
cell seeds a session and sends its cookie through `session-request.ts`, as the
foothold-gate cells do.
