# Code Review: bearer-passkey-gate-coverage

Plan: `bearer-passkey-gate-coverage-plan.md` · Deviation log: `bearer-passkey-gate-coverage-deviation.md`
Branch: `fix/bearer-passkey-gate-coverage` (issue #964)

Three experts (functionality, security, testing) reviewed the branch diff against `origin/main`,
then each round's incremental diff. Every finding below was reproduced by its reporter on scratch
copies; fixes carry cells and red proofs recorded in the deviation log's per-round sections.

## Seed Finding Disposition

Seed unavailable: the local LLM pre-screen could not run (Ollama not reachable), so the experts
started without seed findings.

## Round 1 — commit `52b377f95`

Functionality and Testing were restarted from scratch for this round (the first pair of agents was
stopped before reporting).

| ID | Sev. | Finding | Resolution |
|---|---|---|---|
| F1 | Major | A comment marker in an earlier template part hid the relation keyword from the table-position test; the static W6 rule missed the same template | Fixed (mint + W6); superseded by the round-3 mechanism |
| F2 | Minor | Stale `nonBearerHashFields` entries were not detected | Fixed |
| F3 | Minor | Line-based schema scan missed multi-line and `fields:` forms | Fixed; superseded by the round-3 mechanism |
| F4 | Minor | A self-recursive builder counted its own call as a site | Fixed |
| S18 | Minor | W5 treated `$` as a word character, so a table name inside a dollar-quoted body passed | Fixed |
| S19 | Minor | A `DO` block executing a CREATE/ALTER of an object did not qualify its file | Fixed; 0 real hits |
| T1–T22 | Minor | 22 gate arms with no cell (surviving mutants) | Cells added; `createMany` in `SCALAR_WRITE_OPS` removed as dead code |

## Round 2 — commit `645e01bb0`

| ID | Sev. | Finding | Resolution |
|---|---|---|---|
| F5 / T23 | Major | Regression from round 1: the covered-span guard was removed as "redundant", so `{ tokenHash: "tokenHash" }` passed unlisted | Guard restored; cells per spelling; equivalence claim corrected in the log |
| S20 / F6 | Major | Schema scan stripped `//` and counted brackets inside string literals; an ordinary URL default silently disabled later checks | Fixed; superseded by the round-3 mechanism |
| S21 | Minor | A fragment holding a comment marker hid the keyword across fragments | Template-wide refusal (`RAW_SQL_COMMENT_MARKER`); superseded by the assembled-text test |
| T24 | Minor | Column-0 attribute continuation not joined | Fixed |
| T25 | Minor | Missing allow twins on new arms | Cells added |

## Round 3 — commit `3124399b6`

Two areas had been bypassed in three consecutive rounds each (table-position composition:
F1 → S21 → F7/S23; schema scan: F3 → S20/F6 → T26/S22), so each got a different mechanism
instead of another case.

| ID | Sev. | Finding | Resolution |
|---|---|---|---|
| F7 | Major | A comment marker assembled across a substitution (or by `joinSql`) passed the per-part test | Comment-marker test now runs on the assembled text of every `trustedSql` and `joinSql` result |
| T26 | Major | String-aware scanner fed string-unaware patterns: a `)` inside a relation name hid `references: [tokenHash]` | One pre-pass reduces the schema to code (comments removed, strings emptied); every later step reads only that |
| S22 | Minor | An indented `model`/`view` header was invisible to the scan and to the shared loader | Fatal: indented block header, indented closing brace, brace on a later line, unclosed bracket |
| S23 | Minor | A FROM-syntax function split across two fragments renders a table as a value past both layers | Function-call form closed in round 4 (S25); keyword-only split stays declared in plan SC4 |
| T27 | Minor | Missing cells; a vacuous allow cell; refusal-code values unpinned; one orphan cell | Fixed |

## Round 4

Functionality: no defects (one note, F8: the W6 `-`/`/` hole adjacency also refuses
`${col}->>'k'` and `${x}/2`; no real template is affected and a space around the operator passes —
left as is, the rule is deliberately the simple one).

| ID | Sev. | Finding | Resolution |
|---|---|---|---|
| S24 | Minor | Unique-hash membership missed `@id`, `@@id([...])` and `@@unique(name: …, fields: […])` | See "Round 4 fixes" in the deviation log |
| S25 | Minor | SC4's cost line overstated for the cross-fragment case; a paren-balance rule closes the function-call form cheaply | See "Round 4 fixes" in the deviation log |
| T28 | Minor | No cell detects a `//` comment swallowing the rest of the schema | Cell added |
| T29 | Minor | No cell for an unterminated string at end of file (mutant loops forever) | Cell added |

## Declared residuals (not findings)

Plan SC1–SC7. SC4 was reworded during review to name the cross-fragment shape that remains open.

## Recurring Issue Checks

- R3 (propagation): header, `raw-sql-usage.txt` and manifest agree with code after each round.
- R42 (member sets): `TOKEN_TABLE_NAMES` pinned against 13 literals independently of the array and
  against the schema by the gate; unique-hash member set widened in round 4 (S24).
- R47/R49 (fail-open scan input): schema scan and SQL-file scan fail closed on shapes they cannot
  read (round 3).
- R55 (sentinel collision): the U+E000 refusal still holds for literals and SQL files.
- Equivalence claims for removed code are proven by mutation in both directions after the F5
  regression (deviation log, rounds 2–3).

## Environment Verification Report

- VE1 (CI `static-checks` has no generated Prisma client): the gate still runs on ts-morph without
  a Program and reads `prisma/schema.prisma` as text; no generated artifact is imported.
- Local verification results on the final tree are recorded in the deviation log and the PR body,
  including the two environmental pre-pr failures (shared dev database carrying another branch's
  migrations; `backup-db.test.mjs` Group B in a git worktree).

## Resolution Status

All Critical/Major findings resolved. Minor findings resolved or, for the keyword-only
cross-fragment split, declared in plan SC4 with worst case, likelihood and cost.
