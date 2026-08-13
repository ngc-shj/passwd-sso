# Coding Deviation Log: bind-stepup-to-session-credential

Phase 2. Every entry is a place where the implementation departed from the locked plan, or where a
plan-stage judgement turned out to be wrong once the code existed. Sections implemented as planned
are not recorded here.

## D1 — A cross-user binding check was added to `C4` step 1 (not in the plan)

**What changed**: `src/app/api/auth/passkey/reauth/verify/route.ts` now selects
`authCredential.userId` alongside `credentialId` and fails closed as `no_binding`, recording no
credential id, when the binding resolves to a credential owned by a different user.

**Why**: the plan's Step 2-1 storage verification considered a composite FK to
`(id, tenant_id)` and **declined** it, on the stated ground that "the only writer reads the
credential row from the verified assertion scoped to the session's own user". That is an assumption
about the writer, not a constraint the schema imposes — PostgreSQL performs referential-integrity
checks outside row security and across no user or tenant predicate. The plan therefore left a
declared invariant with nothing enforcing it (R49). Batch E's integration test then built a fixture
on exactly that path (a credential row owned by another user, reachable by the session's relation
JOIN and by no `{id, userId}`-scoped query), which demonstrated the state is constructible. Without
the check, `boundCredentialId` in this user's audit metadata would carry another user's identifier.

**Evidence the guard is live**: adding it reddened 13 existing route tests whose mocks did not yet
carry `authCredential.userId` — the mocks were then aligned with the production `select` (RT1).
A dedicated test covers the case: `reauth/verify/route.test.ts` → "denies a binding that resolves
to another user's credential, and records no id for it", asserting the status, the audit `reason`,
`boundCredentialId: null`, and that the other user's id appears nowhere in the emitted metadata.
The mutation used to confirm the guard's reachability was written to the scratchpad, never to the
production file; the real file was verified byte-identical afterwards.

## D2 — `credential_missing` is not deterministically reachable at the integration tier

**What changed**: the integration case Batch E wrote as "bound credential unreachable by the
user-scoped lookup → `credential_missing`" now asserts `no_binding` instead, and its comment records
why the original reason is unreachable there.

**Why**: `D1`'s guard catches the cross-user construction earlier, so that substitute no longer
reaches `credential_missing`. Re-deriving what can reach it: for a **same-user** binding, any
credential deletion that commits before step 1's read has already nulled `auth_credential_id`
through `ON DELETE SET NULL` — which is `no_binding`. So `credential_missing` requires the deletion
to land between step 1's read and the `{id, userId}` lookup inside the same transaction: the genuine
race the plan's `C4` ordering table row 2 describes, and a window this suite cannot schedule.
Batch E reported the same conclusion independently before `D1` existed, and declined to fake it.

**Disposition**: the reason stays in the code and keeps its route-tier test (mocked verifier), which
is where the classification — not the crypto — is under test. This is a narrowing of what the
integration tier claims, not a loss of coverage: the tier never could reach that state.

## D3 — `BASE64URL_RE` accepted the empty string, and existed twice

**What changed**: the new shared constant in `src/lib/validations/common.server.ts` was
`/^[A-Za-z0-9_-]*$/` (zero-or-more) — it would have passed an empty string as a valid credential id.
Corrected to `+`. The pre-existing local duplicate in `src/app/api/mobile/authorize/route.ts` was
removed in favour of importing the shared one.

**Why**: caught by the cross-batch symbol-deduplication check, which surfaced the same name in two
files with **different** semantics. The consolidation is one import line and removes a duplicate
this change itself created by adding a shared constant beside an existing local one (R1). The
mobile route's behaviour is unchanged — it already used `+`; its 131 tests pass.

## D4 — Three `eslint-disable` + fifteen `as any` casts were replaced, not accepted

**What changed**: `src/lib/auth/webauthn/verify-authentication-assertion.test.ts` came back from
Batch B with `tx as any` at every call site and three `eslint-disable-next-line
@typescript-eslint/no-explicit-any` comments. The stub is now typed once at its definition
(`as unknown as TxOrPrisma`), matching the convention at `src/lib/tenant/tenant-management.test.ts:45`,
and the file contains zero suppressions and zero `any`.

**Why**: a suppression is not a fix (R36), and the root cause was a missing return-type annotation
on the stub factory, not an unavoidable type mismatch. The remaining deliberate cast — an assertion
object with `id` removed, to reach the missing-credential-id branch — is now
`as unknown as AuthenticationResponseJSON` with the reason stated inline.

## D5 — Deferred parity gap: 2 CI gates have no local pre-PR equivalent

> **Corrected in round 4 — this entry originally said seven, and five of them were wired all
> along.** The claim was derived by grepping `pre-pr.sh` for the `npm run check:*` alias names;
> `pre-pr.sh` invokes the checkers by script path instead, so the grep returned nothing and the
> absence looked real. Deriving a member set from the spelling a caller happens to use is the same
> mistake D15 is about, made in prose. Re-derived by reading both files: `check-team-auth-rls`
> (`scripts/pre-pr.sh:332`), `check-bypass-rls` (`:333`), `check-crypto-domains` (`:338`),
> `check-migration-drift` (`:339`) and `tsc --noEmit` (`:812`) are all in the pre-PR batch.

`bash scripts/check-state-mutation-centralization.sh` (`.github/workflows/ci.yml:324`) and the three
`licenses:check:*:strict` scripts (`.github/workflows/ci.yml:797-799`) are executed by CI but not by
`scripts/pre-pr.sh` — grep for `state-mutation` or `licenses` in that file returns nothing.

**Anti-Deferral check**: out of scope (different feature).
**Justification** — worst case: a CI-only failure surfaces after push, costing one push round;
likelihood: low for this branch specifically, because both were run by hand in Step 2-4 and again in
round 4, and passed; cost to fix: adding two entries to `pre-pr.sh`'s bounded-parallel batch
scheduler, which is a tooling change with its own review surface and no relation to this security
fix — bundling it here would mix two unrelated diffs.
**Tracked**: `TODO(bind-stepup-to-session-credential): 2 CI gates absent from scripts/pre-pr.sh`
in the plan's Implementation Checklist.
**Orchestrator sign-off**: the "out of scope (different feature)" exception is satisfied, and the
gap is neutralised for this branch by running both gates manually.

## D6 — The plan's forbidden-pattern spec gained a comment-line exclusion

**What changed**: `C3`/`C4`'s `?? undefined` forbidden pattern is now specified as matching code
lines only.

**Why**: the conformance grep fired on two hits, both inside comments that explain *why* the
optional Prisma filter is forbidden. Per the Anti-Deferral rule on check false-positives, the fix is
to make the check comment-aware rather than to rephrase the documentation around its blind spot —
a forbidden pattern must not match its own fix. Code-line matches: zero.

## D7 — `prisma migrate dev` blocked after applying the migration; no reset was permitted

`npm run db:migrate` (`prisma migrate dev`) blocked with no output in this non-interactive
environment — the path where it can prompt to **reset** the database. It was not allowed to
continue. The migration had in fact already applied (`_prisma_migrations` shows
`20260811120000_add_session_auth_credential_id` finished, `applied_steps_count = 1`), and the result
was verified directly against the live database: the column exists, the FK
`sessions_auth_credential_id_fkey` has `confdeltype = 'n'` (SET NULL), and both new `AuditAction`
enum values are present. No reset was performed and no data was destroyed.

## D8 — `refactor-phase-verify --force` fails locally on a stale, gitignored baseline; no rebase was needed

Running the CI gate `node scripts/refactor-phase-verify.mjs --force` locally reports
"Branch is stale vs origin/main — expected 88c8a859e…, current 3b4dd5284…, rebase and re-run".
Investigated rather than obeyed:

- `88c8a859e` comes from `.refactor-phase-verify-baseline`, which is **gitignored**
  (`.gitignore:127`) and was last written on 2026-06-07 by an earlier refactor phase. It is a
  local-environment artifact, not a repo fact.
- This branch is **not** stale: `git ls-remote origin refs/heads/main` and `origin/main` both read
  `3b4dd5284`, and `git log HEAD..origin/main` is empty. Nothing to rebase onto.
- In CI the baseline file does not exist, so the gate takes its first-run branch, records the
  current SHA and passes — the behaviour a previous piece of work already documented at
  `docs/archive/review/stale-override-floors-deviation.md:93`.
- The path `scripts/pre-pr.sh` actually invokes (`--skip-merge-queue-guards`) exits 0.

**Disposition**: left untouched. Deleting or rewriting another developer's stale local baseline is
an environment change with no bearing on this branch, and the gate is green on both the CI path and
the pre-PR path. Recorded here so the red is not mistaken for a real staleness problem next time.

Process note on how this was diagnosed: the first reading of the gate's status was taken through
`| tail -8`, which reported exit 0 while the gate itself had exited 1 — the R44 trap, walked into
and then corrected by re-running the gate unpiped. Every other gate result in Step 2-4 was captured
from the command's own exit status.

## D9 — The I9 integration test was renamed to what it actually proves

**What changed**: `reauth-credential-binding.integration.test.ts`'s "I9" case was titled
"a credential deleted while a ceremony is outstanding cannot be substituted by another credential"
and its comment credited the split verifier's scoped lookup. Phase 3 review demonstrated that
claim false by execution: an instrumented probe showed `verifyAssertionForCredential` is never
called in that test, and swapping the route to `verifyAssertionAnyCredential` — the exact
regression `C4` exists to prevent — left it green.

**Why**: the deletion commits before the route runs, so `ON DELETE SET NULL` has already nulled
the binding and step 3 denies first. The test is a genuine FK-cascade→route integration check; it
is not evidence about the verifier.

**Disposition**: renamed to name the step-3 gate, comment rewritten to say what it does and does
not prove, and two assertions added so it cannot be re-read as verifier evidence — the audit
`reason` is pinned to `no_binding` and the Redis challenge is asserted still present (I9b). The
substitution defense is proven where it lives: `verify-authentication-assertion.test.ts`'s DENY
case against the real verifier, and the "bound row present, wrong credential presented"
integration case. I9's true concurrent interleaving is not schedulable in this harness, the same
conclusion D2 reached for `credential_missing` and for the same reason.

## D10 — `check-bypass-rls.mjs`'s fixed scan radius was replaced with an extent walk

**What changed**: the gate scanned only 10 lines after each `withBypassRls(` call for
`tx.<model>.` references. Phase 3 review showed by injection that the three callbacks this branch
lengthened put their most security-relevant model access 8 to 67 lines past that window, so an
unlisted model there still exited 0. The window is now a balanced-delimiter walk of the call's own
extent, comment-only matches are skipped (`src/auth.ts:66` names the helper in prose), and a call
whose extent cannot be determined now **fails** the gate by name instead of silently falling back.

**Why it is in this branch rather than deferred**: the three files whose callbacks outgrew the
window are this branch's own, and the entry the plan added for
`recent-current-auth-method.ts` was unenforced without this — the allowlist edit and the gate that
enforces it are one change.

**Red-proof**: injecting `tx.someUnauthorizedModel.` at the previously-invisible line of each of
the three files makes the gate exit 1 in all three cases; the real tree still exits 0. Mutations
were applied to scratchpad-backed copies and the files verified byte-identical afterwards.

**Two pre-existing members it surfaced**, both legitimate and both previously invisible:
`src/app/api/user/mcp-tokens/route.ts` genuinely uses `mcpRefreshToken`, `delegationSession` and
`auditLog` in its bulk-revoke callback — the sibling `[id]/route.ts` entry has listed exactly those
for as long as it has existed — so the parent entry was extended to match. This is the expected
shape of widening a verifier: the class is derived over the verifier's inputs, not its call sites,
so members that were always in the class become visible at once.

## D11 — Two Implementation-Checklist test files needed no edit

`src/app/[locale]/auth/signin/page.test.ts` and `page.basepath.test.ts` are named under `C5` in the
Implementation Checklist and are absent from the diff. Both mock
`@/lib/auth/session/recent-current-auth-method` at the module boundary and neither changed
function's signature changed, so they compile and pass unmodified — re-run this round, 25/25 pass.
Their existing "passes `canUsePasskey=false` to the panel when the session cannot recover" case
still covers the UI's half of the contract, and the predicate's own behaviour is covered at the
unit and integration tiers. Recorded because the checklist is read as a change manifest: a file
listed there and missing from the diff must be explained rather than left to look overlooked.

## D12 — The migration's recorded checksum was re-synced after the file was wrapped

Wrapping the migration in `BEGIN`/`COMMIT` changed the file's bytes after it had already been
applied to the dev database, so `_prisma_migrations.checksum` (a SHA-256 of the file, recorded once
at apply time) no longer matched: recorded `1842111f…`, file `c694b2ec…`. Phase 3 review measured
both and flagged it. Left alone, the next `npm run db:migrate` on any database that applied the
pre-wrap file is blocked.

Re-synced with a targeted metadata update on the dev database and verified equal afterwards, and
`prisma migrate status` reports the schema up to date. Fresh databases (CI, new clones, production)
are unaffected — they apply the wrapped file and record the matching checksum on first apply.
**Any other environment that applied the pre-wrap file needs the same one-line re-sync**; on the
`mrx33` verification host that is:

```sql
UPDATE _prisma_migrations
SET checksum = 'c694b2ec5dac801c8db3f5495a3b0327e99451aeb22147634abfe5c19eab4f3c'
WHERE migration_name = '20260811120000_add_session_auth_credential_id';
```

## D13 — The E2E dialog-selection spec has not been executed; the blocker is pre-existing and environmental

The plan puts `e2e/tests/step-up-credential-binding.spec.ts` **in scope, not deferred** (`SC5`
covers only the virtual-authenticator work). Phase 3 review correctly refused to classify it as
either verified or a legitimate deferral, so it was attempted rather than argued about.

Attempted with a dedicated dev server (`NEXT_PUBLIC_BASE_PATH=""`, port 3099, the existing server on
3000 untouched — `.env` sets a basePath and that server does not answer on localhost, both of which
would make the default `E2E_BASE_URL` 404). Playwright's own exit status: 1. It never reached this
branch's spec: `globalSetup` fails on the **first, pre-existing** fixture user with
`new row violates row-level security policy for table "users"` at `e2e/helpers/db.ts:206`
(`seedVaultReadyUser`, `global-setup.ts:68`) — the seeding role does not set the RLS bypass GUC, and
`users` has forced row-level security. That blocks **every** E2E spec in this repo locally, not this
one, and predates this branch.

Not fixed here: making the E2E seeding harness work against a forced-RLS local database is its own
change, it touches how tests bypass RLS (security-adjacent), and it belongs to no contract in this
plan. Teardown ran cleanly — `select count(*) from users where email like 'e2e-%@test.local'` → 0,
port 3099 released.

**Where it will actually run**: the CI `e2e` job (`.github/workflows/ci.yml:491`) triggers on
`e2e/**` changes and runs `npm run test:e2e`; this branch touches `e2e/**`, so the spec executes on
the PR. That is the gate, and a red result there is blocking.

**Anti-Deferral check**: acceptable risk, quantified. Worst case: a defect in the spec itself
(selector, locale, timing) or in the dialog-selection wiring surfaces on the PR's own CI run rather
than during review. Likelihood: moderate for the spec, low for the wiring — the wiring's decision is
covered at the unit tier (all four `use-inline-reauth` outcomes, both `operator-token-card` codes)
and the integration tier (the gate/predicate against a real DB). Cost to fix locally: repairing the
E2E seed path for forced RLS, unbounded from here and unrelated to this branch.
**Tracked**: `TODO(bind-stepup-to-session-credential): D13 — run step-up-credential-binding.spec.ts;
local E2E seeding is blocked by forced RLS on users`.

## D14 — Replacing the gate's scanner a third time, and one flaky pre-PR gate

**The gate's mechanism was escalated, not patched again.** `check-bypass-rls.mjs`'s model scan has
now been wrong three times, each time one level down from the last:

1. a fixed 10-line radius — stopped covering callbacks as they grew (round-1 finding M2);
2. a regex deciding "is this a comment?" — skipped a real call whose line held a string containing
   `//`, and skipped it *entirely*, escaping even the fail-loud net (round-2 finding SEC-5);
3. a hand-rolled character automaton — misread a `/` inside a regex character class (`/[/*]/`) as
   opening a block comment and blanked the rest of the file, and blinded the model scan to code
   inside a template interpolation that the original raw-text scan had seen (round-3 SEC-7, SEC-8).

Each fix was a better guess about the grammar. Three escapes on the same predicate is the signal to
change the mechanism rather than add another case, so the scan now reads the parse tree via
`scripts/checks/lib/ast-project.mjs` — the ts-morph helper the other AST gates in this repo already
use (`grep -l ast-project scripts/checks/*.mjs` → nine siblings; the "five" this entry originally
claimed was a derived number nobody re-ran), and which documents its own no-Program rationale. A call is a call because the parser says so,
its extent is `getStart()`..`getEnd()` with nothing to balance, and `tx.model` inside `${…}` is code
because it is code. Comments, strings and regex literals are out of scope structurally.

The fail-loud property was kept in a form the new mechanism can support: if the raw text calls the
helper but no `withBypassRls` identifier survives in the tree, the parse lost the code and the file
is named as unscanned. The old "extent could not be determined" case has no analogue — the parser
recovers from truncation and still yields the call — so its test now asserts that stronger outcome
instead. `PRISMA_MODEL_RE` and the extent walker were deleted rather than left unused.

The gate now carries **13 tests** where it had none for this logic, including both round-3
regressions as fixtures. Red-proof, run against the previous implementation: the round-2 lexer exits
**0** (blind) on both the regex-literal and template-interpolation fixtures; the AST version exits
**1** and names the model.

> **Superseded by D15.** Two claims in the paragraphs above are false and were corrected in round 4,
> both by execution. The fail-loud net could not fire for any file that imports the helper, because
> the import specifier is itself a surviving `withBypassRls` identifier — so a syntax error that
> swallowed a real call exited 0. And the parser does *not* always recover: an unterminated template
> literal yields zero call expressions. The "13 tests" figure counted the whole file; 10 covered this
> logic, 3 were the unrelated F3 scan.

## D15 — The AST move was applied to one predicate; four siblings kept judging code by its spelling

**What changed**: `scripts/checks/check-bypass-rls.mjs` now answers *every* code question from the
parse tree. Previously D14 moved only the model scan, leaving the file filter, the call-site test,
the client-identifier test, the tx-less (C2) check, the F3 unused-`tx` scan and the fail-loud net on
raw text or on name equality.

**Why**: round 4 reviewed D14's own commit and all three lanes converged on the same shape. Six
inputs, each demonstrated against the shipped gate before anything was written:

| Input | round-3 verdict | now |
|---|---|---|
| `import { withBypassRls as wb }` … `wb(prisma, …)` in a file **not** on the allowlist | exit 0 | exit 1 |
| syntax error (unterminated template) swallowing a real call in an importing file | exit 0 — `OK` | exit 1, named unscanned |
| callback parameter named `db` instead of `tx`, reaching an unlisted model | exit 0 | exit 1 |
| unlisted model inside a nested `tx.$transaction(async (inner) => …)` | exit 0 | exit 1 |
| unlisted model inside a callback passed by name (`withBypassRls(prisma, run, …)`) | exit 0 | exit 1 |
| compliant `(tx) =>` call whose comment quotes the banned `() =>` form | exit 1 (**false**) | exit 0 |

The first two are the serious pair. The alias case escaped the **file** allowlist, not just the model
one — the filter required the literal text `withBypassRls(`, which an aliased import does not
contain. The syntax-error case is D14's fail-loud net failing on exactly the population it was
written for. The last row is a regression D14 introduced: it moved the C2 check from comment-blanked
text to raw text, so documenting the banned shape beside a call — this repo's own comment style —
reddened the build.

**The rule this file now states, and the reason it is stated as a rule**: not "use the AST for the
scan" but *no predicate in this file decides a code question by surface form*. Four defects in four
rounds were all the same defect, and the round-3 fix closed the instance rather than the class —
which is how the fifth arrived. One raw-text test remains, and is named in the header as a prefilter
that only chooses which files to parse, never a verdict; it is deliberately a superset (238 files
parsed instead of 88, whole gate ~0.7 s).

**Two pre-existing issues this surfaced rather than fixed**, both recorded in `INDIRECT_CALLBACK_ALLOWLIST`
with the reason: `src/app/api/vault/status/route.ts:25` and `src/app/api/vault/unlock/data/route.ts:57`
pass `withTenantRls` a callback that is their own wrapper's `fn` parameter, so nothing about its
shape or its model access is visible from those files. The wrapper's `fn: () => Promise<T>` contract
is itself the tx-less form C2 forbids, one level up. Allowlisted so the gate is honest about what it
did not examine and a *new* such site must be reviewed; fixing the routes is its own change.
`TODO(bind-stepup-to-session-credential): D15 — vault route wrappers use the tx-less fn() contract`

**Evidence**: 25 tests (up from 13), 25/25 pass. Eleven mutations were applied one at a time to a
scratchpad copy, each reddening a different clause: prefilter, client-name set, nested-`$transaction`
traversal, by-name callback resolution, the unresolvable-callback report, the tx-less check (both
directions), the F3 predicate, the fail-loud net, and `.tsx` scanning. Where a mutant still exits 1
for the wrong reason — dropping by-name resolution turns a model catch into an unresolved-callback
report — the test discriminates on the message, not the status, which is why those assertions name
the string. **Coverage differential over the real tree** (all 93 allowlist entries emptied, both
implementations run, `(file, model)` pairs compared): nothing lost against round 3, two gains, both
in `passkey-enforcement.ts`'s by-name callback. One pair present in the *round-2* raw-text scan is
absent from both AST versions — `src/lib/notification.ts:78` (`prisma.notification`), which is
`typeof tx.notification.create` inside a `Parameters<…>` type query. A type position is not a runtime
access; the model is allowlisted regardless. Examined and accepted, not a loss.

**A flaky pre-PR gate, recorded rather than dismissed.** One `scripts/pre-pr.sh` run failed on
"Extension: Test" with an unhandled `ReferenceError: window is not defined` at teardown. Evidence
that it is not this branch's: `git diff --name-only main...HEAD | grep -c '^extension/'` → **0**; the
extension suite passes 940/940 on three consecutive isolated runs; and the next full pre-PR run
returned 70/70, exit 0. It looks like a teardown-time unhandled rejection that only surfaces under
pre-pr's bounded-parallel scheduling. Not investigated further here — it is unrelated to this change
and would be its own piece of work — but it is a real flake in an authoritative gate and should not
be discovered again from scratch.
`TODO(bind-stepup-to-session-credential): D14 — extension suite flake under pre-pr parallelism`

## D16 — Round 4's fix repeated the failure it diagnosed, and this entry names what is still open

**What changed**: `scripts/checks/check-bypass-rls.mjs` — `callbackOf` now resolves a by-name
callback against the bindings *visible from the call* rather than against the whole file;
`declaresUnusedTx` and `clientNamesIn` read the parameter's own binding instead of the spelling
`tx`; the import-specifier test matches the module rather than a text tail; a destructured client's
bound properties are read as model accesses; a present-but-empty `src/` refuses to report OK; and
the gate prints its parsed-file count on the success path.

**Why**: round 5 reviewed round 4's commit and found the same defect class one level down — plus
one regression round 4 introduced. `callbackOf` accepted a name when exactly one *function-valued*
binding of it existed anywhere in the file, so an unrelated `const job = async (tx) => …` in a
sibling function resolved a `job` that actually referred to the enclosing function's own parameter.
The gate then scanned a body the call never runs and printed OK, **in place of** the "could not be
resolved" report round 4 had just added. Adding six lines of unrelated code turned a fail-loud
report into a silent pass. Executed both ways: with the decoy exit 0, without it exit 1.

Round 4's header declared "no predicate in this file decides a code question by surface form" while
`declaresUnusedTx` compared `getName() !== "tx"` and Check 2 compared `getText() === "BYPASS_PURPOSE"`.
Declaring the class closed is what made round 5 necessary to find the rest, so the header now
carries the list of known gaps instead of the claim.

**Numbers corrected** (R29): the prefilter parses **238** files, not the 154 stated in the header,
D15 and the round-4 review record — 154 was the count of files importing `@/lib/tenant-rls`, not the
regex's match count. The gate now prints the figure at runtime so it cannot rot again. The
`ast-project.mjs` adopter note was wrong on both its load-bearing claims: `isScannableSourceFile`
already excludes `src/lib/tenant-rls.test.ts`, and the two exclusion predicates select the *same*
1011 files out of 2066 — the only real difference is missing-root behaviour, which is now the sole
recorded reason.

**Deliberately left open, with the reason** (all four are pre-existing classes the gate does not
make worse than `main`, each its own change):

1. **Check 2 (`BYPASS_PURPOSE`) is file-scoped, not call-scoped.** One `BYPASS_PURPOSE.X` anywhere
   satisfies it for every call in the file, and its receiver test is name equality, so an aliased
   import is a false positive. Verified: a file whose only call site passes `"audit-drain"` exits 0
   when an unrelated `BYPASS_PURPOSE.AUDIT` sits elsewhere. Audited the real tree — 193 call sites,
   0 without a `BYPASS_PURPOSE.*` argument, so nothing is live.
2. **A renaming re-export defeats the prefilter.** `export { withBypassRls as wb } from "@/lib/tenant-rls"`
   leaves the caller's text naming neither the helper nor the module, so the file is never parsed and
   escapes the file allowlist. Verified exit 0. No such re-export exists today
   (`rg 'export .*from.*tenant-rls' src/` is empty).
3. **The scan root is `src/` only.** `scripts/tenant-domain.ts` (6 call sites, runs against a live
   database) and `scripts/manual-tests/share-access-audit.ts` (5 tx-less `withBypassRls`) are
   examined by nothing. Extending the root would surface 11+ unreviewed bypasses — real work, and
   not this branch's.
4. **`INDIRECT_CALLBACK_ALLOWLIST` is keyed by file**, so a new unresolvable call site inside an
   already-listed file is excused without review.

`TODO(bind-stepup-to-session-credential): D16 — four declared gaps in check-bypass-rls.mjs`

**Anti-Deferral check**: out of scope (different feature) for 1–4.
**Justification** — worst case: an RLS bypass reaches main unreviewed through one of the four
shapes; likelihood: low for gaps 1, 2 and 4, which require a code shape absent from the tree today (verified), and for gap 3 the 11 live call sites listed above are deferred on SCOPE, not on non-occurrence — they are unreviewed now and stay so until that work is done; all four
are now named in the file's own header where the next editor reads them; cost to fix: (1) and (4)
are contained but change the gate's verdict surface again, (2) needs a two-pass prefilter or a
companion no-re-export gate, (3) surfaces 11+ pre-existing unreviewed call sites that need their own
security review — none belongs in a branch whose subject is step-up credential binding.
**Orchestrator sign-off**: this is the fifth consecutive round whose findings were in the previous
round's fix, all inside one CI gate that this branch touched only because contract `C5`'s allowlist
entries needed enforcing. The branch's actual subject — contracts C1–C7 across 45 routes — has been
clean in all three lanes for four consecutive rounds. Continuing to rewrite this gate inside this
branch trades a converging security fix for a diverging tooling change, so the remaining gaps are
declared rather than closed, on the user's explicit decision.

**Evidence**: 33 tests (up from 25), 33/33 pass; full suite 1008 files / 14560 passed. Seven
mutations applied singly to a scratchpad copy, each reddening a different clause — scope filter,
`FunctionDeclaration` indexing, destructured-model extraction, the `tx` name gate, the
property-name exclusion, the specifier regex, and the empty-corpus refusal. Two of them still exit 1
under mutation and are discriminated by message rather than status (`FunctionDeclaration` turns a
model catch into an unresolved report), which is why those assertions name the string. Coverage
differential against round 4 over the real tree with all 93 allowlist entries emptied: **279 pairs
both sides, nothing lost, nothing gained** — every fix addresses a shape the tree does not yet
contain, which is the point of a gate.

## D17 — Round 6 corrections to D15/D16, and what the perf claim actually cost

**What changed**: `scripts/checks/check-bypass-rls.mjs` — `bindingIndex` keys each destructuring
binding by the names it binds rather than by its pattern text, and is built lazily; `callbackOf`
refuses a parameter's default value, a `let`/`var` binding and a bodyless declaration;
`destructuredModelRefs` skips rest elements and nested patterns while `clientNamesIn` takes the rest
binding as a receiver; the F3 message names the offending parameter; the success line divides by the
scannable set. `scripts/__tests__/check-bypass-rls.test.mjs` uses `spawnSync` so stderr is real on
both exit paths.

**Why**: the scoped verification round found two fail-opens in D16's own fix. `getInitializer()` on
a `Parameter` returns its **default**, so a callback with a default was scanned instead of the one
the caller passes — `drain(async (tx) => tx.user.deleteMany())` exited 0. And `getName()` on a
destructuring binding returns the pattern text, so `bindingIndex` filed it under a name nothing can
match; an unrelated same-named `const` then resolved as unique. D16 fixed exactly this
`getName()`-on-a-pattern mistake in two other functions and reintroduced it in the one it added.

**Two claims corrected** (R29, second consecutive round on my own prose):

1. *"~0.7 s, unchanged from before the widening"* — measured **0.656 → 0.797 s**, about +25%,
   repeated in four places including the R45 verification verdict. Cause: `bindingIndex` ran for all
   238 parsed files while only 3 consult it. Fixed by making the claim true — the index is now lazy
   and the gate measures **0.67–0.69 s**, against Round 4's 0.68.
2. *"each requires a code shape that does not occur today"* (D16's Anti-Deferral justification) —
   true for gaps 1, 2 and 4, **false for gap 3**, whose 11 live call sites the same entry lists
   eleven lines earlier. Re-derived: `scripts/tenant-domain.ts` 6 + `scripts/manual-tests/share-access-audit.ts`
   5 = 11. The justification is now per-gap, and gap 3 is deferred on **scope**, not on
   non-occurrence.

The four D16 gaps are unchanged and still open by the user's decision.

**Evidence**: 40 tests (up from 33), 40/40; full suite 1008 files / 14567 passed; real tree exit 0.
Seven single-clause mutations, each reddening a different case. One is stated as not independently
observable: a `Parameter` has no `getVariableStatement`, so the `const`-only refusal already excludes
it and the explicit kind check is intent, not a second guard — recorded rather than claimed. Coverage
differential against D16's gate, all 93 allowlist entries emptied: 279 pairs both sides, nothing lost.

## D18 — An external security review found a fifth gap the header presented as a complete list

**What changed**: `clientNamesIn` and `destructuredModelRefs` are replaced by `clientBindingsIn`,
which follows the bypassed client through assignment to a fixpoint instead of recognising it only
under the callback parameter's own name.

**Why**: the client reaches a model under more than one spelling, and the gate followed only two of
them. Reported and reproduced:

```ts
withBypassRls(prisma, async (tx) => {
  const db = tx;
  return db.tenantMember.findMany();   // exit 0 — unlisted model, not reported
}, BYPASS_PURPOSE.AUDIT);
```

Three shapes, all exit 0 before, all exit 1 now: a plain alias (`const db = tx`), a chain
(`const a = tx; const b = a;`), and a delegate lifted off the client in the body
(`const { tenantMember } = tx`). The allow side — an alias and a destructured delegate that stay
inside the allowlist — stays exit 0, which is what stops the fix being "report every local binding".

**The part that matters more than the code.** D16 and this file's header presented four gaps as the
complete set of what the gate does not cover, and this was a fifth. The enumeration was derived over
*the shapes the previous rounds had found*, not over *the ways a value can reach a model access* —
the same class-derivation error that has now produced findings in six consecutive rounds, this time
in the prose that was supposed to compensate for it. The header no longer says "all four"; it names
what is followed, names what is not (an initializer that is not a plain identifier — `cond ? tx :
prisma`, a client returned by a helper), and says explicitly that the list is the current best
enumeration rather than a closed one.

**Evidence**: 45 tests (up from 40), 45/45; full suite 1008 files / 14572 passed; real tree exit 0;
lint 0, typecheck 0, the four CI-only gates 0. Four single-clause mutations, each reddening a
different case: alias tracking (1→0 on `const db = tx`), body destructuring (1→0 on
`const { tenantMember } = tx`), the fixpoint (1→0 on an alias declared textually before the client it
derives from — a forward chain resolves in one pass, so that ordering is what makes the loop
observable), and the allow-side fixture held at 0 under the alias mutation. Runtime 0.67–0.70 s,
unchanged. Coverage differential against D17's gate with all 93 allowlist entries emptied: 279 pairs
both sides, nothing lost.

The four D16 gaps remain open by the user's decision; this one is closed rather than declared
because it was reachable by a one-line edit inside an already-allowlisted callback.

## D19 — Two more client-flow escapes, and the boundary that makes the analysis usable

**What changed**: `clientBindingsIn` follows the bypassed client through the whole file rather than
only the callback, through plain assignments as well as initializers, and through a choice between
clients; nested `$transaction` parameters get the same destructuring treatment as the outer one; and
the file-wide collection is hoisted behind a lazy per-file index.

**Why**: a second external review reproduced three more shapes, all exit 0 before:

```ts
const db = prisma;                       // module scope — prisma is the Proxy, so this
withBypassRls(prisma, async (tx) => db.tenantMember.findMany(), P);   // is a bypassed client too

withBypassRls(prisma, async (tx) => { let db; db = tx; return db.tenantMember.findMany(); }, P);

withBypassRls(prisma, async (tx) =>
  tx.$transaction(async ({ tenantMember }) => tenantMember.findMany()), P);
```

The first is the one that matters: the alias lived outside the callback, and the fixpoint only
walked the callback. The third was my own inconsistency — `spreadPattern` was applied to the outer
callback parameter and not to the nested one, so `"{ tenantMember }"` was registered as a *client
name* and the model went unrecorded.

**The suggestion I did not take, and why.** The review proposed failing closed on "expressions that
contain a known client but cannot be analysed". Measured on this tree: **131** such initializers,
essentially all of the shape `const user = await tx.user.findUnique(...)` — a query *result*, not a
client. Implemented as proposed it would red the build on nearly every real callback. Proven rather
than argued: a mention-based variant run against the real tree reports `prisma.map`,
`prisma.ownerId`, `prisma.userId` — properties of result objects, named as Prisma models.

So the decidable slice is implemented instead: a value is a client when it *is* one, or is a choice
between them (`cond ? tx : prisma`, `maybe ?? tx`, through parens/casts). A client returned by a
helper (`const db = wrap(tx)`) stays unfollowed — undecidable without type resolution, which this
gate runs without by design — and is named in the header. The query-result boundary is pinned by its
own test, because it is what keeps the analysis usable.

**Evidence**: 51 tests (up from 45), 51/51; full suite 1008 files / 14578 passed; real tree exit 0;
lint 0, typecheck 0, four CI-only gates 0. Five single-clause mutations, each reddening a different
case: file-wide scan → callback-only (1→0 on the outer alias), assignment tracking off (1→0), nested
`$transaction` pattern → `getName()` (1→0), conditional flow off (1→0), and `yieldsClient` widened to
mention-based (the query-result allow case 0→1). Coverage differential with all 93 allowlist entries
emptied: 279 pairs both sides, nothing lost.

**Performance, measured rather than asserted** — the previous round shipped a false "unchanged" here,
so: 0.68 s before this change, **0.73 s** after, with both the binding index and the new flow index
built lazily and once per file. Collecting the flow index per *call* instead cost 0.83 s, and the
~7% that remains is the tracking itself. The header carries the same numbers and the instruction to
re-measure rather than re-copy.

## D20 — Two client ORIGINS, and the header contradicting its own implementation

**What changed**: `clientBindingsIn` seeds the client set from the call's own first argument, and
`flowIndex` collects `Parameter` nodes so a parameter default is evaluated by the existing
`yieldsClient`. The header's known-limitations list is corrected.

**Why**: a third external review found the flow analysis correct but its *origins* incomplete. Both
shapes are decidable from the tree — neither needs the type resolution the header cites as the
reason for the remaining limit:

```ts
import { prisma as db } from "@/lib/prisma";
withBypassRls(db, async (tx) => db.tenantMember.findMany(), P);   // exit 0 before

async function drain(db = prisma) {
  return withBypassRls(prisma, async (tx) => db.tenantMember.findMany(), P);   // exit 0 before
}
```

The first is the cleaner miss: the client set was seeded from the literal string `"prisma"`, so a
client imported under any other name was invisible — while the helper's own signature says the
**first argument is the client**, which needs no inference at all. The second required adding
`Parameter` to the flow index.

**A deliberate asymmetry, recorded so it does not read as a contradiction**: `callbackOf` REFUSES a
parameter's default (guessing which function runs is fail-open), while client tracking ACCEPTS one
(over-approximating a client only reports more models, which is fail-closed). Same construct,
opposite direction, because the questions differ.

**The header was wrong about its own implementation** (R29, and the fourth round in which the
correction lands in prose rather than code): it still listed `const db = cond ? tx : prisma` as not
followed after D19 implemented exactly that, and cited "D16/D18" after D19 existed. A stale
limitation is worse than none — the next editor reads it as a designed boundary and builds on it.
The list now names only the genuine remaining limit (a client returned by a call, which needs types),
enumerates what IS followed, and says outright that three successive reviews each found a member
missing from it — the same class-derivation failure as the code defects, committed in the prose
written to compensate for them.

**Evidence**: 54 tests (up from 51), 54/54; full suite 1008 files / 14581 passed; real tree exit 0;
lint 0, typecheck 0, four CI-only gates 0; runtime 0.74 s, unchanged from D19's measurement. Two
single-clause mutations, each reddening its own case: client-argument seeding off (1→0 on the
aliased import), parameter-default tracking off (1→0). Both allow siblings — an aliased-import client
and a parameter default that stay inside the allowlist — hold at exit 0. Coverage differential with
all 93 allowlist entries emptied: 279 pairs both sides, nothing lost.

## D21 — Generalising the client argument, and a phantom performance regression

**What changed**: a client is now identified by its **expression text** rather than by a bare name.
`clientExprText` reduces type-level wrappers (`db as typeof db`, `(db)`, `db!`, `db satisfies X`) and
accepts a member access, so `clients.prisma` from a namespace import is tracked like any other
client. A first argument that reduces to neither — `withBypassRls(getClient(), …)` — is now
**reported** rather than scanned with an incomplete client set. The internal comment that still
listed `cond ? tx : prisma` as unfollowed is corrected.

**Why**: a fourth external review found the flow analysis and its origins correct but the argument's
*form* over-restricted. Both shapes exit 0 before, exit 1 now, and neither needs type resolution:

```ts
withBypassRls(db as typeof db, async (tx) => db.tenantMember.findMany(), P);
withBypassRls(clients.prisma, async (tx) => clients.prisma.tenantMember.findMany(), P);
```

The real tree's first arguments are 314 `prisma` and 2 `dbClient`, all bare identifiers, so the
generalisation and the new fail-loud path both cost nothing today. The `dbClient` pair is the
aliased-import shape D20 closed — this codebase already does it.

**A comment contradicting the implementation, for the second round running.** D20 corrected the file
header; the doc comment on `clientBindingsIn` still said conditionals were not followed. Same defect,
adjacent lines, one round later. Both now describe what the code does, and the header says plainly
that four successive reviews each found a member missing from its list.

**The phantom regression, recorded because it nearly cost a wrong fix.** The gate measured 0.74 s
before this change and 1.10 s after, so a fast path was added to `modelRefsIn` and a second reduction
helper written to avoid `getText()` on member accesses. Neither moved the number. Measured properly —
the previous commit and this one **interleaved** — both run 0.98–1.15 s: the machine was under load,
and there was no regression at all. The second helper was reverted (two reduction functions that must
agree is the drift shape this file keeps suffering); the single kind guard in `modelRefsIn` stayed.
The comment now refuses to state an absolute figure and says to compare interleaved builds, because
this file has now produced a false "unchanged" in one direction and a phantom regression in the other,
both from trusting a number written down earlier.

**Evidence**: 58 tests (up from 54), 58/58; full suite 1008 files / 14585 passed; real tree exit 0;
lint 0, typecheck 0, four CI-only gates 0. Four single-clause mutations: wrapper unwrapping off and
member-access clients off both redden their tests **by message** — the mutants fall into the new
fail-loud path, so they exit 1 for a different reason, which is the correct degradation; the
unresolved-client report off (1→0); and the allow-side namespace fixture under the member-access
mutation (0→1). Coverage differential with all 93 allowlist entries emptied: 279 pairs both sides,
nothing lost.
