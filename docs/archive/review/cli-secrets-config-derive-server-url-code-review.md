# Code Review: cli-secrets-config-derive-server-url
Date: 2026-05-06
Review rounds: 2

## Changes from Previous Round

Round 1: initial review.
Round 2: incremental verification of Round 1 fixes; surfaced 6 minor cleanups (variable shadow, sparse-object replacement, redundant trim, two vacuous-pass mock setups, incomplete mock surface). All applied.

## Functionality Findings

### [F1] Major: Silent schema change breaks existing `apiKey`-only users with no migration path

- File: `cli/src/lib/secrets-config.ts:46`, `cli/.passwd-sso-env.example.json`
- Evidence: Old schema required `"server": "https://..."` in `.passwd-sso-env.json`. New code silently ignores the field (TypeScript cast, no runtime rejection, no deprecation warning). Users with existing `server` field who have not run `passwd-sso login` get the cryptic error: `"Server URL not configured. Run 'passwd-sso login' first."`
- Problem: The `server` field was the documented way to configure the URL for `apiKey`-only CI/CD workflows. Upgrading the CLI silently breaks these pipelines. No deprecation warning, no migration hint.
- Impact: Any CI/CD pipeline that uses `.passwd-sso-env.json` with `"server"` + `"apiKey"` and no prior `passwd-sso login` session will fail on upgrade with a cryptic error.
- Fix: Detect the orphaned `server` field at load time and emit a deprecation warning to stderr, including the URL it found and the migration command (`passwd-sso login -s <url>`).

### [F2] Minor: Error message for missing `serverUrl` is misleading for `apiKey`-only users

- File: `cli/src/lib/secrets-config.ts:77`
- Evidence: `throw new Error("Server URL not configured. Run \`passwd-sso login\` first.");`
- Problem: For users on the `apiKey` auth path, instructing them to run `passwd-sso login` implies an OAuth flow they may not use. Only the server URL is missing; no full login is required.
- Impact: User confusion in headless CI environments.
- Fix: Improve error message to mention the `-s <server-url>` flag explicitly.

### [F3] Minor: `entry` and `field` validated with `.trim()` but raw values used downstream

- File: `cli/src/lib/secrets-config.ts:58-62`, used at `cli/src/commands/env.ts:72`, `cli/src/commands/run.ts:77`
- Evidence: Validation uses `entry.trim().length === 0` but the raw untrimmed value is stored in `parsed` and passed to `getPasswordPath(mapping.entry, useV1)` and `blob[mapping.field]`.
- Problem: A config with `"entry": "  real-id  "` passes validation but produces a URL with `%20` padding (404), or a field name like `" password "` fails the blob lookup silently.
- Impact: Subtle misconfiguration produces confusing runtime errors instead of clear config-validation failure.
- Fix: Trim values before storing them back into the parsed config.

## Security Findings

### [S1] Minor: `getSecretsServerUrl()` does not re-validate the stored URL before use in `fetch()`

- File: `cli/src/lib/secrets-config.ts:74-79`, used at `cli/src/commands/env.ts:73`, `cli/src/commands/run.ts:78`
- Evidence: `validateServerUrl()` exists in `cli/src/lib/oauth.ts` and is called only at login time (`login.ts:43`). `getSecretsServerUrl()` reads `serverUrl` from disk and uses it for `fetch(url)` without re-validation.
- Problem: A user who manually edits `$XDG_CONFIG_HOME/passwd-sso/config.json` after login can insert a non-HTTPS, `file://`, or non-loopback `http://` URL. The fetch goes to that target carrying the Bearer token in the Authorization header.
- Impact: Defense-in-depth gap. An attacker with config-file write access (which already implies local compromise) can redirect vault API requests to an attacker-controlled host.
- Fix: Import and call `validateServerUrl(serverUrl)` inside `getSecretsServerUrl()` before returning.

### [S2] Minor: `apiKey` in `.passwd-sso-env.json` may be committed to VCS without warning

- File: `cli/.passwd-sso-env.example.json`, `README.md`, `README.ja.md`
- Evidence: Example file contains `"apiKey": "api_xxxxxx..."` placeholder. `.gitignore` covers `.passwd-sso-env.json` at repo root, but the example file does not warn against committing the file when populated with a real key.
- Problem: Trust-boundary shift (server URL moves to authenticated login config) makes the secrets-config file safer to commit, but `apiKey` remains a long-lived credential. Documentation and example do not surface this distinction.
- Impact: Developer error vector — copy example, fill in real key, commit. Social-engineering / documentation gap.
- Fix: Note in README and example that `apiKey` must not be committed; add to project `.gitignore`.

### [S3] Minor: `isPlaceholderEntryId` regex covers example placeholder but not all common variants

- File: `cli/src/lib/secrets-config.ts:31-34`
- Evidence: Regex `/^<[^>]+>$/` plus the literal `"dummy-entry-id"`. Patterns like `{{entry-id}}`, `REPLACE_ME`, `YOUR_ENTRY_ID`, `00000000-0000-0000-0000-000000000000` are not blocked.
- Problem: Defense-in-depth gap; a user using a non-matching placeholder gets a runtime HTTP 404 rather than a fast-fail config error. No security impact (server rejects fabricated IDs).
- Impact: Minor UX degradation; informational.
- Fix: No code change strictly required. Optionally extend the placeholder list. Acceptable as-is.

## Testing Findings

### [T1] Major: `envCommand` has only one of six exit paths tested

- File: `cli/src/__tests__/unit/env.test.ts`
- Evidence: The single test exercises the `loadSecretsConfig` throw path. Untested paths: `getSecretsServerUrl()` failure (env.ts:35-39), `getToken()` returns null (env.ts:47-51), `autoUnlockIfNeeded()` returns false (env.ts:56-59), `BLOCKED_KEYS` match (env.ts:68-71), HTTP fetch error (env.ts:78-81).
- Problem: Five regression-prone paths have no coverage.
- Impact: Regressions in error-handling paths would not be caught.
- Fix: Add tests using the project's established `vi.mock()` pattern (see `agent.test.ts`).

### [T2] Major: `runCommand` has no unit tests

- File: `cli/src/__tests__/unit/` (no `run.test.ts`)
- Evidence: `grep -r "runCommand" cli/src/__tests__/` returns nothing.
- Problem: Entire `passwd-sso run` command is untested. Includes `spawn` lifecycle, child-process exit-code propagation, and child-process error event paths.
- Impact: All `runCommand` paths have no regression coverage.
- Fix: Create `cli/src/__tests__/unit/run.test.ts` mirroring `agent.test.ts`'s mock pattern; mock `node:child_process` to control spawn return value.

### [T3] Minor: superfluous `vi.unmock` in `secrets-server.test.ts` afterEach

- File: `cli/src/__tests__/unit/secrets-server.test.ts:5`
- Evidence: File uses only `vi.doMock`, never `vi.mock`. `vi.unmock` only removes registrations from `vi.mock`. The call is a no-op.
- Problem: Misleading dead code — readers may believe a static mock was registered.
- Fix: Remove `vi.unmock("../../lib/config.js")`.

### [T4] Minor: `env.test.ts` couples `.rejects.toThrow()` to the exit-code string

- File: `cli/src/__tests__/unit/env.test.ts:39-43`
- Evidence: `await expect(envCommand({...})).rejects.toThrow("process.exit(1)");` — the string `"process.exit(1)"` is an implementation detail of the `vi.spyOn(process, "exit")` mock.
- Problem: If the exit code changes, this assertion fails with a misleading message; `exitCode === 1` is the meaningful business assertion.
- Fix: `.rejects.toThrow()` without the string argument.

### [T5] Minor: `env.test.ts` mocks at `console.error` instead of `output.ts` boundary

- File: `cli/src/__tests__/unit/env.test.ts:18, 44-46`
- Evidence: Other tests (`agent.test.ts:44-49`) mock `output.ts` at the module boundary. `env.test.ts` spies on `console.error` and relies on the `output.error → chalk.red → console.error` chain.
- Problem: If `output.error` changes its mechanism (e.g., to `process.stderr.write`), the spy silently stops intercepting; the assertion passes vacuously.
- Fix: `vi.mock("../../lib/output.js", () => ({ error: vi.fn(), warn: vi.fn() }))` and assert on the mocked `output.error`.

## Adjacent Findings

None — all findings stayed within their expert's scope.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert
- R1 (Shared utility reimplementation): Checked — `getSecretsServerUrl` correctly delegates to `loadConfig`; no duplication
- R2 (Constants hardcoded): Checked — no issue
- R3 (Pattern propagation): Checked — `config.server` removal traced; only consumer was env/run; no stale references
- R4 (Event dispatch gaps): N/A — no mutations
- R5 (Missing transactions): N/A — no DB
- R6 (Cascade delete orphans): N/A — no deletes
- R7 (E2E selector breakage): N/A — no E2E tests touched
- R8 (UI pattern inconsistency): N/A — no UI
- R9 (Transaction boundary for fire-and-forget): N/A
- R10 (Circular module dependency): Checked — `secrets-config.ts` imports `config.ts`; `config.ts` does not import `secrets-config.ts`. No cycle
- R11-R13: N/A
- R14-R16: N/A — no DB role / migration changes
- R17 (Helper adoption coverage): Checked — new `getSecretsServerUrl` used at all consumer sites (env.ts, run.ts)
- R18 (Allowlist/safelist sync): N/A
- R19 (Test mock alignment + Exact-shape assertion): Checked — `secrets-config.test.ts:92` uses strict `.toEqual({ secrets: {...} })` which would fail if a new field were added; `loadSecretsConfig` return shape `{ apiKey?, secrets }` is correctly asserted
- R20 (Multi-statement preservation): N/A — no mechanical edits
- R21 (Subagent completion verification): tests+build re-run pending (Step 3-6)
- R22 (Perspective inversion): Checked — both forward (consumers migrated) and inverted (no other reads of `config.server` remain)
- R23 (Mid-stroke input mutation): N/A
- R24 (Migration additive+strict split): N/A
- R25 (Persist/hydrate symmetry): N/A
- R26 (Disabled-state visible cue): N/A
- R27 (Numeric range in user-facing strings): N/A
- R28 (Toggle label grammatical consistency): N/A
- R29 (External spec citation accuracy): N/A — no spec citations
- R30 (Markdown autolink footguns): Checked — README diff has no bare `#N` / `@name` / SHA hex
- R31 (Destructive operations): N/A
- R32 (Runtime-shape boot test): N/A — not a long-running runtime artifact
- R33 (CI config cross-config propagation): N/A — no CI config change
- R34 (Adjacent pre-existing bug deferred): Checked — env.ts return-instead-of-exit pre-existing bug WAS fixed in this PR (good)
- R35 (Manual test plan): N/A — diff matches no deployment-artifact pattern
- R36 (Static-analysis warning suppression): N/A
- R37 (Internal jargon in user-facing strings): Checked — README/error strings use user-domain language (vault, login, server URL); no internal tokens leaked

### Security expert
- R1-R37: see Functionality entries; same answers
- RS1 (Timing-safe comparison): N/A — no credential comparison
- RS2 (Rate limiter on new routes): N/A — no new HTTP routes
- RS3 (Input validation at boundaries): Checked — new per-entry/per-field validation cannot be bypassed (empty string, non-object, placeholder all blocked)
- RS4 (PII / placeholder leakage): Checked — test files use `example.com` (RFC 2606 safe), no real emails / hostnames / handles

### Testing expert
- R1-R37: see Functionality entries; same answers
- RT1 (Mock-reality divergence): Finding T5 (boundary mock issue, not strict divergence)
- RT2 (Testability): Checked — recommended T1/T2 tests are testable using established project pattern
- RT3 (CI integration): Checked — vitest picks up new test files
- RT4 (Race-test vacuous-pass): N/A — no race tests
- RT5 (Test call-path includes production primitive): N/A — no production primitive

## Resolution Status

### [F1] Major Silent schema change breaks existing apiKey-only users — Accepted (declined by user)
- Anti-Deferral check: explicit user instruction
- Justification: user explicitly stated "Migration いらないです" — accepted as designed.
  - Worst case: existing CI pipelines with `server` field in `.passwd-sso-env.json` and no prior `passwd-sso login` will fail with the (now improved) error message pointing to `passwd-sso login -s <server-url>`.
  - Likelihood: low — pre-1.0 release, small user base, easy to recover.
  - Cost to fix: ~10 LOC for warning + test.
- Orchestrator sign-off: user authorized accepting this finding without fix.

### [F2] Minor Error message for missing serverUrl misleading
- Action: improved message to mention `passwd-sso login -s <server-url>` explicitly.
- Modified file: `cli/src/lib/secrets-config.ts:78-79`

### [F3] Minor entry/field trimmed for validation but raw values used downstream
- Action: trim the values and store them back into `parsed.secrets[envName]`.
- Modified file: `cli/src/lib/secrets-config.ts:55-67`

### [S1] Minor getSecretsServerUrl does not re-validate stored URL before fetch
- Action: import `validateServerUrl` from oauth.js and call it in `getSecretsServerUrl`. Added two new tests for the rejection path (non-HTTPS / non-loopback, file://).
- Modified files: `cli/src/lib/secrets-config.ts:4`, `cli/src/lib/secrets-config.ts:79-83`, `cli/src/__tests__/unit/secrets-server.test.ts`

### [S2] Minor apiKey may be committed without warning
- Action: README and README.ja added an explicit "do not commit if it contains an apiKey" line.
- Modified files: `README.md:91`, `README.ja.md:90`

### [S3] Minor isPlaceholderEntryId regex coverage — Accepted (informational)
- Anti-Deferral check: acceptable risk
  - Worst case: user picks a non-matching placeholder (e.g., `REPLACE_ME`) → server returns HTTP 404; clear runtime error rather than fast-fail.
  - Likelihood: low — example file uses the matched pattern; only freelance template choices land outside the regex.
  - Cost to fix: trivial code-wise but list churn — reviewer recommended no code change.
- Orchestrator sign-off: defense-in-depth UX gap; no security impact; aligned with reviewer's recommendation.

### [T1] Major envCommand exit paths untested
- Action: rewrote `env.test.ts` to mock all dependencies at module scope; added tests for loadSecretsConfig throw, getSecretsServerUrl throw, getToken null, autoUnlockIfNeeded false.
- Modified file: `cli/src/__tests__/unit/env.test.ts`

### [T2] Major runCommand has no tests
- Action: created `run.test.ts` with 5 tests covering the same exit paths plus the empty-command path.
- Modified file: `cli/src/__tests__/unit/run.test.ts` (new)

### [T3] Minor superfluous vi.unmock in secrets-server.test.ts
- Action: rewrote secrets-server.test.ts to use module-scope `vi.mock` + `mockReset`; the spurious `vi.unmock` is gone.
- Modified file: `cli/src/__tests__/unit/secrets-server.test.ts`

### [T4] Minor rejects.toThrow couples to exit-code string
- Action: dropped the `"process.exit(1)"` argument; only `exitCode === 1` is asserted now.
- Modified file: `cli/src/__tests__/unit/env.test.ts`, `cli/src/__tests__/unit/run.test.ts`

### [T5] Minor env.test.ts mocks console.error instead of output.ts
- Action: switched to `vi.mock("../../lib/output.js")` at module scope and assert on the mocked `output.error`.
- Modified file: `cli/src/__tests__/unit/env.test.ts`

### Off-finding: README cleanup
- Action: removed the misleading `DATABASE_URL has no special meaning unless...` aside per user feedback. Replaced with a clearer statement that the CLI does not synthesize connection strings.
- Modified files: `README.md:91`, `README.ja.md:90`

---

## Round 2 findings and resolutions

### [F4 (new in round 2)] Minor variable shadow `raw` (outer JSON string vs inner mapping cast)
- Action: renamed inner variable to `rawMapping`.
- Modified file: `cli/src/lib/secrets-config.ts:58`

### [F5 (new in round 2)] Minor sparse-object replacement strips unknown user-added fields
- Action: spread `rawMapping` first then override `entry`/`field` so unknown keys (e.g. user-added `comment`) survive the normalisation.
- Modified file: `cli/src/lib/secrets-config.ts:73`

### [F6 (new in round 2)] Minor redundant `.trim()` inside `isPlaceholderEntryId`
- Action: removed the internal trim; callers now pass already-trimmed values, and the function's contract is documented by the caller-side normalisation.
- Modified file: `cli/src/lib/secrets-config.ts:32-34`

### [T-F1 (new in round 2)] Minor vacuous-pass: `autoUnlockIfNeeded.mockResolvedValue(false)` is decorative
- Action: added `expect(vi.mocked(autoUnlockIfNeeded)).toHaveBeenCalled()` so the test fails when the branch is skipped, not just when the error message matches.
- Modified files: `cli/src/__tests__/unit/env.test.ts`, `cli/src/__tests__/unit/run.test.ts`

### [T-F2 (new in round 2)] Minor vacuous-pass: `getToken.mockResolvedValue(null)` is decorative
- Action: added `expect(vi.mocked(getToken)).toHaveBeenCalled()` for the same reason as T-F1.
- Modified files: `cli/src/__tests__/unit/env.test.ts`, `cli/src/__tests__/unit/run.test.ts`

### [RT1 (new in round 2)] Minor mock surface incomplete for `output.ts`
- Action: added `table`, `json`, `masked` to the `vi.mock` factory in env.test.ts and run.test.ts so structural drift between mock and real module surface no longer hides future regressions.
- Modified files: `cli/src/__tests__/unit/env.test.ts`, `cli/src/__tests__/unit/run.test.ts`

---

## Tightening-only termination — Round 3 skipped

Findings applied in Round 2 (no Round 3 review):
- [F4] Minor variable shadow rename — `cli/src/lib/secrets-config.ts:58`
- [F5] Minor sparse-object spread — `cli/src/lib/secrets-config.ts:73`
- [F6] Minor remove redundant trim — `cli/src/lib/secrets-config.ts:32-34`
- [T-F1] Minor toHaveBeenCalled assertion on autoUnlockIfNeeded — env/run test files
- [T-F2] Minor toHaveBeenCalled assertion on getToken — env/run test files
- [RT1] Minor complete output.ts mock surface — env/run test files

Justification: every Round 2 finding scoped within Round 1 fix range, inline minor (variable rename, dead-code removal, mock setup tweaks), no security-boundary touch (the S1 validateServerUrl call was unchanged across Round 2). Pre-PR (15/15), TypeScript check, vitest (212/212) all green. Closing the review loop.
