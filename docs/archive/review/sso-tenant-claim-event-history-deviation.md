# Coding Deviation Log: sso-tenant-claim-event-history

Phase 2 implementation of `docs/archive/review/sso-tenant-claim-event-history-plan.md`
(revision 4). Entries are deviations from the locked contract, and decisions the plan
deliberately left to implementation where the choice turned out to matter.

---

## D-1 — The escape GUC is `app.allow_claim_event_purge`, and it lifts DELETE only

**Plan (C1)**: `app.allow_claim_event_mutation`, gating the `BEFORE UPDATE OR DELETE`
trigger.

**Implemented**: `app.allow_claim_event_purge`, and the trigger consults it **only on
`DELETE`**. `UPDATE` and `TRUNCATE` raise unconditionally.

**Why**: the only sanctioned mutation is the purge routine, and it deletes. A GUC that
also lifts `UPDATE` would grant a capability nothing needs — and an in-place `UPDATE` of
a history row is the one edit that leaves no trace at all, since the row count does not
change. The name follows the narrowed meaning. Verified live: `proconfig` on the routine
is `['app.allow_claim_event_purge=on']`.

## D-2 — `created_at` is trigger-assigned, not a column DEFAULT

**Plan (C1)**: `created_at` uses `clock_timestamp()`; the trigger assigns the three
principal columns.

**Implemented**: the `BEFORE INSERT` trigger assigns `created_at := clock_timestamp()`
alongside them, and the column has no DDL `DEFAULT`.

**Why**: a `DEFAULT` is overridable by any INSERT that names the column, so a
caller-supplied timestamp would be stored — the same forgeability the plan closes for
`db_user`. The forensic timestamp deserves the same treatment as the forensic principal.
It also removes the `@default(dbgenerated(...))` question from the Prisma model, so
`check-migration-drift` has nothing to disagree about (verified: drift gate exits 0
against the applied migration).

## D-3 — Three forbidden-pattern literals were reworded out of my own comments

The plan declares `app\.bypass_rls` and `SECURITY DEFINER` forbidden in the new
migration, and `RETURNING` forbidden in the producer module — and my first drafts of
both files explained, in comments, *why those things are absent*. The greps fired on the
explanations.

Rewritten so the literals do not appear ("the one `withBypassRls()` sets", "definer
rights"), and the `RETURNING` check in C5's gate was made AST-scoped to string/template
nodes rather than full-text.

**Why it is worth an entry**: a forbidden pattern that reds on its own rationale gets
deleted rather than obeyed, and the rationale is the part a future reader needs most.
The alternative — dropping the comments — would have traded the explanation for the
check. Neither the check nor the reason was given up.

## D-4 — `check-destructive-migration.mjs`'s `TRUNCATE` matcher was narrowed, rather than baselining this migration

**Not anticipated by the plan's gate survey**, which recorded this gate as firing on
"no `DROP` of any object type". It also matches a bare `TRUNCATE` token, and C1's
`CREATE TRIGGER … BEFORE TRUNCATE` — the statement that *forbids* truncation — tripped it.

**Implemented**: the matcher now excludes a `TRUNCATE` preceded by `BEFORE`, `AFTER` or
`OR`, in the same shape as the gate's existing `NON_DESTRUCTIVE_AFTER_DROP` exclusion
set. Fail-closed is preserved: in PostgreSQL's grammar no truncation *statement* can
follow any of those three tokens, so the exclusion cannot admit one.

**Why not the baseline file, which is what the gate's own message prescribes**: every
entry there is annotated "predates the expand-and-contract rule", and this migration is
not destructive at all — a baseline entry would record "destructive but safe" about DDL
whose entire purpose is preventing destruction. That is suppression, not a fix, and it
would sit permanently in a security-relevant file as a false statement.

**Red-proof**: the gate reported `DESTRUCTIVE_MIGRATION` for this migration before the
change and `OK` after; three new self-test cases (`T1b`, one per lead-in token) cover the
allow side, and the pre-existing `TRUNCATE TABLE` deny case still fails as it must —
which is what proves the narrowing opened no hole. Self-test 29 → 32 cases.

## D-5 — The C5 gate's self-test writes fixtures into a temp root rather than committing them

**Plan (C5)**: "Committed fixtures, each red-proved."

**Implemented**: `scripts/__tests__/check-tenant-claim-event-coverage.test.mjs` builds
each fixture tree with `mkdtempSync` and points the gate at it with the scan-root
override — the shape `check-critical-audit-atomic.test.mjs` already uses.

**Why**: committed fixture directories are the `check-env-docs` pattern, not this gate's
sibling's, and inventing a second convention for a new gate is the twin-drift shape the
plan warns about elsewhere. Temp roots also avoid a per-run collision on the shared dev
database's working copies. Every case the plan enumerates is present, including the
two-file case and the empty-scan-root case; the derived inputs still resolve from the
real repo root, so the fixtures exercise the real derivation.

## D-6 — `audit-db-grants.mjs --write` re-serialises an unrelated comment line

**Observed**: regenerating `db-grants-manifest.json` rewrote the file's `_comment` field,
converting its `—` escapes to literal em-dashes — a ~2 KB diff line with no
security content, alongside the one line that has all of it.

**Implemented**: the comment was restored to its committed form, leaving the diff at
exactly `+ "TABLE:passwd_app\tpublic.tenant_claim_events\tINSERT"`.

**Why it matters and is recorded rather than shrugged at**: the manifest's own header
says "review the diff — it is the security-relevant part of that migration". A tool that
is not diff-stable makes that review harder every time it runs, and the noise is exactly
where a second, unintended grant change would hide. The tool's non-diff-stability is a
pre-existing property, not something this PR introduced; recorded so it is visible.

## D-7 — Empirical verification of the applied migration, recorded because the plan's criteria are about what the database actually does

Read-only verification against the dev database after `npm run db:migrate`, with the
user's explicit confirmation:

- existing data intact (284 tenants, 488 users, 2 `tenant_claims`) — no reset occurred;
- `tgenabled = 'A'` on **all three** triggers (the plan's C1 criterion, and the property
  a `session_replication_role` regression leaves trigger *existence* intact);
- `passwd_app`: `INSERT` true; `SELECT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`,
  `TRIGGER` all false;
- `passwd_outbox_worker` / `passwd_retention_gc_worker`: nothing;
- purge routine `prosecdef = false` (invoker rights) with
  `proconfig = ['app.allow_claim_event_purge=on']` — the function-level `SET` is really
  there, which is the round-2 G2 remedy;
- `PUBLIC` holds `EXECUTE` on none of the three new routines — the premise the
  `SECURITY INVOKER` decision rested on, confirmed rather than assumed;
- no `tenant_id` column, RLS not enabled, zero policies — the manifest exemption holding
  by construction.

`node scripts/audit-db-grants.mjs` then reports `OK (389 grants match the manifest)`.
Its exit status was read **unpiped**: an earlier run through `tail` showed `exit=0` for
a gate that had actually failed (R44 — the pipe's tail status masks the gate's own).

---

# Step 2-5 self-R-check round

The three-expert self-check returned 9 Majors against the implementation, **eight of
them against the gate and the tests rather than against the shipped behaviour**. The
entries below are the ones that changed a contract or a shared file.

## D-8 — The gate shipped without the `sec-F6` guard its own contract mandates

C5 says the gate "adopts `check-gate-selftest-coverage.sh`'s `sec-F6` guard against an
override leaking into a real CI run". It did not. **Why the omission mattered more than
it looks**: the empty-scan and zero-writer floors close only the *empty* leak. An
override pointing at any tree containing one compliant writer — which is exactly what
this gate's own self-test fixture is — yields a non-zero file count, a non-zero writer
count, zero violations and a green OK, while the shipping tree is never read. Added,
with a self-test case on each side (refuses under `CI=true` without the acknowledgement;
allows with it). Both arms of the guard's condition are covered; no case in that file
runs the gate without a scan-root override, so CI's real shape (no override) remains
unexercised by this self-test.

## D-9 — `tenant.upsert` was a blind spot in a control declared fail-closed

`WRITE_VERBS` included `upsert`, but the nested-relation detector looked only under
`data:`. `upsert` splits the same payload across `create:` and `update:`, so
`tenant.upsert({ where, create: { …, claims: { create … } } })` registered no writer and
its enclosing function was never required to emit an event. No live member exercises
that shape, which is precisely why it needed a fixture rather than a comment. Carrier
list widened to `data | create | update`; deny fixture added.

## D-10 — The gate is now actually the runner for C1's forbidden patterns

C1 declares three forbidden patterns for the migration "runner: C5's gate, reading the
migration file (a forbidden pattern with no runner is the shape D-13 recorded one PR
ago)" — and the shipped gate read only `schema.prisma` and the producer module. The
patterns were therefore exactly the thing the contract said they must not be.

Implemented, with two design points worth recording:
- the migration is located by **content** (`CREATE TABLE tenant_claim_events`), not by a
  spelled timestamped directory name, which is the kind of literal that goes stale
  silently;
- finding **no** such migration is `exit 2`, not a pass. "Looked at nothing" and "found
  nothing wrong" are different answers, and this gate now says so in three places.
- the migration is a **subject**, not a derived identifier, so it follows the scan-root
  override while the relation field and operation set stay pinned to the repo root. That
  distinction is what makes the runner red-provable from the self-test at all; a runner
  the self-test cannot red is the shape RT7 exists to catch.

## D-11 — The producer's docstring credited the gate with a guarantee it does not give

The docstring said the in-transaction requirement is held by "every production caller
passes a `tx`, plus the completeness gate". The gate had no predicate on argument 0 —
it proves an event is emitted in the same function, which is necessary and not
sufficient, so `recordTenantClaimEvent(prisma, …)` inside a `withBypassRls` callback
passed every predicate while losing exactly the atomicity the table exists for.

Both halves fixed rather than one: the wording now claims only what is proven, **and**
the gate gained a tripwire on the direct spelling `prisma` as the first argument — with
its limit enumerated in place (without a Program it matches an identifier, so an aliased
binding passes). A tripwire with a stated limit is worth more than a docstring with an
overstatement.

## D-12 — The deletion-retention matrix's section prose was false for this table

`npm run generate:security-matrices` places every non-GC'd model under a heading whose
prose reads "deleted only via explicit application code … or as an `ON DELETE CASCADE`
side effect of a parent-row deletion". **Both disjuncts are false here by construction**:
there is no foreign key, and `passwd_app` holds no `DELETE`. A reader would conclude the
rows disappear with their tenant — precisely what the append-only design guarantees they
do not.

Corrected in the generator (the prose is generated, not hand-edited), keeping the
invariant the section actually exists for — the retention-GC sweep never touches these
tables — and replacing the false disjunction with the three real deletion paths, naming
the owner-only routine as the third.

---

# Phase 3 review round 1

Functionality: 2 Majors (both red-proved by the reviewer on a throwaway tree) + 2 Minors.
Security: **no Critical, no Major**, 7 Minors — after attacking the two-layer claim,
attribution forgery, injection, the fail-closed sign-in path and the GUC scoping.
Testing: 6 Majors + 5 Minors.

## D-13 — The gate's nested-write detector had a verb list; it now has none

`nestsClaimWrite` matched only the creation verbs (`create|createMany|connectOrCreate`),
so `claims: { connect: { id } }` inside `tenant.update` — which rewrites
`tenant_claims.tenant_id`, i.e. a reassignment, i.e. the operation this table exists to
record — registered no writer at all. Same for `updateMany`, `disconnect`, `set`,
`delete`, `deleteMany`.

Fixed by **removing** the verb list rather than extending it: the carriers consulted
(`data:`, `create:`, `update:`) are write payloads by construction, so the relation field
appearing under any of them is a write. `where:` / `select:` / `include:` are not
consulted, which is what keeps a read from counting. A fail-closed gate cannot be one
release behind its ORM's verb set, and D-9 had already widened the carrier list once
while leaving the verbs — the second half of the same defect.

## D-14 — Predicate (1) counts DISTINCT operations, not calls

The shipped form compared call counts, which the reviewer red-proved green on: one arm
emitting two events and another emitting none. The arms are mutually exclusive, so two
events of one operation can never stand in for a second arm's.

Now: distinct operations named by producer calls >= effective writers. This is the
closest code-derivable form of the contract's per-`(function, operation)` set equality —
the operation a given arm *can* produce is not derivable generically, but a function with
N mutually exclusive writers must name N distinct operations. **Limit enumerated in the
gate**: a function legitimately emitting N events of the SAME operation for N writers
would false-deny; no such site exists, and the remedy would be to split the function
rather than loosen this back to a count.

## D-15 — The forbidden-pattern runner checked a file that is immutable after merge

D-10 gave C1's patterns a runner, and the runner selected its subject with
`CREATE TABLE tenant_claim_events` — which matches exactly one migration, the one nobody
can change once merged. A later `ALTER TABLE … ADD CONSTRAINT … REFERENCES tenants` —
**the single change that destroys this table's purpose**, since I4's authority is the
*absence* of FKs — lives in a file the runner never opened. Same for a later
`CREATE OR REPLACE FUNCTION … SECURITY DEFINER`.

The subject set is now derived rather than anchored: any migration whose text names the
table. The `CREATE TABLE` match survives only as the trigger for the "no subject" floor,
so an empty result still exits 2. Red-proved with a second-migration fixture.

This is R42 applied to a gate's *subject* set rather than to the code's member set — and
it is the same accretion signature the rule warns about: the subject was chosen from the
one file in front of me at the time.

## D-16 — `TRUNCATE` was being fired at the real shared table in autocommit

The no-truncate red-proof ran `TRUNCATE tenant_claim_events` as the owner, outside any
transaction. The assertion is correct only while the trigger works — and the moment it
does not, which is the *only* state the test exists to detect, the statement wipes every
row of the routing history on the shared dev database, irreversibly, for every other
working copy.

Now inside `BEGIN … ROLLBACK` on one connection. `TRUNCATE` is transactional in
PostgreSQL, so nothing about the assertion changes and the blast radius is zero. NF3's
"never by mutating the shared dev database" applies to the statement a red-proof *fires*,
not only to the setup around it — the trigger-drop proof honoured that rule and this one
did not.

## D-17 — SEC-2 (routine EXECUTE ACL) accepted, on a reason the round itself created

The three new routines' EXECUTE ACL rests on migration `20260725140000`'s unscoped
`ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, whose binding is
per-creating-role, and no *prescriptive* control covers function EXECUTE
(`app-role-denied-privileges.json` is table-scoped; `audit-db-grants.mjs`'s `FUNCTION:`
family is descriptive and launderable by `--write`).

**Correction after round 2 (security R2-3): the acceptance stands, but it was
priced against the wrong control.** The out-of-migration case — a definer
conversion or a grant applied by hand, by a bootstrap change, or by an initdb
script — is outside a gate that reads migration *files*. What actually closes it
is `scripts/rls-cross-tenant-verify.sql`'s `[E-RLS-SECDEF]` ASSERT: it reads
`pg_proc.prosecdef` from the **live catalogue**, fails on any `SECURITY DEFINER`
routine in `public` outside a two-name allowlist, and is wired into both CI
(`ci.yml`) and `pre-pr.sh`. Verified by reading it rather than by citing it from
memory. The three new routines are `prosecdef = false` and pass it today. It is
now cited in the migration itself, because the natural move when someone does
convert the routine — adding it to that allowlist — would remove the real
closure without anyone knowing it was load-bearing here.

**Accepted rather than fixed, and the reason is the gates, not cost**: the exploit shape the
finding names is a future `SECURITY DEFINER` conversion, and D-15's widened subject set
now fails the gate on `SECURITY DEFINER` appearing in **any** migration that names this
table — which is where such a conversion would have to live. With invoker rights and no
`DELETE` for any non-owner role, an EXECUTE grant on its own confers nothing.
**Worst case**: a future migration grants EXECUTE to an audited role, which produces a
`FUNCTION:` line and an `UNEXPECTED_GRANT` at the next deploy-time audit. **Likelihood**:
requires a deliberate grant nothing needs. **Cost to fix later**: extending the
denied-privileges schema to function EXECUTE — a change to a shared security control read
by two consumers and the runtime image, which is its own piece of work and does not
belong in a claim-history PR.

## D-18 — Minors folded in

`--by` now reserves `signin` (SEC-6) — the one label a `history` reader treats as
engine-written, rejected at ingest because storage keeps what was typed and I1 makes the
row uncorrectable afterwards. The generated retention matrix says "only **sanctioned**
deletion path" (SEC-3), matching `audit-log-schema.md` and the DDL rather than
overstating what the trigger binds. `cmdHistory` refuses `--domain` and `--tenant`
together and uses one predicate for the guard and the selector choice (F3) — previously
`--domain ""` alongside a `--tenant` silently discarded the tenant. The post-write line
no longer says "see history above" when what is above is a command suggestion (F4). The
throwaway LOGIN role carries `VALID UNTIL` (SEC-7), which is the bound that survives its
`finally` not running. `client_addr`'s absence from `history` output, and the owner
recovery for rows an app-role compromise injects with unreachable tenant ids, are now
stated in `audit-log-schema.md` (SEC-4, SEC-5).

---

# Post-merge hardening pass — external review, 2026-07-31

Four findings against the merged design, closed in one migration,
`prisma/migrations/20260731170000_tenant_claim_events_hardening/`, on branch
`feat/tenant-claim-event-history`. The hard rule this pass added for itself: no
existing, already-applied migration is edited — `20260729110000_add_tenant_claims`
and `20260731100000_add_tenant_claim_events` are both untouched. Everything below is
new DDL layered on top.

## D-19 — passwd_app's UPDATE/DELETE on `tenant_claims` was never used and never revoked (HIGH)

`20260729110000_add_tenant_claims` granted `SELECT, INSERT, UPDATE, DELETE` to
`passwd_app` by following the convention every other new-table migration in this repo
uses, without checking this table's actual write surface first. It has exactly one:
`findOrCreateTenantForClaim`'s nested `claims: { create: … }`, plus the operator CLI's
own privileged (non-`passwd_app`) connection. No code path issues `UPDATE` or `DELETE`
as `passwd_app`.

That is the exact shape `tenant_claim_events` exists to make survivable for the CLI's
two writers (`add --from`, un-revoke) and did NOT make survivable here: a compromised
app role could rewrite `tenant_id` or clear `revoked_at` directly, on the same table,
with the same effect, leaving no history row at all — because the write never goes
through `recordTenantClaimEvent` in the first place. C5's completeness gate cannot see
this class by construction (its header now says so): it proves code that intends to
write emits an event, and says nothing about a write that isn't code the gate scans.

**Closed** with `REVOKE UPDATE, DELETE ON TABLE tenant_claims FROM passwd_app`, and by
adding `tenant_claims` entries to `scripts/checks/app-role-denied-privileges.json` for
all three non-owner roles (the same two-layer pattern `tenant_claim_events` already
uses) — `SELECT`/`INSERT` stay granted, the sign-in path still needs both.

## D-20 — the tenant-deletion cascade hole was believed to need an ambient GUC, and did not (MEDIUM)

Round 4 of the original plan recorded, and this branch shipped with, a known gap: a
tenant deletion cascades away its `tenant_claims` rows via `ON DELETE CASCADE`, with no
`tenant_claim_events` row. The stated reason for deferring rather than closing it was
that closing it meant writing from a trigger on `tenant_claims`, which "would read the
actor label from an ambient GUC — the shape the escape-hatch decision just rejected."

That reasoning does not hold once the actual write is specified: the trigger does not
attribute the deletion to a person at all. `actor_label = 'cascade'` is a fixed string
naming the mechanism, the same way `SIGNIN_ACTOR_LABEL = 'signin'` already names the
sign-in auto-registration path rather than claiming to know who caused it. No GUC —
ambient, escape, or otherwise — is read by this trigger; it only INSERTs into
`tenant_claim_events`, and INSERT there needs no escape (the append-only triggers on
that table fire on UPDATE/DELETE/TRUNCATE, never INSERT).

**Closed** with a `BEFORE DELETE ON tenant_claims` trigger,
`tenant_claims_record_deregister_event`, `SECURITY INVOKER`, `ENABLE ALWAYS` (matching
the sibling triggers' `session_replication_role` reasoning). Population:
`old_tenant_id` = the deleted tenant, `new_tenant_id` = NULL, `old_revoked_at` = the
claim row's own `revoked_at`, `new_revoked_at` = NULL, `operation` = the new
`deregister` value. The `tenant_claim_events_operation_check` CHECK constraint had to
be dropped and re-added to admit it — baselined in
`scripts/checks/destructive-migration-baseline.txt` with the reason the gate's own
message asks for: the replacement is a strict superset of the four values it already
accepted, applied in the same transaction, so nothing previously accepted becomes
rejected.

Test-infrastructure consequence, not obvious until it broke: `deleteTestData` in
`src/__tests__/db-integration/helpers.ts` used to purge `tenant_claim_events` BEFORE
`DELETE FROM tenants`, on the stated grounds that ordering was free (no FKs either
direction). It is no longer free — the cascade this trigger watches now happens
*during* that `DELETE FROM tenants`, so a purge that already ran cannot see the
`deregister` row it produces, and every test tenant carrying a `tenant_claims` row
would leak one permanently onto the shared dev database. Reordered: `DELETE FROM
tenants` now runs first, the purge second, so it reaches whatever the cascade just
wrote.

## D-21 — `tenant_claim_events` was unindexed for its actual query shape, and unbounded (MEDIUM)

The original migration indexed `claim` and `created_at` individually.
`tenant-domain history` filters on `claim` OR on `(old_tenant_id OR new_tenant_id)`
and then orders the result — neither single-column index supports that combination
well. **Closed** with three composite indexes, `(claim, created_at, id)`,
`(old_tenant_id, created_at, id)`, `(new_tenant_id, created_at, id)`; the original two
single-column indexes are left in place rather than dropped (the migration says why —
avoiding widening this migration's DROP surface for a storage saving on a table
expected to stay small).

`cmdHistory` also had no upper bound at all. **Closed** with a named constant,
`HISTORY_ROW_CAP` (500), a `seq`-based keyset cursor (`--after <seq>`), and — the part
an incident CLI cannot skip — the exact re-invocation printed when the cap is hit,
rather than a bare "results truncated" notice. `cmdHistory` also gained a `rowCap` test
seam (never a CLI flag) so the truncation path is red-provable without inserting 501
real rows on the shared dev database.

## D-22 — same-millisecond ordering was undefined (LOW)

`created_at` is `TIMESTAMPTZ(3)`; 1000 consecutive `clock_timestamp()::timestamptz(3)`
reads were observed identical. **Closed** with `seq BIGINT GENERATED ALWAYS AS
IDENTITY` on `tenant_claim_events` (backfills existing rows), `@unique` in
`prisma/schema.prisma` (Prisma requires `@id`/`@unique` on an `autoincrement()` field —
this is how a `GENERATED ALWAYS AS IDENTITY` column round-trips through the schema for
`check-migration-drift.mjs`). `cmdHistory` now orders and paginates by `seq`;
`created_at` stays the displayed time and is never compared for ordering again.

A literal same-millisecond collision cannot be forced deterministically in a test (the
`BEFORE INSERT` trigger always overwrites a caller-supplied `created_at`, and
`clock_timestamp()` is real wall-clock time) without asserting something that would be
flaky on a host with finer clock resolution. The ordering test in
`tenant-claim-cli.integration.test.ts` instead inserts two rows in one multi-row
`INSERT` statement — the closest reproducible proxy for "the same instant" — and
asserts `history` returns them in insertion (`seq`) order, which is true whether or not
the millisecond actually collides; that is the property the fix guarantees.

## Verification not run

All four DDL changes above are unapplied on the shared dev database as of this pass:
`npm run db:migrate` was deliberately NOT run (R-c — requires explicit user
confirmation, obtained separately from writing the migration). `check-migration-drift`,
`check-destructive-migration`, `check-migration-transaction`,
`check-tenant-claim-event-coverage` and its self-test, `tsc --noEmit` and `eslint` were
run and pass. The new `src/__tests__/db-integration/*` cases above are unexercised
against a live database — they will run once the migration is applied.
