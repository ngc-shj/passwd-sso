# Plan: route-policy-sql-security

Branch: `hardening/route-policy-sql-security` (created after the P1 session's branch merges)
Plan file: `docs/archive/review/route-policy-sql-security-plan.md`

## Project context

- Type: `web app` (Next.js 16 App Router, TypeScript, Prisma 7, PostgreSQL 16)
- Test infrastructure: `unit + integration + E2E + CI/CD` (vitest, real-DB integration tests, Playwright e2e, GitHub Actions, `scripts/pre-pr.sh` static gates)
- Verification environment constraints:
  - VE1: DB integration tests require a running Postgres (available locally via `npm run docker:up`) — `verifiable-local`.
  - VE2: All P2 deliverables are static checks + vitest tests — `verifiable-local`.
  - VE3: P3 is a static review of worker code; any fix it produces is verified by existing unit/integration suites — `verifiable-local`.
  - No `blocked-deferred` paths.

## Objective

Close the top three follow-ups from the external security assessment (2026-07-04), in
priority order P2 → P3 → P4:

1. **P2 — Route-policy and raw-SQL specification**: make the security-relevant route
   classes (public, bearer-token-allowed, destructive, operator-gated, side-effecting GET)
   and the raw-SQL usage surface machine-readable and CI-enforced, so that membership
   drift becomes a build failure instead of a review-round finding.
2. **P3 — Worker / raw-SQL safety review**: run a targeted three-expert review of the
   background workers and raw-SQL call sites against five lenses (tenant scope,
   idempotency, partial failure, audit chain integrity, retention policy drift); fix
   small findings in-branch, track large ones.
3. **P4 — Security architecture documentation refresh**: produce the missing
   consolidated matrix documents (route policy, deletion/retention, tenant boundary,
   auth surface + token types, audit-chain threat model), generated from
   machine-readable sources where one exists.

Rationale: the assessment's central claim — verified against this repo's own review
history — is that residual risk is dominated by *control-plane drift between parallel
paths*, not by individual vulnerabilities. The fix is to externalize the specification
of each control class and tie it to code with bidirectional CI guards, following the
proven `aad-scope-manifest.json` + `check-crypto-domains.mjs` pattern.

## Requirements

Functional:
- FR1: A single machine-readable route-policy manifest covering **all** `src/app/api/**/route.ts` files, with per-route kind, methods, auth mechanisms, and security-class flags.
- FR2: Bidirectional parity between the manifest and code (missing entry → CI fail; stale entry → CI fail; wrong `kind` → CI fail).
- FR3: A raw-SQL usage allowlist covering every production file that calls a Prisma raw primitive, with a per-file purpose.
- FR4: A completed worker/raw-SQL safety review with all findings adjudicated (fixed, or tracked with grep-able TODO markers).
- FR5: Five new/updated matrix documents under `docs/security/`, with freshness guards.

Non-functional:
- NF1: New checks follow existing `scripts/checks/` conventions (txt `path # reason` with ≥10-char reason + STALE_EXEMPT drift detection; JSON manifest + parity test; `run_step` registration in `pre-pr.sh`).
- NF2: Zero runtime behavior change from P2/P4 (static checks and docs only). P3 fixes may change runtime behavior; each such fix ships with a regression test.
- NF3: Generated docs must be reproducible: `generate → git diff --quiet` is the drift check (same pattern as `check:env-docs`).

## Technical approach

- **One manifest, one parity test** for route classes: rather than six separate txt
  files, a single `scripts/checks/route-policy-manifest.json` keyed by repo-relative
  route-file path, verified by one vitest parity test that imports the real
  `classifyRoute` / `isBearerBypassRoute` (TS imports rule out a plain `.mjs` check)
  and re-derives the destructive / operator-gated / side-effecting-GET member-sets from
  the same defining greps the existing checks use. This gives a single SSoT and avoids
  N×(manifest, check) pairs.
- **Raw SQL** stays a `.sh` allowlist check (member files span `src/lib`, `src/workers`,
  `scripts/` — outside route-file globbing, no TS import needed).
- **Docs generation**: `scripts/generate-security-matrices.ts` renders the
  route-policy matrix and deletion/retention matrix from their machine-readable
  sources (manifest JSON; retention-gc `registry.ts`; `schema.prisma` model list).
  Hand-written docs (auth surface, tenant boundary prose, audit-chain threat model)
  get required-heading guards via the existing `check-security-doc-exists.sh` pattern.
- **Invariant strength note**: every invariant in this plan is CI-enforced (build-time
  gate). Schema-enforced equivalents do not exist for route-classification or
  documentation invariants — the storage engine cannot express "every route file has a
  manifest entry". CI-gate is the strongest available form for this class. P3 findings
  that touch DB behavior MUST prefer schema-enforced fixes where expressible
  (per plan-review rule).

## Contracts

### C1 — Route-policy manifest + parity test

**Files**:
- `scripts/checks/route-policy-manifest.json` (new)
- `scripts/checks/route-class-patterns.json` (new; shared regex source, see below)
- `src/__tests__/proxy/route-policy-manifest.test.ts` (new)
- `scripts/checks/check-permanent-delete-stepup.sh` (modified: read DELETE_SIGNAL from the shared pattern file)

**Manifest schema** (per entry, keyed by repo-relative route file path, e.g.
`src/app/api/passwords/[id]/route.ts`):

```jsonc
{
  "$schema-note": "verified fields are asserted by the parity test; doc fields are review-enforced",
  "routes": {
    "src/app/api/<...>/route.ts": {
      "kind": "api-session-required",        // verified: === classifyRoute(concretePath)
      "methods": ["GET", "PUT", "DELETE"],   // verified: === exported HTTP handlers
      "bearerBypass": ["GET", "PUT"],         // verified: ⇔ isBearerBypassRoute(path, m) per method (omit if none)
      "auth": ["session", "extension-token"], // doc field: mechanisms the handler accepts
      "handlerAuthReason": "...",             // verified non-empty (≥10 chars) when kind is api-default / public-*
      "destructive": true,                    // verified: ⇔ file matches DELETE_SIGNAL grep (omit if false)
      "sideEffectingGet": "reason ...",       // verified: required if GET-only file contains write primitives
      "operatorGated": true                   // verified: see assertion 8 (maintenance + admin operator surface)
    }
  }
}
```

**Verification method per field** (two deliberate mechanisms, not a conflict):
- *Classifier fields* (`kind`, `bearerBypass`, `methods`) are verified by importing the
  real production functions (`classifyRoute`, `isBearerBypassRoute`) into the vitest
  test — both are already exported from `src/lib/proxy/route-policy.ts` /
  `src/lib/proxy/cors-gate.ts`; no extraction needed.
- *Class-flag fields* (`destructive`, `sideEffectingGet`, `operatorGated`) are verified by
  re-deriving the member-set from the defining grep patterns. To prevent drift between
  the existing `.sh` checks and the vitest test, the patterns move to a shared source:
  `scripts/checks/route-class-patterns.json` (keys: `deleteSignal`, `writePrimitive`,
  `rawSql`), consumed by `check-permanent-delete-stepup.sh` (via **`jq -er`** — the `-e`
  flag makes a missing/null key exit non-zero so the consumer fails CLOSED under
  `set -euo pipefail`; bare `jq -r` prints the literal string `null` with exit 0, which
  would silently corrupt the grep instead of failing), `check-raw-sql-usage.mjs` (C2;
  native JSON import, no jq), and the parity test (JSON import; the test asserts each
  required key is a non-empty string before use). The literal regexes are defined once.

**Parity test assertions** (each is one test case):
1. Bijection: `glob('src/app/api/**/route.ts')` set === manifest key set.
2. `kind`: for each entry, `classifyRoute(toConcretePath(file))` === manifest kind.
   `toConcretePath` substitutes `[param]` segments with a fixed UUID literal.
3. `methods`: exported handler set === manifest methods. Extraction regex:
   `export (async )?(function|const) (GET|POST|PUT|PATCH|DELETE)` — the `async` keyword
   MUST be optional: 2 of 212 route files use the non-async form `export function GET()`
   (`src/app/api/health/live/route.ts:5`,
   `src/app/api/mobile/.well-known/apple-app-site-association/route.ts:31`). During
   implementation, re-verify the corrected regex covers the full universe (arrow
   exports, `export { x as GET }` re-exports, multi-line signatures) and extend if any
   further style is found.
4. `bearerBypass`: for every route × method, `isBearerBypassRoute(concretePath, method)` ⇔ method listed in `bearerBypass`. Both directions (a bearer route missing the field fails; a field entry the gate rejects fails).
5. Public/self-enforced surface: every entry whose kind is `api-default`, `public-share`, or `public-receiver` has `handlerAuthReason` ≥10 chars and non-empty `auth`.
6. `destructive` ⇔ membership in the DELETE_SIGNAL member-set (re-derived in-test with the same regex as `check-permanent-delete-stepup.sh`).
7. `sideEffectingGet`: every GET-only route file whose source matches the write-primitive
   pattern carries a non-empty `sideEffectingGet` reason; entries carrying the field must
   match the grep (STALE direction). The `writePrimitive` pattern requires a Prisma
   Client receiver shape — `\b(prisma|tx)\.[A-Za-z]+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(`
   or `\$executeRaw` — so plain-object/`Map`/`Set` mutations do not false-positive
   (plan-time raw grep produced 4 hits; `src/app/api/watchtower/hibp/route.ts:84` is
   `cache.delete(k)` on an in-memory `Map` and is excluded by the receiver-shape
   requirement, leaving the 3 true members below). Additionally, the floor pattern
   includes delegated-consumption verbs `\b(consume|redeem|markUsed)[A-Za-z]*\(` so
   future one-time-token GET routes are caught even when the write is service-delegated;
   an inline exemption list (path + ≥10-char reason) in the test handles any future
   false positive of either pattern.
8. `operatorGated` (replaces the earlier path-prefix-only `maintenance` flag): three
   sub-assertions, none circular:
   (a) *path floor*: every route under `src/app/api/maintenance/` or `src/app/api/admin/`
   MUST declare `operatorGated` EXPLICITLY — `true` or `false`. Omission fails. A
   `false` declaration additionally requires `handlerAuthReason` ≥10 chars (this is what
   keeps the exception machine-checked instead of implementer-judged);
   (b) *auth-pattern completeness*: every `operatorGated: true` entry's source contains
   `verifyAdminToken(` AND `requireMaintenanceOperator(`;
   (c) *reverse drift*: every route file containing `requireMaintenanceOperator(` MUST be
   declared `operatorGated: true` (catches operator surfaces added outside the two
   prefixes).
   Current members: 10 × `true` (all satisfy (b), including the dcr-cleanup 410 stub,
   which deliberately keeps full auth so stale cron jobs are surfaced — both symbols
   verified present in `src/app/api/maintenance/dcr-cleanup/route.ts`; line numbers
   intentionally omitted, the file is being edited on the in-flight P1 branch) and
   1 × `false`: `src/app/api/admin/rotate-master-key/route.ts` — the legacy single-actor
   rotation endpoint, now a 410 Gone stub with NO auth by design ("the 410 itself is
   the answer"); it contains neither auth symbol, so it must be declared `false` with
   that rationale as `handlerAuthReason`.

**Member-set derivation (R42)** — code-derived, commands run 2026-07-04:

- Destructive class (defining primitive = `check-permanent-delete-stepup.sh` DELETE_SIGNAL):
  ```
  grep -rlE 'passwordEntry\.delete(Many)?\(|teamPasswordEntry\.delete(Many)?\(|executeVaultReset\(|deleteTeamPassword\(|[^A-Za-z0-9_]team\.delete\(' src/app/api --include=route.ts
  ```
  → 9 members: `passwords/[id]`, `passwords/bulk-purge`, `passwords/empty-trash`,
  `teams/[teamId]/passwords/[id]`, `teams/[teamId]/passwords/bulk-purge`,
  `teams/[teamId]/passwords/empty-trash`, `teams/[teamId]`, `vault/admin-reset`, `vault/reset`.
- Side-effecting GET class (GET-only route files with direct write primitives; delegated-write
  limitation documented below): raw grep = 4 hits, 1 adjudicated clean
  (`watchtower/hibp` — in-memory `Map.delete`, excluded by the receiver-shape pattern),
  → 3 members:
  `src/app/api/mobile/authorize/route.ts` (mints one-time mobileBridgeCode),
  `src/app/api/share-links/[id]/content/route.ts` (atomic view_count++ , shareAccessLog.create),
  `src/app/api/tenant/breakglass/[id]/logs/route.ts` (non-repudiation PERSONAL_LOG_ACCESS_VIEW auditLog.create).
- Operator-gated class — TWO derivations, whose delta is itself a member requiring
  explicit adjudication (the F6 lesson: the auth-primitive grep cannot see a no-auth
  stub that the path floor covers):
  ```
  # auth-primitive members (operatorGated: true candidates)
  grep -rl 'requireMaintenanceOperator(' src/app/api --include=route.ts   # → 10 files
  # path-floor universe (must declare true OR false)
  find src/app/api/maintenance src/app/api/admin -name route.ts           # → 11 files
  ```
  → 10 × `true`: the 6 `src/app/api/maintenance/*` routes (`audit-chain-verify`,
  `audit-outbox-metrics`, `audit-outbox-purge-failed`, `dcr-cleanup` (410 stub, fully
  authenticated — NOT exempt), `purge-audit-logs`, `purge-history`) + the 4
  `src/app/api/admin/rotate-master-key/**` routes (`initiate`,
  `[rotationId]/approve`, `[rotationId]/execute`, `[rotationId]/revoke`).
  `verifyAdminToken(` grep yields the same 10 files.
  → 1 × `false`: `src/app/api/admin/rotate-master-key/route.ts` (no-auth 410 Gone
  legacy stub; see assertion 8a). Both derivations re-run 2026-07-04.
- Route universe: `find src/app/api -name route.ts | wc -l` → 212 members (bijection test
  re-derives at run time; the number is informational, not a locked constant).

**Known limitation (documented in the test header, accepted)**: the side-effecting-GET
grep detects writes issued directly in the route file. A GET handler delegating a write
to an imported service function is not detected mechanically; the broad
`consume|redeem|markUsed` sweep over GET-only files found no additional members at plan
time. Multi-method files are excluded from this specific check (writes belong to their
mutating handlers). **Invariant strength for assertion 7 is therefore explicitly
two-tier: CI-enforced floor (direct writes in GET-only files) + review-enforced
remainder (delegated writes, multi-method files)** — the manifest field itself remains
the authoritative declaration either way; only the automated detection has the floor.

**Consumer-flow walkthrough**:
- Consumer 1 (parity test, `src/__tests__/proxy/route-policy-manifest.test.ts`) reads
  `{routes: {<path>: {kind, methods, bearerBypass, handlerAuthReason, destructive, sideEffectingGet, operatorGated}}}`
  and uses each field for the assertions listed above. All fields present in schema. ✓
- Consumer 2 (`scripts/generate-security-matrices.ts`, C5) reads
  `{kind, methods, auth, bearerBypass, destructive, sideEffectingGet, operatorGated, handlerAuthReason}`
  to render the Route Policy Matrix rows. All fields present in schema. ✓
- Consumer 3 (human security reviewer) reads `handlerAuthReason` / `sideEffectingGet`
  prose to audit the public surface. Present. ✓

Walkthrough for `scripts/checks/route-class-patterns.json` (the second machine-readable
artifact):
- Consumer A (`check-permanent-delete-stepup.sh`) reads `deleteSignal` via `jq -er`. ✓
- Consumer B (`check-raw-sql-usage.mjs`, C2) reads `rawSql` via native JSON import with a non-empty-string assertion. ✓
- Consumer C (parity test) reads `deleteSignal`, `writePrimitive` (assertions 6-7) via
  JSON import with non-empty-string assertions. ✓
All three keys are present in the schema; no consumer needs a key outside it.

**Documented class-boundary exclusions** (design decisions, not silent gaps — recorded
in the manifest header comment):
- The destructive-class member-set is route-file-scoped by construction. The
  retention-gc worker performs the same hard-delete primitives
  (`src/workers/retention-gc-worker/sweep.ts:533,541` —
  `tx.teamPasswordEntry.deleteMany` / `tx.passwordEntry.deleteMany`) as a background
  sweep with no per-request step-up (architecturally correct — there is no requesting
  user). That surface is covered instead by C5's Deletion/Retention Matrix (visibility)
  and C4's worker review (safety), and C2 allowlists the file's raw SQL.
- `src/app/s/[token]/page.tsx` (server component with raw SQL) is covered by C2 but not
  C1 (route.ts-only universe).

**Forbidden patterns**:
- pattern: `"handlerAuthReason": ""` — reason: empty rationale defeats the manifest's audit purpose.
- pattern: `it.skip|describe.skip` within `route-policy-manifest.test.ts` — reason: parity test must never be disabled piecemeal.

**Acceptance criteria**:
- `npx vitest run src/__tests__/proxy/route-policy-manifest.test.ts` passes on the completed manifest.
- Fail-path proof (RT7), recorded in `docs/archive/review/route-policy-sql-security-manual-test.md`
  with the command transcript: delete the `src/app/api/vault/reset/route.ts` entry from
  the manifest → run the parity test → confirm failure names that path → revert.
  Repeat once for a `kind` flip.

### C2 — Raw-SQL usage allowlist + check

**Files**:
- `scripts/checks/raw-sql-usage.txt` (new; format `path # purpose [# ident-markers=N]`, ≥10-char purpose, `#` comment lines)
- `scripts/checks/check-raw-sql-usage.mjs` (new; Node — see layer 2's span-tracking requirement)
- `scripts/pre-pr.sh` (one `run_step` line added)

**Check invariants (app/CI-enforced) — two independent layers**:
1. *File allowlist*: every file under `src/` or `scripts/` (excluding `*.test.*`,
   `__tests__/`, `manual-tests/`, `e2e/`) that matches
   `\$(queryRaw|executeRaw)(Unsafe)?\b` MUST appear in `raw-sql-usage.txt` with a
   purpose. Listed-but-clean files fail as `STALE_EXEMPT` (same anti-drift behavior as
   `check-permanent-delete-stepup.sh`).
2. *Unconditional interpolation ban (span-based)*: independently of layer 1, EVERY
   scanned file (allowlisted or not) is checked for `${...}` interpolation inside
   Unsafe raw calls; any unexempted occurrence fails. This is the compensating control
   for layer 1's file-level granularity: a new injection-shaped call CANNOT hide inside
   an already-allowlisted high-density file (`audit-outbox-worker.ts` has ~24 raw call
   sites, `sweep.ts` ~18 — a single-line allowlist entry alone would not observe
   additions there).
   - **Matching unit** (an Unsafe SQL template spans multiple physical lines in
     `sweep.ts`, so per-physical-line grep would false-negative): the checker tracks
     the backtick-delimited template-literal span of each
     `$executeRawUnsafe(`/`$queryRawUnsafe(` argument and flags any `${` within that
     span. This requires real span tracking, so the check is implemented as
     **`check-raw-sql-usage.mjs`** (Node, precedent: `check-bypass-rls.mjs`), not
     `.sh` — which also removes the `jq` dependency for this consumer
     (`route-class-patterns.json` is imported natively; the `jq -er` requirement
     remains for the `.sh` consumer `check-permanent-delete-stepup.sh`).
   - **Exemption = strict two-way pairing, centrally declared**: an interpolated span
     is exempt only if it carries a `// raw-sql-ident: <reason ≥10 chars>` marker on
     the call line or inside the span, AND the file's `raw-sql-usage.txt` entry
     declares the expected marker count (`path # purpose # ident-markers=N`). The
     check fails on: marked-span count ≠ N (either direction — an orphaned marker
     after a refactor fails too, no marker "budget" can mask a new unmarked
     interpolation), any unmarked interpolated span, and any marker with a <10-char
     reason. If a file's txt entry omits the `# ident-markers=N` suffix entirely, the
     checker treats N as 0 — any marked interpolated span found in that file then
     fails as a count mismatch (must-declare, not may-declare, once markers exist;
     fail-closed default). Bumping N forces a visible diff in the central txt file,
     so a new interpolation can never be blessed purely at the call site.
   - **Why not validator-adjacency**: mechanically requiring `assertIdentifier(` near
     the marker was considered and rejected — `sweep.ts`'s identifiers are validated
     at worker boot (`validateRegistry()` in `index.ts`), not lexically adjacent to
     the call sites, so an adjacency grep would fail the legitimate sites. The marker
     reason must instead NAME the validation mechanism (e.g. "registry identifiers
     validated by validateRegistry() at boot"), and C4's review verifies each named
     mechanism actually runs before the marked spans.
   - Marker/N values are seeded from a fresh span-scan at implementation time (R42
     refresh — plan-time estimate: 5 Unsafe call-site spans in `sweep.ts` at lines
     187/225/273/316/403, with interpolations spread across their multi-line
     templates; do not trust these numbers, re-derive).
   - Residual risk accepted and documented in the txt header: a new *bound-parameter*
     raw call in an allowlisted file is not CI-flagged (worst case: unreviewed but
     parameterized SQL — not injectable; likelihood: medium over time; per-call-site
     granularity à la `check-bypass-rls.mjs` SCAN_RADIUS is the named escalation if
     this proves insufficient).

**Member-set derivation (R42)** — command run 2026-07-04:
```
grep -rlE '\$(queryRaw|executeRaw)(Unsafe)?\b' src scripts --include='*.ts' --include='*.tsx' \
  | grep -vE '\.test\.|__tests__|manual-tests|/e2e/'
```
→ **29 members** (13 API route files + 2 `src/app/s` files + `src/auth.ts` + 8 `src/lib`
files + 3 `src/workers` files + 2 `scripts/` files; recount verified 2026-07-04 — an
earlier inventory said 28 by under-counting the two `passwords/[id]/attachments*` route
files as one). The initial `raw-sql-usage.txt` is seeded from a FRESH run of the command
at implementation start (R42 refresh), never from this plan's snapshot.

Plan-time safety attributes (from the exhaustive call-site inventory): **zero** call
sites interpolate user/tenant-derived input into SQL strings. Unsafe variants use static
SQL + `$N` bound params, or interpolate only `assertIdentifier`-validated identifiers
from the closed retention-gc registry. This baseline is recorded in the txt header
comment so future diffs are judged against it.

**Forbidden patterns**:
- pattern: `\$executeRawUnsafe\(\s*\`[^\`]*\$\{` — reason: template interpolation into an Unsafe SQL string is the injection-shaped anti-pattern this check exists to keep out.
- (same for `$queryRawUnsafe`)

**Acceptance criteria**:
- `node scripts/checks/check-raw-sql-usage.mjs` exits 0 on the committed tree.
- Fail-path proof (RT7), recorded in `docs/archive/review/route-policy-sql-security-manual-test.md`
  with the command transcript: (1) temporarily add a `$queryRawUnsafe` call to an
  unlisted file → check exits 1 naming the file → revert; (2) remove a listed file's
  raw usage → `STALE_EXEMPT`; (3) add a marker-less `${...}` interpolation inside a
  backtick template that spans ≥2 physical lines (mirroring sweep.ts's real shape — a
  single-line mutation would also pass under a regressed line-based matcher and would
  not prove the span logic) in an Unsafe call in an ALREADY-allowlisted file →
  layer-2 span ban exits 1 → revert;
  (4) add an orphaned `// raw-sql-ident:` marker (no interpolation in its span) without
  bumping `ident-markers=N` → pairing check exits 1 → revert;
  (5) add a marker + interpolation to an allowlisted file whose txt entry has NO
  `ident-markers=` suffix at all → default-N=0 pairing check exits 1 → revert.

### C3 — pre-pr / CI registration

**Files**: `scripts/pre-pr.sh` (C2's `run_step`; C1 rides the existing vitest step),
`package.json` (C5's `generate:security-matrices` script + drift-check script),
CI workflow only if pre-pr registration alone doesn't cover CI (expected: existing CI
runs vitest and the static-check suite; verify and add a step only if missing).

**Placement contract (fail-open prevention)**: `scripts/pre-pr.sh` has a structural
split — unconditional `run_step` calls for static checks vs. steps gated behind
`if [ "$STATIC_ONLY" != "1" ]`. CI's static-checks job executes
`PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh`, so a check registered inside the gated
region silently never runs in CI. BOTH the C2 `run_step` AND the C5 drift-check
`run_step` MUST be registered in the ungated region, alongside the existing
`check:env-docs` registration (the exact precedent for C5's drift check).

**Acceptance criteria**:
- `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` output contains the new check names
  with ✓ (proves CI-side execution, not just full-mode).
- `bash scripts/pre-pr.sh --skip-merge-queue-guards` full mode also shows them ✓.

### C4 — Worker / raw-SQL safety review (P3 execution)

**Review target member-set** (code-derived, fixed at plan time):
`src/workers/audit-outbox-worker.ts`, `src/workers/audit-anchor-publisher.ts`,
`src/workers/retention-gc-worker/{index,registry,sweep}.ts`,
`src/lib/audit/audit-outbox.ts`, `src/lib/tenant-rls.ts`,
`src/app/api/maintenance/**/route.ts` (6 routes),
`scripts/migrate-account-tokens-to-encrypted.ts`,
`prisma/migrations/20260522000200_audit_log_revoke_via_definer/migration.sql` (definer fn),
worker role grant migrations (`20260412100001`, `20260618*`, `20260619*`).

**Lenses** (each expert applies all five): tenant scope, idempotency, partial failure,
audit chain integrity, retention policy drift.

**Adjudication candidates surfaced by plan-time inventory** (to be judged by the
experts, NOT pre-judged as findings):
- A1: `audit_log_purge` deletes low-end `audit_logs` rows without touching
  `audit_chain_anchors`. RESOLVED (see deviation log D2): the T5 characterization test
  pins the ACTUAL post-purge behavior — default `fromSeq=1` verify returns `ok:false`
  (a FALSE TAMPER report), not `SEED_NOT_FOUND` or an empty pass, because the first
  retained row's `chain_prev_hash` points at a purged row and the walk re-seeds from
  genesis. Adjudication: document real semantics in C8 + track the watermark code fix
  (`TODO(route-policy-sql-security): purge watermark`).
- A2: retention-gc has no row-level mutual exclusion between concurrent instances;
  `sweepAuditProvenanceEntry` enqueues audit rows BEFORE delete in the same tx — two
  racing instances can double-emit `*_RETENTION_PURGED` audit events for the same rows.
  Judge: likelihood/impact vs. cost (e.g. advisory lock like anchor publisher, or accept
  + document single-instance deployment contract). If fixed, the regression test shape
  is committed here to avoid mid-implementation improvisation: a DB-integration test
  racing two transactions via `Promise.all` against the contended primitive, asserting
  exactly one emits the audit row AND (RT4 guards) that both the win and lose branches
  occurred at least once — no sleeps.
- A3: the bypass-GUC `set_config` triple is duplicated inline across 7 files instead of
  going through a shared helper. Judge: consolidation value vs. churn (a helper already
  exists as `setBypassRlsGucs` in the outbox worker; `withBypassRls` in tenant-rls.ts).

**Process contract**: findings ≤30 min fix-cost are fixed in-branch with regression
tests (30-minute rule); larger findings get `TODO(route-policy-sql-security): ...`
markers + deviation-log entries with the three-value risk quantification, and are
reported to the user for follow-up PR scheduling. Security-sensitive fixes complete
impact analysis before applying regardless of size.

**Acceptance criteria**: review report saved (part of the standard triangulate review
file); every finding has a resolution status; no unresolved Critical/Major.

### C5 — Generated matrix docs: Route Policy + Deletion/Retention

**Files**:
- `scripts/generate-security-matrices.ts` (new; run via `npm run generate:security-matrices`)
- `docs/security/route-policy-matrix.md` (generated)
- `docs/security/deletion-retention-matrix.md` (generated)
- `package.json` (script entries), `scripts/pre-pr.sh` (drift check: regenerate + `git diff --quiet -- docs/security/route-policy-matrix.md docs/security/deletion-retention-matrix.md`)

**Sources**:
- Route Policy Matrix ← `route-policy-manifest.json` (C1): one row per route — kind,
  methods, auth, bearer surface, flags, reason.
- Deletion/Retention Matrix ← `src/workers/retention-gc-worker/registry.ts` (imported
  via tsx) + the generated client's `Prisma.dmmf.datamodel.models` for the authoritative
  model list (no fragile schema-file regex parsing): registry-managed
  models get rows (kind, cutoff source, per-tenant policy column, floor, audit action);
  all remaining schema models are listed under "no automated purge (manual or
  cascade-only deletion)" so the matrix covers **every** model, closing the gap-analysis
  hole.

**Both files carry a generated-file header**: `<!-- GENERATED by scripts/generate-security-matrices.ts — do not edit by hand -->`.

**Consumer-flow walkthrough**:
- Consumer 1 (drift check in pre-pr) reads the generated bytes; needs determinism —
  generator must sort keys and avoid timestamps. ✓ (no timestamp field in output)
- Consumer 2 (human reader / auditor) reads the tables; every column named above is
  emitted. ✓

**Forbidden patterns**:
- pattern: `new Date()` in `generate-security-matrices.ts` output path — reason: non-deterministic output breaks the drift check.

**Tests** (new file `scripts/__tests__/generate-security-matrices.test.mjs` — the
vitest include glob already covers `scripts/__tests__/**/*.test.mjs`):
1. *Determinism*: invoke the generator function twice in-process, assert byte-identical
   string output (distinct from the pre-pr drift check, which compares against the
   committed file and cannot catch cross-machine iteration-order nondeterminism).
   The generator documents order stability per data source as code comments (explicit
   `.sort()` on manifest keys; `Prisma.dmmf.datamodel.models` is schema-declaration
   order) — mirroring the `scripts/generate-env-example.ts` sort-strategy comment
   precedent.
2. *Content correctness*: assert one known registry-managed model produces a row with
   the expected columns, and one known non-registry model appears in the "no automated
   purge" bucket (a determinism test alone passes even if every row is wrong the same
   way twice).

**Acceptance criteria**: both tests pass; hand-editing a generated doc → drift check
fails.

### C6 — Tenant Boundary Matrix doc

**File**: `docs/security/tenant-boundary-matrix.md` (hand-written prose + two
generated-at-authoring-time tables, clearly sourced).

Content: (a) RLS-enabled tables (derived from `ENABLE ROW LEVEL SECURITY` grep over
`prisma/migrations/`), (b) bypass surface: file × model allowlist summarized from
`check-bypass-rls.mjs` `ALLOWED_USAGE` (source-of-truth pointer, not a copy of all ~150
entries — top-level counts + purpose classes), (c) worker DB roles and their exact
grants (from the role migrations), (d) the GUC mechanism (`app.tenant_id`,
`app.bypass_rls`, `app.bypass_purpose`) and helper contract (`withTenantRls` /
`withBypassRls` nesting rules).

**Guard prerequisite (applies to C6/C7/C8)**: `check-security-doc-exists.sh` is
currently single-purpose — hardcoded to one `DOC=` path and one inline
`required_headings=(...)` array (lines 1-71), with no multi-document support. Before
adding entries, refactor it into a data-driven loop over an array of
`{doc path, required heading list}` tuples (keeping the existing audit-anchor doc as
the first tuple, behavior-identical). The three new docs are then one tuple each — no
copy-pasted check blocks.

**Guard**: required-headings tuple added to the refactored script
(headings: `## RLS-enabled tables`, `## Bypass surface`, `## Worker roles and grants`,
`## Tenant-context GUC mechanism`).

**Acceptance criteria**: doc exists, headings check passes, every file/line claim
spot-checked against code during Phase 3.

### C7 — Auth Surface + Token Type Matrix doc

**File**: `docs/security/auth-surface-matrix.md` (hand-written).

Content: (a) mechanism × surface grid — session cookie, `api_` key, `sa_` token,
`op_` operator token, `mcp_` access/refresh, extension token, SCIM bearer, magic link,
passkey/WebAuthn — mapped to the route surfaces that accept each (grounded in the C1
manifest `auth` fields, `docs/architecture/machine-identity.md` dispatch table, and
route-policy kinds); (b) Token Type Matrix — per token type: prefix, issuer route,
validator function (file ref), TTL source, rotation, revocation path, hash-at-rest.

**Guard**: required-headings tuple in the refactored `check-security-doc-exists.sh`
(`## Auth surface grid`, `## Token type matrix`).

**Acceptance criteria**: every token type listed in
`feedback: session invalidation token-class enumeration` (Session, ApiKey, ExtensionToken,
ServiceAccountToken, OperatorToken, McpAccessToken, McpRefreshToken, DelegationSession,
magic-link verification token, mobile/extension bridge codes) has a row; validator file
refs resolve (spot-check in Phase 3).

### C8 — Audit Chain Threat Model doc

**File**: `docs/security/audit-chain-threat-model.md` (hand-written consolidation).

Content: chain construction (JCS canonicalization, SHA-256 link, per-tenant anchors,
genesis), anchor publishing + pause-window fail-closed behavior, attack tree
(row tamper, low-end truncation via retention purge, gap injection, anchor-race,
tag-secret boundary — consolidating what today lives across
`audit-anchor-verification.md`, `threat-model.md` §Repudiation, `security-review.md`),
and the **purge ↔ chain-verify interaction semantics as decided in C4/A1**.
Cross-links (not duplicates) to `audit-anchor-verification.md` for operator procedure.

**Guard**: required-headings tuple in the refactored `check-security-doc-exists.sh`
(`## Chain construction`, `## Attack tree`, `## Retention-purge interaction`,
`## Residual risks`). Heading guards verify structure, not content truth — content
accuracy is Phase 3 review's job. As a drift nudge for the safety-critical A1
semantics, add cross-reference comments at the two code sites that own the behavior
(the `audit_log_purge` definer-fn migration and the retention-gc registry
`audit_logs` entry) pointing to this doc's `## Retention-purge interaction` section,
mirroring the inline-justification convention used at RLS bypass call sites.

**Acceptance criteria**: doc exists; headings check passes; A1 decision recorded here;
both cross-reference comments present.

### C9 — Security docs index update

**Files**: `docs/security/README.md` (add the five new/updated docs),
`docs/security/security-review.md` (pointer paragraph to the new matrices if it has an
index section — verify during implementation; skip if none).

**Acceptance criteria**: `npm run check:env-docs`-style link validity is NOT in scope
(check-doc-paths skips docs/security — see SC3); manual link check suffices.

## Go/No-Go Gate

| ID  | Subject                                                    | Status  |
|-----|------------------------------------------------------------|---------|
| C1  | Route-policy manifest + vitest parity test                 | locked  |
| C2  | Raw-SQL usage allowlist + check script                     | locked  |
| C3  | pre-pr / package.json registration                          | locked  |
| C4  | Worker/raw-SQL three-expert safety review (P3)             | locked  |
| C5  | Generated Route Policy + Deletion/Retention matrices        | locked  |
| C6  | Tenant Boundary Matrix doc + heading guard                  | locked  |
| C7  | Auth Surface + Token Type Matrix doc + heading guard        | locked  |
| C8  | Audit Chain Threat Model doc + heading guard                | locked  |
| C9  | Security docs index update                                  | locked  |

Locked 2026-07-04 after 3 review rounds (17 + 9 + 2 findings, all resolved; Round-3
residuals were editorial and adopted verbatim from the experts' recommended wording).

## Testing strategy

- All RT7 fail-path proofs (C1, C2, C5 drift check) are recorded with command
  transcripts in `docs/archive/review/route-policy-sql-security-manual-test.md`
  (new artifact) — an unrecorded "verified once" claim is not auditable.
- C1: the deliverable IS a test; plus the recorded fail-path mutations above.
- C2/C3: `node scripts/checks/check-raw-sql-usage.mjs` + the five recorded violation
  runs; `pre-pr.sh` targeted steps under BOTH `PRE_PR_STATIC_ONLY=1` and full mode.
- C4: each in-branch fix ships a regression test that fails before the fix
  (unit or DB-integration as appropriate; worker tests live under
  `src/__tests__/db-integration/` for tx/locking behavior).
- C5: determinism test (run generator twice, diff); drift-check violation run.
- C6–C9: heading guards via `check-security-doc-exists.sh`; content accuracy is
  verified in Phase 3 review (file:line spot-checks by the experts).
- Mandatory before completion: `npx vitest run` and `npx next build` (generator +
  manifest test are code; build must stay green).

## Considerations & constraints

- The P1 session (branch `hardening/maintenance-ratelimit-openapi-host`) touches the 6
  maintenance routes and `rate-limit.ts`. C1's operator-gated assertion (8b) checks
  `verifyAdminToken(` + `requireMaintenanceOperator(` only — deliberately NOT the
  rate-limit call — to avoid coupling to the in-flight P1 diff. After P1 merges, a
  follow-up could strengthen assertion 8b to include the rate limiter (TODO marker in
  the test header).
- This branch is created from main AFTER the P1 branch merges (user instruction);
  member-set greps are re-run at implementation start to catch drift (R42 refresh).
- Manifest maintenance cost: every new route requires a manifest entry. This is the
  point (deliberate friction on security-surface growth), and mirrors the accepted cost
  of `check-bypass-rls.mjs`.
- Class-boundary exclusions (worker hard-deletes, `page.tsx` raw SQL) are documented in
  C1's "Documented class-boundary exclusions" block — single source, not restated here.

### Scope contract

| ID  | Deferred item | Owner / tracker |
|-----|---------------|-----------------|
| SC1 | Mobile/Extension side-by-side trust-boundary matrix (assessment target 9): two strong per-surface docs already exist (`extension-token-bridge.md`, `ios-app.md`); consolidation deferred | `TODO(route-policy-sql-security): mobile-extension trust boundary matrix` in docs/security/README.md |
| SC2 | P1 items (maintenance rate limit tenant-scope/fail-closed, OpenAPI host, memory-fallback eviction) | separate session, branch `hardening/maintenance-ratelimit-openapi-host` |
| SC3 | Removing `docs/security/**` from `check-doc-paths.mjs` SKIP_GLOBS (path-guard all security docs) | follow-up; blast radius spans 1000+ doc files. `TODO(route-policy-sql-security)` in check-doc-paths.mjs comment |
| SC4 | P3 findings with fix cost >30 min | follow-up PRs; deviation log + grep-able TODO markers per Anti-Deferral rules |
| SC5 | Route-handler standard wrapper / route policy DSL refactor (assessment's larger suggestion) | intentionally NOT this PR: manifest-first gives observability without touching 212 handlers. Future ADR if pursued |
| SC6 | Strengthening C1 assertion 8b with rate-limit presence after P1 merges | `TODO(route-policy-sql-security)` in parity test header; the TODO text embeds the mechanical follow-up: `grep -rn 'RateLimit' src/app/api/maintenance src/app/api/admin --include=route.ts` to derive the then-current limiter symbol before extending 8b |

## User operation scenarios

1. **Developer adds a new API route** → vitest parity test fails with
   "src/app/api/foo/route.ts has no manifest entry"; developer adds the entry, choosing
   kind/auth consciously — the security classification becomes part of the PR diff and
   review surface.
2. **Developer adds raw SQL to a service** → `check-raw-sql-usage.mjs` fails; developer
   adds `path # purpose` line; reviewer sees the new raw-SQL surface explicitly.
3. **Route's Bearer surface widens** (new method in `BEARER_RULES`) → parity test fails
   until `bearerBypass` updated; matrix doc regenerates showing the widened surface.
4. **Security auditor asks "why is this route public?"** → `handlerAuthReason` in the
   manifest / Route Policy Matrix answers with a reviewed rationale.
5. **Operator investigates retention behavior** → Deletion/Retention Matrix shows for
   every model whether/how it is purged and which tenant policy column governs it.

## Implementation Checklist

Impact analysis performed 2026-07-04 on post-P1 main (289b5be9); member sets re-derived
(R42 refresh): raw-SQL 29 / destructive 9 / operator-gated 10 (+1 declared-false, path
floor 11) / side-effecting GET 3 / route universe 212 — all match plan.

Reuse obligations (verified exports; sub-agents MUST NOT reimplement):
- `classifyRoute`, `ROUTE_POLICY_KIND` — src/lib/proxy/route-policy.ts:29,112
- `isBearerBypassRoute`, `isBearerBypassPath` — src/lib/proxy/cors-gate.ts:94,106
- txt allowlist conventions (`path # reason` ≥10 chars, STALE_EXEMPT) — check-permanent-delete-stepup.sh
- .mjs checker structure — check-bypass-rls.mjs
- generator sort-strategy comment — scripts/generate-env-example.ts
- run_step registration idiom — scripts/pre-pr.sh:158-186 (ungated region)

CI gate parity: CI invokes `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` (ci.yml:193),
so ungated pre-pr registration covers CI. npm aliases follow package.json `check:*`
convention. No parity gaps; no deferred-parity entries.

Batches:
- A (C1): route-class-patterns.json, route-policy-manifest.json (212 entries),
  route-policy-manifest.test.ts, check-permanent-delete-stepup.sh (jq -er)
- B (C2, after A): check-raw-sql-usage.mjs, raw-sql-usage.txt, sweep.ts markers
- C (C5+C3, after A): generate-security-matrices.ts + test, 2 generated docs,
  package.json scripts, pre-pr.sh registrations
- D (C4, parallel): 3-expert worker/raw-SQL safety review → fixes/TODOs
- E (C6-C9, after D): 3 hand-written docs, check-security-doc-exists.sh refactor,
  README index, cross-ref comments
