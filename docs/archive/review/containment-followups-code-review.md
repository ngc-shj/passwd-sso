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

---

# Round 2 (fixes 9c555e316..06ab97a84)

## Changes from Previous Round
Round-1 findings F1, F2, S-1, S-2, T1–T4 resolved (verified by execution:
mutants of each fix go red). T5 continuing (new drift from the S-1 fix);
backup-db harness continuing. New findings below.

## Functionality Findings
- N-1 [Minor] An exact 90-day range across a DST fall-back day exceeds the
  server's instant check now that the client sends local days.
- N-2 [Minor] `parseLocalDate` mapped years 0–99 to 1900–1999 and refused
  5+-digit years, so a value a date input can emit dropped the filter.
- N-3 [Minor, pre-existing] The service-account token expiry and the entry
  expiration read the date input as a UTC day.
- A-1 [Minor][Adjacent] The backup-db harness swapped even when the ready line
  never appeared (same as Q5).

## Security Findings
S-1, S-2 resolved; no boundary widened (`TENANT_MEMBER_PASSKEY_REVOKE` has one
caller; its only `auditDelivery` access is the tenant-bound `groupBy`).
- S-R2-1 [Minor] A downloader could pad `actions` with repeats past
  METADATA_MAX_BYTES, so truncation replaced every recorded filter
  (`from`/`to`/`actorUserId`/`scope`/`teamId`) with a marker.

## Testing Findings
- Q1 [Minor] The cursor guard missed a non-literal cursor in a page object
  spread into a query.
- Q2 [Minor] The tenant download row's `to` was matched by `expect.any(String)`.
- Q3 [Minor] T5 continuing: the tenant actions/actor-type cell existed in one tree.
- Q4 [Minor] The PATCH `pendingDeliveries` "same tx" claim was unpinned (the tx
  mock was the client mock).
- Q5 [Major] The root-swap cell passed vacuously when the script exited before
  its dumps (no `ready` assertion).
- Q6 [Major] The root-swap cell ran under the 10 s default timeout while its
  harness bounds are 15 s / 20 s.

## Recurring Issue Check
Round-2 experts re-checked the touched rules: R43 (no widening), R44, R49, R57,
RT7, RT9 as above; others unchanged from round 1.

## Resolution Status (round 2)

### N-1 — fixed
`AUDIT_LOG_MAX_RANGE_MS` (`src/lib/validations/common.server.ts`) = 90 days +
1 hour, used by the personal, team and tenant download range checks. Boundary:
exactly 90 days + 1 hour is accepted, 1 ms more is 400 — a cell in each route
test; on the previous bound the accepted case is 400.

### N-2 — fixed
`parseLocalDate` takes four or more year digits and builds the day with
`setFullYear` (years below 100 kept), refusing a NaN date. Cells for year 50
and 12345.

### N-3 — left, with reason (text corrected in round 3, F-R3-2)
Both are UTC-day encodings outside this change, each consistent with itself:
- Entry expiration is the plaintext `password_entries.expires_at` column,
  written as `<day>T23:59:59.999Z` and read back as a date (`slice(0, 10)` /
  `split("T")[0]`) against the local today; nothing compares it as an instant.
  A local end-of-day instant would change that encoding, and its UTC date would
  read as the next day west of UTC.
- The service-account token expiry is UTC end of the chosen day; the choice is
  a code comment, not shown to the user, and the expiry renders in local time
  (a JST user picking day D sees D+1 08:59). Changing either encoding is a
  decision for those features, not part of the audit-log filter fix.
- The token input had a `min` but no `max`, so a day past the server's
  lifetime bound answered 400; fixed in round 3: `max` is the last UTC day whose
  23:59:59Z is within MAX_SA_TOKEN_EXPIRY_DAYS (cell pins min and max at a fixed
  time).

### S-R2-1 — fixed
`parseActionsCsvParam` deduplicates (first-seen order); the download row lists
at most 50 actions and counts the rest in `actionsOmitted`. Cells: parser
dedupe, the helper's cap (53 → 50 + 3) and allow side (50 unchanged), and a
tenant route cell with 600 repeats recording one action and every other filter.

### Q1 — fixed
A `cursor` in an object literal bound to a variable is refused (spread the
page inline). Fixtures: shorthand and identifier-valued page objects.

### Q2 / Q3 — fixed
Exact-range cells in both tenant trees (`from` and `to` as ISO), plus the
actions/actor-type cell mirrored into the app tree.

### Q4 — fixed
The PATCH test's tx carries its own `auditDelivery.count` spy; the client-level
spy must not be called.

### Q5 / A-1 / Q6 — fixed
`runRootSwap` returns `ready` and the cell asserts it (an early-exiting script
is now red, verified by the testing review against this edit); the cell has a
30 s timeout, above the harness's 15 s ready deadline and 20 s kill timer.

### Found during round-2 verification: extension autofill cells asserted after a fixed sleep (pre-existing) — fixed
`extension/src/__tests__/content/autofill-react.test.tsx` failed once in the
parallel pre-PR run (`expected '' to be '4567890'`, 2.3 s): two cells asserted
values written from their own tasks after a fixed 50 ms `settle()`. They now
`vi.waitFor` the values; the cell asserting a value stays empty keeps its
window.


---

# Round 3 (fixes 06ab97a84..10160d9b3)

## Changes from Previous Round
N-1, N-2, S-R2-1, Q1–Q6 resolved; security: no findings; testing: confirmed
by mutation (round-3 testing review). New:

## Functionality Findings
- F-R3-1 [Minor] `parseLocalDate` dropped `to` on America/Nuuk's spring-forward
  Saturday (23:59 falls in the 23:00 gap); the 1 h slack is below
  Antarctica/Troll's 2 h shift.
- F-R3-2 [Minor] The N-3 rationale misstated the entry expiration's storage
  and the shift direction, and called the SA UTC choice user-visible.
- F-R3-3 [Major, pre-existing] A to-only download defaulted `from` to now − 90
  days: `to` = today 400'd as over-range, an old `to` 400'd as reversed, and
  the personal/team query ignored the validated window.

## Resolution Status (round 3)

### F-R3-1 — fixed
End of day is the instant before the next local day starts; the day's
existence is validated on its start. `AUDIT_LOG_MAX_RANGE_MS` slack is 2 h (the
largest tzdata shift). Cells: Nuuk 2026-03-28 ends 2026-03-29T00:59:59.999Z
(the previous code returned undefined); the three route boundary pairs moved to
90 days + 2 h.

### F-R3-2 — fixed
N-3 text corrected (above), and the token input's missing `max` fixed.

### F-R3-3 — fixed
`resolveDownloadRange(from, to)` in `src/lib/audit/audit-query.ts` is the one
range rule for the three downloads: a missing `from` is the 90 days ending at
`to` (or now), a missing `to` is now, and the resolved `{ gte, lte }` is both
the query window and what the audit row records. Personal downloads with
neither bound stay unbounded (by `AUDIT_LOG_MAX_ROWS`), as before. Cells:
resolver unit cases (to-only today and long ago, from-only, invalid, reversed,
over-range) and personal / team route cells for an old to-only download (the
previous code answered 400).

## Testing Findings (round 3)
Q2–Q4, S-R2-1 cells, N-1 constant cells and the autofill waits confirmed by
mutation. New:
- R3-Q1 [Minor] The cursor guard closed only the `const x = { cursor }` form;
  conditional, parenthesised, `as const`, assignment and helper-return page
  objects still passed.
- R3-Q2 [Major] The root-swap cell passed when the script failed right after
  its ready line, before the swap.
- R3-Q3 [Minor] `parseLocalDate`'s end-of-day path for years below 100 and its
  out-of-range refusal were unpinned.
- R3-Q4 [Minor] Tenant test-tree drift (padded-repeats and boundary cells).
- R3-Q5 [Minor] The "DST fall-back" boundary cells used UTC instants; the
  client-to-server span was unpinned.
- R3-Q6 [Minor] The 50-action cap was not tied to METADATA_MAX_BYTES.

### R3-Q1 — fixed
The guard also checks where a query consumes its arguments: a
`findMany`/`findFirst` argument must be an object literal and every top-level
spread a literal or a conditional of literals (the real tree has none other).
One refused fixture per variant, plus the literal-conditional allow case.

### R3-Q2 — fixed
`runRootSwap` returns `aliveAtSwap` (the run had not exited when the root
moved) and the cell asserts it; a positive control runs the same slow-dump
setup unswapped and must publish exactly one generation. Red-proof with
`BACKUP_DB_SCRIPT=<copy exiting right after "dumping">`: both cells fail
("the swap must land while the script runs"; control status 7).

### R3-Q3 — fixed
Cells for `parseLocalDate("0050-03-01", true)` and a year past the Date range
(`300000-01-01`, both paths).

### R3-Q4 / R3-Q5 — fixed
Padded-repeats, 90 days + 2 h boundary and a New York client-span cell in both
tenant trees; the boundary cells are named for what they pin (the constant).
The client-span cell sends `parseLocalDate("2026-08-05")` ..
`parseLocalDate("2026-11-02", true)` under `TZ=America/New_York` (90 local
days = 90 × 24 h + 1 h − 1 ms): 200; one day earlier: 400.

### R3-Q6 — fixed
A cell serialises the worst-case row (the 50 longest actions plus every other
filter) and asserts it fits METADATA_MAX_BYTES.
