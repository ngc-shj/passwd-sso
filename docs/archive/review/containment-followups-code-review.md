# Code Review: containment-followups
Date: 2026-11-17
Review round: 1

## Changes from Previous Round
Initial review (Phase 2 commits ecf7a4b85..9c555e316, plus the simplify pass
and the deviation log D1–D10).

## Functionality Findings

### F1 [Major] Audit-log date filters read the date input as UTC
`src/hooks/vault/use-audit-logs.ts` (`buildFilterParams`): `new Date("YYYY-MM-DD")`
is UTC midnight. East of UTC the from-day lost its local morning (JST: 9 h);
west of UTC the `setHours(23, 59, 59, 999)` end landed on the previous local
day, dropping the whole selected to-day. The K9 link builds `from` as a local
calendar date (`toISODateString`), so its window started late. The hook is
shared: the personal and team audit logs had the same defect. The existing
`initialDateFrom` test pinned the UTC behaviour.

### F2 [Minor] An expiry failure aborted the whole retention pass
`purgeRetention` ran `expireInactiveTargetDeliveriesInTx` uncaught, so a
failure there skipped the SENT, FAILED (PII retention), delivery and webhook
delivery purges.

## Security Findings

No Critical or Major. Q1–Q9 of the brief answered with evidence: tenant
binding and permission parity of the actor filter on list and download, foothold
gate coverage (the three `passwordShare.create` sites are the only creators),
live predicates tenant- and creator-bound, the `.fields.<column>` gate
allowance fail-closed, the C6 worker design, the backfill bypass scope, AAD
byte-identity, metadata narrative gate, UI params.

### S-1 [Minor] AUDIT_LOG_DOWNLOAD did not record the actor type, actions or date range applied
The tenant row recorded `actorUserId` / `scope` / `teamId` only; the personal
and team rows recorded `format` only. Two downloads of different coverage wrote
the same row.

### S-2 [Minor] Deactivating a target silently parks its queued deliveries
The C6 design parks, then expires, deliveries queued before the deactivation;
the deactivation row did not say how many, so silencing a destination showed
only as the destination's silence.

## Testing Findings

### T1 [Major] The cursor-tiebreak guard did not see a shorthand `cursor`
A new `findMany({ orderBy: { createdAt }, cursor, skip })` passed the guard
(executed: exit 0). A relation-level cursor was judged by the outer `orderBy`.

### T2 [Major] The `.fields` exemption's narrowness was unpinned (D1)
Dropping the `=== "fields"` name check left all 41 member-set tests green.

### T3 [Minor] The sends/file ordering test did not record the advisory lock
Moving the gate after `advisoryXactLock` left both test trees green; the
app-tree twin had no ordering cell.

### T4 [Minor] The download integration cell was named for the tiebreak it cannot prove (D8)

### T5 [Minor] The two tenant download test trees covered different cases
Only the app tree had the D9 `scope=TENANT&teamId` cell; only `__tests__` had
the `orderBy` pin.

### T6 [Minor][Adjacent] No test of an expiry failure inside purgeRetention (same as F2)

## Adjacent Findings
- T6 → F2 (functionality), merged.

## Quality Warnings
None. Each finding cites file, behaviour and an executed or reproducible check.

## Recurring Issue Check

### Functionality expert
R1–R33, R35–R57: OK or N/A as reported. R34 (pre-existing bug in a changed
file): F1. R41: the link target `/[locale]/admin/tenant/audit-logs` exists and
reads `actor` and `from`. R57: all 11 cursor sites end with `{ id }`.

### Security expert
R1–R33, R35–R48, R50–R57: OK or N/A. R34: S-1. R49: S-2 (deactivation docs
honest, signal weak). RS1 N/A, RS2 N/A, RS3 OK (uuid userId, id schema),
RS4 OK, RS5 N/A, RS6 N/A.

### Testing expert
R1–R46, R48, R50–R57: OK or N/A. R47 / R49: T1, T2. RT1 OK, RT2 OK, RT3 OK,
RT4 OK (overlap cells observe blocking by pid), RT5 OK, RT6 OK, RT7: T1, T2, T3,
RT8 OK, RT9: T5, RT10 OK, RT11 OK.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1. Integration runs are
`verified-local` against `passwd_sso_wt_1069` with MinIO
(`ANCHOR_TEST_S3_ENDPOINT` set to the local MinIO) and the RLS grant evidence
file collected, as CI does.

## Resolution Status

### F1 [Major] Date filters read as UTC — fixed
- Action: `parseLocalDate(value, endOfDay?)` in `src/lib/format/format-datetime.ts`,
  the inverse of `toISODateString` (refuses a malformed value or a day the month
  lacks); the hook sends the instants the local days span; the card validates
  its `from` param with it. Tests pin exact instants under `Asia/Tokyo` and
  `America/New_York`; the hook test's partial `format-datetime` mock now spreads
  `importOriginal`.
- Red-proof: the hook with the old parsing (scratch copy) fails both cells
  (`expected '2026-05-01T00:00:00.000Z' to be '2026-04-30T15:00:00.000Z'`,
  `expected '2026-05-01T03:59:59.999Z' to be '2026-05-02T03:59:59.999Z'`).
- Modified: `src/lib/format/format-datetime.ts`, `src/hooks/vault/use-audit-logs.ts`,
  `src/components/settings/account/tenant-audit-log-card.tsx` and their tests.

### F2 / T6 [Minor] Expiry failure starved retention — fixed
- Action: the expiry tx is caught and logged at error under
  `delivery.expire_inactive_target_failed` (documented in `alerts.md`); the
  purges run. A unit cell makes the expiry throw and asserts all four purges
  ran and the line was logged; against the previous code the rejection
  propagates out of `purgeRetention`.

### S-1 [Minor] Download audit row omitted applied filters — fixed in all three downloads
- Action: `auditDownloadFilterMetadata` in `src/lib/audit/audit-query.ts`
  records `from` / `to` (ISO, as applied), `actions`, `actorType`; a filter not
  applied leaves no key. Personal, team and tenant downloads use it (the tenant
  download records its resolved range). Unit cells for the helper and each
  route; `audit-log-reference.md` row corrected (it described a
  `filterCriteria, rowCount` shape no route writes).

### S-2 [Minor] Parked deliveries invisible at deactivation — fixed
- Action: `pendingDeliveries` (PENDING deliveries of the target, counted in the
  same tx as the toggle) on `AUDIT_DELIVERY_TARGET_DEACTIVATE` from containment
  and from the PATCH route, and on `AUDIT_DELIVERY_TARGET_REACTIVATE` (what the
  reactivation releases). `TENANT_MEMBER_PASSKEY_REVOKE` gains `auditDelivery`
  (read only). Unit cells pin the count's where (tenant, target, PENDING) and
  the 0 case; integration cell 3 seeds two PENDING and one SENT delivery and
  reads `pendingDeliveries: 2` under the real roles.

### T1 [Major] Shorthand cursor escaped the guard — fixed
- Action: the guard reads `ShorthandPropertyAssignment` too, a relation's
  cursor is judged by the relation's own `orderBy`, and a shorthand passed to a
  non-query call is not a site. Fixtures: shorthand deny and allow, the
  blob-store shape (0 sites), relation deny and allow.

### T2 [Major] `.fields` exemption unpinned — fixed
- Action: fixtures (a) another non-method member of a foothold delegate is
  still `alias:` and (b) an ungated create around a field reference is still
  reported. The testing review ran (a) against the G1 mutant: red.

### T3 [Minor] Ordering cell did not record the lock — fixed
- Action: the `__tests__` cell records `lock` through the tx's `$executeRaw`
  and asserts `["gate", "lock", "aggregate"]`; the app tree gains the same
  cell. Red-proof: the route with the gate moved after the lock fails the
  `__tests__` cell.

### T4 [Minor] Cell name overclaimed — fixed
- Action: renamed to what it pins (the actor filter across download batches),
  with a comment naming where the tiebreak is proven (D8).

### T5 [Minor] Test-tree drift — fixed
- Action: the `__tests__` tree gains the D9 cell and an actions/actor-type
  cell; the app tree gains the `orderBy` pin.

### Found during verification: backup-db root-swap cell raced under load (pre-existing) — fixed
- `scripts/__tests__/backup-db.test.mjs` "never publishes into a root replaced
  mid-run" failed once in the full suite (exit 0 seen; 3/3 green alone). Its
  harness swapped the root after a fixed `sleep 1`; on a loaded machine the
  swap could land before the script took its root, so the run legitimately
  succeeded in the new root. `runRootSwap` now takes a `readyPattern` and waits
  (bounded, 15 s) for the script's `[backup-db] dumping` line before swapping;
  the hostile-path caller, whose script prints nothing, keeps the fixed delay.

### Found during verification: extension context-menu cell timed out under load (pre-existing) — fixed
- `extension/src/__tests__/background.test.ts` "a second same-host refresh
  within the cache TTL makes no removeAll (CR2)" failed in the parallel pre-PR
  run (1.8 s; 3/3 green alone): its `vi.waitFor` used the default 1 s bound
  while the debounced refresh chain ran slower under load. The wait is on a
  condition, so its bound is raised to 5 s; the cell's assertions are unchanged.
- The same pre-PR run's test-hygiene gate refused direct `process.env.TZ`
  writes in the F1 tests; they use `vi.stubEnv` (unstubbed by setup.ts).

### Found during verification: options page set state from timers after unmount (pre-existing) — fixed
- The next pre-PR run failed `Extension: Test` with an uncaught
  `ReferenceError: window is not defined` from `extension/src/options/App.tsx`:
  the three 2 s status resets (`setSaved(false)`, `setResetStatus("idle")`)
  were never cleared, so under load one fired after the test environment was
  torn down. The popup's and auth prompt's timers already clean up. The options
  page now keeps the timers in a ref and clears them on unmount; a cell spies
  on `setTimeout` / `clearTimeout` and asserts the pending reset is cleared by
  `unmount()`.
- Considered and left: nine web-app components use the same uncleared
  `setTimeout(() => setX(...))` shape (copy buttons, share/send dialogs, the
  generator). It is not a production defect — React ignores a state update
  after unmount and `window` exists in a browser; the failure above needs a
  torn-down test environment — and none of those files is touched here.
