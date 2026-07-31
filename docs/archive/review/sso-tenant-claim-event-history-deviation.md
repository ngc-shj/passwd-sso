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

## D-23 — the identity column's "cannot be overridden" claim was false, and the obvious remedy would have denied sign-ins (HIGH)

`20260731170000` chose `GENERATED ALWAYS AS IDENTITY` over a `DEFAULT` and wrote that
it "cannot be overridden by application INSERT text at all (it raises unless
`OVERRIDING SYSTEM VALUE` is stated explicitly, which no writer in this codebase does
or should)". The parenthesis states the exploit and then treats it as closed by
convention. Measured on a throwaway database and role: with a TABLE-level `INSERT`
grant — which `passwd_app` held — `OVERRIDING SYSTEM VALUE` succeeds, needing no
privilege on the backing sequence. `seq` carries a `UNIQUE` constraint, so a planted
maximal value makes every later engine-assigned value collide; the event writer is
fail-closed, so the symptom is denied first-ever sign-ins and refused operator claim
changes, not a missing history row.

The remedy the finding proposed — scope the grant to columns, and register the
table-level `INSERT` in `app-role-denied-privileges.json` so a convergence run cannot
re-widen it — is **not sufficient on its own, and applying only that half would have
been worse than the defect**. Measured before implementing: `REVOKE <priv> ON TABLE`
erases the COLUMN-level grants of that privilege as well (`pg_attribute.attacl` goes
empty). The declared re-REVOKE would therefore have taken the migration's
`GRANT INSERT (…)` with it on every `bootstrap-rds-roles.mjs` run, leaving the sign-in
writer with no `INSERT` at all — a permanent outage produced by the security control,
converged into place and re-applied on every deploy.

**Closed** in `20260731190000_tenant_claim_events_column_scoped_insert` plus a policy
schema change, because the declaration had to be able to express the pair:

- `app-role-denied-privileges.json` entries gained an optional `columnGrants` map —
  "this privilege is denied at TABLE level and held on exactly these columns". A key
  must also appear in `privileges`, or the map would sit under a still-granted table
  privilege and enforce nothing. `applyDeniedPrivileges` re-GRANTs the columns
  immediately after its REVOKE, in the same loop and the same transaction, so the two
  cannot be separated by an edit that only reads one of them.
- The same entries gained a `sequence` subject. `20260731170000` had revoked
  `passwd_app`'s `USAGE, SELECT` on `tenant_claim_events_seq_seq` and recorded that the
  revoke was "not expressible in `app-role-denied-privileges.json` — that policy's
  subject is a table and its privilege set has no `USAGE`". That inexpressibility was
  the whole finding: `bootstrap-rds-roles.mjs`'s
  `GRANT USAGE, SELECT ON ALL SEQUENCES` is exactly as blind to that object as its
  `ON ALL TABLES` sibling was to `audit_logs`, so every convergence run restored it and
  the descriptive manifest recorded the restoration as expected.
- `audit-db-grants.mjs` treats the declared columns as expected and every OTHER column
  of that privilege as a finding, so the declaration narrows the denial rather than
  suspending it. The opposite direction — a sanctioned column grant that has been
  erased — surfaces as `MISSING_GRANT` against the manifest.

Two properties came free and are worth stating because they are now load-bearing: the
column list omits `db_user`/`session_db_user`/`client_addr`/`created_at`, so those are
un-nameable and not merely overwritten by the `BEFORE INSERT` trigger (a trigger the
table owner can disable; an ACL it cannot). And a `CHECK (seq > 0)` was added behind
the ACL, because `seq` is also the `--after` cursor and a non-positive row would sort
before every real event while being unreachable by any cursor the CLI can produce.

Verified end to end on a throwaway database carrying a full replay of all 184
migrations: with the table-wide grant the attack succeeds; after
`bootstrap-rds-roles.mjs --denied-only` with the committed policy, the real writer's
`INSERT` still succeeds and `OVERRIDING SYSTEM VALUE`, `INSERT … (…, seq) VALUES (…,
DEFAULT)` and `INSERT … (…, db_user)` all raise `42501`. Also measured, and reflected
in the integration test rather than assumed: naming `seq` with a literal value raises
`428C9` during parse analysis, BEFORE any privilege check, so a case built on that
spelling would pass against a wide-open grant.

## D-24 — the replacement indexes were ordered by the column the reader had stopped using (MEDIUM)

`20260731170000` closed D-21 by adding `(selector, created_at, id)` indexes in the same
transaction in which it made `seq` the `ORDER BY` and the pagination cursor. A leading
equality still matched, but there was no usable ordering, so the plan was a scan plus a
sort. **Closed** by replacing the three with `(claim, seq)`,
`(old_tenant_id, seq)`, `(new_tenant_id, seq)`. The three superseded indexes are
DROPped and baselined in `destructive-migration-baseline.txt`: no application code
names an index, so their absence cannot break an old code path, and they have never
existed outside this unmerged branch — while each is write amplification on the
fail-closed sign-in path.

`cmdHistory`'s tenant selector became TWO queries merged in the CLI rather than one
`OR`. Measured with `EXPLAIN (ANALYZE)` on 41k rows with a tenant naming 660 of them:
the `OR` does use the new indexes, as a `BitmapOr` — but a bitmap scan is unordered, so
the plan is `BitmapOr → Sort → Limit` and every matching row is read and sorted however
small the cap is. One equality per side walks `(tenant, seq)` in order, giving
`Index Scan → Limit` with no sort node. The merge is exact rather than approximate:
the union's first `take` rows by `seq` are necessarily a subset of each side's own
first `take`, and `seq` is `UNIQUE`, so it also de-duplicates the rows that name the
tenant on both sides — which is every non-`reassign` event.

## D-25 — the continuation hint built a shell command out of a claim (MEDIUM)

A capped `history` result printed a ready-to-paste
`tenant-domain history --domain <claim> --after <seq>`. A claim is printable ASCII by
CHECK constraint, so `;`, `$(…)` and backticks are all admissible, and
`escapeUnsafeDisplayChars` neutralises terminal control sequences — it is not a shell
quoter and does not claim to be. Anyone who can reach the sign-in auto-registration
path could therefore place a command into a line an operator is invited to paste into a
shell, during an incident.

**Closed** by not rebuilding the command at all, rather than by quoting it: the
operator already has the command they just ran, so naming the one flag to add carries
the same information with nothing interpolated into command position.
`lastSeq` is a `BigInt` read from the database. The notice is deliberately two lines —
the descriptive line names the claim, escaped, as every other display line does, and
the copyable line carries a flag name and digits only. The test asserts on the LINE, not
on the whole call, because the line is the unit an operator selects; the first version
of that test failed against a single-line message and the split is what it drove out.

## D-26 — `cascade` named a mechanism the trigger cannot observe (LOW)

D-20's argument — that a fixed string naming a MECHANISM is not an attempt to attribute
an act to a person — holds. The string it chose does not: a `BEFORE DELETE` trigger on
`tenant_claims` fires identically for a cascade from `DELETE FROM tenants` and for a
direct `DELETE FROM tenant_claims`, and nothing available inside it distinguishes them.
On a direct delete the row asserted a cascade that never happened, on the one table
whose purpose is to be believed later. **Closed** by relabelling to `db-delete`, which
is what the trigger can vouch for; which delete, and by whom, is already answered by
the `db_user`/`session_db_user` pair. `CASCADE_ACTOR_LABEL` is renamed
`DEREGISTER_ACTOR_LABEL` accordingly. Rows written under the previous definition keep
saying `cascade` and are NOT backfilled — the table is append-only, `UPDATE` raises,
and rewriting recorded history to match a later opinion about its wording is the
behaviour this table exists to prevent.

## D-27 — the round's own self-check findings

Three focused sub-agents ran the recurring-rule check against this round before it
closed. Four fires, all acted on rather than deferred:

- **RT7 (Major, found independently by all three).** `violatesDenied` gained two
  branches — the `SEQUENCE:` match and the sanctioned-column filter — and
  `audit-db-grants.integration.test.ts` was untouched, so deleting either branch left
  the whole prescriptive block green. The bootstrap half of the same change had a
  paired red-provable case (T6b) and the audit half, which is the CI-side gate, had
  none. **Closed** with five cases: a sanctioned column is not reported while another
  column of the same privilege still is (the narrowing must not become a suspension),
  a table-level grant is still reported under a column exception, a sequence privilege
  is reported, the same is silent once revoked, and a wrong-kind subject fails closed.
- **RT5 (Critical).** No test covered *the shipping writer × the production grant
  shape*. The one case that drives `findOrCreateTenantForClaim` under an ACL-enforcing
  probe role granted TABLE-level `INSERT` — strictly wider than what `passwd_app` now
  holds, and exactly the grant this round removed. A ninth column in
  `recordTenantClaimEvent`, or `seq`/`db_user`, would have 42501'd in production while
  both that test and the hand-copied statement in the ACL test stayed green — and the
  writer is fail-closed, so the symptom is a denied first-ever sign-in. **Closed** by
  granting the probe role a COLUMN-scoped `INSERT` whose column list is read from
  `loadDeniedPolicy()`, so the fixture cannot drift from the declaration production
  converges to, and the correspondence the migration asserts in prose is now gated.
- **R3 (Major).** The audit already hard-errors on an entry naming a role it does not
  read, because such an entry looks enforced and enforces nothing. This round added a
  second axis on which that can happen — subject KIND — without extending the guard:
  `"table": "public.foo_seq"` passes the identifier check, passes the existence guard,
  and its implicit-TABLE `REVOKE` even succeeds, while the audit emits `SEQUENCE:` keys
  for that object so the entry matches nothing. The mirror mistake fails loudly
  (`REVOKE … ON SEQUENCE <table>` errors), so only this direction was silent.
  **Closed** with `assertSubjectKind`, one rule consulted by both consumers against
  `pg_class.relkind`.
- **R49 (Minor).** A comment claimed the erased-column-grant direction was "caught by
  the manifest comparison". True in compare mode; false in `--write`, which is the mode
  the adjacent refusal gate exists for. **Closed** by making it true rather than by
  weakening the sentence: `missingDeclaredColumnGrants` refuses a regeneration whose
  database is missing a declared column grant, the availability mirror of the
  over-privilege refusal beside it.

**R42 (Major), re-derived rather than closed.** `scripts/rls-smoke-seed.sql` and
`scripts/rls-cross-tenant-seed.sql` issue blanket `GRANT … ON ALL TABLES` /
`ON ALL SEQUENCES` to `passwd_app` with no `--denied-only` behind them — deferred in
round 1 as A1, on a cost justification that enumerated the members it re-opened. This
round invalidated that enumeration by adding table-level `INSERT` on
`tenant_claim_events` and three sequence entries, the second of which is precisely the
object class the blanket sequence grant reaches and which had no policy expression
until now.

The deferral still stands on the merits, and the re-derivation is what makes that
statement checkable: the member set is **every `passwd_app` entry in
`app-role-denied-privileges.json`**, derived from the file rather than listed, so the
next expansion cannot invalidate it the way this one did. Running `--denied-only`
there is not a drop-in: that job creates only `passwd_app`, and the mode requires every
declared target to exist — by design, since a mode whose job is to apply the policy
must not report success without applying it. The three conditions that make the
exposure acceptable are now written beside the grants themselves: the database is
ephemeral, the job asserts nothing about the covered tables, and it never runs
`--write`, so nothing is recorded as expected.

## D-28 — Phase 3 review findings

Three reviewers took the round after the self-check. One regression this round
introduced, and a set of coverage gaps; all acted on.

**The continuation hint told the operator to do something the parser refuses
(Major, functionality).** The shell-quoting fix replaced a paste-ready command with
"re-run the SAME command with `--after <seq>` appended" — correct from page 1 to page
2, and wrong from page 3, because page 2's command already carries `--after` and round
4's S5 made `parseFlags` refuse a repeated flag outright. Reproduced live: the
instruction exits 1 with no rows. So the fix for an injection surface had introduced a
dead end on the same incident read path. **Closed** by branching the wording on whether
`--after` was already given ("in place of the --after already on it"), without echoing
the old value back — naming the flag to replace says the same thing with no operator
input in the line. The round's tests could not see it: they drive `cmdHistory()`
directly and stopped at page 2. There is now a case that reaches a second truncated
page and asserts the wording.

**Coverage the round claimed and did not have (three Majors, testing).** Each was
demonstrated by simulating a mutant against the same fixture, not argued:

- `--tenant` truncation was pinned by nothing. `cmdHistory` returns no `truncated`
  field, so `message` is the only channel; a per-side fetch that dropped the `+1` probe
  row returned the same rows, said "2 event(s) listed", printed no hint, and every
  assertion passed. An incident responder would read a truncated routing history as
  the whole of it. Now asserted, along with the non-truncated boundary on the last
  page.
- `--after` was never exercised with `--tenant` at all — the selector whose cursor is
  now spread into TWO independent queries, which is the single most natural place for a
  later refactor to lose one. Dropping it from either side makes `lastSeq` move
  backwards and the documented continue-loop never terminate. Now paged three deep,
  asserting strict advance past the cursor and that the pages partition the full result.
- the "cap applies to the MERGED result" assertion did not test its own comment: with
  the both-sides row seeded second, a merge with de-duplication removed still produced
  two distinct rows, because the duplicate fell off the end of the cap. Seeding it
  first puts the duplicate inside the cap.

**The index replacement was unpinned (Major, testing).** The CLI returns identical rows
under either index set, so every behavioural assertion is green against the shape this
round replaced — a later migration re-adding `created_at`-ordered indexes would revert
the fix silently. Now asserted from `pg_indexes` against the index DEFINITIONS, not
their names, plus the three superseded ones by exact name (a substring match would also
have demanded the removal of `tenant_claim_events_created_at_idx`, which
20260731170000 deliberately kept).

**Not closed, recorded instead:** nothing asserts that the tenant selector issues TWO
queries rather than one `OR`. Both return the same rows; only the plan differs, so
pinning it needs a spy on the Prisma client through the `migrationClientFactory` seam.
The index assertion above covers the other half of the same regression, the measured
`EXPLAIN` output is in the migration and in cmdHistory's comment, and the cost of the
spy is a fixture that breaks on any Prisma client shape change. Revisit if the plan
regresses in practice.

**Silent-inertness axes, completed (Minors, functionality).** `assertSubjectKind`
closed the wrong-KIND axis; two more of the same shape were open. An UNQUALIFIED
subject (`"tenant_claim_events"`) resolves through `search_path`, so the kind check
passes and the bootstrap's REVOKE succeeds, while the audit's keys are always
schema-qualified and the entry matches nothing — the subject regex now requires the
dotted form (roles keep the bare one). And a REPEATED `(role, subject)` pair was
merely redundant before `columnGrants` and is destructive after it: entries apply in
file order, so a second entry without the re-grant erases the first one's, produced by
the convergence run meant to restore it. Both are now loader errors with unit tests.

**Audit-script minors (functionality).** `missingDeclaredColumnGrants` disagreed with
the other two consumers about what an absent subject means — it would refuse a
pre-migration `--write` with advice that cannot work, since the bootstrap skips the
absent table too; it now takes the existing-subject set. It also read `d.table` inline
rather than through `subjectOf`, the exact coupling that helper exists to prevent. And
the required-column direction is now checked against the MANIFEST as well as live,
mirroring the denied direction: live-only leaves a state where the keys are absent from
both and every check passes on a database whose fail-closed writer cannot append.

**Not changed: `DROP INDEX` without `IF EXISTS`.** Correct in the abstract — an
out-of-band drop would leave `migrate deploy` failed. Declined because the migration is
already applied, and editing an applied migration breaks its recorded checksum; the
three indexes are created by `20260731170000` and dropped by `20260731190000`, both on
this same unmerged branch, so any database that has the former also receives the
latter.

**Also corrected: two comments still asserted the framing D-26 retired** — the
`TENANT_CLAIM_EVENT_OPERATION` docblock and a test comment both said the deregister row
comes from a tenant-deletion cascade and carries `'cascade'`. And the DIRECT
`DELETE FROM tenant_claims` path — the case that motivated the relabel — had no test at
all, only the cascade. It has one now: the tenant survives, so the only thing that can
produce the event is the trigger itself.

## D-29 — a cascade attributes the deletion to the table OWNER, and the docs said to read the column that says so

The security review's finding, reproduced independently on a throwaway database before
acting on it. PostgreSQL runs a referential action under the REFERENCED table's owner,
so a trigger fired by `ON DELETE CASCADE` sees `current_user` = owner. The same trigger,
the same role, two paths:

    direct DELETE FROM child   ->  current_user = probe_role,   session_user = probe_role
    cascade from parent        ->  current_user = passwd_user,  session_user = probe_role

`tenant_claim_events_set_principal` assigns `db_user := current_user`, so every
cascade-produced `deregister` row records the migration/owner role no matter who issued
the `DELETE FROM tenants`. `passwd_app` holds `DELETE` on `tenants`: a compromised
application that deletes a tenant destroys its `tenant_claims` rows and leaves a trace
that reads, to anyone applying the documented rule, as an operator action.

This is D-26's own defect one level up — a recorded value asserting more than the
mechanism can vouch for — and D-26's remedy leant on exactly the wrong half of the pair
("who is already answered by `db_user`/`session_db_user`"). The information was never
lost: `session_user` does not follow the security-context switch. **Closed** by naming
the right column in `docs/security/audit-log-schema.md` and in `DEREGISTER_ACTOR_LABEL`,
and by a case that deletes a tenant as an ACL-enforcing probe role and asserts BOTH
columns — `session_db_user` is the probe role, `db_user` is the table owner, read from
`pg_class` rather than compared to a literal (the owner is `passwd_user` locally and
`postgres` in CI). Every pre-existing cascade case deletes as the superuser, where owner
and caller are the same principal, so none of them could have seen it.

That probe role is granted `DELETE` on `tenants` and NOTHING on `tenant_claims` or
`tenant_claim_events`, which incidentally pins a second property: the cascade and the
event INSERT both run in the owner's context, so the write happens without the caller
holding any privilege on either table.

## D-30 — the denied set on the routing tables, completed by derivation

The security review noted `TRIGGER` and `REFERENCES` were outside the declaration. The
one with teeth is `TRIGGER`: `CREATE TRIGGER` needs only that privilege plus `EXECUTE`
on a function, and a `BEFORE INSERT ... FOR EACH ROW` trigger that returns `NULL`
discards every append while the statement still reports success — a fail-closed writer
does not notice, and there is nothing left to read afterwards.

Rather than add the two named privileges, the set was re-derived: **on the two routing
tables, deny every privilege the grant audit reads that the role does not need.** That
gives all seven for `tenant_claim_events` (with `passwd_app`'s `INSERT` held on eight
columns), all seven for both workers on `tenant_claims`, and five for `passwd_app`
there — `SELECT`/`INSERT` stay, since the sign-in path looks up and creates claim rows.
The derivation also picked up `TRUNCATE` on `tenant_claims`, which nobody had named: it
destroys every claim's routing AND fires no row-level trigger, so it would leave no
`deregister` events at all — evidence destruction, not merely a denial of service.

None of the added privileges is held on the development database, so this is a
tightening of the declaration rather than a repair.

## D-31 — `check-runtime-image-assets` read an error message as a file path

The final pre-PR run went red on a gate nothing in this round touched. The cause is
worth recording because the shape recurs: the gate derives its required-asset set from
string LITERALS rather than raw text, precisely so a path named in a comment is not
counted — and D-3 records the sibling case, where forbidden-pattern greps fired on this
PR's own explanatory comments. Literals are not enough. A message built as

    `DENIED_POLICY_INVALID: … ${subject}. ` + "The subject must be schema-qualified…"

leaves a `TemplateTail` whose literal text is exactly `". "`, which the gate's
relative resolution turns into `scripts/lib/. ` — a required asset no `COPY` can
satisfy, so the gate reds on prose.

**Closed in the gate, not by rewording.** D-3 chose rewording because there the check
was correct and the comment merely tripped it; here the derivation itself is wrong —
`". "` is not a path reference under any reading, and the next person to end a template
span with a full stop pays the same review round. `assetPathFrom` now drops any
candidate containing whitespace, with the risk direction stated in place: it narrows a
fail-closed gate, so it could in principle hide a real asset whose FILENAME contains a
space — no file under `scripts/checks/` or `scripts/lib/` has one. A self-test case
pins the shape, next to the existing comment-exclusion case; the red→green is the real
tree, which failed before the change and reports
`OK (2 script(s), 3 distinct asset(s))` after.

## Verification

The migration set (`20260731100000`, `20260731170000`, `20260731190000`) is applied to
the shared development database, with explicit user confirmation for each application
(R-c). Before that application, all 184 migrations were replayed from empty onto a
throwaway database to prove the chain applies, and the D-23 convergence proof was run
there rather than against shared roles.

Run and passing: `bash scripts/pre-pr.sh` (68/68, which includes lint, the unit suite
and the Next.js build), `npx tsc --noEmit`, and
`node scripts/audit-db-grants.mjs` — run unpiped, so the exit status read is the
gate's own and not a pipe tail's.

`npm run test:integration` passes on every file this branch touches. The full-suite
run reports one unrelated failure per run, in a different file each time, always one
this branch does not modify (`webhook-delivery-durable`,
`audit-outbox-worker-fanout`): the `audit-outbox-worker` container is running against
the same development database and drains `audit_outbox` rows out from under tests that
assert on them. Re-running the named file in isolation passes. This is the environment
condition already recorded for this repository, not a regression — the discriminator
used each time is (1) the file is absent from the branch diff, and (2) it is green when
run alone.

`scripts/checks/db-grants-manifest.json` was regenerated with
`node scripts/audit-db-grants.mjs --write` after the migration. The diff is exactly the
D-23 change and nothing else: `TABLE:passwd_app public.tenant_claim_events INSERT`
removed, the eight `COLUMN:` keys added. The regeneration is only trustworthy because
the prescriptive policy refuses to launder a denied privilege into the manifest — that
check ran first and passed, which is what the first (failing) audit run above it
demonstrated.
