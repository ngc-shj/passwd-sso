# Code Review: env-config-sync-and-generator

Date: 2026-04-24
Review round: 1

## Changes from Previous Round

Initial code review after Phase 2 completion. Three expert sub-agents reviewed 71 files / ~6077 insertions on `feature/env-config-sync-and-generator`. Local LLM pre-screening returned "No issues found".

Round 1 surfaced **17 findings: 0 Critical, 8 Major, 9 Minor.** All Majors fixed in this round; most Minors fixed too.

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
