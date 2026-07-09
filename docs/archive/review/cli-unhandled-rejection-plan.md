# Plan: cli-unhandled-rejection

## Project context

- Type: `CLI tool` (the `cli/` workspace of the passwd-sso monorepo; Node.js ≥18 ESM, commander 13, TypeScript `NodeNext`/`ES2022` — top-level await available)
- Test infrastructure: `unit + integration + CI/CD` (vitest under `cli/src/__tests__/unit/` and `cli/src/__tests__/integration/`; integration tests spawn `node dist/index.js` guarded by `it.skipIf(!distExists)` — see `cli/src/__tests__/integration/version.test.ts`)
- Verification environment constraints:
  - **VE1**: integration tests require a built `cli/dist/` (`cd cli && npm run build`). Classification: `verifiable-local` (build is part of the repo's pre-PR checks).
  - **VE2**: the reported repro (`passwd-sso unlock` against a global Homebrew install) cannot be reproduced byte-for-byte locally, but `node cli/dist/index.js unlock` with isolated `HOME`/`XDG_*` env vars is behaviorally identical (same entry point, same credential resolution). Classification: `verifiable-local`.
  - No paid services, external APIs, or hardware are involved. No contract is `blocked-deferred`.

## Objective

`passwd-sso unlock` executed without a prior `login` currently crashes with a raw Node.js
stack trace (unhandled promise rejection) instead of a clean one-line error. Fix the
reported symptom AND the underlying class: **no top-level CLI command may surface an
internal stack trace to the user**. Errors must render as the CLI's standard
`✗ <message>` line on stderr with a non-zero exit code.

Reported repro:

```
❯ passwd-sso unlock
Master passphrase:
file:///.../dist/lib/api-client.js:88
        throw new Error("Not logged in. Run `passwd-sso login` first.");
        ...stack trace...
Node.js v26.4.0
```

Two defects compound here:

1. `cli/src/index.ts:197` calls `program.parse()` (synchronous). Commander does not await
   async `.action()` handlers under `parse()`, so any rejection becomes an **unhandled
   promise rejection** — Node prints the stack trace and aborts.
2. `unlockCommand()` (`cli/src/commands/unlock.ts:130`) prompts for the master passphrase
   **before** any login check; the "Not logged in" error from
   `apiRequest()` (`cli/src/lib/api-client.ts:117`) is only thrown after the user has
   already typed their passphrase.

## Requirements

Functional:
- FR1: Any error thrown from a top-level command action is printed as `✗ <message>` on stderr, with exit code 1 and **no stack trace**. The `✗ ` prefix is applied by `output.error` itself (`cli/src/lib/output.ts:12-14`: `console.error(chalk.red(\`✗ ${message}\`))`) — the handler passes the bare message. Scope note: FR1 covers action-handler errors only; commander's own usage/flag errors (handled internally by commander before/without reaching an action) keep commander's standard format and are out of scope (see SC2).
- FR2: `unlock` without stored credentials fails fast with the "Not logged in" message **before** prompting for the master passphrase (user-approved scope addition).
- FR3: `audit-verify`'s documented exit codes 10–18 are preserved unchanged.
- FR4: Successful flows (login → unlock → REPL) are behaviorally unchanged; REPL-internal error handling (`cli/src/index.ts:369-371`) is unchanged.

Non-functional:
- NF1: Exit code on error remains non-zero (scripts relying on failure detection keep working; the pre-fix unhandled rejection also exited 1).
- NF2: No new dependencies.

## Technical approach

Class-level structural fix, not per-command patching: replace the synchronous
`program.parse()` with an awaited `program.parseAsync()` wrapped in a single top-level
try/catch (ESM top-level await; `module: NodeNext`, `target: ES2022` permit it). This
creates one choke point through which every top-level action rejection flows, so future
commands are covered automatically.

Commander behavior notes (verified against commander 13 semantics):
- `--help`/`--version`/usage errors call `process.exit` inside commander itself (no
  `exitOverride()` in use), so the new catch only ever sees action-handler rejections.
- `audit-verify` catches its own errors and calls `process.exit(10..18|1)` inside its
  action (`cli/src/index.ts:181-194`); it exits before the outer catch, preserving FR3.
- The interactive REPL runs inside the `unlock` action and therefore inside
  `parseAsync()`'s promise; its errors are already caught per-command inside the loop
  (`cli/src/index.ts:369-371`) — unchanged.

For the fail-fast (FR2): extract the existing "Not logged in" throw into a shared
`assertLoggedIn()` helper in `api-client.ts` (single source of the message, DRY with
`apiRequest`), and call it at the top of `unlockCommand()` before `readPassphrase()`.
The thrown error is rendered by the new top-level handler — same message, clean output.

No DB, no concurrency primitives, no schema changes → the plan-stage real-DB probe
requirement does not apply.

## Contracts

### C1 — Top-level CLI error handler (parseAsync + single catch)

- **Signature** (`cli/src/index.ts`, replacing line 197 `program.parse();`):

  ```ts
  try {
    await program.parseAsync();
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  ```

  No new exported symbols. `output.error` is already imported in `index.ts`.
  `parseAsync()` with zero args defaults to `process.argv` exactly like the current
  `parse()` call — do not pass args or `{ from: ... }` (F1). Replace line 197 **in
  place**; the `interactiveMode` function declaration below it hoists and needs no
  move (F4). Commander 13.1.0 verified: both async-rejection and synchronous-throw
  paths inside `_parseCommand` propagate to an awaited `parseAsync()`
  (commander/lib/command.js:1101, runtime-repro confirmed by review).

- **Invariants**:
  - I1 (app-enforced, structural choke point): every rejection escaping a top-level
    `.action()` handler is rendered as `✗ <message>` on stderr and terminates the
    process with exit code 1. A schema-enforced equivalent does not exist for a CLI
    process boundary; the single-choke-point placement (the only `parse` call in the
    binary) is the strongest available form — there is no second entry point to forget.
  - I2 (app-enforced): `audit-verify` exit codes 10–18 are unchanged (its inner catch
    exits before the outer handler can run).
  - **Member-set derivation (R42)** — class: "every top-level commander action whose
    rejection must not escape as a stack trace". Defining primitive: `.action(` in the
    CLI entry point. Derivation command and result:

    ```
    $ grep -n '\.action(' cli/src/index.ts
    64:   login
    70:   status
    75:   unlock          (async lambda: unlockCommand + interactiveMode)
    91:   generate
    105:  env
    112:  run
    122:  api-key list
    131:  api-key create
    143:  api-key revoke
    150:  agent
    158:  decrypt
    170:  audit-verify    (self-handles errors; exits with 10–18|1 before outer catch)
    ```

    All 12 members are covered by the single choke point — the control is applied at
    the shared `parseAsync()` call, not per-member, so the set cannot silently grow a
    gap when a new command is added. Indirect members: the REPL dispatch loop
    (`interactiveMode`) is reached only through the `unlock` action and has its own
    per-command catch (`cli/src/index.ts:369-371`); it is a covered indirect member.
    There is no other `parse`/`parseAsync` call site in `cli/src/` (verified:
    `grep -rn 'program.parse' cli/src/` → only `index.ts:197`).

    Known uncaught throw paths that today reproduce the bug (evidence the class is
    real beyond the reported seed): `unlock` → `apiRequest` throw
    (`api-client.ts:117`), `api-key list/create/revoke` → same `apiRequest` throw,
    `login` → `saveConfig`/`saveCredentials` symlink-refusal throw
    (`config.ts:86`), network-level `fetch` rejections in any `apiRequest` caller
    that lacks a local try/catch.

    Clarity note (T5): `env` and `run` are covered members but were never
    stack-trace-prone — they already fail fast with their own
    `output.error` + `process.exit(1)` before any rejection can escape
    (`env.ts:47-51`, `run.ts:50-54`) — which is why they are absent from the
    "known uncaught throw paths" list above. No per-member regression test is
    needed for them.

- **Forbidden patterns**:
  - pattern: `^program\.parse\(\);?$` in `cli/src/index.ts` — reason: sync parse leaves async action rejections unhandled (the root cause).
  - pattern: `console\.error\(err\)` or passing an `Error` object (not `.message`) to `output.error` in the new handler — reason: would re-print the stack trace the fix exists to remove.

- **Acceptance criteria**:
  - AC1-1: `node cli/dist/index.js api-key list` with no stored credentials → exit 1; stderr contains `Not logged in. Run \`passwd-sso login\` first.`; neither stdout nor stderr contains stack-frame text (`    at `) or `node:internal`.
  - AC1-2: `node cli/dist/index.js --version` and `--help` behave exactly as before (exit 0, same output).
  - AC1-3: `audit-verify` failure paths keep exit codes 10–18 (existing tests `cli/src/__tests__/integration/audit-verify.test.ts` stay green).

- **Consumer-flow walkthrough** (the "shape" this contract defines is the CLI's
  error-output/exit-code contract consumed outside the producer):
  - Consumer A (shell scripts / CI pipelines invoking `passwd-sso ...`): reads { exit code, stderr }. Uses exit code ≠ 0 to detect failure — satisfied by `process.exit(1)`; pre-fix behavior was also exit 1 (unhandled rejection), so no consumer-visible regression. Uses stderr for the human-readable reason — satisfied by `output.error` writing to stderr (`console.error`, `cli/src/lib/output.ts:12-14`).
  - Consumer B (scripted `audit-verify` consumers, e.g. `scripts/` and compliance tooling): reads { exit codes 10–18 } to branch on failure class — satisfied by I2 (inner catch exits first; outer handler unreachable for these paths).
  - Consumer C (interactive REPL user): reads REPL error lines — unaffected; REPL catches internally and never rejects out of the action (indirect member note above).

### C2 — Fail-fast login check in `unlock` (+ shared `assertLoggedIn`)

- **Signatures**:

  ```ts
  // cli/src/lib/api-client.ts (new export)
  export function assertLoggedIn(): void;
  // throws Error("Not logged in. Run `passwd-sso login` first.") when getToken() returns null

  // cli/src/lib/api-client.ts (existing, modified internally)
  // apiRequest<T>(...) — replaces its inline `if (!token) throw ...` with assertLoggedIn()
  // + getToken() (behavior identical; message identical)

  // cli/src/commands/unlock.ts (existing, modified)
  // unlockCommand(): Promise<void> — calls assertLoggedIn() BEFORE readPassphrase()
  ```

- **Invariants**:
  - I3 (app-enforced): the exact message `Not logged in. Run \`passwd-sso login\` first.` (without the ", or set apiKey" suffix) exists in exactly one place (`assertLoggedIn` in `api-client.ts`). Grep check (verified against current code): `grep -rn 'Not logged in' cli/src --include='*.ts'` excluding tests → today 3 hits: `api-client.ts:117` (this contract's target), plus `env.ts:49` and `run.ts:52`, which use a deliberately different message including the apiKey alternative and are NOT members — they guard a different auth mode (config `apiKey`) and already fail fast with `process.exit(1)`. After the change the exact-message grep yields exactly 1 production hit (the helper).
  - I4 (app-enforced): `unlockCommand` performs no interactive read before the login check. Ordering: `isUnlocked()` guard → `assertLoggedIn()` → `readPassphrase()`.
  - I3b (app-enforced, F3): `env.ts` and `run.ts` KEEP their existing `getToken()` null-check + own message + `process.exit(1)` idiom. They must NOT be migrated to `assertLoggedIn()` in this PR: their message deliberately differs (", or set apiKey in config"), and they must not throw (they format their own error and exit). Migrating them would be a user-visible message regression.
- **Forbidden patterns**:
  - pattern: `Not logged in` string literal appearing in `cli/src/commands/unlock.ts` — reason: message must come from the shared helper, not be duplicated.
  - pattern: `assertLoggedIn` appearing in `cli/src/commands/env.ts` or `cli/src/commands/run.ts` — reason: I3b; those commands keep their apiKey-aware message and exit idiom.
- **Acceptance criteria**:
  - AC2-1: with no stored credentials, `node cli/dist/index.js unlock` → exit 1, stderr contains `Not logged in`, stdout does NOT contain `Master passphrase:`, no stack-frame text.
  - AC2-2: with valid credentials, `unlock` prompts for the passphrase exactly as before (regression: existing `cli/src/__tests__/unit/unlock.test.ts` suite stays green).
  - AC2-3: `apiRequest` with no token still throws the identical message (existing `cli/src/__tests__/unit/api-client.test.ts` expectations unchanged or updated in-kind).
- **Member-set correction (R42 clause ①b — added during Phase 2 self-R-check)**: C2's
  fail-fast belongs to a class ("no passphrase prompt before a login check") whose
  defining primitive is a production `readPassphrase(` call site. Derivation:
  `grep -rn 'readPassphrase(' cli/src --include='*.ts'` (excl. tests and the
  definition) → 3 members: `unlock.ts` (the seed), `agent.ts:162`
  (`agentCommand` `--eval` TTY path — `autoUnlockIfNeeded()` performs no API call,
  so nothing checks login before the prompt), and `agent-decrypt.ts:283`
  (`decryptAgentCommand` parent path — prompts directly). Phase 1 treated C2 as a
  single-site fix; the Phase 2 security self-R-check surfaced the two sibling
  members, and per R42/R34 (auth-flow carve-out + 30-minute rule) both received the
  same `assertLoggedIn()` call before their prompt, with ordering tests mirroring
  the unlock one (readPassphrase is cross-module in these files, so the mocked
  `readPassphrase` not-called assertion is direct). `decrypt.ts` has no
  `readPassphrase` call site (verified) — not a member.
- **Consumer-flow walkthrough**:
  - Consumer A (`unlock` action in `index.ts:75-80`): reads { thrown Error } via C1's handler; also reads `isUnlocked()` afterwards to decide on `interactiveMode()` — when `assertLoggedIn` throws, `parseAsync` rejects, C1 prints and exits; `interactiveMode` is never reached. Satisfiable from the locked shape.
  - Consumer B (`apiRequest` internal call path): reads nothing new — behavior and message identical to today's inline throw.
  - Consumer C (unit tests mocking `api-client.js`): `unlock.test.ts` mocks the `api-client` module; the new `assertLoggedIn` export must be added to that mock factory (R19) — enumerated in C3.

### C3 — Regression tests (unit + integration)

- **Signatures** (test files, no production symbols):
  - `cli/src/__tests__/unit/unlock.test.ts` (extend). **Required concrete edits (T1/T3/T4)**:
    1. Mock-factory fix (T1, RT1): the existing factory at lines 4-6 exports only
       `apiRequest`; add `assertLoggedIn: vi.fn()` (a plain `vi.fn()` is a no-op —
       returns undefined) or the pre-existing `unlockCommand` tests at lines 310/343
       fail with `TypeError: assertLoggedIn is not a function` the moment C2 lands.
    2. New case `unlockCommand rejects with "Not logged in" before prompting when
       not logged in` (T4, T6): override the mock with the self-consuming
       `vi.mocked(assertLoggedIn).mockImplementationOnce(() => { throw new Error("Not logged in. Run \`passwd-sso login\` first."); })`
       — a plain no-op default would make this test a vacuous pass. Do NOT use
       sticky `mockImplementation(...)`: empirically verified (vitest 4.1.8) that it
       leaks past this file's `beforeEach: vi.clearAllMocks()` /
       `afterEach: vi.restoreAllMocks()` hooks (`clearAllMocks` clears call history
       only; `restoreAllMocks` restores only `vi.spyOn` spies, not `vi.fn()` factory
       mocks), silently poisoning any test declared after this one. Declare this
       case as the **last** test in the `unlockCommand` describe block (T7): an
       unconsumed once-impl also survives `clearAllMocks` (flushed only by
       `mockReset`), so if the test ever breaks before reaching `assertLoggedIn`,
       last-position guarantees the residual queued throw has no victim — an
       already-red-run noise concern only, never a false green.
    3. Prompt-absence assertion mechanism (T3, RT2): `readPassphrase` is
       same-module-called (ESM local binding — namespace spies cannot intercept it).
       Observe absence indirectly, matching the file's existing approach
       (unlock.test.ts:315-341): `vi.spyOn(process.stdout, "write")` before calling
       `unlockCommand()`, assert it is never called with a string containing
       `Master passphrase:`, and assert the rejection message.
  - `cli/src/__tests__/unit/api-client.test.ts` (extend if needed): `assertLoggedIn` throws when `getToken()` is null; returns undefined when a token exists.
  - `cli/src/__tests__/integration/cli-error-output.test.ts` (new): spawns `node dist/index.js` with `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` pointed at a fresh empty temp dir (isolates `config.json`, `credentials`, AND the legacy `~/.passwd-sso` migration path, since `os.homedir()` follows `$HOME` on POSIX):
    - `unlock` → exit 1, stderr matches `Not logged in`, no `Master passphrase:` on stdout, no `    at ` / `node:internal` anywhere (AC2-1, AC1-1's no-stack-trace property on the reported seed command).
    - `api-key list` → exit 1, stderr matches `Not logged in`, no stack-frame text (proves C1 generically, on a member WITHOUT a command-local fail-fast — verified: `api-key.ts:25-30` goes straight to `apiRequest` with no local guard; this test goes red if C1 is reverted even with C2 in place).
    - **Closed-stdin spawn config (T2, mandatory)**: spawn with stdin closed/ended —
      `execFileSync(..., { input: "" })` or `stdio: ["ignore", "pipe", "pipe"]` —
      plus a `timeout` option. Review reproduced that an open-pipe stdin HANGS at the
      passphrase prompt indefinitely if C2 regresses (`readPassphrase` resolves only
      on data/end); with closed stdin a C2 revert fails fast on the wrong output
      (`Passphrase is required.` — verified via /dev/null stdin) instead of hanging
      CI. Default stdio inheritance is environment-dependent — always set it
      explicitly.
    - Output-assertion robustness: chalk 5 disables color on non-TTY piped output
      (review-verified by direct execution), so plain substring assertions are safe.
    - Uses `it.skipIf(!distExists)` following `version.test.ts`.
- **Invariants**:
  - I5 (app-enforced): the integration test's "no stack trace" assertion is a negative assertion on combined stdout+stderr, not an OR-fallback (R7 assertion-side trap).
  - I6 (RT7, proven-red): each new test must be demonstrated to fail against the pre-fix code — `api-key list` case fails when `program.parse()` is restored; `unlock` unit case fails when the `assertLoggedIn()` call is removed. Recorded in the Phase 2 deviation log.
- **Forbidden patterns**:
  - pattern: `\.toContain\(.*\)\s*\|\|` (OR-combined assertions) in the new tests — reason: OR-fallback assertions pass vacuously (R7).
- **Acceptance criteria**:
  - AC3-1: `cd cli && npx vitest run` green.
  - AC3-2: `cd cli && npm run build` green (ESM `.js` import-extension check — tsc catches what vitest does not).
  - AC3-3: RT7 red-proof performed for both new test families (documented in deviation log, not committed as failing code).

## Go/No-Go Gate

| ID  | Subject                                                        | Status |
|-----|----------------------------------------------------------------|--------|
| C1  | Top-level parseAsync + single error choke point                | locked |
| C2  | unlock fail-fast login check + shared assertLoggedIn           | locked |
| C3  | Regression tests (unit + integration, proven-red)              | locked |

## Testing strategy

- Unit (vitest, `cli/`): C2 fail-fast ordering and `assertLoggedIn` behavior; existing `unlock.test.ts` / `api-client.test.ts` suites as regression harness. Mock alignment (R19): enumerated via `grep -rln "lib/api-client" cli/src/__tests__/` → 9 files (`unit/unlock.test.ts`, `unit/api-client.test.ts`, `unit/login.test.ts`, `unit/env.test.ts`, `unit/run.test.ts`, `unit/agent.test.ts`, `unit/agent-decrypt.test.ts`, `unit/ssh-sign-authorizer.test.ts`, `integration/agent-decrypt-ipc.test.ts`). Phase 2 must check each file's mock factory for the module and add `assertLoggedIn` where the factory is exhaustive (partial factories that don't reach `unlockCommand`/`apiRequest` need no change — verify per file, don't blanket-edit).
- Integration (vitest, spawn built CLI): the end-to-end shape of the reported bug — exit code, stderr message, absence of stack trace — for both the seed command (`unlock`) and a generic member (`api-key list`). Env-isolated per test (`HOME`/`XDG_*` → temp dir).
- Build: `cd cli && npm run build` (mandatory — NodeNext import-extension errors surface only in tsc).
- Repo-level: `npx vitest run` at root (unchanged tests must stay green); `npx next build` is not affected by `cli/`-only changes but CI runs it regardless. `scripts/pre-pr.sh` covers cli build/test before push.
- RT7 discipline: temporarily revert C1 (restore `program.parse()`) and C2 (drop the `assertLoggedIn` call) locally to confirm each new test goes red; record in deviation log. Expected red shapes (review-verified): the `api-key list` integration case goes red under a C1 revert solely via the negative no-stack-frame assertion (exit code and stderr message still match on the unhandled-rejection dump); the new unit ordering test under a C2 revert stalls at `readPassphrase`'s never-resolving promise and goes red via vitest's default 5s test timeout — a timeout-shaped failure, not a message mismatch.

## Considerations & constraints

- Commander's own `process.exit` behavior (help/version/usage errors) is intentionally left untouched; no `exitOverride()` is introduced (YAGNI — nothing consumes CommanderError today).
- `process.exit(1)` in the C1 handler may truncate un-flushed async stdout writes; `output.error` uses `console.error` (synchronous for TTY/pipe on POSIX), matching the existing `process.exit(1)` usage in `env.ts`/`run.ts`.
- The fix is CLI-only; no server, extension, or iOS surface is touched. The AAD/crypto contracts are untouched.

### Scope contract

- **SC1**: Exit-code semantics of non-exception error paths that print `✗ ...` and `return` (e.g. `unlockCommand`'s empty-passphrase path, `apiKeyListCommand`'s HTTP-error path exit 0 today). Deliberately unchanged — a behavioral contract change beyond the reported bug, owned by a future `TODO(cli-exit-codes)` follow-up if the user requests it.
- **SC2**: Error-message wording/i18n of individual commands — unchanged; only the delivery mechanism (no stack trace) is in scope. This includes commander-internal exits (F5): unknown commands, missing required options, and other usage errors are handled inside commander itself (stderr message + `process.exit(1)`, or exit 0 for explicit `--help`/`--version`) and never reach the C1 catch; their format is commander's standard output and stays as-is.
- **SC3**: REPL-internal error handling (`index.ts:369-371`) — already correct; explicitly not modified.

## User operation scenarios

1. **Reported seed**: fresh machine, no login → `passwd-sso unlock` → single line `✗ Not logged in. Run \`passwd-sso login\` first.`, exit 1, no passphrase prompt, no stack trace.
2. **Generic member**: no login → `passwd-sso api-key list` → same clean error, exit 1 (previously: raw stack trace).
3. **Server unreachable**: logged in, server down → `passwd-sso unlock` → passphrase prompt, then a clean `✗ fetch failed`-class message (via C1), exit 1 — no stack trace.
4. **Login file-permission edge**: `~/.local/share/passwd-sso` is a symlink → `passwd-sso login --token` (manual-paste path; the OAuth path's `saveCredentials` is caught locally inside `oauthLogin` and renders via `output.error` without reaching C1) → clean `✗ Data directory is a symlink — refusing to write credentials.`, exit 1.
5. **Happy path**: `login` → `unlock` → REPL commands → `lock` — unchanged, including REPL error lines for bad subcommands.
6. **Scripted audit verification**: `passwd-sso audit-verify -m bad.jws` → exit codes 10–18 exactly as documented — unchanged.
