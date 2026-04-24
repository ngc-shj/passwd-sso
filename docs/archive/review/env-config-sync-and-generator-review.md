# Plan Review: env-config-sync-and-generator

Date: 2026-04-24
Review round: 2

## Changes from Previous Round

Round 1 findings fully reflected in the plan rewrite (see `env-config-sync-and-generator-plan.md` rev-`round-2`). Round 2 re-review surfaces:
- 1 **Critical** (F16 — `envSchema.pick()` throws on refined schema; T9 fix broken)
- 8 **Major** (F17-F20, S14, S15, T16-T18)
- 10 **Minor** (F21-F24, S16-S18, T19-T23)

Verified as resolved: R1-F1..F13 (all Functionality Round 1 issues), R1-S1..S11 (all Security Round 1 issues), R1-T1..T13 (all Testing Round 1 issues).

---

## Round 2 Findings

### [F16] Critical: `envSchema.pick()` throws on refined schema — T9 Option (a) fix is broken
- File: plan `:176, :368`; `src/lib/env.ts:37-333`
- Evidence: Zod 4.3.6 (installed version) runtime test:
  ```
  envSchema.pick({ DATABASE_URL: true }) → throws ".pick() cannot be used on object schemas containing refinements"
  ```
- Impact: Step 5 fails on first run; F-Req-1 worker validation obligation unmet.
- Fix: Split schema export into `envObject` (pure `z.object`, pickable) and `envSchema = envObject.superRefine(...)` (used by parseEnv). Worker imports `envObject.pick({...}).parse(process.env)`. Update plan step 3 accordingly.

### [F17] Major: `SHARE_MASTER_KEY_CURRENT_VERSION.max(10)` is a silent boot regression
- Evidence: Current schema `.max(100)`. Plan's D6-split text "Tightened to 10" breaks any tenant past V10.
- Fix: Keep `.max(100)`. Model V1..V10 as explicit Zod fields. Keep V11..V100 in `superRefine` via `data.SHARE_MASTER_KEY_V${n}` — after the refactor the schema can be queried by `envObject.shape[`SHARE_MASTER_KEY_V${n}`]` for 1..10, and by `process.env[...]` fallback inside superRefine for >10 (documented exception).

### [F18] Major: D6-split row overstates files with bracket access
- Evidence: `src/lib/crypto/crypto-server.ts:38` + `src/lib/key-provider/base-cloud-provider.ts:90` read only CURRENT_VERSION, NOT V{N}. Only `src/lib/env.ts:294,306` and `src/lib/key-provider/env-provider.ts:61` do bracket V{N} access.
- Fix: Narrow the file list in D6-split row.

### [F19] Major: A34 (NEXT_DEV_ALLOWED_ORIGINS) classification wrong — Zod default unreachable
- Evidence: `next.config.ts:28` is evaluated by Next CLI at build/dev-server start, BEFORE `register()` runs.
- Impact: Zod validation does nothing for this var; allowlist is the correct bucket.
- Fix: Move A34 from A-Table-1 to A-Table-2 with `consumers=["next.config.ts:28"]`.

### [F20] Major: A30-A33 (NEXT_PUBLIC_*) server Zod default does not reach client bundle
- Evidence: Next.js inlines `NEXT_PUBLIC_*` at build time; unset at build ⇒ `undefined` in client bundle; server-side `.default()` cannot rescue.
- Fix: Keep A30-A33 in Zod (server-side safety net), but add NF-5 anti-regression: "consumer-side `??` fallbacks MUST NOT be removed because client bundles inline at build time."

### [F21] Minor: Worker `pick()` set ellipsis ambiguous
- Fix: Enumerate the complete pick set: `{ DATABASE_URL, OUTBOX_WORKER_DATABASE_URL, OUTBOX_BATCH_SIZE, OUTBOX_POLL_INTERVAL_MS, OUTBOX_PROCESSING_TIMEOUT_MS, OUTBOX_MAX_ATTEMPTS, OUTBOX_RETENTION_HOURS, OUTBOX_FAILED_RETENTION_DAYS, OUTBOX_READY_PENDING_THRESHOLD, OUTBOX_READY_OLDEST_THRESHOLD_SECS, OUTBOX_REAPER_INTERVAL_MS, NODE_ENV, DB_POOL_*, LOG_LEVEL, AUDIT_LOG_FORWARD, AUDIT_LOG_APP_NAME }`. Document that `envInt`-based reads still use process.env for the moment (Phase 2 migration).

### [F22] Minor: A7 SMTP_PORT behavior changes for empty string
- Evidence: `parseInt("" ?? "587")` → NaN today; Zod `z.coerce.number()` on empty string fails safeParse.
- Fix: Document in NF-5 as "intentional boot-time validation tightening for SMTP_PORT"; add a test asserting empty-string rejection.

### [F23] Minor: A-Table-3 V{N} commented placeholders vs drift check 8 interact
- Fix: Document that check 8 enforces only `.required()`; conditional (`superRefine`) requirements are out of the drift-checker's scope. Note this limitation in §D.

### [F24] Minor: Prompt order vs write order
- Fix: Decouple in §C: prompt order = required-first → conditional-required → optional, within (group, order) as tiebreaker. Write order stays sidecar (group, order).

### [S14] Major: SEC-5 fallback regex misses hex in `.ts`/`.mjs` source files
- Evidence: Plan's fallback only matches `KEY=hex64` dotenv shape; a hardcoded `const X = "abc...64hex"` in `.ts` slips through.
- Fix: Broaden to `grep -E '^\+.*\b[a-f0-9]{64}\b' | grep -v '^\+[[:space:]]*(//|#|\*)'` and add an explicit disclaimer that the fallback is best-effort, not a gitleaks substitute.

### [S15] Major: `LOG_LEVEL=debug` production `superRefine` is a silent boot regression
- Evidence: Plan's A1 adds `superRefine` forbidding `debug`/`trace` in production. Existing deployments with `LOG_LEVEL=debug` for troubleshooting boot today; they will crash after merge.
- Fix: Remove the production `superRefine` from this PR. A1 stays as enum + `.default("info")`. Schedule the tightening as a follow-up PR with changelog, deprecation warning phase, and operator-facing docs.

### [S16] Minor: `.env.example` generator must apply NF-4.6 secret-pattern guard too
- Fix: Extend NF-4.6: the guard applies to BOTH `init:env` (writes `.env.local`) AND `generate:env-example` (writes `.env.example`). For any `secret: true` field, the example is replaced with a canonical placeholder `# generate via crypto.randomBytes(32).toString('hex')` — never emits a literal hex even if the sidecar author supplies one.

### [S17] Minor: SENTRY_DSN vs NEXT_PUBLIC_SENTRY_DSN confusion guard
- Fix: A14's sidecar description must explicitly note: "Server-only DSN. DO NOT reuse the same value as NEXT_PUBLIC_SENTRY_DSN. Use a dedicated client DSN with narrower scope for the browser."

### [S18] Minor: CODEOWNERS line added but not registered in `check-codeowners-drift.mjs` roster
- Evidence: `scripts/check-codeowners-drift.mjs` `ROSTER_GLOBS` does not include `scripts/env-allowlist.ts`.
- Fix: Add `"scripts/env-allowlist.ts"` to the roster in the same commit as the CODEOWNERS line.

### [T16] Major: Global `src/__tests__/setup.ts` bleeds `process.env` into `scripts/__tests__/`
- Evidence: `vitest.config.ts:14` applies `setupFiles` to all includes.
- Fix: §E adds mandatory pattern — `beforeEach`/`afterEach` snapshot/restore `process.env`; subprocess spawns use explicit `{ env: { PATH, ...overrides } }` — no inheritance.

### [T17] Major: `audit-outbox-worker-env.test.mjs` needs concrete spawn contract
- Fix: Add `--validate-env-only` flag to the worker that exits 0 after `envObject.pick({...}).parse(process.env)` — deterministic, no DB needed. Tests spawn `tsx scripts/audit-outbox-worker.ts --validate-env-only` with explicit env. Assert exit code + stderr content.

### [T18] Major: `pre-pr-env-drift.test.mjs` risks recursive vitest invocation
- Evidence: `pre-pr.sh:52` runs `npx vitest run` — spawning `pre-pr.sh` from vitest would recurse.
- Fix: Split the test in two: (1) spawn ONLY `npm run check:env-docs` with a broken sidecar fixture, assert exit 1; (2) grep-style wiring assertion on `scripts/pre-pr.sh` to prove the step is called. Do NOT spawn full `pre-pr.sh`.

### [T19] Minor: `LANG=ja_JP.UTF-8` may silently fall back to C on CI
- Fix: Use `LC_ALL=tr_TR.UTF-8` (Turkish dotted/dotless I — classic localeCompare foot-gun; available on ubuntu-latest). Add a precondition assertion that the locale is installed; skip with clear message otherwise.

### [T20] Minor: Windows mode-0600 assertion silently skips
- Fix: Use `it.skip("not applicable on win32", ...)` with visible reporter output — NOT an inline `if (!win32)` branch.

### [T21] Minor: NF-6 step 4 (worker) has no automated equivalent for fallback behavior
- Fix: Add test variant: "worker resolves DATABASE_URL when OUTBOX_WORKER_DATABASE_URL omitted" using `--validate-env-only`.

### [T22] Minor: Sidecar group-name typo not caught
- Fix: Define `export const GROUPS = ["Database","Auth","Vault",...] as const` and type `SidecarEntry.group: (typeof GROUPS)[number]` — typos become compile errors.

### [T23] Minor: `envSchema.shape` access path depends on wrapper
- Fix: Helper `getSchemaShape()` handles both `ZodObject` and `ZodEffects` (post-superRefine). Solved by §F16 fix — `envObject` is always plain ZodObject with `.shape`.

---

## Round 3 Findings

All Round 2 findings verified as addressed. Round 3 surfaced:

### [F25] Major: Stale `envSchema.pick()` / `keyof z.infer<typeof envSchema>` references after F16 split
- Fix: swept 5 sites (F-Req-1, NF-3, NF-6 step 4, A29 row, step 6 sidecar, Testing strategy) to use `envObject` for pick/shape/per-field keyof and `envSchema` for boot-time validation.

### [F26] Major: Drift rule 9 collided with V11..V100 regex allowlist
- Fix: §D rule 9 exempts regex-form allowlist entries; literal-key entries remain subject to rule 9.

### [F27] Major: `envInt()` helper reads invisible to drift rule 9
- Fix: rule 9 also scans `envInt("VAR", ...)` / `envBool("VAR", ...)` string-literal arguments.

### [F28] Major: `next.config.ts` outside `src/**/*.ts` glob scope
- Fix: rule 5 (stale allowlist) opens each `consumers[]` path literally; rule 9 (app-read violation) scans only `src/**/*.ts`. Plan clarifies both scopes.

### [F29]/[T26] Major: `tr_TR.UTF-8` NOT pre-installed on ubuntu-latest — determinism test decorative
- Fix: Replaced OS-locale approach with `Intl.Collator(locale, {...})` locale parameter. Test feeds `["İ","I","i","a","Z"]` through generator's sort function with `locale="en"` and `"tr"`, asserting determinism independent of OS locale.

### [F30]/[S22] Minor: Worker stderr contract leaked rejected values via Zod's `issue.received`
- Fix: `safeParse` + per-issue sanitized error emitting only `path` + `code`.

### [F31] Minor: Step 6 sidecar type referenced `envSchema` — contradicted §B
- Fix: aligned step 6 with §B (`envObject` for keyof).

### [S19] Major: SEC-5 fallback `\b` is GNU-grep-only — BSD grep (macOS) makes the fail-closed guarantee fail-open
- Fix: replaced shell-regex fallback with a Node-based `scripts/lib/hex-leak-scan.mjs`. Character-class boundaries `(?:^|[^a-f0-9])([a-f0-9]{64})(?:$|[^a-f0-9])` replace `\b`.

### [S20] Major: Comment-filter pipeline missed block-comment continuations
- Fix: Node-based scanner tracks `/* ... */` block-comment state across diff lines. Markdown fenced code blocks → fail-closed (conservative).

### [S21] Minor: Placeholder string with embedded quotes leaks to shell history on copy-paste
- Fix: changed placeholder to `# generate via: npm run generate:key` (uses existing npm script).

### [S23] Minor: Allowlist-file presence not self-healing
- Fix: drift rule 11 requires `scripts/env-allowlist.ts` present on disk.

### [S24]/[S25] Minor: Allowlist regex patterns unbounded — ReDoS and blanket-bypass risk
- Fix: drift rule 10 bounds regex patterns — no unbounded `.*`/`.+`/nested quantifiers; ≥8-char literal prefix; reject patterns matching >20% of a 60-var fixture.

### [S26] Minor: NF-4.7 `git status --porcelain` filename parsing unsafe
- Fix: use `-z` NUL-separated; parse properly.

### [S27] Minor: xargs `sh -c` command injection via crafted filename
- Fix: Node-based scanner (S19) obsoletes the xargs pipeline.

### [T24] Minor: `process.env` restoration caveat
- Fix: common-obligation uses delete-then-restore pattern; subprocess spawns require explicit env.

### [T25] Minor: Stdout substring assertion permits payload drift
- Fix: §E mandates byte-exact JSON equality via `expect(JSON.parse(stdout.trim())).toEqual({...})`.

### [T27] Minor: GROUPS TS `as` cast bypass
- Fix: drift rule 6 adds runtime check — every sidecar `group` must be in the `GROUPS` `as const` list.

### [T28] Minor: Fixture file names not enumerated
- Fix: §E enumerates 8 fixture subdirectories with their minimum-file lists.

### [T29] Minor: Worker test per-field coverage ambiguous
- Fix: §E worker test scope explicitly limited to spawn-contract; per-field coverage delegated to `src/lib/env.test.ts`.

---

## Round 4 Verification

All three experts returned "**All Round 3 fixes verified. No new findings. Plan is implementation-ready**" for Functionality, Security, and Testing scopes respectively.

One non-blocking cosmetic inconsistency noted by Security (§C flow step 3 missing `-z` while NF-4.7 governing clause had it) — patched in the post-Round-4 pass.

The plan is considered converged at Round 4. Total cumulative findings across 4 rounds:
- Round 1: 40 (1 Critical, 17 Major, 16 Minor, 6 Adjacent) — all addressed in Round-2 rewrite
- Round 2: 19 (1 Critical, 8 Major, 10 Minor) — all addressed in Round-3 updates
- Round 3: 19 (0 Critical, 5 Major, 14 Minor) — all addressed in Round-4 updates
- Round 4: 0 new blocking findings — converged

---

## Round 1 Findings (preserved)



## Functionality Findings

### [F1] Major: D1 includes `OUTBOX_FLUSH_INTERVAL_MS` that no code reads
- File: `docs/archive/review/env-config-sync-and-generator-plan.md:69` ; evidence at `src/lib/constants/audit/audit.ts:679-689`
- Evidence: `grep "OUTBOX_FLUSH_INTERVAL_MS"` across `src/` returns zero hits. The `AUDIT_OUTBOX` const block does not declare it. `.env.example` documents it but nothing consumes it.
- Problem: Adding to Zod would create a ghost field; indicates the inventory was derived from `.env.example`, not from a `grep process.env.*` pass.
- Impact: Ghost schema field emitted by generator; loose audit methodology may miss real vars (see F2-F4).
- Fix: Remove from D1. Re-derive the authoritative D1 list from `grep -rn "envInt(" src/lib/constants/audit/audit.ts`.

### [F2] Major: D5 Sentinel vars miss `REDIS_SENTINEL_PASSWORD` and `REDIS_SENTINEL_TLS`
- File: `docs/archive/review/env-config-sync-and-generator-plan.md:73`
- Evidence: `src/lib/redis.ts:14-18` reads 5 vars: `REDIS_SENTINEL`, `REDIS_SENTINEL_HOSTS`, `REDIS_SENTINEL_MASTER_NAME`, `REDIS_SENTINEL_PASSWORD`, `REDIS_SENTINEL_TLS`. D5 lists only three.
- Impact: Secret-class var (`REDIS_SENTINEL_PASSWORD`) missing is the worst omission kind.
- Fix: Extend D5 to 5 vars; mark `REDIS_SENTINEL_PASSWORD` as secret.

### [F3] Major: D8 wrongly suggests `LOG_LEVEL` may be test-only
- File: `docs/archive/review/env-config-sync-and-generator-plan.md:76`
- Evidence: `src/lib/logger.ts:18` — `level: process.env.LOG_LEVEL ?? "info"`. Production code.
- Fix: Rewrite D8 to definitive: "Add `LOG_LEVEL: z.enum(['trace','debug','info','warn','error','fatal']).default('info')`. Required because `src/lib/logger.ts:18` reads it at module load."

### [F4] Major: F-Req-1 violated — D1-D8 inventory missing ≥10 production readers
- File: `docs/archive/review/env-config-sync-and-generator-plan.md:35, 63-76`
- Evidence: `process.env.*` readers NOT in `env.ts` and NOT in D1-D8: `NEXTAUTH_URL` (`src/app/api/sessions/helpers.ts:10`), `EMAIL_FROM` (`src/auth.config.ts:101`), `RESEND_API_KEY` (`src/lib/email/index.ts:17`), `SMTP_PORT/USER/PASS`, `AZURE_KV_URL` (`src/lib/key-provider/index.ts:31`), `GCP_PROJECT_ID` (ibid:41), `TAILSCALE_API_BASE/SOCKET` (`src/lib/services/tailscale-client.ts:86-87`), `SENTRY_DSN` (`src/instrumentation.ts:20,28`), 4 × `NEXT_PUBLIC_*`.
- Impact: SSOT objective defeated on day one; drift checker will flag or allowlist balloons.
- Fix: Replace D1-D8 with a ripgrep-derived inventory. Categorize each: (a) add to Zod, (b) add to allowlist with consumer documented. Run baseline drift-check against main BEFORE opening branch.

### [F5] Major: D4 vs "Deliberate omissions" contradiction for `JACKSON_API_KEY`
- File: `docs/archive/review/env-config-sync-and-generator-plan.md:72` vs `:195`
- Evidence: D4 says "add to both env.ts + .env.example"; Deliberate omissions says "not read by our app code — allowlist".
- Impact: Same var cannot be both in Zod and allowlist. Implementer will pick arbitrarily.
- Fix: Apply one consistent rule: "vars required by `docker-compose.yml` `${VAR:?...}` but not read by Node → allowlist". Move `JACKSON_API_KEY` out of D4's "add to env.ts" column.

### [F6] Major: Drift checker ignores overlay-literal env injection
- File: `docs/archive/review/env-config-sync-and-generator-plan.md:108`
- Evidence: `docker-compose.ha.yml:66-70` injects `- REDIS_SENTINEL=true` via plain literal; override injects `OUTBOX_WORKER_DATABASE_URL` similarly. Plan only checks `${VAR:?...}` syntax.
- Impact: `REDIS_SENTINEL_HOSTS` can disappear from `.env.example` and CI still passes, yet HA deploys silently lose it.
- Fix: Extend checker to scan all `environment:` block literal forms (`- VAR=...` and `VAR: value`) in every `docker-compose*.yml`. Add a fourth negative-case test.

### [F7] Major: NF-6 step 2 (`npm run build`) does not exercise `env.ts`
- File: `docs/archive/review/env-config-sync-and-generator-plan.md:56`; `src/instrumentation.ts:1-6`
- Evidence: instrumentation.ts header: "Does NOT run during `next build` — only `next dev` and `next start`."
- Impact: Contributor satisfies NF-6 on paper (build succeeds) while shipping a broken Zod default.
- Fix: Rewrite step 2: "Start with `npm run start` (production mode) using existing `.env.local` — prove production boot validates the same way dev does." Label build as "type-check only; does not exercise env.ts."

### [F8] Minor: D3 script-only var policy still ambiguous
- File: plan line 71 vs 260
- Fix: Resolve in place: "Do NOT add to `env.ts`. Add to `scripts/env-allowlist.ts` with `reason='consumed only by scripts/set-outbox-worker-password.sh'`. Document in `.env.example` under `# script-only` header."

### [F9] Minor: Production profile semantically incompatible with validator requirements
- File: plan lines 39, 97, 167
- Evidence: `envSchema.superRefine` requires `AUTH_SECRET>=32`, `AUTH_URL`, `VERIFIER_PEPPER_KEY`, `REDIS_URL`, ≥1 provider in production. None generatable locally.
- Impact: Re-prompt loop never converges without user pasting provider secrets.
- Fix: Document that `--profile=production` requires pasted secrets; offer `--abort-on-missing`. Clarify max retry bound (e.g. 5 attempts then exit 1).

### [F10] Minor: `@clack/prompts` option 1 contradicts NF-1
- File: plan lines 48, 90-92
- Evidence: `@clack/prompts` is NOT in `package.json` top-level deps. NF-1 forbids new deps.
- Fix: Remove option 1. Use only minimal `node:readline/promises` wrapper.

### [F11] Minor: Idempotency (F-Req-2) + NF-3 interaction on env.ts re-order
- Fix: Make the sidecar (`group` + `order`) authoritative for output ordering, not `envSchema.shape`'s iteration order. Document in F-Req-2.

### [F12] Minor: Plan unaware two env test files already exist
- Evidence: `src/lib/env.test.ts` (193 lines) + `src/__tests__/env.test.ts` (362 lines).
- Fix: Pick `src/lib/env.test.ts` as canonical. Either merge the second or clarify its purpose in a docstring.

### [F13] Minor: D6 closes SMTP_HOST but leaves variadic `SHARE_MASTER_KEY_V{N}`
- File: `src/lib/env.ts:293-315`
- Fix: Add D9: "Document variadic SHARE_MASTER_KEY_V{N} as a documented exception. Generator prompts for V{CURRENT_VERSION} only. Drift checker allowlist pattern: `SHARE_MASTER_KEY_V\d+`."

### [F14-A] [Adjacent] Major: `--print-secrets` / backup-file-mode — Security scope (see S8, S9, M-S2)
### [F15-A] [Adjacent] Minor: Re-prompt loop max-retry bound — Testing scope (see T4)

## Security Findings

### [S1] Critical: Backup and temp files not covered by `.gitignore` (escalate: true)
- File: `.gitignore:19` — pattern `.env*.local` matches `.env.local` but NOT `.env.local.bak-*` or `.env.local.tmp`
- Evidence: `git check-ignore .env.local.tmp` / `.env.local.bak-20260424-120000` — no output (NOT ignored).
- Problem: Any `git add -A` after `npm run init:env` commits plaintext 256-bit master keys (`SHARE_MASTER_KEY`, `VERIFIER_PEPPER_KEY`, `WEBAUTHN_PRF_SECRET`, `DIRECTORY_SYNC_MASTER_KEY`, `AUTH_SECRET`, `ADMIN_API_TOKEN`).
- Impact: Master-key compromise = every tenant vault decryptable; pepper compromise enables offline passphrase guessing; `WEBAUTHN_PRF_SECRET` enables unlock bypass; `ADMIN_API_TOKEN` is the bearer for key-rotation and purge endpoints.
- Fix: Add to `.gitignore`:
  ```
  .env.local.tmp
  .env.local.tmp.*
  .env.local.bak
  .env.local.bak-*
  .env.local.bak.*
  ```
  Defense in depth: generator aborts if `git status --porcelain` would expose the target path.
- escalate: true
- escalate_reason: Plan as written ships a secret-leaking feature. Must be addressed before implementation starts.
- Orchestrator assessment: confirmed on independent inspection — `git check-ignore` evidence is direct and reproducible. Opus re-run skipped because finding is unambiguous and fix is trivial; orchestrator (Opus 4.7) is satisfied.

### [S2] Major: Atomic `.env.local.tmp` creation mode underspecified — TOCTOU / permissive-umask risk
- File: plan line 98
- Problem: `fs.writeFile` default mode is `0666-umask`; a separate `chmod(0600)` has a race window; permissive `umask 000` (some CI) yields `0o666`.
- Fix: Specify:
  1. `fs.open(tmpPath, 'wx', 0o600)` (atomic create with mode + exclusive).
  2. `fchmod(fd, 0o600)` defensively.
  3. `fsync(fd)` before `rename()`.
  4. On `EEXIST` abort with clear error (prevents symlink attack).
  5. Unit test with `process.umask(0)` verifies resulting file stat is `0o600`.

### [S3] Major: D7 `HEALTH_REDIS_REQUIRED` silent production behavior change
- File: `src/lib/health.ts:63` — current default unset → `false`. Plan D7: `.default("true")`.
- Evidence: `docs/operations/redis-ha.md:17` confirms current default is `false`.
- Impact: Availability regression — degraded-but-available Redis blip starts returning 503. Violates NF-5. OWASP A04 Insecure Design (silent upgrade-time behavior flip).
- Fix: Keep default: `.default("false").transform(v => v === "true")`. Default change is a separate PR with changelog.

### [S4] Major: Variadic `SHARE_MASTER_KEY_V{N}` still escape-hatched; SSOT claim incomplete
- File: `src/lib/env.ts:293-294, 306`
- Evidence: `process.env[\`SHARE_MASTER_KEY_V${currentVersion}\`]` dynamic bracket access.
- Fix: Either (a) model V1..V10 explicitly as `hex64.optional()`, or (b) document as exception + allowlist pattern `SHARE_MASTER_KEY_V\d+` + dedicated unit test for superRefine rejection of malformed V-keys.

### [S5] Major: Allowlist widening not enforced by tooling
- Fix:
  1. Typed union requiring `justification` field (regex `^.{40,}$` minimum).
  2. CI check in `check:env-docs` fails if allowlist key also appears as `process.env.X` in `src/**/*.ts`.
  3. `CODEOWNERS` entry for `scripts/env-allowlist.ts` requiring security-team reviewer.

### [S6] Major: Generator stdin not defended against dotenv-syntax injection
- File: plan §C.3
- Problem: Value like `mypassword\nSHARE_MASTER_KEY=<attacker>` piped via stdin written verbatim; Zod strips unknown keys silently but runtime consumer reads injected line.
- Fix:
  - Always double-quote values with dotenv-compatible escape (escape `"`, `\`, `\n`, `\r`, `$`).
  - Reject values containing `\n`, `\r`, `\x00`. Reject keys outside `[A-Z_][A-Z0-9_]*`.
  - Negative test: stdin injects `foo\nADMIN_API_TOKEN=deadbeef` into a non-secret prompt; assert single-line escaped, no second `ADMIN_API_TOKEN=`.

### [S7] Minor: Validation-error re-prompt may echo rejected value
- Fix: NF-4 addition: "Validation-error messages include `path` + human `message` only. Never echo rejected value. Test: invalid 63-char hex64 via stdin; assert invalid value absent from captured stderr/stdout."

### [S8] Minor: `--print-secrets` + `--non-interactive` must be mutually exclusive
- Fix: Generator exits 1 if both flags set.

### [S9] Minor: gitleaks pre-pr step is optional — no fallback scan
- Fix: Update `scripts/pre-pr.sh` to install-or-error on gitleaks, OR add grep fallback scanning staged diff for `^[A-Z_]+=[a-f0-9]{64}$` (excluding `.env.example`).

### [S10] Minor: Snapshot test lacks guard against plausible-secret patterns
- Fix: Generator aborts if any emitted value matches `/^[A-Fa-f0-9]{32,}$/` unless sidecar marks field with `secret: true` (forcing empty placeholder).

### [S11] Minor: `@clack/prompts` transitive presence is a supply-chain footgun
- Evidence: `package-lock.json:721` — transitive via `better-result`.
- Fix: Explicit plan text: "Do NOT import `@clack/prompts` even though it appears transitively. Use only `node:readline/promises`. Adding as direct dep is a separate PR with audit."

### [S12-A] [Adjacent] Minor: LOG_LEVEL=debug in production can log request bodies — Functionality scope
### [S13-A] [Adjacent] Minor: Drift checker must handle all compose substitution forms (`${VAR}`, `${VAR:-default}`) — Functionality/Testing scope (see F6)

## Testing Findings

### [T1] Critical: Planned test files will not be collected by vitest
- File: `vitest.config.ts:8-12` — `include: ["src/**/*.test.{ts,tsx}", "e2e/helpers/*.test.ts", "scripts/__tests__/**/*.test.mjs"]`
- Problem: Plan's `scripts/{generate-env-example,check-env-docs,init-env}.test.ts` match no include glob.
- Impact: `vitest run` exits 0 with zero coverage for new suites.
- Fix: Place tests at `scripts/__tests__/*.test.mjs` (match existing `check-licenses.test.mjs` pattern) with `await import("../generate-env-example.ts")`, OR extend `vitest.config.ts` `include` to add `"scripts/**/*.test.ts"` in the same commit. Prefer `.mjs` path for consistency.

### [T2] Critical: Zod schema not testable in isolation
- File: `src/lib/env.ts:341-371` — `export const env = parseEnv()` runs at import.
- Impact: Per-field tests require `vi.resetModules()` + `process.env` mutation each case; entire `superRefine` re-runs; flaky.
- Fix: Export bare `envSchema` (`export const envSchema = ...`). New tests call `envSchema.safeParse({...})` directly — no parseEnv, no reset.

### [T3] Major: Snapshot determinism gaps unstated
- Fix: NF-3 additions: (1) iterate schema keys by documented ordering (group → sidecar `order` field); (2) never call `Date.now()`/`new Date()`; (3) no `process.platform` branches in output; (4) sort with `(a, b) => a.localeCompare(b, 'en')`. Determinism test: run twice, byte-identical; run with `LANG=C` vs `LANG=ja_JP.UTF-8`, identical.

### [T4] Major: "Scripted stdin" for `readline/promises` is unsolved in this repo
- Evidence: grep for `readline` across `/scripts` — no matches.
- Fix: Mandate in §C that the prompt layer is pluggable: `scripts/init-env.ts` exports `run(opts: { stdin, stdout, stderr, now })`. CLI entry wires `process.stdin`. Tests use `PassThrough` stream pushing answer strings with trailing `\n`. Document the ≤20 LoC pattern in plan before implementation.

### [T5] Major: CI integration of `check:env-docs` under-specified
- Fix: Add to §D: "New job `env-drift-check` gated on a new `env` path filter containing `.env.example`, `src/lib/env.ts`, `scripts/env-descriptions.ts`, `scripts/check-env-docs.ts`, `scripts/env-allowlist.ts`, `docker-compose*.yml`. node-setup only; no services; timeout 3m."

### [T6] Major: Drift-checker "three negative cases" insufficient
- Fix: Expand §E to seven negative cases adding:
  - (d) sidecar entry whose key is not in Zod (runtime check; TS `keyof` may be circumvented)
  - (e) allowlist entry for var that IS in Zod — dead entry
  - (f) allowlist entry for var no docker-compose references — stale
  - (g) `.env.example` has commented-out key while schema marks required
  - (h) Duplicate keys in `.env.example`
  Add fixtures under `scripts/__tests__/fixtures/env-drift/`.

### [T7] Major: No test for pre-pr.sh shell-level change
- Fix: (1) Place `check:env-docs` after lint, before vitest/build (fast-fail). (2) Add smoke step documented in plan: `node scripts/check-env-docs.ts` exit-code propagation check. (3) Add `scripts/__tests__/pre-pr-env-drift.test.mjs` spawning pre-pr.sh with broken sidecar, asserting non-zero.

### [T8] Major: D7 `HEALTH_REDIS_REQUIRED` default inverted (duplicate of S3)
- Merged with [S3]. Testing-scope fix: ensure `src/__tests__/lib/health.test.ts` still passes after the schema addition; regression test stays the canonical verifier.

### [T9] Major: Mock-vs-reality gap in D2/D3 — worker does not import `env.ts`
- File: `scripts/audit-outbox-worker.ts:8`
- Fix: Either (a) worker imports `envSchema.pick({ OUTBOX_*: true, DATABASE_URL: true, OUTBOX_WORKER_DATABASE_URL: true })` and calls `safeParse` at startup; add `scripts/__tests__/audit-outbox-worker-env.test.mjs` that invalid URL exits non-zero; OR (b) document explicitly in D2 that schema-level validation does not cover the worker. Option (a) strongly preferred.

### [T10] Minor: Interactive-generator test assertions not specified
- Fix: Extend each §E bullet with: (a) exit code, (b) file existence + mode 0600 POSIX, (c) `envSchema.safeParse(parsed).success === true`, (d) generated secrets match `/^[0-9a-f]{64}$/`, (e) transcript does NOT contain the generated secret literal.

### [T11] Minor: No test for generator idempotency
- Fix: "Determinism: run twice, assert `readFileSync(a) === readFileSync(b)`."

### [T12] Minor: Test naming not behavioral
- Fix: Rename: "returns exit 0 when .env.example in sync with schema", "reports extra key and exits 1 when ...", etc.

### [T13] Minor: Vitest setup env bleed
- File: `src/__tests__/setup.ts:18-28`
- Fix: §E adds: "Use `envSchema.safeParse({...})` with explicit object; do NOT depend on `process.env`. Consider `.strict()` to detect unknown keys."

### [T14-A] [Adjacent] Major: D4 inconsistency blocks test design — Functionality scope (see F5)
### [T15-A] [Adjacent] Minor: D8 LOG_LEVEL misclassification — Functionality scope (see F3)

## Adjacent Findings

Routed for resolution (preserved from the originating expert's report):

- **F14-A** (Functionality → Security): `--print-secrets` shell history leak + backup mode unspecified — addressed by S2, S7, S8.
- **F15-A** (Functionality → Testing): Re-prompt loop max-retry bound — addressed by T4 + F9 joint fix (max 5 attempts, exit 1).
- **S12-A** (Security → Functionality): Disallow `debug` LOG_LEVEL in production — addressed by tightening F3's Zod enum with a superRefine check.
- **S13-A** (Security → Functionality/Testing): Drift checker must handle `${VAR}` and `${VAR:-default}` forms — addressed by F6 fix.
- **T14-A** (Testing → Functionality): D4 inconsistency — addressed by F5.
- **T15-A** (Testing → Functionality): LOG_LEVEL classification — addressed by F3.

## Quality Warnings

From the merge-findings quality gate:

- **M-F6 / S13** (drift-checker parsing forms) — **[VAGUE]**: The merged fix says "extend the checker" without a concrete pattern. Revised fix below.
  - **Revised Fix**: Drift-checker parses `docker-compose*.yml` via `js-yaml` (pinned dev-dep; check if already present), walks the `services.*.environment` list, extracts keys regardless of value form (plain key, `${VAR}`, `${VAR:?...}`, `${VAR:-default}`, literal `VAR=value`, or map form `VAR: value`). YAML parsing is mandatory — regex is rejected as insufficient.
- **M-T5** (CI integration) — **[VAGUE]**: No sample YAML snippet. Revised fix: specify concrete `.github/workflows/ci.yml` job definition in the plan, including paths filter and step list. Plan §D gets a sub-bullet with the exact block.
- **M-S5** (allowlist CODEOWNERS) — **[NO-EVIDENCE]**: Recommendation uses "CODEOWNERS" but the repo's CODEOWNERS file status is unverified. Revised fix: "Add or create `.github/CODEOWNERS` with `scripts/env-allowlist.ts @<security-team-github-handle>` — if no CODEOWNERS exists yet, the plan must decide whether to introduce one in this PR or as a follow-up." Verified during implementation via `ls .github/CODEOWNERS`.

## Recurring Issue Check

### Functionality expert
- R1 (Shared utility reimplementation): Checked — no issue
- R2 (Constants hardcoded): Finding F4 (hardcoded vars not in SSOT)
- R3 (Pattern propagation): Finding F6 (overlay literals)
- R4-R15: N/A for this plan
- R16 (Dev/CI environment parity): Checked — CI env hardcodes verified against schema
- R17 (Helper adoption coverage): N/A — no new helper in plan
- R18 (Allowlist/safelist sync): Finding F5 (JACKSON_API_KEY contradiction)
- R19 (Test mock alignment): N/A
- R20 (Multi-statement preservation): N/A
- R21 (Subagent completion vs verification): Checked — NF-6 has gates but see F7
- R22 (Perspective inversion for helpers): N/A
- R23-R28: N/A
- R29 (External spec citation accuracy): N/A — plan cites no RFC/NIST
- R30 (Markdown autolink footguns): Checked — no bare #NNN in plan

### Security expert
- R1-R15: See expert output above (mostly N/A)
- R16 (Dev/CI environment parity): Pass
- R17 (Helper adoption coverage): N/A
- R18 (Allowlist/safelist sync): **Fail** — S5 no tooling enforcement
- R19 (Test mock alignment): Defer to Testing
- R20-R28: N/A
- R29 (External spec citation accuracy): Pass — only OWASP A04 (verified as 2021 Insecure Design category)
- R30 (Markdown autolink footguns): Pass
- RS1 (Timing-safe comparison): N/A — no credential comparison in plan
- RS2 (Rate limiter on new routes): N/A — no new HTTP routes
- RS3 (Input validation at boundaries): **Fail** — S6 stdin not defended

### Testing expert
- R1-R15: N/A
- R16 (Dev/CI environment parity): Pass
- R17 (Helper adoption coverage): N/A
- R18 (Allowlist/safelist sync): Pass — noted via Security expert
- R19 (Test mock alignment): **Fail** — T9 (worker env not validated)
- R20-R28: N/A
- R29 (External spec citation accuracy): Pass — plan cites no RFCs
- R30 (Markdown autolink footguns): Pass
- RT1 (Mock-reality divergence): **Fail** — T9 (worker env mock-reality gap)
- RT2 (Testability verification): **Fail** — T1 (tests not collected), T2 (schema untestable in isolation), T4 (stdin driving not solved)
- RT3 (Shared constant in tests): Pass — plan mentions using exported schema constants
