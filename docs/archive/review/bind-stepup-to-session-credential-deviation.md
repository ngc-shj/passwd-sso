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

## D5 — Deferred parity gap: 7 CI gates have no local pre-PR equivalent

`npm run typecheck`, `npm run check:bypass-rls`, `npm run check:migration-drift`,
`npm run check:crypto-domains`, `npm run check:team-auth-rls`,
`bash scripts/check-state-mutation-centralization.sh`, and the three `licenses:check:*:strict`
scripts are executed by CI but not by `scripts/pre-pr.sh`.

**Anti-Deferral check**: out of scope (different feature).
**Justification** — worst case: a CI-only failure surfaces after push, costing one push round;
likelihood: low for this branch specifically, because all seven were run by hand in Step 2-4 and
passed; cost to fix: adding seven entries to `pre-pr.sh`'s bounded-parallel batch scheduler, which
is a tooling change with its own review surface and no relation to this security fix — bundling it
here would mix two unrelated diffs.
**Tracked**: `TODO(bind-stepup-to-session-credential): 7 CI gates absent from scripts/pre-pr.sh`
in the plan's Implementation Checklist.
**Orchestrator sign-off**: the "out of scope (different feature)" exception is satisfied, and the
gap is neutralised for this branch by running every gate manually.

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
`scripts/checks/lib/ast-project.mjs` — the ts-morph helper five sibling gates in this repo already
use, and which documents its own no-Program rationale. A call is a call because the parser says so,
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

**A flaky pre-PR gate, recorded rather than dismissed.** One `scripts/pre-pr.sh` run failed on
"Extension: Test" with an unhandled `ReferenceError: window is not defined` at teardown. Evidence
that it is not this branch's: `git diff --name-only main...HEAD | grep -c '^extension/'` → **0**; the
extension suite passes 940/940 on three consecutive isolated runs; and the next full pre-PR run
returned 70/70, exit 0. It looks like a teardown-time unhandled rejection that only surfaces under
pre-pr's bounded-parallel scheduling. Not investigated further here — it is unrelated to this change
and would be its own piece of work — but it is a real flake in an authoritative gate and should not
be discovered again from scratch.
`TODO(bind-stepup-to-session-credential): D14 — extension suite flake under pre-pr parallelism`
