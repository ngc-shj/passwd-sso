# Plan Review: bearer-passkey-gate-coverage

Date: 2026-11-14
Review round: 1

## Changes from Previous Round

Initial review. Local LLM pre-screening was skipped (Ollama unavailable), so findings were
merged by hand from each expert's JSON index. No Critical finding; no escalation.

Convergent findings (two perspectives, same root cause):

- F3 + S5 + T4 — the run-time position rule is a second adjudicator (functionality +
  security + testing).
- F11 + T5 — the base fixture lacks the new inputs (functionality + testing).
- F1 + T1 — existing entries' `calls` change and nothing pins the counting rule
  (functionality + testing).

## Functionality Findings

- F1 Major (design) — placement under `updateMany` / `createMany` / `omit` is undefined
  because the walkers drop the model there; `calls` changes meaning; existing entries change.
  **Resolved**: C1 placement is its own channel on the receiver model, `calls` is redefined,
  the expected deltas are listed, A-6 records the before/after table.
- F2 Major (design) — the alias keyword set is undefined; `SET` is not a reserved word, so
  the 6 real `UPDATE`s would be refused. **Resolved**: C3 defines a closed follow-set and
  A-9a pins `SET` and `WHERE (` as allow cells.
- F3 Major (design) — the run-time rule has no lexer and is not the static predicate.
  **Resolved**: the rendered-text rule is removed. A token table spliced as an identifier
  goes through `sqlTable`, which `trustedSql` position-checks against the template's own
  text; `sqlIdentifier` refuses token tables. One judge per input.
- F4 Major (design) — a trigger's `EXECUTE FUNCTION` made 8 migrations qualify instead of 5.
  **Resolved**: `EXECUTE` counts only inside a function or procedure body.
- F5 Minor (design) — `DO` blocks and single-quoted bodies in migrations. **Resolved** in C4.
- F6 Minor (design) — site counting by call ancestry can disagree with the attributed key.
  **Resolved**: the counted ancestor must share the manifest key (C1, A-4).
- F7 Minor (design) — class members and non-exported top-level spellings have no key.
  **Resolved**: they fail as unattributable, with the remedy stated.
- F8 Minor (design) — C2's reach is bounded by the digest-spelling pre-filter.
  **Resolved**: stated in C2.
- F9 Minor (design) — the spelling kinds were a typed-in list. **Resolved**: C1 classifies
  every identifier occurrence by role and treats an unknown role as a key.
- F10 Minor (design) — `.query` value references are refused only in importer files; three
  pool lists. **Resolved**: SC7 records the residual; C5 states the importer set is derived
  from code each run.
- F11 Minor (adjacent, testing) — see T5.

## Security Findings

- S1 Major (design) — `k.to_jsonb` is `to_jsonb(k)` in PostgreSQL (executed on the dev
  database, `LIMIT 0`), so a column qualifier must be a real column. **Resolved**: W2
  requires a schema-declared column.
- S2 Major (design) — C1 attributes a helper-built filter to the helper; later consumers
  are unseen. **Resolved**: a direct call of a function holding a floating object-literal
  key is a site of the caller (C1, A-4b). What that does not reach is SC6, quantified there.
- S3 Minor (design) — `ts_stat` runs its string argument; the function list is a sample.
  **Resolved**: W5 refuses a token table's name inside any string token; `ts_stat` joins W4.
- S4 Minor (design) — relation position by preceding keyword only; case and quoting
  unspecified. **Resolved** in C3's static definitions.
- S5 Minor (design) — see F3. W4 against check-bypass-rls: **resolved** by stating W4 is an
  independent deny.
- S6 Minor (design) — C4's trigger set was a list; the schema check was one-directional.
  **Resolved**: any non-DDL statement naming a digest column qualifies; all string bodies
  are re-lexed; the digest-column set is checked both ways.
- S7 Minor — non-migration SQL is cheap to read; SC5 unquantified. **Resolved**: C4 reads
  `infra/postgres/initdb` and `scripts/*.sql`; SC5 is quantified.
- S8 Minor (design) — `DIGEST_KEYS` is a typed-in list. **Resolved**: a schema check over
  unique hash/digest fields with a `nonBearerHashFields` allowlist.

Checked and found sound by the security expert: no compound unique key embeds a digest
field today; `select` plus a JavaScript comparison is caught through the member read;
`orderBy` / `distinct` / `by` spellings float; pg imports are already confined to
`pool-factory` by check-bypass-rls.

## Testing Findings

- T1 Major (design) — the site-counting rule and count stability are unpinned.
  **Resolved**: A-4 and A-6.
- T2 Major (design) — deny cells match substrings over all output, so a cell can pass for
  another rule's reason. **Resolved**: C6 requires an exact-failure-set helper and
  one-violation fixtures for new cells.
- T3 Major (design) — allow-side and axis cells omitted. **Resolved**: A-1, A-5, A-7, A-9a,
  A-10, A-11 name the axes; each rule has a deny and an allow cell differing in one axis.
- T4 Major (design) — the shared vectors could be vacuous or mismatched. **Resolved**: the
  twin is removed (F3), so no vector file exists; `TOKEN_TABLE_NAMES` has both-direction
  cells; the `raw-sql` export-surface test is named in A-13.
- T5 Major (design) — the base fixture lacks migrations, the new manifest sections,
  `raw-sql.ts` and `pool-factory`. **Resolved** in C6.
- T6 Major (design) — the red-proof plan was not auditable. **Resolved**: C6 lists what the
  deviation log records and requires both mutation directions.
- T7 Minor (design) — the timing budget was asserted. **Resolved**: R-5 is a recorded
  median of 3 runs, declared not to be a threshold.
- T8 Minor (design) — A-10 did not name the suites that move. **Resolved** in A-13 and
  I-C3b. The integration suite runs against this worktree's own database, so the dev
  workers need not be stopped.
- T9 Minor (prose) — figures without commands. **Resolved**: the gate prints the counts in
  its summary line; the plan says the figures were reproduced by the functionality expert.
- T10 Minor (adjacent, functionality) — a string or comment naming a token table would be
  refused at run time. **Resolved**: no rule reads rendered text any more.

## Adjacent Findings

- F11 → Testing: merged into T5.
- T10 → Functionality: merged into F3.

## Quality Warnings

None. Every finding carried evidence (file and line, a command, or an executed statement).

## Anti-Deferral Entries

None in round 1: every finding was reflected in the plan. The residuals the plan declares
(SC1–SC7) each carry worst case, likelihood and cost there.

## Recurring Issue Check

### Functionality expert

- R1 Checked — no issue (reuses `tokenizeSql`, `loadPrismaSchema`).
- R2 Checked — no issue.
- R3 Finding F1 / F6.
- R4–R16 N/A (R15: C4 reads migrations only).
- R17 Checked — no issue.
- R18 Finding F10.
- R19–R21 N/A.
- R22 Checked — no issue.
- R23–R28 N/A.
- R29 Finding F4 / F10; the other inputs were reproduced.
- R30–R33 N/A.
- R34 Checked — no issue.
- R35 N/A.
- R36 Checked — no issue.
- R37–R41 N/A.
- R42 Findings F2, F9.
- R43 Checked — no issue.
- R44 Checked — no issue.
- R45 Checked — measured (+0.3 s census, 0.35 s C4).
- R46 Checked — no issue.
- R47 Finding F3.
- R48 Findings F3 / F10.
- R49 Findings F3 / F10.
- R50 Checked — no issue.
- R51 N/A.
- R52 Finding F1.
- R53–R57 N/A.

### Security expert

- R1 N/A, R2 N/A, R3 OK, R4–R17 N/A, R18 OK, R19–R28 N/A.
- R29 Checked (citations confirmed; remaining counts not re-measured), R30 N/A, R31 OK
  (read-only SQL only), R32 N/A, R33 OK, R34 N/A, R35 N/A, R36 OK, R37–R41 N/A.
- R42 Finding (S3, S6, S8), R43 OK, R44 N/A, R45 OK, R46 Watch (S2 remedy must resolve
  scope-aware), R47 Finding (S1, S3, S4), R48 Finding (S5), R49 Finding (S2, S7), R50 N/A,
  R51 N/A, R52 Finding (S2), R53–R57 N/A.
- RS1 N/A, RS2 N/A, RS3 N/A, RS4 OK, RS5 N/A, RS6 N/A.

### Testing expert

- R1 Checked — no issue. R2 Checked — no issue. R3 Checked (T1, T3).
- R4–R9 N/A. R10 Checked — no issue. R11–R15 N/A. R16 Checked — no issue. R17 N/A.
- R18 Checked (T5). R19 Finding T4. R20–R28 N/A.
- R29 Finding T9. R30–R32 N/A. R33 Checked — no issue. R34 Checked — no issue. R35 N/A.
- R36 Checked — no issue. R37–R39 N/A. R40 Checked (T4). R41 Checked — no issue.
- R42 Checked. R43 N/A. R44 Checked — no issue. R45 Finding T7. R46 N/A. R47 Checked (T3).
- R48 Finding T4. R49 Checked — no issue. R50 Finding T2 / T6. R51 N/A. R52 Checked (T1,
  T3). R53 Findings T7, T9. R54 N/A. R55 Checked (T3). R56 N/A. R57 N/A.
- RT1 N/A. RT2 Checked. RT3 Checked. RT4 Checked. RT5 Checked (T6). RT6 Checked.
- RT7 Findings T1, T2, T6. RT8 N/A. RT9 Finding T4. RT10 Finding T3. RT11 Checked (T5).

---

# Round 2

Date: 2026-11-14
Review round: 2

## Changes from Previous Round

The plan was rewritten for round 1's findings: a role-based census, a `sqlTable` mint in
place of the rendered-text rule, a declared-column requirement for qualifiers, W5, three SQL
roots, schema checks, and the self-test harness obligations. Round 2 verified those and
reviewed the new parts. No Critical; one security Major and six testing Majors, all against
the round-1 additions.

Status of round-1 findings: F1–F11 resolved; S1–S4 and S6–S8 resolved, S5 resolved after
S10; T1, T4, T6, T7, T9, T10 resolved; T2, T3, T5, T8 continued as T14, T17, T11, T13.

Convergent: S10 + F12 + T12 (the mint's position check was looser than the static
predicate) — severity floor Major.

## Functionality Findings

- F12 Minor (design), convergent — see S10. **Resolved**: W6.
- F13 Minor (design) — `INSERT INTO t (cols)` was a value use. **Resolved**: the column
  list after `INTO t` is exempt; allow cell in A-9a.
- F14 Minor (design) — the non-DDL bullet qualified two `INSERT ... VALUES` seed scripts.
  **Resolved**: `INSERT ... VALUES` is plain.
- F15 Minor (prose) — A-1 demanded `UNLISTED` for unattributable roles. **Resolved** in A-1.

Reproduced by the functionality expert on the real repo: 52 object-literal properties (51
placed, 1 floating), 5 member reads, 3 equal strings; exactly the 4 new keys and the 1
changed entry the plan lists; the builder rule adds no site today; no false refusal from W5
or the declared-column rule over the 27 literals in scope; 5 migrations qualify under C4;
no field needs a `nonBearerHashFields` entry.

## Security Findings

- S9 Major (design) — the builder trigger covered only object-literal keys; a filter built
  by assignment was missed. **Resolved**: the trigger is any floating write key (C1, A-4b).
- S10 Major by convergence (design) — the mint accepted `IS DISTINCT FROM ${t}` and
  `${t}.to_jsonb` had no judge. **Resolved**: W6. The mint decides only "a table sits after
  a relation keyword or before a dot"; the lexer refuses, for any substitution, the
  non-relation `FROM`s, value followers, an undeclared qualifier name and adjacency to a
  word character.
- S11 Minor (prose) — partial-name assembly was undeclared. **Resolved**: W6 refuses
  adjacency within a template; assembly across fragments is in SC4; R-2 no longer implies
  closure.
- S12 Minor (design) — a foreign key to a digest column passed as plain DDL. **Resolved**:
  `REFERENCES` naming a digest column qualifies; a `@relation` referencing a digest key
  fails the schema check.
- S13 Minor (prose) — scope of the unique-field check and of W5's "names". **Resolved** in
  C4 and C3.
- S13 adjacent — `TeamInvitation.token` is stored in plaintext. Not this gate's subject
  (a one-time token accepted under a session); reported to the user as a separate item.

## Testing Findings

- T11 Major (design) — the base fixture schema violates the new fatal schema checks.
  **Resolved** in C6.
- T12 Major (design), convergent with S10 — run-time cells incomplete. **Resolved** in A-9b.
- T13 Major (design) — check-raw-sql-usage's self-test needs `sqlTable` cells. **Resolved**
  in C3.
- T14 Major (design) — the exact-outcome helper had no fatal form and no rule for inherent
  pairs. **Resolved** in C6.
- T15 Major (design) — the unknown-role default had no constructible test. **Resolved**:
  A-1b.
- T16 Minor (design) — how the before/after table is produced. **Resolved** in A-6.
- T17 Major (design) — widening mutations had no allow cell to turn red. **Resolved** in
  A-4b, A-9a, A-10.
- T18 Minor (prose) — an unreproduced figure in SC7. **Resolved**: the number is dropped.

## Adjacent Findings

- T12 → Security: merged into S10.
- S13 (`TeamInvitation.token`) → Functionality: out of this change; see above.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert

R1 Checked. R2 Checked. R3 Checked. R4–R16 N/A. R17 Checked. R18 Checked. R19 Checked.
R20–R21 N/A. R22 Checked. R23–R28 N/A. R29 Checked — figures reproduce. R30–R33 N/A.
R34 Checked. R35 N/A. R36 Checked. R37–R41 N/A. R42 Checked. R43 Checked. R44 Checked.
R45 Checked — measured (+0.3 s). R46 Checked. R47 Finding F12. R48 Finding F12.
R49 Checked. R50 Checked. R51 N/A. R52 Checked. R53–R57 N/A.

### Security expert

R1–R2 N/A, R3 OK, R4–R17 N/A, R18 OK, R19–R28 N/A, R29 OK, R30 N/A, R31 OK, R32 N/A,
R33 OK, R34–R35 N/A, R36 OK, R37–R41 N/A, R42 Finding (S9, S12, S13), R43 OK, R44 N/A,
R45 OK, R46 OK, R47 Finding (S10), R48 Finding (S10), R49 Finding (S11, S9/SC6), R50–R51
N/A, R52 OK, R53–R57 N/A. RS1–RS3 N/A, RS4 OK, RS5–RS6 N/A.

### Testing expert

R1 Checked. R2 Checked. R3 Finding T13, T17. R4–R9 N/A. R10 Checked. R11–R15 N/A.
R16 Checked. R17 Finding T12. R18 Findings T11, T13. R19 Finding T13. R20–R28 N/A.
R29 Finding T18. R30–R32 N/A. R33 Checked. R34 Checked. R35 N/A. R36 Checked. R37–R39 N/A.
R40 Checked. R41 Finding T12. R42 Checked (T15). R43 Finding T12. R44 Checked. R45 Checked.
R46 Checked. R47 Findings T15, T17. R48 Finding T12. R49 Checked. R50 Finding T14. R51 N/A.
R52 Finding T13. R53 Checked. R54 N/A. R55 Checked. R56–R57 N/A.
RT1 N/A. RT2–RT6 Checked. RT7 Findings T13, T15. RT8 Finding T13. RT9 Finding T12.
RT10 Findings T12, T17. RT11 Checked.

---

# Round 3

Date: 2026-11-14
Review round: 3

## Changes from Previous Round

Round 2's findings were reflected (W6, the write-key builder trigger, `REFERENCES`, the
harness obligations). Round 3 verified them. No Critical and no Major. Functionality: no
findings. Security: 4 Minor. Testing: 2 Minor. Every finding is against a round-2 addition.

Status of round-2 findings: F12–F15, S9–S13 and T11–T18 resolved.

## Functionality Findings

No findings. Verified on the real repo: W6 refuses none of the 21 `trustedSql` templates
(36 substitutions); the assignment trigger adds no builder; no `REFERENCES` clause names a
digest column in the three SQL roots.

## Security Findings

- S14 Minor (design) — a qualifier name could be "a substitution", which re-admits
  `${t}.${sqlIdentifier("to_jsonb")}`. **Resolved**: a qualifier name must be a declared
  column; no real template uses `${x}.${y}`.
- S15 Minor (design) — a comment in the template text could supply the relation keyword to
  the mint. **Resolved**: a part holding a comment marker directly before a table is refused.
- S16 Minor (prose) — builders that spell the key as a string argument were not triggers.
  **Resolved**: a string literal passed as a call's argument is a write key.
- S17 Minor (design) — `INSERT ... VALUES` with a scalar subquery copies a digest.
  **Resolved**: plain only without `SELECT` and without `ON CONFLICT ... DO UPDATE`.

## Testing Findings

- T19 Minor (design) — W4/W5 and W2/W6 could co-fire, so a per-rule red proof could be
  empty. **Resolved**: a substitution qualifier is W6's alone; W4's string-argument cells
  name no token table; each rule is red-proved alone.
- T20 Minor (design) — W6 was outside I-C3a and A-9c; the `INTO ${t} (` exception and "word
  character" were undefined. **Resolved** in C3.

## Adjacent Findings

None.

## Quality Warnings

None.

## Saturation call

Round 3 is the exit round. Three rounds are complete. No Critical or Major finding is open:
every finding of rounds 1–3 is reflected in the plan, and none carries a Skipped, Accepted
or Out-of-scope disposition. The six round-3 findings were labelled by their experts as
five `design` and one `prose`, all Minor, all against text added in round 2, and all are
now in the plan; none remains to carry forward, so the plan has no
`Carried-Forward Plan Findings` section. The count per round (29, 17, 6) and the severity
(12 Major, 7 Major, 0 Major) both fell, and the last two rounds found nothing against the
round-1 design. A further round would review round 3's six small edits. The contracts are
locked and work proceeds to Phase 2, where the cells and red proofs test those edits
directly.

## Recurring Issue Check

### Functionality expert

R1–R3 Checked. R4–R16 N/A. R17–R19 Checked. R20–R21 N/A. R22 Checked. R23–R28 N/A.
R29 Checked — figures reproduce. R30–R33 N/A. R34 Checked. R35 N/A. R36 Checked.
R37–R41 N/A. R42–R50 Checked — no issue (R47/R48: W6 and the mint divide the work).
R51 N/A. R52 Checked. R53–R57 N/A.

### Security expert

R1–R2 N/A, R3 OK, R4–R17 N/A, R18 OK, R19–R28 N/A, R29 OK, R30 N/A, R31 OK, R32 N/A,
R33 OK, R34–R35 N/A, R36 OK, R37–R41 N/A, R42 Finding (S16), R43 OK, R44 N/A, R45 OK,
R46 OK, R47 Finding (S15), R48 Finding (S15), R49 OK (no new overclaim), R50–R51 N/A,
R52 OK, R53–R57 N/A. RS1–RS3 N/A, RS4 OK, RS5–RS6 N/A.

### Testing expert

R1–R3 Checked. R4–R9 N/A. R10 Checked. R11–R15 N/A. R16–R19 Checked. R20–R28 N/A.
R29 Checked. R30–R32 N/A. R33–R34 Checked. R35 N/A. R36 Checked. R37–R39 N/A.
R40–R46 Checked. R47 Finding T20. R48 Finding T19. R49–R50 Checked. R51 N/A.
R52 Finding T20. R53 Checked. R54 N/A. R55 Checked. R56–R57 N/A.
RT1 N/A. RT2–RT6 Checked. RT7 Finding T19. RT8–RT9 Checked. RT10 Finding T20. RT11 Checked.
