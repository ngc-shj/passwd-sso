# Coding Deviation Log: issue-838-follow-ups

## D1 — SC5 was already closed before this branch started (plan error)

The plan's Scope contract lists **SC5** — "the partial unique index on active memberships (design
note Q11). Owner: after production measurement (2) is known." That entry is wrong: PR `#830` shipped
the index, in `prisma/migrations/20260909120000_one_active_membership_per_user/migration.sql`
(`CREATE UNIQUE INDEX … "tenant_members_one_active_per_user"`). The plan was written from the design
note's "decidable now" section without checking the migration tree — an R29 failure of my own, found
by the C4 implementation when its `multiActive` fixture could not be inserted.

Consequences, all carried in the code rather than left as prose:

- The design note's measurement query (2) — users with more than one active membership — is now an
  INVARIANT CHECK rather than a population estimate. `tenant-domain measure` keeps running it (the
  count is what proves the invariant holds), and the integration cell asserts a zero delta for it.
- C4 item 4's `multiActive` flag cannot be reached by a row created today; the index refuses the
  insert. It stays in the code because `owningTenantOf`'s oldest-first rule is what decides such a
  row, and a row predating the index (or a future schema without it) would still be handled — but
  its proof moved to a pure unit test over the exported `candidateFromRow`, and an integration cell
  now asserts the index itself refuses the second active membership
  (`rejects.toThrow(/tenant_members_one_active_per_user/)`).
- Acceptance A-C4-2b's multi-active half is therefore satisfied by the unit cell plus the
  index-refusal cell, not by a DB fixture. `--limit` is still proven against real divergent rows.

SC5 is struck from the scope contract: there is nothing deferred there.

## D2 — C2's wired-hook and unclassifiable-command predicates are not singly load-bearing for the exit code

Red-proofing C2 showed that disabling either the wired-hook-existence check or the
unclassifiable-command check still exits 1, because a later check (awk failing to open the missing
file, or the file-existence check reading the literal `$CLAUDE_PROJECT_DIR/…` path) catches the same
fixture for a different reason. The cells assert the diagnostic MESSAGE, which does flip, so each
predicate is red-proved — but the defence in depth means neither is the only thing standing between
the fixture and a green run. Recorded rather than "fixed": collapsing the redundancy would trade a
named refusal for an incidental one.

## D3 — C3 item 6 required narrowing an existing predicate, not only adding new ones

`helperCallsIn` matches `<obj>.withBypassRls(…)` by property name alone, deliberately, "because
over-matching here only means an extra call gets scanned". Item 6's closing sentence — a
helper-named member that resolves to a different declaration passes — is therefore not satisfiable
by adding rules on top: the pre-existing matcher had to be narrowed with the same declaration-set
test Rule A uses (`filterCallsByReceiverDeclaration`). Confirmed to be genuine new behaviour: the
A-C3-2 allow fixture (`const x = { withBypassRls: () => 0 }; x.withBypassRls()`) fails against the
pre-change gate too. Recorded because narrowing an existing security predicate is a bigger change
than the plan's wording implied, and Phase 3 should review it as such.

## D4 — C3 item 5c reports at the binding site instead of binding the local name

The plan says a quoted or computed destructuring key that resolves to a helper "binds the local name
as a helper binding (so the call is analysed)". The implementation instead reports at the
`BindingElement` itself, for both outcomes (resolved-to-helper and unresolvable). Flowing the
resolved name into the syntactic call scanner would mean reconciling node identity across two
independently parsed trees — the Program's and the in-memory `astProject`'s — for a shape that
occurs nowhere in the real tree outside fixtures. The substitute is strictly more conservative
(refuse rather than analyse), never less. Deliberate, documented in the gate's own comment.

## D5 — C3's fixture Program needs an ambient `@prisma/client` stub for CORRECTNESS, not speed

The plan anticipated the stub as a performance lever ("if resolution dominates, give the harness a
minimal ambient stub"). Measurement says resolution cost is ~150-165 ms either way — it does not
dominate. The stub is needed for a different reason: without it `Prisma.TransactionClient` widens to
`any`, and that `any` reaches the `tx` callback parameter, which then trips item 5's `any`-callee
branch and Rule B in fixtures that have nothing to do with a module load. The stub is therefore part
of the fixture contract, not an optimisation.

## D6 — C3's self-test suite lands at ≈1.98× against a 2× budget

Interleaved, same 142 pre-existing cells: 37.2 s old, 73.2-74.3 s new. Inside the budget the plan
set, with almost no headroom; under load it could tip over. The lever the plan sanctions — reusing
one Program across cells in a worker — was NOT implemented. Recorded as an open cost rather than
silently accepted: if CI's `app-ci` step tightens, this is the first thing to do, and it is a harness
change, never a weakening of a rule. Gate runtime itself is ≈17 s against a 30 s budget (old: 1.6 s).

## D7 — C1 preserves the SC2 residual deliberately

The scanner dequotes words for the printer, dumper and tracer rules, but the decrypt-DETECTION
matcher keeps reading raw text. Dequoting it would close `passwd-sso 'decrypt' x`, which the plan
carries as a KNOWN evasion under SC2 (the residual a lint cannot close; the closure is a decrypt
surface that never returns plaintext). Closing it accidentally would have made the hook claim reach
it does not have everywhere else, so the asymmetry is deliberate and commented.

## D8 — the owning-tenant rule's input order was not total (found by the Phase 2 self-check, fixed)

"Oldest active membership" was read as `ORDER BY created_at ASC` with no secondary key, in every
reader of the rule — the three in `src/lib/tenant-context.ts` that predate this branch, and the two
C4 added (the backfill's listing query and its per-user re-read). `created_at` carries no uniqueness
guarantee, so on a tie two separately-executed queries may pick different rows, and `owningTenantOf`
then answers the same user differently depending on which reader asked. For the backfill that is
worse than academic: the operator confirms "user X → tenant A" from the listing and the apply step
re-reads and could move them to tenant B, both valid under the rule, neither what was shown.

Fixed by making the order total everywhere the rule reads memberships — `[createdAt, id]` in the
three Prisma readers plus the backfill's re-read, `ORDER BY tm.created_at ASC, tm.id ASC` in the
listing SQL — and by stating the obligation in `owning-tenant-rule.ts`, which is where a future
reader will look. `measure`'s three queries stay verbatim from the design note: their `n = 1` filter
makes the ordered pick irrelevant, and they are the note's text.

This is pre-existing in the production readers, not something this branch introduced; it is fixed
here rather than deferred because C4 added two more readers of the same rule, which is what turned a
latent ambiguity into a visible operator-facing one. The three unit assertions that pinned the old
`orderBy` shape were updated with it (R19).
