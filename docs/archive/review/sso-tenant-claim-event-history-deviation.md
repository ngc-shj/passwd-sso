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
allows with it), plus a check that CI's real shape (no override) is unaffected.

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
