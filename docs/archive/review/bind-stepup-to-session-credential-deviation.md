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
