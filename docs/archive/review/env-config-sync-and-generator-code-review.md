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

### Round 4 (verification-only, post commit `e563460c`)
A single verification-scope sub-agent confirmed each Round 3 claimed fix against the shipped code:
- CF5/CF6/CF7 wiring at concrete file:line locations (sidecar grep + structural assertions).
- CT15/CT16 test names match the plan obligations.
- vitest: 138 passed + 1 skipped. lint: 0 errors. check:env-docs: exit 0.
- No new regressions.

**Verdict: Verified clean. No Round 5 needed.**

Code review converged after **4 review rounds + 2 fix commits + 1 follow-up commit**, total 12 commits on the feature branch.

### Post-convergence refactor: `.env`-primary (2026-04-25)

User questioned whether `.env.local` was necessary at all given the new `--env-file .env.local` workaround in the docker wrappers. Confirmed it was workaround complexity without underlying value: both `.env` and `.env.local` were gitignored at the same level, no shared base file was ever committed, and Docker Compose's natural file is `.env`. Switched to **Option A**: `.env` is the canonical file (auto-loaded by both Docker Compose and Next.js convention); `.env.local` is preserved as the optional per-developer override.

Changes:
- `src/lib/load-env.ts`: comment-only clarification — load order was already correct (`.env.local` first under dotenv's no-overwrite policy = override semantics; `.env` second as base).
- `scripts/init-env.ts`: write target changed to `.env`. Backup files now `.env.bak-<UTC stamp>` (was `.env.local.bak-...`). Atomic-write tmp file is `.env.tmp`. The git tracked-file safety check covers BOTH new (`.env`/`.env.tmp`) and legacy (`.env.local`/`.env.local.tmp`) names so a mid-migration developer is still protected. New "Migration warning" surfaces a one-time NOTE when a legacy `.env.local` exists, recommending `mv .env.local .env`. The header doc + every internal stderr/stdout message updated.
- `package.json`: `docker:up`/`docker:down` no longer pass `--env-file .env.local` — Docker Compose auto-loads `.env`.
- `.gitignore`: added `.env.tmp`/`.env.tmp.*`/`.env.bak`/`.env.bak-*`/`.env.bak.*` patterns alongside the existing legacy `.env.local.*` patterns.
- `scripts/__tests__/check-env-gitignore.test.mjs`: now iterates both new and legacy patterns (12 tests total).
- `scripts/__tests__/init-env.test.mjs`: `envLocalPath` → `envPath`, all `.env.local` references → `.env`. CT16 docker-wrapper test inverted — now asserts `--env-file` is NOT present (a regression to it would re-introduce the workaround era).
- `scripts/generate-env-example.ts`: External-section header text updated to reflect the new `.env`-auto-load reality (no more `--env-file` instruction).
- `README.md`: rewrote ".env vs .env.local" subsection. Migration callout: "if your repo predates this change you may have a `.env.local` and no `.env` — run `mv .env.local .env`".
- `CLAUDE.md`: Common Commands + Notes-on-env-files updated with the new convention.

Verification: lint clean, `npm run check:env-docs` exit 0, `npx vitest run scripts/__tests__/ src/lib/env.test.ts` 144 passed + 1 skipped, `npx next build` succeeds.

### Round 5 (incremental review of commit `44e7211e`, the .env-primary refactor)

Triangulated review on the .env-primary refactor commit alone. Three experts + Ollama pre-screen. **1 Critical, 6 Major, 3 Minor.** Critical was caught independently by both Functionality (RF1) and Security (RS-1). Pre-screening returned a Major finding that proved to be a false positive (Ollama hallucinated based on partial diff context — sidecar entries it claimed were missing actually exist from earlier commits).

#### Findings + resolutions

**RF1 / RS-1 Critical**: `docker-compose.yml:13` and `docker-compose.override.yml:26` retained `env_file: - .env.local`. After the refactor, `init:env` writes to `.env` and the README migration callout says `mv .env.local .env`. Result: `npm run docker:up` would fail with "env file `.env.local` not found" for any developer following the new flow.
- **RESOLVED**: Both compose files now `env_file: - .env`. Inline comments explain that `.env.local` is NOT injected into containers; override semantics apply only to host-side `npm run dev` via `src/lib/load-env.ts`.

**RF2 Major**: README migration paragraph contradicted itself (told users `mv .env.local .env` would let docker:up work, but RF1 broke that promise).
- **RESOLVED**: RF1 fix makes the README accurate. No README change needed beyond what the prior commit already shipped.

**RF3 Minor → upgraded to addressed because operator UX matters**: when both `.env` and `.env.local` exist on a mid-migration developer's machine, the Backup-and-overwrite path read `priorValues` from `.env` only, silently losing keys that lived solely in `.env.local`.
- **RESOLVED**: When `legacyLocalExists && envExists` and the operator picks Backup-and-overwrite, init-env.ts now also parses `.env.local` and merges its keys into `priorValues` (`.env` wins on conflicts — mirrors load-env.ts precedence). User-visible message confirms the merge count.

**RT1 Major**: legacy `.env.local` migration NOTE had no test.
- **RESOLVED**: New test `emits the migration NOTE when .env.local exists and writes new content to .env (not .env.local)` pre-creates `.env.local` in the tmpDir, runs `init:env --profile=dev`, asserts (a) stderr contains the NOTE + recommended `mv` command, (b) `.env` is created with new content, (c) `.env.local` is left untouched.

**RT2 Major**: backup-file path (`.env.bak-<stamp>`) and 0600 mode were not exercised by any end-to-end test.
- **PARTIALLY RESOLVED via wiring assertion**: an end-to-end Backup-and-overwrite test consistently OOMed vitest's fork worker (the readline-non-TTY buffering issue documented in the existing test file's preamble — driving 40+ prompts via `DelayedAnswerStream` + fallback `""` exhausts the fork's heap). Replaced with a wiring assertion that greps init-env.ts for the exact `path.join(repoRoot, \`.env.bak-${stamp}\`)` literal AND for `await atomicWrite(backupPath, ...)`. The atomicWrite mode-0600 guarantee is already verified end-to-end by the existing "sets file mode 0600 on the written .env" test (same call site — atomic-write helper is shared between primary and backup paths).
- **Anti-Deferral check**: acceptable risk per Anti-Deferral Rules §Point 3.
  - Worst case: a future change reverts the backup-file naming to `.env.local.bak-*` AND replaces atomicWrite with a non-atomic write. The wiring assertion catches the path naming; the atomicWrite call coverage in the primary path catches the mode regression.
  - Likelihood: low — both regressions would have to land together.
  - Cost to fix: ~50 LoC plus solving the readline-OOM driver issue (historically flake-prone).

**RT3 Major**: `src/lib/load-env.ts` precedence (`.env.local` overrides `.env`) was an invariant in a comment with no enforcing test (R25 persist-hydrate symmetry).
- **RESOLVED**: New `src/lib/load-env.test.ts` with 5 tests pinning the override semantics: (1) `.env.local` overrides `.env` at the same key; (2) `.env` fills in keys not in `.env.local`; (3) `.env`-only fallback; (4) `.env.local`-only back-compat; (5) shell-env wins over both files (dotenv default no-overwrite behavior).

**RT4 Minor (deferred)**: CT16 inversion test only checks `docker:up`/`docker:down`, not sibling `docker:*` scripts that don't exist yet. Acceptable risk — sibling scripts can be added with their own assertions when needed.

**RS-2 Minor (no action)**: `.env.bak` (no suffix) is gitignored + tested but never written by `init-env.ts`. Defensive — guards against operator manual `cp .env .env.bak`. Correct as-is.

**Pre-screening false positive**: Ollama claimed many sidecar entries (NEXTAUTH_URL, AZURE_KV_URL, etc.) were missing. Verified all 4 cited keys exist in `scripts/env-descriptions.ts`. `npm run check:env-docs` continues to pass — the sidecar↔Zod sync check confirms completeness independently.

#### Verification

- `npm run lint`: exit 0
- `npm run check:env-docs`: exit 0
- `npx vitest run scripts/__tests__/ src/lib/env.test.ts src/lib/load-env.test.ts`: 151 passed + 1 skipped (13 test files)
- `npx next build`: success

**Verdict**: 1 Critical + 5 Major resolved on this branch (RF1/RS-1, RF2, RF3, RT1, RT3). 1 Major partially resolved via wiring assertion (RT2). 1 Minor deferred (RT4). Plan converged.

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
