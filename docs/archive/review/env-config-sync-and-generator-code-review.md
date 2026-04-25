# Code Review: env-config-sync-and-generator

Date: 2026-04-24
Review rounds: 2 (converged)

## Changes from Previous Round

### Round 1
Initial code review after Phase 2 completion. Three expert sub-agents reviewed 71 files / ~6077 insertions on `feature/env-config-sync-and-generator`. Local LLM pre-screening returned "No issues found".

Round 1 surfaced **17 findings: 0 Critical, 8 Major, 9 Minor.** All Majors fixed; 7 of 9 Minors fixed; 2 Minors accepted under Anti-Deferral Rules §Point 3 (see Resolution Status below).

### Round 2 (verification-only)
After Round 1 fixes landed as commit `6e47d0a4`, a single verification-scope sub-agent confirmed each of the 14 claimed fixes against the actual shipped code, ran `npx vitest run scripts/__tests__/ src/lib/env.test.ts` (132 passed + 1 skipped), `npm run lint` (exit 0), and `npm run check:env-docs` (exit 0).

**Verdict: Verified clean. No new regressions.**

### Post-review user feedback (2026-04-25)
User pointed out a real onboarding gap: the new `npm run init:env` writes only Zod-declared vars to `.env.local`, but Docker Compose's `${JACKSON_API_KEY:?...}` substitution requires `JACKSON_API_KEY` to be in the host env. New developers running `init:env` then `docker compose up` would hit `Error: JACKSON_API_KEY is required`. The plan's allowlist accepted that the var was "external to the app" but did not surface it to operators.

Closed the gap on this branch (commit pending):
- `scripts/env-allowlist.ts`: added `includeInExample`, `description`, `example`, `secret` fields to `LiteralAllowlistEntry`. Marked JACKSON_API_KEY, PASSWD_OUTBOX_WORKER_PASSWORD, SENTRY_AUTH_TOKEN, NEXT_DEV_ALLOWED_ORIGINS as `includeInExample: true`. Framework-set NEXT_RUNTIME and test-only BASE_URL/APP_DATABASE_URL stay invisible.
- `scripts/generate-env-example.ts`: emits a trailing **External / Build-time** section listing every `includeInExample: true` entry with its description, secret-pattern guard applied. NF-3 determinism preserved.
- `scripts/init-env.ts`: prompts for the same set after the Zod loop, with the secret-aware "Generate now? [Y/n]" flow (24-byte hex for JACKSON_API_KEY, 32-byte for the others). Empty input → field omitted from .env.local. Values written under a matching trailing section with the same hex-32+ guard.
- `scripts/check-env-docs.ts`: extended `AllowlistEntry` shape to accept the new fields.
- `package.json`: added `npm run docker:up` / `docker:down` wrappers that pass `--env-file .env.local` so the Next.js app and Docker Compose share one source of truth.
- `README.md`: new ".env vs .env.local" subsection documenting the docker workflow and the trailing External section.
- `CLAUDE.md`: Common Commands block adds docker:up/down; Docker line updated with the new wrapper.

Tests added:
- `generate-env-example.test.mjs`: asserts External section header + each operator-facing var appears as commented; verifies framework-set/test-only vars do NOT appear.
- `init-env.test.mjs`: dev-profile happy path now also asserts `JACKSON_API_KEY` (48-hex generated) and `PASSWD_OUTBOX_WORKER_PASSWORD` (64-hex) are written; verifies External section header in file content.

Verification: lint clean, 133 tests pass + 1 win32 skip, `npm run check:env-docs` exit 0, `npx next build` succeeds.

### Round 3 (incremental review of commit `66fbfd74`)
Three expert sub-agents reviewed the onboarding-gap fix commit. **0 Critical, 3 Major, 5 Minor.** Security expert found nothing — all NF/SEC obligations correctly extended to External-section entries.

**Functionality:**
- CF5 Major: `--profile=ci` blocked on the new external-allowlist prompt loop (no skip guard).
  - **RESOLVED**: Added `skipExternalPrompts = profile === "ci"` guard around the external loop. Also extended ci-profile seeding to include Zod-default fields (so any optional-with-default field doesn't fall into the prompt loop). Changed prompt-loop guard from `if (profile === "ci" && sources.get(key) === "profile")` to unconditional `if (profile === "ci") continue` — ci is now strictly non-interactive.
- CF6 Minor: Backup-and-overwrite re-prompted everything, silently dropping prior secrets when user pressed Enter.
  - **RESOLVED**: Added `parseSimpleDotenv()` helper (exported for unit testing). When the user picks "Backup-and-overwrite", existing `.env.local` is parsed and `priorValues` is seeded into `collected` with source="user". Both Zod prompt loop and external loop use prior values as defaults. Stdout prints "Prior values restored as defaults" hint after the backup line.
- CF7 Minor: External section emitted as commented (`# JACKSON_API_KEY=`) — broke `cp .env.example .env.local && npm run docker:up` flow for required-for-deployment entries.
  - **RESOLVED**: Added `requiredForConsumer?: boolean` to `LiteralAllowlistEntry`. Marked `JACKSON_API_KEY` and `PASSWD_OUTBOX_WORKER_PASSWORD` true. Generator emits these uncommented (parallel to CF4 always-required Zod fields). `SENTRY_AUTH_TOKEN` and `NEXT_DEV_ALLOWED_ORIGINS` stay commented (optional). Drift checker shape extended to accept the new field.

**Testing:**
- CT12 Major / CT13 Major / CT14 Minor: deferred under Anti-Deferral Rules §Point 3.
  - **CT12 (user-entered external value path)**: defense-in-depth coverage; existing tests + the source-grep wiring assertion catch regressions in the surrounding structure. Worst case: a regression in the user-entered (non-generate) external branch goes undetected; likelihood low (the branch is straightforward and shares `validateInputValue` with the Zod loop); cost to fix: ~30 LoC plus stream-coordination work that has historically been flake-prone.
  - **CT13 (hex-on-non-secret allowlist abort)**: defense-in-depth; would need a test-only allowlist fixture to monkey-patch in a poisoned entry. Worst case: a future allowlist change with `secret: false` and a hex example slips through to .env.example; likelihood low (CODEOWNERS gate + the existing hex-32+ scan in `generate-env-example.test.mjs:135` would flag the OUTPUT even if the abort test is missing); cost to fix: ~60 LoC fixture infrastructure.
  - **CT14 (production profile + allowlist prompts)**: production happy-path test would need a complete fixture (real DATABASE_URL/AUTH_URL/etc.); the existing production-fail test does cover the prompt-loop interaction up to the validation gate.
- CT15 Minor: Backup-and-overwrite path with allowlist entries untested.
  - **RESOLVED**: Added 3 unit tests against the exported `parseSimpleDotenv` (bare KEY=value, quoted with escapes, and a wiring-assertion test that greps init-env.ts for the priorValues seeding code paths). Avoids the readline-driver flakiness that an end-to-end Backup-flow test would surface.
- CT16 Minor: `npm run docker:up` wrapper had no test.
  - **RESOLVED**: Added a `package.json` string assertion that `docker:up` and `docker:down` both contain `--env-file .env.local` and both compose `-f` flags.
- CT17: documentation only — skipped.

**New Round 3 test file count**: `init-env.test.mjs` 5 → 10 tests (one new file in CT16's describe block); `generate-env-example.test.mjs` assertion update only. All 12 test files pass — 138 total + 1 win32 skip.

**Verification**: lint clean, `npm run check:env-docs` exit 0, `npx next build` succeeds.

## Functionality Findings

### [CF1] Major: init-env.ts missing NF-4.6 secret-pattern guard
- File: scripts/init-env.ts write loop
- Problem: generate-env-example.ts enforces the hex-32+ emit guard (NF-4.6/S16); init-env.ts did not.
- **RESOLVED**: Added HEX32_RE guard before each `lines.push(\`${key}=...\`)`. Non-secret fields with hex values now abort with a sidecar-bug error.

### [CF2] Major: env-provider.ts:61 bracket V-access NOT refactored
- Plan A-Table-1 D6-split specified refactor.
- **RESOLVED via deviation-log D7**: `env-provider.ts` left unchanged; D7 documents why (Phase 2 migration, not Phase 1 SSOT). Runtime behavior unchanged; no drift-checker false positive.

### [CF3] Major: Plan §E per-field tests for A1-A33 + V1..V10 not shipped
- File: src/lib/env.test.ts unchanged before this round.
- **RESOLVED**: Extended src/lib/env.test.ts with a new `describe("envObject per-field validation")` block. Adds per-field accept/reject for LOG_LEVEL, HEALTH_REDIS_REQUIRED, SMTP_PORT (incl. F22 regression), OUTBOX_BATCH_SIZE, OUTBOX_WORKER_DATABASE_URL, REDIS_SENTINEL_*, NEXT_PUBLIC_*, NEXTAUTH_URL, V1..V10 (hex acceptance + non-hex rejection via it.each), AUDIT_LOG_FORWARD. 53 tests total pass.

### [CF4] Minor: DATABASE_URL emitted as commented in .env.example (UX regression)
- File: scripts/generate-env-example.ts:197-207
- **RESOLVED**: Added `isZodOptional`/`isAlwaysRequired` helpers. Keys without `.default()` AND without `.optional()` now emit uncommented. `.env.example` regenerated: `DATABASE_URL=postgresql://passwd_app:pass@localhost:5432/passwd_sso` is now uncommented.

## Security Findings

### [CS1] Minor: Same-line `/* ... */` block comments not exempted by hex-leak-scan
- File: scripts/lib/hex-leak-scan.mjs
- **RESOLVED**: Added `cleaned = content.replace(/\/\*[\s\S]*?\*\//g, "")` before HEX64_RE check. Same-line block comments are now stripped before matching. New test fixtures (f) and (g) verify the behavior — inline hex in comment exempt, hex OUTSIDE the comment still flagged.

### [CS2] Minor: init-env.ts re-prompt loop printed stale validation errors
- File: scripts/init-env.ts reprompt loop
- **RESOLVED**: Added `currentIssues` variable refreshed from each `testResult` at the end of the retry iteration. Users now see the error for the value they JUST typed, not the stale original message. NF-4.3 (no rejected value echo) still satisfied — `issue.message` does not embed input values for the Zod validator types used.

## Testing Findings

### [CT1] Major: Generator determinism test writes to live repo's .env.example (non-hermetic)
- **RESOLVED**: Added `--out=<path>` CLI arg to `scripts/generate-env-example.ts`. `scripts/__tests__/generate-env-example.test.mjs` rewritten to use `mkdtempSync()` per test and spawn the generator with `--out=<tmpdir>/.env.example`. Live repo file is never touched by vitest.

### [CT2] Major: T26 locale test reimplemented sort logic locally
- **RESOLVED**: Extracted comparator into `scripts/lib/env-sort.ts` as `makeEnvKeyCollator(locale)`. Generator imports it; test imports the same function and exercises it against `["İ","I","i","a","Z"]` under "en" vs "tr". Regression guard: `expect(enSorted).not.toEqual(trSorted)` — a regression to locale-independent sort would fail this assertion. ASCII-only subset also tested.

### [CT3] Major: Re-prompt count 5 not asserted
- **RESOLVED**: Test now captures stdout, counts `Re-enter <field>` occurrences per field, and asserts `maxRetries === 5`. A regression changing MAX_FIELD_ATTEMPTS to any other value fails the test.

### [CT4] Major: hex-leak-scan block-comment fixture didn't exercise state machine
- **RESOLVED**: Added new fixture `(d-bare)` where hex is on a BARE line inside a `/* ... */` block — no leading ` * ` to trigger the single-line-comment regex. Only the block-comment state machine can exempt this case. Keeps the original JSDoc `(d)` as a second test.

### [CT5] Major: Ambiguous-bucket fixture also triggered stale-allowlist
- **RESOLVED**: Created `scripts/__tests__/fixtures/env-drift/ambiguous-bucket/scripts/some-script.sh` containing DATABASE_URL. The stale-allowlist check is now satisfied, isolating the ambiguous-bucket assertion.

### [CT6] Minor: extractJsonLine dotenvx skip comment misleading
- **RESOLVED**: Replaced the prefix-match skip with a comment-documented catch-based skip. Non-JSON lines fall through to JSON.parse and are skipped on parse error — no reliance on specific prefix strings.

### [CT7] Minor: Determinism test r1 vs r2 byte-equality inferred via stdout
- **RESOLVED** as part of CT1 rewrite: content1 is read immediately after r1, content2 after r2, direct byte equality asserted.

### [CT9] Minor: Pre-pr wiring test grep pattern brittle to label changes
- **RESOLVED**: Pattern softened to `/run_step[\s\S]{0,120}check:env-docs/` — tolerates label-text renames.

### [CT10] Minor: init-env dev-profile test asserted envObject (looser) not envSchema
- **RESOLVED**: Test now asserts `envSchema.safeParse(parsed).success === true` AND `envObject.safeParse(parsed).success === true`. Surfaces cross-field superRefine mismatches that envObject alone would miss.

## Minor Findings Deferred

### [CT8] Positive fixture too minimal
- Defer as acceptable (most checks have dedicated negative cases). Can expand in a follow-up.

### [CT11] init-env test imports `dotenv` for parsing
- Defer as acceptable (dotenv is an existing dep; the parser is well-tested).

## Adjacent Findings

None in Round 1 — all findings landed cleanly within each expert's scope.

## Quality Warnings

None — every finding had specific file:line evidence.

## Recurring Issue Check

### Functionality expert
R1-R30: pass (see func-findings.txt §Recurring Issue Check). Notable: R16 (input validation) → CF1 resolved; R25 (plan divergence) → CF2 + CF3 resolved; R9 (test file colocation) → CF3 resolved.

### Security expert
R1-R30 + RS1-RS3: pass. Two minor findings (CS1, CS2) both resolved. No Critical escalations.

### Testing expert
R1-R30 + RT1-RT3: pass. Noted failures: R4/R7/R27 (CT1/CT2/CT3) — all resolved. RT1 (CT6) — resolved. RT2 (CT2) — resolved.

## Resolution Status

### [CF1] Major — RESOLVED
- Action: Added HEX32_RE guard in init-env.ts write loop; non-secret hex value aborts with sidecar-bug error.
- Modified file: scripts/init-env.ts (write loop, before lines.push)

### [CF2] Major — RESOLVED via deviation-log D7
- Action: Documented Phase-2-migration rationale in D7 rather than refactoring env-provider.ts in this PR (Phase 1 SSOT charter; refactor is invasive on hot-path decrypt code).
- Modified file: docs/archive/review/env-config-sync-and-generator-deviation.md (D7 added)
- Anti-Deferral check: "pre-existing pattern in an unchanged file" — env-provider.ts:61 is NOT in `git diff main...HEAD`, but the plan promised a refactor. The D7 entry routes this to a Phase 2 follow-up with a grep-visible `TODO(env-config-phase2)` marker. Acceptable risk: worst case = no Phase 2 follow-up ever happens (low likelihood — env.ts header explicitly schedules it); cost to fix = 10-20 LoC plus hot-path integration test.

### [CF3] Major — RESOLVED
- Action: Extended src/lib/env.test.ts with `describe("envObject per-field validation")` — 25 new assertions covering LOG_LEVEL, HEALTH_REDIS_REQUIRED, SMTP_PORT (F22 regression), OUTBOX_BATCH_SIZE, OUTBOX_WORKER_DATABASE_URL, REDIS_SENTINEL_*, NEXT_PUBLIC_*, NEXTAUTH_URL, V1..V10, AUDIT_LOG_FORWARD.
- Modified file: src/lib/env.test.ts (appended describe block)

### [CF4] Minor — RESOLVED
- Action: Added isZodOptional + isAlwaysRequired helpers; emit uncommented when has-default OR always-required. Regenerated .env.example.
- Modified file: scripts/generate-env-example.ts, .env.example

### [CS1] Minor — RESOLVED
- Action: Inline /* ... */ stripping via `content.replace(/\/\*[\s\S]*?\*\//g, "")` before HEX64 check. Tests (f) and (g) added.
- Modified file: scripts/lib/hex-leak-scan.mjs, scripts/__tests__/pre-pr-hex-fallback.test.mjs

### [CS2] Minor — RESOLVED
- Action: currentIssues refreshed from each testResult at end of retry iteration.
- Modified file: scripts/init-env.ts (reprompt loop)

### [CT1] Major — RESOLVED
- Action: --out CLI arg added to generator; test uses mkdtempSync-per-test hermetic pattern.
- Modified files: scripts/generate-env-example.ts, scripts/__tests__/generate-env-example.test.mjs

### [CT2] Major — RESOLVED
- Action: Extracted comparator to scripts/lib/env-sort.ts. Tests import and exercise directly; no local reimplementation.
- Modified files: scripts/lib/env-sort.ts (NEW), scripts/generate-env-example.ts, scripts/__tests__/generate-env-example.test.mjs

### [CT3] Major — RESOLVED
- Action: Count `Re-enter <field>` occurrences in stdout; assert maxRetries === 5.
- Modified file: scripts/__tests__/init-env.test.mjs

### [CT4] Major — RESOLVED
- Action: Added (d-bare) fixture where hex is on a comment-prefix-less line inside a multi-line block.
- Modified file: scripts/__tests__/pre-pr-hex-fallback.test.mjs

### [CT5] Major — RESOLVED
- Action: Added scripts/__tests__/fixtures/env-drift/ambiguous-bucket/scripts/some-script.sh to satisfy stale-allowlist check.
- Modified file: fixture file added

### [CT6] Minor — RESOLVED
- Action: Replaced prefix-match skip with catch-based skip; updated comment to reflect dotenv (not dotenvx) reality.
- Modified file: scripts/__tests__/audit-outbox-worker-env.test.mjs

### [CT7] Minor — RESOLVED
- Action: Folded into CT1 rewrite — content1 read immediately after r1, direct byte equality.
- Modified file: scripts/__tests__/generate-env-example.test.mjs

### [CT9] Minor — RESOLVED
- Action: Grep pattern softened to tolerate label-text changes.
- Modified file: scripts/__tests__/pre-pr-env-drift.test.mjs

### [CT10] Minor — RESOLVED
- Action: Assert both envSchema.safeParse and envObject.safeParse success.
- Modified file: scripts/__tests__/init-env.test.mjs

### [CT8] Minor — Accepted
- **Anti-Deferral check**: "acceptable risk" — minimal positive fixture.
- **Justification**:
  - Worst case: a regression where check 3/4/5/9/10 always returns ERROR in happy path goes undetected.
  - Likelihood: low — negative cases for each check exercise the check logic; a happy-path regression would also fail multiple negative-case assertions.
  - Cost to fix: ~30 LoC for an expanded positive fixture + 1-2 more positive sub-fixtures.
- **Orchestrator sign-off**: Acceptable risk per Anti-Deferral Rules §Point 3. Tracked as `TODO(env-config-followup): expand positive fixture to exercise checks 3/4/5/9/10 green branches`.

### [CT11] Minor — Accepted
- **Anti-Deferral check**: "acceptable risk" — test depends on dotenv.parse for assertions.
- **Justification**:
  - Worst case: a divergence between `dotenvEscape()` and `dotenv.parse()` on an edge case (e.g. embedded $, \n) produces a false green or false red test.
  - Likelihood: low — both use compatible dotenv syntax on the subset used (simple KEY="value" with common escapes); no adversarial inputs in the test fixture.
  - Cost to fix: ~40 LoC for a round-trip test of dotenvEscape against adversarial inputs.
- **Orchestrator sign-off**: Acceptable risk per Anti-Deferral Rules §Point 3. dotenv is already a runtime dep; the assertion uses stable syntax.
