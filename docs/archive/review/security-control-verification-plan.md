# Plan: security-control-verification

Branch: `security/control-verification`
Origin: external codebase evaluation (2026-07) cross-verified against repo measurements. Three
adopted workstreams: (A) security-gate self-test coverage, (B) destructive-wrapper derivation,
(C) crypto key/AAD version state-transition hardening + integration tests.

## Project context

- Type: web app (Next.js 16 App Router) + workers + multi-client (extension / iOS / CLI)
- Test infrastructure: unit (vitest) + real-DB integration (`vitest.integration.config.ts`,
  local Postgres via docker compose — running) + Playwright E2E + CI/CD (GitHub Actions)
- Verification environment constraints:
  - **VE1** Real-DB integration tests: local Postgres available (`passwd-sso-db-1` healthy);
    CI has an integration job. Classification: `verifiable-local` + `verifiable-CI`.
  - **VE2** Master-key execute partial-failure (C9b): the failing statement is
    `passwordShare.updateMany` inside `withBypassRls`. Injecting a real mid-transaction DB
    failure requires a fault seam. Real-DB injection is possible via a session-scoped
    statement_timeout or a revoked-permission role, but both distort the code path.
    Classification: `verifiable-local` for the CAS/terminal-state assertions;
    the thrown-after-CAS branch itself is verified at unit level with a mocked share-revocation
    step (existing mock-test idiom for this route). Anti-deferral justification recorded at C9b.
  - **VE3** E2E (browser) rotation flows already covered by `e2e/tests/settings-key-rotation.spec.ts`;
    new server-side guards are asserted at unit + integration level, no new E2E needed.

## Objective

Convert the externally-identified residual risk classes into machine-enforced controls:

1. Every security gate in `scripts/checks/` is proven able to fail (RT7 applied to the gates
   themselves), enforced by a meta-gate so future gates cannot land untested.
2. The destructive-primitive wrapper list in `route-class-patterns.json` becomes code-derived
   instead of manually curated (closes the new-wrapper evasion path in the step-up guard).
3. The personal-vault key-version state machine gets the server-side guard the team side already
   has (stale `keyVersion` writes rejected), closing a data-loss race between entry writes and
   key rotation; the remaining unc covered rotation/CAS state transitions get real-DB tests.

## Requirements

Functional:
- New guards fail closed; violations exit non-zero in CI with one machine-greppable line per hit.
- Stale-key writes to personal entries return the standard error envelope with a stable code.
- No behavior change for well-behaved clients (current web/extension/iOS/CLI always send the
  vault's current keyVersion after unlock).

Non-functional:
- All new checks wired into `scripts/pre-pr.sh` static section (single source shared with the CI
  `static-checks` job via `PRE_PR_STATIC_ONLY=1` — R33).
- Allowlist/debt files require a non-trivial `# reason` per entry, rejected otherwise (same parse
  contract as `stepup-delete-exempt.txt`).
- Race tests must prove contention actually occurred (RT4) — no vacuous passes.

## Technical approach

### Plan-stage real-DB probe (concurrency obligation) — EXECUTED

Probe run 2026-07-17 against the actual dev stack (pg driver, same as the Prisma `@prisma/adapter-pg`
pool; no intermediate pooler in this deployment):

```
(1) default transaction_isolation: read committed
(2) FOR UPDATE + UPDATE proceeded while advisory lock held: NOT BLOCKED (race window real)
(3) second advisory lock on same key blocked as expected: canceling statement due to statement timeout
```

Command: two `pg.Client` connections; A: `BEGIN; SELECT pg_advisory_xact_lock(hashtext('probe-user'))`;
B: `SELECT ... FOR UPDATE` + `UPDATE` on a scratch row (2 s statement_timeout) → succeeded;
B: same advisory key → blocked. Conclusions:
- The rotation advisory lock serializes rotation-vs-rotation and rotation-vs-migration ONLY.
  It does NOT serialize rotation vs entry PUT/create — the gap-6 race window is real.
- Isolation is `read committed`; the design below therefore relies on explicit row locks
  (`FOR UPDATE` / `FOR SHARE`) and CAS predicates, never on isolation-level upgrades
  (project precedent: Prisma proxy drops nested tx `isolationLevel` options; the codebase
  standardized on `pg_advisory_xact_lock` + row locks).

### Workstream A — gate self-test coverage

Meta-gate mirroring `check-fail-closed-routes-have-test.sh`: every executable check must have a
sibling test in `scripts/__tests__/` or a reasoned debt entry. Negative tests for the 8
security-relevant untested gates use the established fixture pattern (env-override scan roots,
as `STEPUP_GUARD_API_DIR` does); overrides default to production paths, are set only by tests.

### Workstream B — destructive-wrapper derivation

`route-class-patterns.json#deleteSignal` mixes raw Prisma primitives with hand-added wrapper
names (`executeVaultReset`, `deleteTeamPassword`). A new check derives the wrapper set from
code: scan non-route production sources for the raw primitives, resolve the enclosing exported
function (ts-morph, no Program — established in `ast-guards.ts`), and require each to be either
matched by `deleteSignal` (so calling routes classify as destructive) or allowlisted with reason
(worker-only paths point at `worker-policy-manifest.json`). Inverse direction detects stale
wrapper names in `deleteSignal` that no longer exist in code.

### Workstream C — key-version state machine

Server-side current-version guard for personal entries (mirrors team `TEAM_KEY_VERSION_MISMATCH`),
with an explicit lock-ordering design to close the read-committed TOCTOU:

- **Lock order invariant (all personal-vault transactions): `users` row first, `password_entries`
  rows second.** Both sides acquire in this order, so no deadlock cycle:
  - Entry write tx (blob path): `SELECT key_version FROM users WHERE id = $userId FOR SHARE`
    → compare → then the existing `FOR UPDATE` on the entry row → history snapshot → update.
    (Today the entry `FOR UPDATE` comes first; it moves after the user read.)
  - Rotation tx: `advisoryXactLock(tx, userId)` (unchanged, first) → NEW
    `SELECT key_version FROM users WHERE id = $userId FOR UPDATE` → existing guards/updates.
- Effect: a rotation blocks at its user-row lock while any in-flight guarded write holds
  `FOR SHARE`; a guarded write that starts after rotation's lock blocks until rotation commits
  and then reads the NEW version → 409. No interleaving can commit a stale-version row or an
  un-rekeyed history row (the mid-rotation history-insert hole is closed by the same lock).
- Rejection: HTTP 409, new code `KEY_VERSION_MISMATCH` in `api-error-codes.ts` (sibling of
  `TEAM_KEY_VERSION_MISMATCH`).

Core invariant (app-enforced): *outside an in-flight rotation transaction, every committed
`password_entries` / `password_entry_history` row has `key_version == users.key_version` for its
owner (rows predating the versioning epoch excluded).* Why app-enforced rather than
schema-enforced: a cross-table trigger would have to be a DEFERRABLE CONSTRAINT TRIGGER (the
rotation tx legitimately holds entries at N+1 while `users` is still at N mid-transaction),
adding migration + RLS interplay complexity; recorded as possible future hardening, out of scope
(SC5).

## Contracts

### C1 — meta-gate: `scripts/checks/check-gate-selftest-coverage.sh`

- Signature: bash; env overrides `GATE_SELFTEST_CHECKS_DIR`, `GATE_SELFTEST_TESTS_DIR`,
  `GATE_SELFTEST_DEBT_FILE` (defaults: `scripts/checks`, `scripts/__tests__`,
  `scripts/checks/gate-selftest-debt.txt`). Exit 0 pass / 1 fail; one
  `MISSING_GATE_SELFTEST: <path>` line per offending check; `DEBT_ENTRY_WITHOUT_REASON: <line>`
  for malformed debt entries (fail closed, like the step-up exempt parser).
- Member-set derivation (R42): class = executable security gates. Defining primitive part 1:
  `ls scripts/checks/*.sh scripts/checks/*.mjs` → 32 files today (18 without sibling tests —
  enumerated at C2/C3). Sibling test = `scripts/__tests__/<base>.test.mjs` or `.test.ts`
  (both patterns exist today: `check-state-mutation-centralization.test.ts`).
- **Defining primitive part 2 (sec-F9): inline `run_step "..." bash -c '...'` gates in
  `scripts/pre-pr.sh`** (~20 today: `master-key-rotation-execute-cas`, `dcr-public-only-literal`,
  `client-secret-hash-non-null`, `prf-salt-immutable`, etc. — all security controls). Anchoring
  the member set on the `scripts/checks/` directory alone lets a new gate evade the meta-gate by
  being written inline. The meta-gate therefore ALSO parses `pre-pr.sh` `run_step` lines and, for
  each inline `bash -c` gate, requires EITHER extraction into a tested `scripts/checks/` file
  OR a reasoned debt entry. This round does not extract the existing ~20 (out of scope, SC7) —
  they are seeded into the debt file with a one-line reason each so the anti-evasion guarantee
  holds going forward; the plan records the count explicitly rather than silently excluding them.
- **Stale-entry anti-drift (sec-F5, mirrors `check-permanent-delete-stepup.sh` STALE_EXEMPT):**
  every debt entry naming a check/gate that no longer exists (file deleted, or inline gate
  removed, or a test since added) → `STALE_DEBT_ENTRY: <entry>` exit 1. Keeps the allowlist from
  rotting into silent coverage gaps.
- Wiring: `run_step "Static: gate-selftest-coverage" ...` in `scripts/pre-pr.sh` static section
  (propagates to CI static-checks — R33). No separate npm script needed (matches the other
  pre-pr-only checks).
- Self-test (RT7): `scripts/__tests__/check-gate-selftest-coverage.test.mjs` — fixture dirs:
  (a) check without test and without debt entry → exit 1 + `MISSING_GATE_SELFTEST`;
  (b) debt entry without `# reason` → exit 1; (c) fully covered → exit 0.
- Acceptance: running against the real repo passes once C2+C3 land; deleting any new test file
  makes it fail.

### C2 — negative tests for the 8 security-relevant untested gates

Member set (derived: checks in `scripts/checks` with no `scripts/__tests__/<base>.test.*`,
security-classified):

| # | Gate | Violating fixture (must exit 1) | Clean fixture (exit 0) |
|---|------|--------------------------------|------------------------|
| 1 | `check-actions-sha-pinned.sh` | workflow using `actions/checkout@v4` tag | SHA-pinned workflow |
| 2 | `check-team-auth-rls.mjs` | fixture source violating its team-auth/RLS pairing rule | conforming fixture |
| 3 | `check-migration-drift.mjs` | migrations dir missing a model present in schema fixture | in-sync fixture |
| 4 | `check-raw-body-read.sh` | route fixture calling `req.text()` with no byte cap | capped-read fixture |
| 5 | `check-dockerfile-prisma-pin.sh` | Dockerfile fixture with floating `prisma` version | exact-pin fixture |
| 6 | `check-security-matrices.sh` | committed matrix fixture drifted from generator output | regenerated fixture |
| 7 | `check-ios-no-diagnostic-logging.sh` | `.swift` fixture containing `PSSO_DIAG` | clean fixture |
| 8 | `check-fail-closed-routes-have-test.sh` | route fixture with `failClosedOnRedisError: true`, no sibling test | route + sibling test |

- Where a gate has no scan-root override, add one following the `STEPUP_GUARD_*` idiom
  (default = production path; override changes scan target only, never the pass criteria).
  - **Multi-input gates (test-F10)**: `check-dockerfile-prisma-pin.sh` (Dockerfile +
    package-lock.json) and `check-fail-closed-routes-have-test.sh` (route root + debt file) take
    a SINGLE fixture-root-dir override containing both inputs, not per-file env vars — avoids the
    half-overridden state where a fixture Dockerfile is compared against the real lockfile.
    `check-team-auth-rls.mjs` and `check-migration-drift.mjs` use cwd-relative paths and are
    fixturable by cwd alone (no code change).
  - **Env-override fail-open hardening (sec-F6)**: every override-capable gate (new and the
    existing `STEPUP_GUARD_*`) MUST (a) print its effective scan-root/exempt-file path on one
    line (CI-log auditable) and (b) when `CI=true` and any override is set, require an explicit
    `<GATE>_FIXTURE_MODE=1` or exit 1 — so accidental env pollution (a stray `export` leaking
    into a CI step) cannot silently green a gate by pointing it at an empty dir.
- Each test asserts BOTH directions (fail on violation, pass on clean) and greps the specific
  marker line, not just exit status (RT8 analogue: prove the detection, not the wrapper).
- Feasibility valve: if during implementation a gate proves un-fixturable without distorting its
  logic (candidate: #6, which shells out to the generator), it moves to the debt file with a
  reason naming the compensating test (`generate-security-matrices.test.mjs` already covers the
  generator) — recorded in the deviation log, not silently dropped.

### C3 — debt entries for the 10 non-security untested checks

`scripts/checks/gate-selftest-debt.txt` initial content: `check-api-error-body-drift.sh`,
`check-api-error-codes.sh`, `check-e2e-selectors.sh`, `check-security-doc-exists.sh`,
`check-settings-card-layout.sh`, `check-test-hygiene.sh`, `check-doc-paths.mjs`,
`check-dynamic-import-specifiers.mjs`, `check-mjs-imports.mjs`,
`check-vitest-coverage-include.mjs` — each with a one-line reason (non-security scope; test debt
acceptable). Acceptance: C1 passes with exactly these entries; adding an 11th check with no test
fails CI.

### C4 — `scripts/checks/check-destructive-wrapper-derivation.mjs`

- Signature: node ESM; reads `route-class-patterns.json`; env overrides
  `DESTRUCTIVE_WRAPPER_SCAN_ROOT`, `DESTRUCTIVE_WRAPPER_EXEMPT_FILE`. Exit 0/1;
  `UNDECLARED_DESTRUCTIVE_WRAPPER: <file>#<function>` and `STALE_DELETE_SIGNAL_NAME: <name>` lines.
- Scan scope: **all production `src/**/*.ts` excluding `route.ts` and tests** (test-F8 widened
  it from `src/lib`+`src/workers` — a wrapper defined in `src/app/api/x/helpers.ts` would
  otherwise evade derivation; a self-test fixture places a wrapper there to prove it is caught).
  Raw primitives (subset of `deleteSignal` minus wrapper names):
  `passwordEntry.delete(Many)?(`, `teamPasswordEntry.delete(Many)?(`, `[^A-Za-z0-9_]team.delete(`,
  and **`[^A-Za-z0-9_]user.delete(`** (sec-F4: `PasswordEntry.user` is `onDelete: Cascade`, so
  `user.delete` wholesale-destroys the owner's vault via the parent row — same class as
  `team.delete`, which is already in `deleteSignal` for exactly this reason). The existing
  production site `src/lib/auth/session/auth-adapter.ts` (Auth.js adapter callback, not
  route-reachable) goes in the exempt file with that reason. This same `user.delete` alternative
  is ALSO added to `deleteSignal` in `route-class-patterns.json` so the step-up gate classifies
  a future account-deletion route as destructive. Parent models cascading to `password_entries`
  are enumerated from the schema (`user`, `team`; `tenant` is `Restrict` → excluded) and the
  derivation record is kept in the check header.
- For each hit, resolve the enclosing exported function via ts-morph (no Program — the
  `ast-guards.ts` precedent). Pass criteria per function: name matched by `deleteSignal` OR
  listed in `scripts/checks/destructive-wrapper-exempt.txt` with `# reason`. Exempt keys are
  **`path#functionName` exact-match** (`grep -qxF` semantics), NOT bare function names — sec-F5:
  a bare name would silently exempt a same-named new function in another file (name-collision
  fail-open). Worker sweep functions reference `worker-policy-manifest.json` in their reason.
  Stale-entry anti-drift (sec-F5): an exempt entry whose `path#function` no longer resolves to
  an existing exported function → `STALE_WRAPPER_EXEMPT` exit 1.
- Inverse: every identifier-like alternative in `deleteSignal` that is not a raw Prisma primitive
  (`executeVaultReset`, `deleteTeamPassword` today) must resolve to an existing exported function
  → otherwise `STALE_DELETE_SIGNAL_NAME`.
- Member-set derivation (R42): the grep glob MUST match the widened scan scope above and include
  the `user.delete` alternative (test-round2 F8 residual — the earlier grep drifted to
  `src/lib`+`src/workers` only and omitted `user.delete`, which would seed an incomplete exempt
  file and miss the `src/app/api/**/helpers.ts` evasion path the widening targets):
  `git grep -nE '(passwordEntry|teamPasswordEntry)\.delete(Many)?\(|[^A-Za-z0-9_](team|user)\.delete\(' -- 'src/**/*.ts' ':!**/route.ts' ':!**/*.test.*' ':!**/__tests__/**'`
  executed at implementation time; results enumerated in the check's fixture test and the initial
  exempt file. Indirect members: `$executeRaw` hard-deletes are already gated per-statement by
  `check-raw-sql-usage.mjs` (C2 allowlist) — interaction documented in the check header, not
  duplicated.
- Wiring: pre-pr static section. Self-test (C1 enforces): fixture with a new
  `wipeAllEntries()` wrapper absent from `deleteSignal` → exit 1; fixture matching → exit 0;
  stale name → exit 1. **Fixture-authoring note (round3 test-F3)**: the `[^A-Za-z0-9_]` boundary
  in the primitive regex does NOT match a call at column 0 (`user.delete(` with nothing before
  it). All real sites are prefixed (`tx.`/`prisma.`/`await `), matching production, but C4's own
  fixtures MUST prefix the primitive call (`tx.user.delete(`, `await prisma.team.delete(`) or the
  fixture false-passes. The self-test asserts the boundary matches a prefixed call and (as a
  guard) that a line-start occurrence is a known limitation, not silently relied upon.

### C5 — personal keyVersion current-version guard (production change)

- New error code: `KEY_VERSION_MISMATCH: "KEY_VERSION_MISMATCH"` in
  `src/lib/http/api-error-codes.ts` + `API_ERROR` entry. Adding a code forces THREE
  `satisfies`-exhaustive maps in the same file (compile error if any is omitted — func-R2 Minor,
  caught at build): `API_ERROR_STATUS` (→ 409, mirroring `TEAM_KEY_VERSION_MISMATCH`),
  `API_ERROR_I18N` (→ message key), and `API_ERROR_MESSAGE_KEY` if separate. i18n: add the
  `keyVersionMismatch` key to BOTH `messages/en/ApiErrors.json` and `messages/ja/ApiErrors.json`
  (sharded per-namespace files, confirmed by `teamKeyVersionMismatch` at
  `messages/en/ApiErrors.json:55`) — no internal jargon in user strings, ja uses 保管庫.
- New shared helper (single choke point, R1/R17):
  `assertCurrentKeyVersion(tx: Pick<Prisma.TransactionClient, "$queryRaw">, userId: string, keyVersion: number): Promise<void>`
  in `src/lib/vault/key-version-guard.ts` — executes
  `SELECT key_version FROM users WHERE id = $userId FOR SHARE`; throws typed
  `KeyVersionMismatchError` (carries `expected`/`received`) when unequal; routes map it to 409.
  - **Fail-closed on empty result (func-F6/sec-F3a)**: zero rows returned (user row
    RLS-filtered or deleted mid-flight) → throw `KeyVersionMismatchError` (received=null),
    NEVER a naive `rows[0].key_version` that TypeErrors into a 500 or an
    `if (row && …)` that silently no-ops the guard. The helper must fail closed.
  - **Open-transaction requirement (func-F6b/sec-F3b)**: the `FOR SHARE` lock is only
    load-bearing inside an open transaction. The helper's param type is narrowed to the
    tx-client surface, and the header documents "MUST run inside an open transaction — a bare
    `prisma` call autocommits and degrades the guard to an unlocked re-read." Where a member
    site calls through a service on the ambient `prisma` proxy (bulk-import →
    `createPersonalPasswordEntry`), the plan verifies the proxy folds the call into the
    surrounding `withUserTenantRls` transaction (established: `src/lib/prisma.ts` ambient-RLS
    proxy); the service guard therefore runs inside that tx. This is asserted by C6's
    lock-lifetime test running through the real service path, not just the helper.
  - Error propagation: the throw happens inside `prisma.$transaction` — Prisma rolls back on any
    thrown error (established pattern across this codebase); route handlers catch
    `KeyVersionMismatchError` specifically and return the 409 envelope, re-throwing anything else.
    The helper never catches/swallows; no explicit `tx.rollback()` API exists or is needed.
- Member set (R42, derived from
  `git grep -lE 'passwordEntry\.(create|update|upsert|createMany|updateMany)' -- 'src/**/*.ts'`
  filtered by `keyVersion`):

| Site | Payload source | Action |
|------|---------------|--------|
| `src/app/api/passwords/[id]/route.ts` (PUT, **blob branch**) | client keyVersion | guard inside blob tx, BEFORE entry `FOR UPDATE` (lock order users→entries) |
| `src/app/api/passwords/[id]/route.ts` (PUT, **no-blob branch**) | client keyVersion | **func-F1/sec-F1 (Critical, 3-expert convergence): STRIP `keyVersion`/`aadVersion` from `updateData` in the metadata-only branch.** They cannot legitimately change without a blob (the existing `KEY_VERSION_WITHOUT_REENCRYPT` guard already forbids it); writing an equal value is a no-op EXCEPT under the rotation race, where it relabels a v2 blob back to v1 → permanent undecryptability. Server-authority no-op is the minimal, lock-free fix and preserves "metadata edits succeed" behavior. |
| `src/app/api/v1/passwords/[id]/route.ts` (PUT, both branches) | client keyVersion | same: guard in blob branch (lock order); strip keyVersion/aadVersion in no-blob branch |
| `src/app/api/v1/passwords/route.ts` (POST) | client keyVersion | wrap create in tx + guard |
| `src/lib/services/personal-password-service.ts` `createPersonalPasswordEntry` | client keyVersion | guard inside the service (covers POST `/api/passwords` + bulk-import); MUST run inside the caller's tx (verified via ambient-RLS proxy) |
| `src/app/api/passwords/bulk-import/route.ts` | client keyVersion | **func-F4: the per-entry `try/catch { failedCount++ }` swallows `KeyVersionMismatchError` → 201 instead of the promised 409.** Detect `KeyVersionMismatchError` in the loop and abort the WHOLE import by rethrowing out of the `withUserTenantRls` tx (full rollback, no partial rows), mapped to 409. Single-tx + first-guard `FOR SHARE` means mid-import rotation cannot interleave, so stale-at-start is the only case. |
| `src/app/api/passwords/[id]/history/[historyId]/restore/route.ts` | `history.keyVersion` | guard on `history.keyVersion` AND **func-F2: move the snapshot into the write tx** — re-read the entry's blob/version under `FOR UPDATE` inside the tx (the PUT blob-path pattern, `route.ts:197-202`) and snapshot from that locked read, not the stale out-of-tx `entry.*` read at lines 70-80. Closes the rotation-between-the-two-pre-tx-reads window that commits a stale v1-labeled history row past the guard. Also fixes the pre-existing same-version lost-update on this route (R34: in-scope because this plan touches these exact lines). |
| `src/lib/vault/rotate-key-server.ts` | authority (sets N+1) | Version-bump authority. Add early **CAS** (NOT just a lock anchor — sec-F2) as the FIRST statement INSIDE `applyVaultRotation`: `SELECT key_version, vault_setup_at, account_salt FROM users WHERE id = $userId FOR UPDATE`, then abort with a typed error UNLESS the in-tx read matches the pre-tx snapshot as a **tuple**: `key_version == oldKeyVersion AND vault_setup_at == oldVaultSetupAt AND account_salt == oldAccountSalt`. Also abort if `vault_setup_at IS NULL`. **The discriminator is derived from the WRAPPING-WRITE PRIMITIVE, not the reset scenario (sec-round3 SEC-R3-1, an R42 self-application).** The state the CAS protects is the vault wrapping (`encryptedSecretKey`/`accountSalt`/verifier); the complete set of writers of that wrapping is FOUR — `setup`, `change-passphrase` (`change-passphrase/route.ts:110-111`), `recover` reset step (`recover/route.ts:188-191`), and rotation itself. `change-passphrase` and `recover` rewrite the wrapping WITHOUT touching `keyVersion` or `vaultSetupAt`, so a `(keyVersion, vaultSetupAt)`-only tuple is blind to them: an old-passphrase-holding attacker's stale rotation could clobber a concurrent legitimate rewrap. `account_salt` is rewritten by ALL FOUR wrapping writers (verified — `change-passphrase/route.ts:110`, `recover/route.ts:191`, plus setup/rotation), so including it in the tuple catches change-passphrase/recover AND reset→resetup (reset nulls the wrapping). `masterPasswordServerSalt` is NOT sufficient (change-passphrase/recover leave it unchanged). Pre-tx snapshot: the route's `findUnique` select at `route.ts:141-147` reads `vaultSetupAt` + `keyVersion` today but NOT `accountSalt` (verified) — **`accountSalt: true` MUST be added to that select** so the CAS snapshot has all three values to pass into `applyVaultRotation`. Placing the CAS inside `applyVaultRotation` (not the route) is required so C6's direct `applyVaultRotation` calls exercise it (test-F1). |
| `src/lib/vault/vault-reset.ts` `executeVaultReset` | n/a (wipe) | lock-order member only: add the same early user-row `FOR UPDATE` before entry deletes (today it locks entry rows first, then updates `users` — a guarded write holding user `FOR SHARE` while waiting on an entry row would form a deadlock cycle) |

- **Lock-order audit (complete member set)**: transactions touching BOTH the `users` row and
  `password_entries`/history rows, derived via
  `git grep -lE '(tx|prisma)\.user\.update' -- 'src'` intersected with files touching
  `passwordEntry|password_entries` in the same tx → **three** (func-R2 correction; the earlier
  "exactly two" claim omitted `auth.ts`):
  1. `src/lib/vault/rotate-key-server.ts` — gets the new user `FOR UPDATE` CAS first (above).
  2. `src/lib/vault/vault-reset.ts` `executeVaultReset` — add early user-row `FOR UPDATE` before
     entry deletes (above).
  3. `src/auth.ts:90-199` (bootstrap→IdP tenant-migration tx) — `tx.user.update` (:94) then
     `tx.passwordEntry.updateMany` (:105) + `tx.passwordEntryHistory.updateMany` (:132) in one
     tx. Verified it ALREADY acquires `users` first (exclusive lock via `user.update`), then
     entry rows — CONSISTENT with the users→password_entries invariant, so it introduces no
     deadlock cycle and needs NO code change. It is added to the audited set only to make the
     deadlock-freedom argument complete rather than accidental.
  All other `user.update` sites (travel-mode, locale, favicon-pref, change-passphrase, recovery,
  setup, unlock, lockout, auth-adapter, directory-sync) touch no entry rows in the same tx — no
  ordering obligation. Postgres would detect and abort a genuine cycle (no hang), but the abort
  surfaces as a 500-class error; consistent ordering across all three members removes it.

  Indirect members checked: extension/iOS/CLI write through these routes (no separate write
  path); team entries governed by the existing `TEAM_KEY_VERSION_MISMATCH` guard; SCIM/MCP do
  not write personal entries.
- Invariants:
  - (app-enforced) stale-version write rejected with 409 at every member site — enforcement
    verified by C6 tests; single-helper adoption checked by grep in Phase 2 conformance
    (`forbidden`: a member-site diff touching keyVersion without `assertCurrentKeyVersion`).
  - (app-enforced) lock order users→password_entries in every personal-vault tx (deadlock
    freedom); documented in the helper's header.
  - Why not schema-enforced: cross-table DEFERRABLE CONSTRAINT TRIGGER needed (rotation holds
    mixed versions mid-tx) — deferred, SC5.
- Hot-row contention note (sec-F7): the `users`-row `FOR SHARE` is compatible with other
  `FOR SHARE` (concurrent entry writes do not block each other), but bulk-import holds it for the
  duration of ONE ambient `withUserTenantRls` tx spanning all imported rows. A large import
  therefore holds the shared lock while a concurrent rotation waits on its `FOR UPDATE`. Impact is
  per-user (self-DoS only, no cross-tenant blast radius). Mitigation is bounded by the existing
  import size cap and `VAULT_ROTATE_TX_TIMEOUT_MS`; the plan verifies the import cap × per-row
  cost stays within a reasonable lock-hold window at implementation and records it. Chunked-tx
  import is out of scope (SC8) unless the measured window is unacceptable.
- Forbidden patterns:
  - pattern: `updateData.keyVersion = keyVersion` reachable without a preceding
    `assertCurrentKeyVersion` in the same handler — reason: reintroduces the stale-write hole.
    NOTE (func-F1): a per-handler grep is branch-blind — a handler with a guard on the blob
    branch and an unguarded no-blob branch passes. Phase-2 conformance therefore ALSO greps that
    the no-blob branch of each PUT route does not assign `updateData.keyVersion`/`.aadVersion`
    at all (the strip fix), so the two branches are covered by complementary greps.
  - pattern: `FOR UPDATE[\s\S]*FOR SHARE` within one personal-entry tx (entry lock before user
    lock) — reason: violates lock ordering, deadlock risk.
- New raw-SQL sites (func-F5): `src/lib/vault/key-version-guard.ts` (FOR SHARE), the rotation
  early FOR UPDATE (in `rotate-key-server.ts`), and the `vault-reset.ts` early FOR UPDATE each
  need an entry in `scripts/checks/raw-sql-usage.txt` (fail-closed Layer-1 allowlist) with a
  purpose comment mirroring the existing FOR UPDATE entries — a named deliverable so the
  first implementation commit does not fail `check-raw-sql-usage.mjs`.
- Consumer-flow walkthrough (error shape) — CORRECTED per func-F3 (envelope is FLAT
  `{ error: ApiErrorCode }`, NOT `{ error: { code, message } }`; `errorResponse()` in
  `src/lib/http/api-response.ts`, canonical `docs/api/error-handling.md` §3.1):
  - Consumer 1 (web fetch wrappers + password form components) reads `body.error` (a string
    `ApiErrorCode`) and resolves the human message client-side via `API_ERROR_MESSAGE_KEY` →
    `messages/{en,ja}/ApiErrors.json` (sharded per-namespace files, NOT `messages/{en,ja}.json`;
    e.g. `teamKeyVersionMismatch` is at `messages/en/ApiErrors.json`). New `keyVersionMismatch`
    key added to both locale ApiErrors files; ja uses 保管庫, no internal jargon; renders a
    "vault key was rotated — unlock again" message. No body-context fields (omit `expected`/
    `received`; surfacing them would be a `ContextField` governed by
    `check-api-error-body-drift.sh` — deliberately not done).
  - Consumer 2 (v1 API external clients / OpenAPI): reads the same flat `error` string. OpenAPI
    error enum auto-derives via `enum: Object.values(API_ERROR)` (`src/lib/openapi-spec.ts:409`)
    — adding the code to `API_ERROR` covers the two v1 endpoints automatically (no manual enum
    edit; R12 satisfied structurally).
  - Consumer 3 (extension background sync): reads `body.error`; unknown codes already fall back
    to generic failure + re-unlock prompt — verified acceptable, no extension change required.
  - Consumer 4 (bulk-import response, func-F4 CORRECTED in round 2): the client import path
    (`password-import-importer.ts`) sends entries in CHUNKS and folds any non-429 failure into
    `failedCount` (`:241`) WITHOUT reading `body.error` — `use-import-execution.ts` only receives
    `{successCount, failedCount}`. So the server-side 409 abort correctly prevents partial
    UNDECRYPTABLE rows within the failing chunk (real win), but the user sees a bare failed-count,
    not a re-unlock prompt, and earlier chunks have already committed. This plan's scope is the
    server-side data-integrity guard; the chunked-client re-unlock UX is explicitly SC3 (client
    UX backlog). User-scenario 2 is corrected below to match. NOT claimed: that the client
    surfaces `KEY_VERSION_MISMATCH` — it does not today.
  - Consumer 5 (existing route tests asserting current 200 behavior for stale versions): grep
    during implementation; any found are updated as intended behavior change.
- Acceptance:
  - PUT with `keyVersion != users.key_version` (blob present) → 409 `KEY_VERSION_MISMATCH`,
    entry row unmodified, no history row created.
  - **Metadata-only PUT (no blob) carrying any `keyVersion`/`aadVersion`: those fields are
    NEVER written to the row (stripped); the rest of the metadata update succeeds. A concurrent
    rotation therefore cannot be undone by a metadata edit.** (func-F1/sec-F1 acceptance.)
  - Create (POST `/api/passwords`) / v1 POST with stale keyVersion → 409, no row created.
  - Bulk-import with stale-at-start keyVersion → whole import aborts with 409
    `KEY_VERSION_MISMATCH`, zero rows created (func-F4).
  - Restore with a stale history row → 409, entry unmodified; and the snapshot written into
    history is read under `FOR UPDATE` inside the tx so it always reflects the committed
    pre-restore blob (func-F2).
  - Requests without any `keyVersion` field: unchanged behavior (the existing
    `KEY_VERSION_WITHOUT_REENCRYPT` guard — labeled "C7" in route comments from an earlier plan,
    unrelated to this plan's contract C7 — still governs).
  - Well-behaved current-version writes: unchanged responses (regression: existing route tests
    pass with mock updated to include the user-version read).

### C6 — real-DB integration: rotation-vs-write race invariant

File: `src/__tests__/db-integration/key-version-guard.integration.test.ts`.
**Production entry points are named per scenario (test-F1/RT5) — tests import and drive the real
handlers/functions, never a test-authored reimplementation of the tx:**
- Route handler: `import { PUT } from "@/app/api/passwords/[id]/route"` (session auth mocked, DB
  real — precedent: `cache-rollback-report-audit.integration.test.ts` imports the route handler).
- Service path: the real `createPersonalPasswordEntry` (drives the bulk-import member).
- Rotation: the real `applyVaultRotation` (the new user `FOR UPDATE` CAS is the FIRST statement
  INSIDE it — see C5 rotation row — so direct calls exercise it).

- T1 stale write post-rotation: seed user at v1 + entry; run `applyVaultRotation` to v2; drive
  the real `PUT` handler with a body carrying `keyVersion: 1` + blob → assert 409
  `KEY_VERSION_MISMATCH`, entry still v2, no history row created (RT8: assert non-mutation).
- T2 rotation-vs-write contention (RT4): forward — a test-opened tx calls the production guard
  path to take the user `FOR SHARE` and holds it (deferred-promise barrier); a concurrent
  `applyVaultRotation` must block at its user `FOR UPDATE`. Contention witness (test-F7/round2,
  required — no elapsed-time alternative): a THIRD connection polls `pg_locks` for the rotation's
  ungranted **row-level** lock. **Witness predicate = `pg_blocking_pids(<blocked-pid>)` non-empty as the PRIMARY witness (round3 test-F1: directly answers "is this backend blocked and by whom", immune to the transient `tuple` locktype and cross-xid noise), with `locktype = 'transactionid' AND NOT granted` on the blocked backend as the fallback — NOT `tuple` (held only transiently during lock handoff, usually not observable mid-poll) and NOT `advisory`** — the `advisory`
  predicate from the T12.6c precedent only witnesses advisory locks; a blocked
  `FOR UPDATE`/`FOR SHARE` waiter never appears as `advisory`. There is no existing repo
  precedent for a row-lock witness, so this predicate is stated explicitly here rather than by
  analogy. Release, then rotation completes → all rows v2. Inverse — rotation
  holds `FOR UPDATE` mid-tx (barrier: seed a large entry set to widen the window, or hold a late
  row lock the rotation needs from a separate client and release after the writer's guard read
  starts); the writer's guard read blocks, then observes v2 → 409. Both directions assert the
  lock-wait actually occurred via the same row-lock predicate.
- T3 loop non-vacuity (test-F3, matches `passwords-history-lost-update` precedent): N≥50
  iterations of racing write vs rotation with per-index jitter; record each outcome (write
  committed pre-rotation at old v / write got 409 / write committed post-rotation at new v) and
  assert AT LEAST TWO distinct outcomes occurred across the run (proves the race actually fired,
  not just that the final invariant held). After each iteration the invariant query
  `SELECT count(*) FROM password_entries WHERE user_id=$u AND key_version <> (SELECT key_version FROM users WHERE id=$u)` = 0, same for history.
- T4 reset-vs-rotation TOCTOU (sec-F2 + sec-round2 NEW-1), two sub-cases:
  - T4a decreased-version: seed vault at v1; barrier so `executeVaultReset` commits (keyVersion→0,
    vaultSetupAt→null, rows+VaultKey deleted) AFTER the rotation route's pre-tx checks pass but
    BEFORE `applyVaultRotation`'s CAS; drive an empty-payload rotation → the in-tx tuple-CAS reads
    `key_version=0 != oldKeyVersion=1` (and `vault_setup_at IS NULL`) → typed abort, no
    `user.update`, vault stays reset.
  - T4b reset→resetup→same-version (the NEW-1 interleaving the plain keyVersion CAS misses):
    seed v1; commit reset (→0/null); commit a legitimate re-setup (→keyVersion 1, NEW
    `vaultSetupAt`, NEW `accountSalt`); THEN run the attacker's in-flight empty-payload rotation
    carrying `oldKeyVersion=1` + ORIGINAL `oldVaultSetupAt` + ORIGINAL `oldAccountSalt`. The
    tuple-CAS reads `key_version=1` (matches) but `vault_setup_at`/`account_salt` differ → typed
    abort. RT7: with the CAS reduced to keyVersion-only, T4b must fail.
  - T4c rotation-vs-change-passphrase, NO reset (sec-round3 SEC-R3-1): seed v1; attacker's
    rotation snapshots `(oldKeyVersion=1, oldVaultSetupAt=T0, oldAccountSalt=S0)` and passes
    passphrase verify; concurrently a legitimate `change-passphrase` commits (rewrites
    `encryptedSecretKey`+`accountSalt`→S1, leaves keyVersion=1 and vaultSetupAt=T0 UNCHANGED);
    attacker's rotation CAS reads `(1, T0, S1)` — `key_version` and `vault_setup_at` match but
    `account_salt = S1 != oldAccountSalt = S0` → typed abort. Proves the wrapping-hijack is
    blocked on the no-reset path. RT7: with `account_salt` dropped from the CAS tuple, T4c must
    fail (this is the kill-mutant proving the discriminator is derived from the wrapping-write
    primitive, not the reset scenario).
- Acceptance (per-lock RT7 proof table — test-F2, proven once during implementation, recorded in
  the test-file header). NOTE (test-round2): T1 is SEQUENTIAL — its 409 comes from the version
  *comparison* (guard reads 2, receives 1) and fires whether the read is `FOR SHARE` or a plain
  `SELECT`, so T1 does NOT prove the lock. Only the concurrent tests prove locks:
  - Comment out the writer-side user `FOR SHARE` → **T2/T3** must fail (T1 stays green — it tests
    the comparison, not the lock; it is proof for the *guard*, not the *lock*).
  - Remove the rotation-side user `FOR UPDATE`+tuple-CAS → T2-forward's row-lock witness and T4
    (both the decreased-version and the reset→resetup tuple case) must fail.
  - Revert the entry-`FOR UPDATE`-after-user-read reorder → T2/T3 must fail (deadlock or stale
    commit observed).

### C7 — team rotation real-DB integration

File: `src/__tests__/db-integration/team-rotate-key.integration.test.ts`.
- Concurrent double rotation to the same target version: exactly one succeeds, loser gets
  `TEAM_KEY_VERSION_CONFLICT` (real CAS re-read, not mock). RT4 barrier (test-F6 + test-round2
  correction): the team-rotate optimistic lock re-reads via a PLAIN non-locking
  `tx.team.findUnique` (`rotate-key/route.ts:119`), NOT `SELECT … FOR UPDATE` — under
  read-committed a plain SELECT does not wait on another tx's row lock, so the "hold a `FOR UPDATE`
  on the teams row that the re-read needs" barrier does NOT work here and is dropped. The real
  serialization point is the write-lock at the entry `updateMany` / `team.update` commit. Correct
  barrier: **the loop-with-both-outcomes-asserted pattern** (≥50 iterations of two concurrent real
  POST-handler rotations to the same target version, **each iteration seeded with per-pair jitter
  as in the `passwords-history-lost-update` precedent**; assert `successCount > 0 AND conflictCount > 0`
  explicitly — NOT merely "the invariant held", so the loop cannot pass vacuously when scheduling
  skew yields a single outcome; round3 test-F2). This is the primary mechanism, not a fallback. No
  `pg_locks` witness is claimed for the non-locking read.
- Member-set TOCTOU: member added (keyDistributed) between pre-read and tx → rotation rejects.
- v0 legacy + v1 ItemKey mixed entry set: v0 gets blob re-encrypt, v1 gets item-key rewrap only;
  exact-set mismatch (extra/missing entry) rejects.
- Old `TeamMemberKey` rows retained at previous version after success.

### C8 — team history decryptability after rotation

Extend C7 file: seed team entry + history at teamKeyVersion 1 (real AES-GCM fixtures via
the golden-vector helpers), rotate to 2, assert: history rows still carry version 1, the
retained v1 `TeamMemberKey` decrypts them (roundtrip decrypt in test), and current entries
decrypt under v2. Pins the intentional "history is NOT re-keyed on team rotation" invariant.

### C9 — master-key rotation state machine

File: `src/__tests__/db-integration/master-key-rotation-races.integration.test.ts`.
- C9a CAS races (real DB): concurrent approve-vs-revoke on one `pending` row → exactly one wins
  (`count===1`), loser 409-equivalent (`count===0`); concurrent execute-vs-revoke on an
  `approved` row → same exclusivity; double-execute → single transition. Tests import and call
  the three real route handlers (approve/revoke/execute) with env bearer-token stubs (test-F1).
  RT4 barrier (test-F6 + test-round2 correction): the execute/approve/revoke CAS is a SINGLE
  atomic conditional `masterKeyRotation.updateMany({ where: {...executedAt: null...} })` with no
  preceding `SELECT … FOR UPDATE` — there is no "pre-read" phase. Write-write contention is real:
  a separate client holding `FOR UPDATE` on the `MasterKeyRotation` row DOES block both handlers'
  `updateMany`, so the loser's ungranted **row-level** lock is witnessable — but as
  `pg_blocking_pids(<blocked-pid>)` non-empty as the PRIMARY witness (round3 test-F1: directly answers "is this backend blocked and by whom", immune to the transient `tuple` locktype and cross-xid noise), with `locktype = 'transactionid' AND NOT granted` on the blocked backend as the fallback — NOT `tuple` (held only transiently during lock handoff, usually not observable mid-poll) and NOT `advisory` (same predicate
  correction as C6 T2). Framing is write-write contention on an atomic conditional UPDATE, not a
  read-phase barrier. Fallback if the seam is awkward: ≥50-iter loop with per-pair jitter asserting
  `winCount > 0 AND loserCount > 0` explicitly (round3 test-F2 — not "invariant held").
  **Loser-branch side effects asserted (test-F5/RT8), not just CAS counts**: the losing `execute`
  must NOT have run `passwordShare.updateMany` (assert no share rows changed
  `masterKeyVersion`); the losing `approve`/`revoke` must NOT have emitted its success audit
  event or advanced any dependent state. Post-state: the rotation row is in exactly ONE terminal
  state, no duplicate audit/side-effect records.
- C9b execute partial-failure (S2): unit-level with mocked `passwordShare.updateMany` throwing
  AFTER the CAS — assert row remains `executed`, audit carries `shareRevocationError`, 500
  returned (per VE2; the CAS-committed-first ordering is separately asserted against real DB in
  C9a's double-execute case). Anti-deferral: real-DB fault injection would require distorting the
  route (fault seam) for one branch already pinned at unit level — cost exceeds benefit now;
  revisit if a generic fault-injection seam lands (SC6).
- C9c env drift: initiate with `SHARE_MASTER_KEY_CURRENT_VERSION=N`, flip env to N+1, execute →
  rejected by the execute-time re-validation (env stub per test, real DB row).

### C10 — personal rotation exact-set + retry semantics

Extend `vault-rotate-key-attachments.integration.test.ts`'s sibling
(`vault-rotate-key-gaps.integration.test.ts` or new file):
- Entry created after `/data` fetch payload was built → `ENTRY_COUNT_MISMATCH` abort, nothing
  committed (all rows still oldVersion).
- History row appearing mid-flow → `HISTORY_COUNT_MISMATCH` abort.
- Retried rotation after success (same payload, `newKeyVersion` now colliding with the existing
  `VaultKey @@unique([userId, version])` row): pinned expected outcome (test-F9, not
  "pin-whatever-happens") — the rotation MUST fail with the route's rotation-conflict error code
  and the standard error envelope (409-shaped), NOT a bare Prisma unique-violation surfacing as a
  500 with no envelope. If the current code does the latter, mapping it to the rotation-conflict
  error is part of this contract's deliverable, and the test asserts the mapped code + envelope
  shape.

### C11 — attachment `cekWrapAadVersion` validation at all write boundaries (production change)

sec-F8 (R42 recompute): `cekWrapAadVersion` has **three write boundaries**, not one. Validating
only the rotation post-write guard leaves a deferred-failure DoS: a bad value written at upload
or migrate lies dormant until the next rotation, which then aborts with
`RotationPostConditionError` — the user has permanently poisoned their own vault's rotation with
no recovery short of a DB row edit. Members:
1. **Upload** — `src/app/api/passwords/[id]/attachments/route.ts` (today floor `>=1` only, while
   the sibling `aadVersion` is pinned to exactly 1): change to an EQUALITY check against
   `CURRENT_CEK_WRAP_AAD_VERSION` (Zod or explicit compare) → 400 on mismatch.
2. **Migrate** — the mode-2 migrate route (same floor-only `>=1`): same equality check.
3. **Rotation rewrap** — `src/lib/vault/rotate-key-server.ts` rewrap loop (writes the
   client-supplied value): assert `rewrap.cekWrapAadVersion === CURRENT_CEK_WRAP_AAD_VERSION` and
   throw immediately, in addition to keeping the post-write sweep as defense-in-depth.
Expected value sourced from the existing `CURRENT_CEK_WRAP_AAD_VERSION` constant
(`src/lib/crypto/crypto-aad.ts`), no new literal (R2). Tests: a boundary-rejection case per site
(bad value → 400/typed-error, row not written) plus the existing rotation post-write sweep case.
Acceptance: well-formed uploads/migrates/rotations unaffected; existing rotation tests pass.

## Go/No-Go Gate

Four review rounds converged (func/sec/test experts; detail in
`security-control-verification-review.md`). R1: 21 findings incl. func-F1/sec-F1 Critical
(metadata-only PUT stale-write, 3-expert convergence). R2: 3 Major (auth.ts lock-order member;
bulk-import chunked-client; rotation CAS not monotonic → reset resurrection). R3: 1 Major
(SEC-R3-1: CAS blind to change-passphrase/recover rewraps) + 3 Low. R4: 0 findings — CAS
discriminator `(keyVersion, vaultSetupAt, accountSalt)` verified complete against the full
vault-wrapping-writer set. All contracts locked.

| ID  | Subject                                                        | Status |
|-----|----------------------------------------------------------------|--------|
| C1  | meta-gate check-gate-selftest-coverage.sh (+ inline pre-pr gates) + self-test | locked |
| C2  | negative tests for 8 security gates (+ scan-root/fixture-mode overrides) | locked |
| C3  | debt entries for 10 non-security checks + seeded inline gates    | locked |
| C4  | destructive-wrapper derivation (user.delete added) + exempt + self-test | locked |
| C5  | personal KEY_VERSION_MISMATCH guard (helper + 6 sites + no-blob strip + lock order) + rotation tuple-CAS | locked |
| C6  | real-DB rotation-vs-write race + reset/change-passphrase CAS tests (T1-T4c) | locked |
| C7  | team rotation real-DB integration (both-outcomes loop, TOCTOU, v0/v1) | locked |
| C8  | team history decryptability after rotation                      | locked |
| C9  | master-key CAS races (loser side-effects) + S2 partial-failure + env drift | locked |
| C10 | personal rotation exact-set + VaultKey retry collision (pinned outcome) | locked |
| C11 | cekWrapAadVersion equality at all 3 write boundaries            | locked |

## Testing strategy

- Unit: new helper (`key-version-guard`), error mapping per member site. Mock-prisma route tests
  updated (R19/RT1) — but the existing blanket `$queryRaw: vi.fn().mockResolvedValue([curRow])`
  (`route.test.ts:282`) would answer BOTH the new `FROM users` guard read and the existing
  `FROM password_entries` `FOR UPDATE` with the same row, vacuously satisfying the guard
  (test-F4). Required: mocks discriminate by SQL text (`mockImplementation` matching `FROM users`
  vs `FROM password_entries`), return distinct fixtures, and add an order assertion (user read
  observed BEFORE entry `FOR UPDATE`) alongside the existing "queryRaw before History.create"
  test. At least one route test per member site runs the REAL `assertCurrentKeyVersion` against
  the discriminated mock (not a mock of the helper) so the guard logic itself is exercised.
  Check-script self-tests are fixture-driven, both directions per C2.
- Real-DB integration: C6-C11 via `npm run test:integration` (serial, forks pool, superuser URL);
  every race test carries an RT4 contention proof.
- Static: C1/C4 run in pre-pr + CI static-checks (single wiring point).
- Mandatory before completion: `npx vitest run`, `npx next build`, `npm run test:integration`,
  `bash scripts/pre-pr.sh` (targeted re-runs on failure per established practice).

## Considerations & constraints

- `.claude/settings.json` has an unrelated local modification — not part of this plan; leave
  untouched.
- Release semantics: `fix:`/`feat:` mix — C5 is a behavioral fix (`fix:` — release-please bumps
  patch); gates/tests are `test:`/`chore:`-shaped but land in the same PR; final commit prefix
  decided at PR time (memory: release-please skips chore/docs — use `fix:` for the guard commit).
- Stale-client UX: a client that held the vault open across a rotation elsewhere now receives
  409 instead of silently corrupting the entry. Web client maps the code to a re-unlock prompt
  message (i18n keys if the convention requires — verified during implementation, C5).

### Scope contract

| ID  | Deferred item | Owner |
|-----|---------------|-------|
| SC1 | EmergencyAccess STALE marking end-to-end through the rotation POST route (covered in isolation by `vault-rotate-key-gaps.integration.test.ts`) | future integration-coverage pass |
| SC2 | Security-control inventory/registry consolidation (external evaluation's candidate 1) | explicitly not adopted this round (user scope decision) |
| SC3 | Full stale-client re-unlock UX (beyond error-message mapping) in extension/iOS/CLI | client UX backlog |
| SC4 | Generalized mutation-testing framework for gates (beyond negative tests + meta-gate) | future hardening |
| SC5 | Schema-enforced (deferrable constraint trigger) variant of the keyVersion invariant | future hardening |
| SC6 | Generic fault-injection seam for real-DB partial-failure tests (C9b) | future hardening |
| SC7 | Extracting the ~20 existing inline `bash -c` gates in pre-pr.sh into tested `scripts/checks/` files (seeded into the meta-gate debt file this round with reasons; anti-evasion for NEW inline gates is enforced now) | future hardening |
| SC8 | Chunked-tx bulk-import to shorten the `users`-row `FOR SHARE` hold window (sec-F7) — only if the measured single-tx window proves unacceptable | future hardening |

## User operation scenarios

1. User rotates the vault key in browser tab A while tab B (or the extension, or iOS) still holds
   the old key and saves an entry edit → tab B gets 409 `KEY_VERSION_MISMATCH` with a
   "unlock again" message instead of silently writing an entry that can never be decrypted again.
2. Bulk import running when a rotation commits → import items fail with 409 (no partial
   undecryptable rows); user re-unlocks and retries the import.
3. Developer adds a new `scripts/checks/check-foo.sh` without a test → CI static-checks fails
   with `MISSING_GATE_SELFTEST` until a test or a reasoned debt entry lands.
4. Developer adds `purgeUserEntries()` wrapping `passwordEntry.deleteMany` in a service and calls
   it from a new route without step-up → `UNDECLARED_DESTRUCTIVE_WRAPPER` fails CI before the
   route can ship unclassified.
5. Two admins race approve/revoke on a master-key rotation → exactly one transition wins; the
   loser sees the standard 409; no double-execution of the system-wide share revocation.
