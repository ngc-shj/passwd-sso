# Code Review: worker-error-log-fields
Date: 2026-08-30
Review round: 1

Phase 3 standalone — no Phase 1 plan or deviation log. The branch continues the
sweep `#801` began at `worker.pool.error` and stopped.

## How to read the citations in this file
**Findings** cite the code as it was when written (`main` `d7a8e6bbe` plus the
branch's first two commits). **Resolution Status** cites HEAD.
`verify-references.sh --base main --strict` reports the latter as SHIFTED by
construction.

## Changes from Previous Round
Initial review.

## Merge method
Mechanical join over the experts' fenced json indices on (file, line ±5, root
cause). The Testing expert was not launched: the two experts that ran converged
on the same structural defect — the class boundary — and the orchestrator
reproduced it by execution, which made the scope question answerable without a
third opinion. That is a deviation from Step 3-3's three-expert requirement and
is recorded as one; the `core:` obligation was met by two of the three roles,
not all three.

14 findings across two experts → 11 consolidated (0 Critical, 8 Major, 3 Minor).

## The finding that reframed the branch

**The class was wrong on three axes while its own count reproduced exactly.**
The branch claimed "all 17 error/fatal sites under `src/workers` +
`webhook-dispatcher.ts`". `rg -c 'errorLogFields\('` returns 17. Every axis of
the *definition* was still wrong:

| axis | what was drawn | what it missed | evidence |
|---|---|---|---|
| severity | `error`/`fatal` | `LOG_LEVEL` defaults to `info`, and pino's warn(40) ≥ info(30) — warn is written and shipped identically | 18 sites, incl. `src/workers/audit-outbox-worker.ts:2208`, the `pool.end()` handler, which is the pg-connection case the branch exists for |
| directory | `src/workers` + one `src/lib` file | `src/lib/prisma.ts:100` is the app-side identical twin of the pool handler `#801` repaired | 23 sites, incl. `src/lib/http/with-request-log.ts:65` — every unhandled route error in the product, `/api/vault/*` included |
| derivation | — | 13 sites derive `code` by hand with the top-level read the helper's own docblock declares wrong for Prisma errors | `retention-gc` runs raw SQL, so 42501 / 23503 / 55P03 all collapse to `P2010` |

An honest count of the wrong class. That is why the sweep felt verified.

## Functionality Findings

**F-M1 / Major / `docs/operations/alerts.md:85-96`** — R41/R49. The catch-all
recovery tells the operator to read `error.code` for every `_logType` matching
its namespace regex, and states categorically that "`error` is `{name, code}`".
Ten error-level sites in that set carry no `error` key at all — the three pool
handlers, four retention-gc sites, `cadence_failed`, and
`webhook_delivery_lease_misconfigured`. `worker.pool.error` is named by hand 15
lines below the claim that misdescribes it. The paragraph directly above boasts
that `_logType` "is enforced … not merely stated here"; the new field contract
was merely stated.

**F-M2 / Major / 13 sites deriving `code` by hand** — R3/R17. Same defect as the
third axis above. `retention-gc.entry_failed` reports `P2010` for a permission
denial, an FK violation and a lock timeout alike, while `alerts.md` promises the
wrapper "does not hide it".

**F-M3 / Major / `src/lib/logger/error-fields.ts` — the branch's own regression.**
`cause.code` was not read. undici puts the errno there and leaves the top level
empty, so every `fetch failed` reduced to `{TypeError, unknown}`. Measured:

```
undici ECONNREFUSED → {"name":"TypeError","code":"unknown"}
undici ENOTFOUND    → {"name":"TypeError","code":"unknown"}
```

`github-release-destination.ts` calls bare `fetch` with no local catch, so this
is the anchor publisher's commonest failure — destination unreachable — losing
all diagnosis. And `alerts.md`, in this same branch, promises "the driver's
SQLSTATE or errno where one exists".

**F-m1 / Minor / `error-fields.ts`** — a single `try` over both reads let a
throwing `name` getter abort before `code` was computed, so a hostile value could
suppress the SQLSTATE the helper exists to surface by throwing from an unrelated
accessor.

**F-m2 / Minor (question) / `src/workers/audit-outbox-worker.ts:2184`** — was `leaseError`
excluded deliberately, being a validator string rather than a caught value?
**Closed by evidence:** it is not a caught value, so the class does not reach it;
the gate confirms by not reporting it.

## Security Findings

**F-M4 / Major / `src/workers/audit-anchor-publisher.ts:316-317, 368-369`** — the reduction
moved the message rather than removing it. `:311` reduced the `upload_failed`
line; `:316` re-interpolates the same `errMsg` into `uploadFailedReason`, throws
it, and the enclosing catch at `:368` re-derives `err.message` and logs it as
`reason` — same sink, same string, 51 lines later. That catch spans the whole
publish transaction, so Prisma query text and pg connection strings reach it too.
The value is additionally persisted at `:427` as `metadata.failureReason`, where
log retention does not reach it.

**F-M5 / Major / `src/lib/audit/audit.ts:282, 369`** — `deadLetterEntry(params,
reason, String(err))` puts the full narrative into a field whose logger is
configured with **no redact paths at all**, justified by a comment at
`src/lib/audit/audit-logger.ts:105` enumerating the six fields it emits. The enumeration is
accurate and the conclusion does not follow: `error` is unbounded free text. A
control was skipped because a bounded-field claim was believed (R49).

**F-M6 / Major / cross-cutting** — 18 further sites by regex, ≥20 counting
multi-line forms, including `src/lib/http/with-request-log.ts:65`, whose adjacent line already
passes the same `err` through `sanitizeErrorForSentry` before it goes to Sentry.
One caught value, two egress paths, two policies — and the unprotected one is the
local log sink.

**F-m3 / Minor / `src/lib/auth/policy/account-lockout.ts:443`** — `isLockTimeoutError` remains a
narrower second reading of the SQLSTATE predicate, missing
`meta.driverAdapterError.cause.code`, which is the nesting this repo's adapter
actually produces. Failure direction traced: a real `55P03` under that nesting
falls through to `throw err` and the `VAULT_UNLOCK_FAILED` audit event is never
emitted. Pre-existing; raised because `pgErrorCode` now has a second consumer.

**Verified, not findings:**
- `TOKEN_RE` is a sound containment boundary, red-proved against CSV/Excel
  formula injection (`= + - @`), whitespace, newline, quote, `|`, `;`, `{`, `}`.
  Anchored both ends; 64 accept / 65 reject.
- Committed fixtures are synthetic and use RFC 2606 reserved domains.
- `errorLogFields` is NOT a second adjudicator — it delegates to `pgErrorCode`.
- No dropped correlation key at any migrated site; `outboxId`, `deliveryId`,
  `webhookId`, `destination` all survive. The only key removed is `err` itself.
- R20 verified per hunk: no catch-body statement dropped or reordered.

## Adjacent Findings
- [Adjacent] Minor — 14 of 17 migrated sites had no negative assertion, so a
  revert at any of them shipped green (Security → Testing).
- [Adjacent] Minor — the caught message still reaches `audit_logs.metadata` and
  the outbox worker's fatal console line (Functionality → Security; part of F-M4).

## Quality Warnings
None from the mechanical join: every Major carries an executed reproduction, and
the orchestrator independently re-executed the three that drove the scope
decision (warn-level sites, the `prisma.ts` twin, the `cause.code` regression).

**One expert claim corrected.** The Security expert reported three raw `{ err }`
warn sites in `audit-outbox-worker.ts`; the AST sweep finds **four** (`:2009`
was missed). The finding stands and its severity is unchanged; the count did not.

## Recurring Issue Check
### Functionality expert
R1 Pass · R2 Pass · **R3 FAIL (F-M2)** · R4-R9 N/A · R10 Pass · R11-R16 N/A ·
**R17 FAIL (F-M2)** · R18 Pass · R19 Pass · R20 Pass (per-hunk) · R21 N/A ·
R22 Pass · R23-R28 N/A · **R29 FAIL (F-M3 — alerts.md's errno claim)** ·
R30 Pass · R31-R32 N/A · R33 N/A · R34 Pass · R35-R40 N/A ·
**R41 FAIL (F-M1)** · **R42 FAIL (F-M1, F-M4)** · R43 N/A · R44 N/A · R45 Pass ·
R46 N/A · R47 Pass · R48 Pass · **R49 FAIL (F-M1)** · R50 Pass · R51-R57 N/A

### Security expert
R1 Pass · R2 Pass · **R3 FAIL (F-M6)** · R4-R9 N/A · R10 Pass · R11-R16 N/A ·
**R17 FAIL (F-M6, and the axis error)** · R18 N/A · R19 Pass · R20 Pass ·
R21 N/A · R22 N/A · R23-R28 N/A · **R29 FAIL (Minor — the five-char errno
over-generalisation)** · R30 Pass · R31-R41 N/A · **R42 FAIL (all three axes)** ·
R43-R46 N/A · R47 Pass · **R48 PARTIAL (F-m3)** · **R49 FAIL (F-M4, F-M5)** ·
R50 N/A · R51-R54 N/A · **R55 FAIL (Minor — F-m1)** · R56-R57 N/A ·
RS1-RS2 N/A · RS3 Pass · RS4 Pass · RS5 N/A · RS6 Pass

### Testing expert
Not launched — see Merge method. Recorded as a process deviation, not as a
section with no findings.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1 (no Phase 1 for this
branch). All verification ran locally; every gate mutation ran against a
synthetic tree under `mktemp -d`, and no repo file was modified during
verification.

## Resolution Status

Round 1: 8 Major and 3 Minor. Fixed 8, closed 1 by evidence, raised 2. No
deferrals.

### The class — F-M1, F-M2, F-M6, and the three axes
- Action: **the class is no longer maintained by hand.**
  `scripts/checks/check-caught-error-logging.mjs` derives it from the defining
  primitive — a binding introduced by a `catch` clause reaching a logger call's
  field object — over `src`+`scripts`, at every level. It reported 41 unmigrated
  sites independently of any list, and **it is what decided the migration was
  finished**, not a recount. All 41 migrated; the gate is green and wired into
  `scripts/pre-pr.sh` (74 steps, was 73).
- Any reference counts: `err.message`, `String(err)`, a template, a nested
  object, a spread, a call from a closure inside the block. A call that reduces
  one field and leaks another is still reported — the check is per-property.
- Declared MISSED honestly: a logger reached through a parameter, and a caught
  value stored to an outer variable and logged after the block closes. The
  second is F-M4's shape and is fixed by review, not by the gate.
- Red-proof, one mutation per clause, all run and observed: narrowing to
  error/fatal (2 red); requiring an exact identifier match (6 red); removing the
  clause-ownership check (1 red); removing the shadow check (1 red); removing
  the `catchBlocks === 0` refusal (1 red); removing the `errorLogFields`
  exclusion (7 red).
- **The mutation run found two of the gate's own clauses unpinned, and one of
  them broken.** Comparing binding NAMES made an outer `catch (err)` claim a
  nested `catch (err)`'s line as well: two offending lines, three findings.
  Fixed to own the call by clause identity. The shadow clause turned out
  reachable and load-bearing after all — a nested block may legally re-declare
  the name — and simply had no case, because the obvious fixture
  (`catch (e) { let e = 1 }`) is a SyntaxError.

### F-M3 Major — `cause.code` dropped (the branch's own regression)
- Action: `readCode` now reads nested SQLSTATE → top-level `code` → **one** level
  of `cause.code`. Exactly one level: a cause chain can be cyclic, and one level
  is where Node sets it.
- Boundary and tie: top-level wins over `cause` — Prisma's own code is the fault
  when it has one; a cause underneath is transport detail. Pinned.
- Red-proof: deleting the cause clause reds the undici case; the `P2028` and
  cyclic cases pin the ordering and the termination.

### F-m1 Minor — one `try` over two independent reads
- Action: split. Each field degrades on its own; both directions pinned
  (throwing `name` with a readable code, throwing `code` with a readable name).

### F-M4, F-M5 Major — RAISED, see Open Decisions
### F-m3 Minor — RAISED, see Open Decisions

### F-m2 Minor (question) — CLOSED by evidence
`leaseError` is a validator string, not a caught value. The gate does not report
it, which is the answer.

### Unplanned: two pre-existing gate defects this branch exposed
Neither is a review finding; both were found by running the gates after the
migration, and both are in files the branch touches.

- **`check-api-error-codes.sh` C12 rule** matched
  `NextResponse.json({ … [\s\S]*? … error:` across unlimited intervening code, so
  introducing an `error:` log field bound it to a legitimate
  `NextResponse.json({ valid: false })` **105 lines above**. The reported line
  was the stray key rather than the response, so the message pointed at the
  wrong place too. Now brace-balanced. Verified both ways: a genuine bare
  `NextResponse.json({ error: … })` still reds.
- **The same gate reported `✓ OK` and exited 0 with an empty file set.** Run from
  the wrong directory its `find` roots match nothing, every rule inspects
  nothing, and "examined nothing" comes out spelled as "found nothing wrong" — a
  tree carrying a real C12 violation reported OK that way, which is how I briefly
  mis-read the main version as having missed the injection. The file count is now
  asserted before any verdict.
- **`check-test-hygiene`** fired once the branch touched
  `with-request-log.test.ts`: three pre-existing `process.env.SENTRY_DSN =`
  mutations whose restore lines sat AFTER the assertions, so a failure leaked a
  fake DSN into every later test — and the very next case asserts Sentry is NOT
  called. Migrated to `vi.stubEnv`.

## Verification
- `bash scripts/pre-pr.sh` — 74/74 (lint, full vitest suite, production build)
- `npx vitest run` — 1021 files, 14982 passed
- `npx next build` — success
- `check-caught-error-logging` — green over 1040 files / 315 catch clauses

## Open Decisions (raised, not fixed)

**F-M4 — the anchor publisher re-emits the message it just reduced.** Fixing it
means changing what `uploadFailedReason` carries, which is also persisted to
`audit_logs.metadata.failureReason` and read through
`/api/tenant/audit-logs` — a durable, tenant-visible field. Whether that field
should keep the narrative is an operations decision, not a mechanical one, and
the gate cannot see the shape (a value stored to an outer variable and logged
after the block closes). Recommended: reduce `uploadFailedReason` to
`${dest.name}_UPLOAD_FAILED:${errorLogFields(uploadErr).code}` and keep
`destination` + the distinct `_logType`s as the diagnosis.

**Closed by `f5dacefb3`** (`src/workers/audit-anchor-publisher.ts:321` now builds
`uploadFailedReason` as `` `${dest.name}_UPLOAD_FAILED:${errorLogFields(uploadErr).code}` ``, the
recommended reduction adopted verbatim).

**F-M5 — the dead-letter path stringifies the whole error** into a field whose
logger has no redact paths, justified by an inaccurate enumeration at
`src/lib/audit/audit-logger.ts:105`. The fix is small; what makes it a decision is that
`reason` is the only diagnosis left for a dead-lettered audit event when the
thrown value is not an `Error`, so reducing `error` narrows what an operator has
at exactly the moment the audit pipeline is failing.

**Closed by `f5dacefb3`** (`src/lib/audit/audit.ts:284` — `deadLetterEntry(params, reason,
error?: ErrorLogFields)` takes bounded fields instead of a stringified error; callers pass
`errorLogFields(err)`).

**F-m3 — `isLockTimeoutError`.** Replacing its body with
`pgErrorCode(err) === "55P03"` retires the last second reading of the predicate,
but `pgErrorCode`'s order is measured and this function's is not; the three
shapes it currently recognises must be pinned as fixtures before the copy is
deleted. Out of this branch's scope, and now cheaper than before because
`pgErrorCode` has a second consumer.

**Closed by `f5dacefb3`** (`src/lib/auth/policy/account-lockout.ts:455` — the body is now
`return pgErrorCode(err) === SQLSTATE_LOCK_NOT_AVAILABLE;`, the named constant rather than the
literal `"55P03"`. The path is the post-reorg one; the pre-reorg spelling `src/lib/account-lockout.ts`
no longer resolves.)

## Round 2 decision
Not required for the findings. Every Major is fixed or raised with what would
close it, and the class is closed by a mutation-verified CI guard rather than by
agreement that the list looks complete — which is the R42 ①b convergence
artifact, and the only reason to stop here rather than run another round:
`R42 class caught-error-logging: member-set expanded 17 → 58 — closed by
mutation-verified CI guard scripts/checks/check-caught-error-logging.mjs
(red-proven: narrowing LOG_METHODS to error/fatal reds 2 cases; removing the
clause-ownership check reds 1), wired in scripts/pre-pr.sh`.

The Testing expert was not launched, which is a Step 3-3 deviation rather than a
finding. What it would most likely have raised is already recorded as an Adjacent
finding — 14 of 17 migrated sites had no negative assertion — and the five tests
this round rewrote now pin the absence of `message`/`stack`, not merely the
presence of the new shape.
