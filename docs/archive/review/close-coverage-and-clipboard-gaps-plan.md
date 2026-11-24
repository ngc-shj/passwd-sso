# Plan: close-coverage-and-clipboard-gaps

Revision 4. The finding IDs used here are explained in `close-coverage-and-clipboard-gaps-review.md`:

- **M\*** — round 1.
- **R2-\*** — round 2. The prefix is the expert's letter: `F` functionality, `S` security, `T2-` testing.
- **R3-\*** — round 3. `N` functionality/security, `T3-` testing.

## Project context

- **Type:** web app (Next.js 16 App Router), a security product: an E2E-encrypted password manager.
- **Test infrastructure:**
  - unit tests (vitest 5.1; coverage is sharded ×3 and merged in `app-coverage`);
  - integration tests (`ci-integration.yml`);
  - E2E tests (Playwright);
  - CI/CD.
- **Verification environment constraints:**
  - **VE1.** `ci-integration.yml` runs only when its path filter matches. Any control that relies on output from the integration suite is absent on every other PR.
  - **VE2.** Clipboard behaviour (secure context, focus, transient activation, `readText` permission) differs per browser, and jsdom has none of it. Real-browser checks are manual and listed under Testing strategy (`blocked-deferred` for CI).

## Objective

CI cannot see an under-tested file today:

- coverage measures only a hand-picked `coverage.include` list;
- apart from the global aggregate floors, only about a dozen named files have their own floors;
- one component sat at 2/84 statements.

Remove that blind spot structurally, bring every production file under it, and fix the production defects that writing the tests exposed.

**Member set (production TS).** The single definition lives in `scripts/checks/lib/coverage-members.mjs`:

```
git ls-files -- ':(glob)src/**/*.ts' ':(glob)src/**/*.tsx' proxy.ts instrumentation-client.ts sentry.client.config.ts sentry.server.config.ts \
  | grep -vE '\.(test|spec)\.|/__tests__/|\.d\.ts$'
```

This gives 1,120 today: 1,116 under `src/` plus the 4 root runtime files. Re-run it before use.

**Below-target set.** To derive it:

1. Run `vitest run --coverage` with a scratch config that spreads the real config and *replaces* `include`/`exclude`. Do not use `mergeConfig` on arrays.
2. Assert that the coverage key count equals the member count.
3. List the files below 65% statements or lines.

## Requirements

- **R-1.** Unit coverage measures every member. There is no allowlist and no exemption ledger.
- **R-2.** Every member meets a per-file floor. The floor is checked on the merged result in `app-coverage` on every PR that touches app paths (VE1). The app path filters include every member (C1, R2-F10).
- **R-3.** Every file below target at the start of this PR is raised to ≥65% statements and lines in this PR, and meets the C3 quality bar.
- **R-4.** Every *programmatic* clipboard write of a secret-bearing value goes through `copySecretToClipboard`, and this is enforced by lint. Secret-bearing values here are:
  - share URLs with `#key=`;
  - Send URLs;
  - emergency-access and team invite URLs.

  Manual copy from a displayed read-only field is an accepted residual (Anti-Deferral entry).
- **R-5.** Fix the defects found while writing the tests (C4–C9).

## Technical approach

- **Coverage scope.**
  - `coverage.include = ["src/**/*.{ts,tsx}", "proxy.ts", "instrumentation-client.ts", "sentry.client.config.ts", "sentry.server.config.ts"]`
  - `coverage.exclude = ["src/**/*.test.{ts,tsx}", "src/**/__tests__/**", "src/**/*.d.ts"]`
  - `coverage.reporter = ["text", "html", "clover", "json", "json-summary"]`, which is vitest's defaults plus `json-summary` (R2-T2-3).
  - The `[...nextauth]` exclusion is removed. That route already has two test files.
- **Floors.** Built on vitest 5.1 `thresholds.perFile` in object form:
  - a file with 0 statements scores 100%;
  - glob keys do not remove files from the global aggregate.
- **Integration-only modules.** These get unit tests with state-based fakes, and the plan names the integration test that serves as their real-store proof. Integration coverage is not merged in, because the integration suite is path-filtered (VE1).
- **Pages and layouts.** Tests follow the `admin/layout.test.tsx` and `s/[token]/page.test.tsx` model:
  - `params` is passed as a `Promise`;
  - `redirect`/`notFound` throw in the mocks, and tests assert `.rejects` and the arguments;
  - `setRequestLocale` and `generateMetadata` are asserted;
  - child props are asserted by component identity;
  - no snapshots.

  A `"use client"` page that holds logic is characterised before that logic is extracted (C3).

## Contracts

### C1 — Coverage measures every member

**Shared module.** `scripts/checks/lib/coverage-members.mjs` (R2-T2-2) exports:

| Export | Behaviour |
|---|---|
| `MEMBER_PATHSPECS` | The pathspecs that define the member set. |
| `listMembers(exec)` | Lists the members. Throws on any of: a git error; an empty set; fewer than 1,000 members; any of `src/proxy.ts`, `src/auth.ts`, `proxy.ts`, `sentry.server.config.ts` absent. |
| `scopeMatcher(include, exclude)` | vitest's own picomatch, resolved through `createRequire(createRequire(import.meta.url).resolve("vitest/package.json"))` (R2-T2-13), called as `pm(include, { dot: true, ignore: exclude })`, mirroring `getGlobMatchers`. |
| `checkScope(config, members)` | Returns the members that are not in scope. |
| `checkThresholdKeys(thresholds, members)` | Every exact-path threshold key matches exactly 1 member, and every glob key matches ≥1 member. Uses `pm(key)` without `dot`, as `resolveThresholds` does (R2-S5, R2-F11). Skips the reserved keys `perFile`, `autoUpdate`, `100`, `lines`, `functions`, `statements` and `branches`, mirroring `resolveThresholds`. Throws on `undefined` or an empty object (R3-N1). |
| `checkSummary(summaryJson, members, root)` | Relativises keys against `root`, ignores `total`, and returns the members that are missing (R2-F15). |

**Layers.**

- **(a) Config layer.** The real `vitest.config.ts` (imported by the self-test) must give an empty `checkScope` result, and its `coverage.include` must deep-equal the declared array.
  - `vitest.config.ts` exports `COVERAGE_THRESHOLDS` unconditionally. The `thresholds:` field then uses `isCoverageShard ? undefined : COVERAGE_THRESHOLDS`.
  - The self-test runs `checkThresholdKeys` against the exported constant, not against `coverage.thresholds`. CI's `app-test` sets `VITEST_COVERAGE_SHARD=1`, which makes `coverage.thresholds` undefined (R3-N1, R3-T3-1).
  - Positive controls: the constant contains `perFile` and every C2b key.
  - Identity pin (R4-T4-2):
    1. `vi.stubEnv("VITEST_COVERAGE_SHARD", "")`, then `vi.resetModules()`, then a dynamic import of `vitest.config.ts`.
    2. Assert `cfg.test.coverage.thresholds` is the same object as `COVERAGE_THRESHOLDS` (`toBe`).
    3. With the variable set to `"1"`, assert the field is `undefined`.
  - One self-test run with `VITEST_COVERAGE_SHARD=1` set is recorded green and non-vacuous.
- **(b) Output layer.** `scripts/checks/check-coverage-scope.mjs coverage/coverage-summary.json` runs in `app-coverage` after `npx vitest --merge-reports --coverage`. It fails on any of:
  - a missing, unparseable or empty summary;
  - an empty member list;
  - any missing member.

**Self-test.** `scripts/__tests__/check-coverage-scope.test.mjs` is a sibling of the gate (meta-gate convention). It covers both layers and records one observed red per clause:

- empty set;
- git error;
- each of the four required paths missing, table-driven: `src/proxy.ts`, `src/auth.ts`, root `proxy.ts`, `sentry.server.config.ts` (R4-T4-5);
- narrowed include;
- added exclude;
- a threshold glob that matches nothing;
- an exact key that matches nothing;
- a summary missing one member (with absolute keys);
- a missing summary;
- an unparseable summary;
- a summary containing only `total`;
- fewer than 1,000 members;
- an `include` that is not deep-equal to the declared array;
- `checkThresholdKeys(undefined)` (R3-T3-5).

It also covers these allow cases:

- both `.well-known` routes match;
- a real-tree green run.

**Control class.** A fail-closed verification gate.

- Layer (b) is adjudicated by vitest's coverage output.
- Layer (a) is adjudicated by vitest's matcher applied to the config object.
- Bypass requires editing a reviewed workflow, script or config.

**Path filters (R2-F10).**

- `.github/workflows/ci.yml` `changes.app` gains the `sentry.*.config.ts` files.
- `scripts/pre-pr.sh` `app_paths` gains `instrumentation-client\.ts` and `sentry\.(client|server)\.config\.ts`.

### C2 — Floors

**C2a. Per-file floor.** `perFile: { statements: 60, lines: 60 }`.

Red-proof on the CI path (R2-T2-4):

1. Use a scratch config that spreads the real config. It keeps the real thresholds, sets `root` to the repo, replaces `include` with a narrowed copy, and skips one subject's test file.
2. Shard it with `VITEST_COVERAGE_SHARD=1 --reporter=blob --outputFile.blob=<dedicated dir>`.
3. Merge with `--merge-reports <dedicated dir> --coverage`.

Expected results:

- **Red:** exit ≠ 0, plus the line `does not meet per-file threshold (60%) for <that file>`.
- **Allow run:** exit 0, and a summary key count above 0. The narrowed set must clear the global floors.

**C2b. Security ratchets.** Measure after C3 on the shard+merge path at CI's shard count (R2-T2-9).

- Glob keys at the measured value minus 2 (statements, lines and branches) for each of:
  - `src/lib/crypto/**`
  - `src/lib/proxy/**`
  - `src/lib/security/**`
  - `src/lib/audit/**`
  - `src/lib/tenant/**`
  - `src/lib/auth/**`
  - `src/lib/vault/**`
- Exact-path floors, also at measured minus 2 including branches, for:
  - `rotate-key-server.ts`
  - `delegation.ts`
  - `team-attachment-lock.ts`
  - `extension-connect-request.ts`

`checkThresholdKeys` guards all of these keys. Record every measured value. Red-prove one ratchet with an unreachable value.

**C2c. Coverage-ignore hints (R2-S4, R2-F9, R2-T2-10).**

- **Gate.** `scripts/checks/check-coverage-ignore-hints.mjs` mirrors the provider's two scopes (`ast-v8-to-istanbul` `dist/index.mjs`, R3-N2):
  - It scans the comments of every member with the TypeScript scanner for `(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(if|else|next|file)`.
  - It scans every raw source line of every member for `(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(start|stop)`, because the provider applies `start`/`stop` to raw lines, including strings, templates and JSX text.
  - Both scans are case-insensitive. There are zero hits today.
- **Wiring.** A `pre-pr.sh` `run_step "Static: coverage-ignore hints"`.
- **Self-test.** `scripts/__tests__/check-coverage-ignore-hints.test.mjs` has these deny cases:
  - a single space;
  - a double space;
  - a tab;
  - a newline;
  - `node:coverage`;
  - the `c8` and `istanbul` spellings;
  - `ignore start` and `ignore stop` inside a comment, a string literal, a template literal and JSX text;
  - a hint in root `proxy.ts`.

  It also has an allow case (a comment that mentions "ignore" in prose), and refuses on an empty member list.
- **Control class.** A fail-closed verification gate over the provider's own grammar.

**Headroom (R53, R2-F7).** After C3, on the shard+merge path:

1. Run twice and diff per file to confirm determinism.
2. Record the minimum per-file statement and line values.
3. Record the global aggregates against their floors: statements 75, lines 75, branches 65 (R3-N4).

No member may land below 65 without a recorded reason. If a global aggregate is below its floor, coverage is raised until it clears. The floor is never lowered.

### C3 — Raise every below-target file

**Member set.** The Below-target derivation, run after `3d538bae0`, covers:

- pages, layouts and special files under `src/app`;
- other `src/app` files and the root runtime files;
- components and hooks;
- lib.

**Type-only modules.** Modules whose only counted statement is the `"use client"` directive drop the directive and are left with 0 statements. Today these are:

- `src/hooks/form/password-form-router.ts`
- `src/hooks/personal/personal-login-fields-types.ts`
- `src/hooks/team/team-login-fields-types.ts`

**Store-backed modules.** Mock only at system boundaries, and never mock crypto primitives.

- **`team-attachment-lock.ts`** (`$queryRaw`). Assert:
  - the null paths;
  - that no second query runs after a null team lock;
  - the parameter-slot binding from the tagged template `values`;
  - the column→field mapping.

  Real-DB proof: identify the `db-integration` test that reaches this module, or add one.
- **`rotate-key-server.ts`.**
  - Every abort arm (CAS mismatch, mode-0 residual, mode-2 invariant, count mismatch) asserts both the error and that no later write happened.
  - Every `updateMany` `where` carries the ownership predicate.
  - Mock returns are checked with `satisfies` against the Prisma payload types.

  Real-DB proof: `vault-rotate-key-attachments`, `vault-rotate-key-exact-set`, `key-version-guard`.
- **`delegation.ts`** (Redis). Use an in-memory fake that computes state. Assert the keys and TTLs it ends up with.
- **Deny arms.** In `src/lib/{auth,vault,crypto,security,audit,proxy}`, and in the modules above, every refusal or deny arm has its own test.

**Quality bar.** Recorded in the review artifact before acceptance.

1. **AST scan** of new and changed test files, using `scripts/checks/scan-test-assertions.mjs`. This is a one-off measurement tool kept in the repo. Its self-test is `scripts/__tests__/scan-test-assertions.test.mjs`, with fixtures for:
   - no `expect`;
   - a snapshot;
   - a `toBeDefined`-only test;
   - self-mock;
   - an allow fixture with a helper assertion.

   The scan requires every `it`/`test` to contain at least one of:
   - an `expect`;
   - an awaited `.rejects`/`.resolves`;
   - a call to an imported helper whose name starts with `expect`/`assert`;
   - a Testing Library `getBy*`/`findBy*` call, which throws on absence.

   It forbids:
   - snapshots;
   - new `it.skip`/`it.todo`;
   - tests whose only assertions are `toBeDefined`/`toBeTruthy`/`not.toThrow`;
   - `vi.mock` of the test's own subject.

   (R2-T2-11)
2. **Mutation ledger.** One row per subject: file | mutation (a file-specific literal or branch) | failing test | exact scratch command | exit codes for the control and the mutant.
3. **Orchestrator re-execution.** The orchestrator re-executes at least 10% of the rows, spread across pages, components and lib.
4. **Positive controls.** Every negative-only assertion has a positive control in the same file.

**Page extraction.**

1. Write characterisation tests against the page as it stands, and get them green.
2. Extract the logic and keep those tests green.
3. Add component- and hook-level tests.
4. Name the E2E spec that covers the page, or write "none".

Selectors stay unchanged.

**`src/hooks/use-local-storage.test.ts`.** Replace it. It tests a re-implementation of the hook.

**Acceptance.** Every member is at ≥65% statements and lines, and the quality bar is met.

### C4 — Secret-bearing URLs go through `copySecretToClipboard`

**Member set.** Run `git grep -nE "navigator\.clipboard|clipboardData|execCommand\(" -- 'src/**' ':!*.test.*' ':!**/__tests__/**' ':!src/lib/clipboard/**'` and drop the reads by hand. Five writes remain:

| File | Call site |
|---|---|
| `share-dialog.tsx` | `handleCopyUrl` |
| `send-dialog.tsx` | `handleCopyUrl` |
| `create-grant-dialog.tsx` | post-create |
| `grant-card.tsx` | `handleCopyLink` (dead code, see below) |
| `team-invite-by-email-section.tsx` | post-invite |

The `share-password-gate.tsx` `clipboardData.getData` read is a known non-member.

**Copy-button sites** (share-dialog, send-dialog). Call `copySecretToClipboard(() => url)` and pass the result to `reportCopyOutcome(outcome, { tCopy, onOk: <existing tick> })`.

**team-invite-by-email-section.** Branch locally on the outcome:

- OK → `invitedWithLink`;
- any other outcome → `invitedLinkNotCopied`, as today.

**create-grant-dialog** (R2-F8, R2-S6, R2-F13):

- **After `res.ok`:**
  1. Call `onCreated()` first.
  2. Parse the token.
  3. If the token is missing or parsing throws, show the created state with `grantCreatedLinkUnavailable` and no link.
  4. Otherwise, show the created state: the invite URL in a read-only field with a `CopyButton`, plus a "Done" button.
  5. Attempt the auto-copy. OK → `grantCreatedWithLink`; any other outcome → `grantCreatedLinkNotCopied`.
- **Close.** Every `onOpenChange(false)` (Done, Esc, overlay, X) resets the email, the wait days, the created state and the URL.
  - The dialog cannot close while the POST is in flight: `onOpenChange(false)` is ignored while `loading` is set, and Cancel is disabled at that point too (R3-N2).
  - Cancel, Done and `onOpenChange` all go through one close handler. That handler ignores close while loading and resets state. No button calls `setOpen(false)` directly.
  - In the created state, the footer shows only Done (R4-F4-2).
  - Tests: create, click Done, reopen → the URL is absent. Fill the form, click Cancel, reopen → the form is empty.
- **In-flight close test.** Submit, press Esc while the fetch is pending → the dialog stays open. Then resolve the fetch → the created state is shown. Then press Esc and reopen → the form is shown and the URL is absent.
- **New `EmergencyAccess` keys** (en and ja): `grantCreatedLinkNotCopied`, `grantCreatedLinkUnavailable`, `inviteLinkLabel`, `done`.
- **Tests:**
  - create, then Esc, then reopen → the form is shown and the URL is absent from the DOM;
  - a rejected copy → the not-copied message, `onCreated` called once, and no error toast;
  - a JSON parse failure → link unavailable, `onCreated` called once.

**grant-card dead copy path.** `GET /api/emergency-access` never returns `token`, so this path never runs. Remove:

- `handleCopyLink` and its button;
- `token?` from the `Grant` interfaces in `grant-card.tsx` and `dashboard/emergency-access/page.tsx`;
- the unused `EmergencyAccess.copyLink` key (en and ja);
- the corresponding `grant-card.test.tsx` case.

**C4b — Clear on refocus** (`copy-secret.ts` `scheduleClear`; R2-S1, R2-S2, R2-F5, R2-T2-5):

- **Engine reality (R3-N1).**
  - Chromium allows a clipboard write without a gesture while the document has focus. So the 30 s clear and this refocus retry work there.
  - Firefox and Safari require transient activation for every write. Neither the timer nor a `focus` event provides it, so neither path ever clears on those engines. The secret stays on the clipboard until something overwrites it.
  - This plan does not add a gesture-triggered clear. That would be a separate design decision: clear on the next in-page `pointerdown`/`keydown` without calling `readText`, which would open a paste prompt.
  - The `copy-secret.ts` header states this per engine. The old remark that the blank-without-compare fallback is "the dominant path" on Firefox/WebKit is corrected: on those engines that path cannot write either.
- **Trigger.** When the scheduled clear fails (the read-back and the blanking write both reject), register one `window` `focus` listener. The closure holds only a SHA-256 digest of the value (`crypto.subtle.digest`), never the plaintext. The digest is computed inside the failure branch, before the listener is registered, so registration happens strictly after the digest resolves (R3-T3-2).
- **On `focus`.**
  - If `document.hasFocus()` is false, keep the listener and do nothing else.
  - Otherwise, remove the listener and make exactly one attempt:
    - read the clipboard; if the digest of its contents equals the held digest, blank it;
    - if `readText` is unavailable or rejects, blank it without comparing. That is the existing trade, and it applies to Chrome without `clipboard-read`, to WebKit, and to Firefox.
  - A failed attempt does not re-register the listener.
- **No `visibilitychange` listener**, so a hidden→visible transition cannot use up the retry.
- **Control class.** Best-effort, and on Chromium only. Residuals:
  - On Firefox and Safari, nothing is ever cleared.
  - On Chromium, the clear is lost if the page unloads before the user refocuses it.
  - On Chromium without the `clipboard-read` permission, the clear blanks without comparing, which can wipe an unrelated clipboard value.
- **Header comment.** Add secret-bearing URLs to the values the module bounds. Mark the Firefox `readText` remark as browser-version dependent.
- **Test harness.**
  - Fake timers.
  - A stateful clipboard fake that holds its content.
  - `vi.spyOn(document, "hasFocus")`, restored in `afterEach`, because jsdom returns false by default.
  - A spy on `window.addEventListener`. Each test awaits registration with `vi.waitFor` before dispatching `focus`.
  - An `afterEach` that removes listeners and runs pending timers.
- **Tests (R3-T3-2):**
  - a failed clear, then focus with `hasFocus` true → `readText` is called and the clipboard is blanked;
  - focus with `hasFocus` false (no `readText` call), then focus with `hasFocus` true → blanked on the second;
  - the content changed before refocus → `readText` is called (positive control), and the clipboard is not blanked;
  - `readText` rejects on retry → blanked;
  - a second qualifying `focus` after the retry → no further `readText` or `writeText` calls;
  - the first clear succeeds → `crypto.subtle.digest` is never called, and `window.addEventListener("focus", …)` is called 0 times after `vi.advanceTimersByTimeAsync` (R4-T4-3);
  - the retry fails → `addEventListener("focus", …)` was called exactly once, and a later `focus` makes no further calls.

**Lint (control class: best-effort tripwire, adjudicated by the ESLint parser).**

- **Layout,** stated in a comment in `eslint.config.mjs` (R2-F14):
  1. Block 1 is unchanged: `INSENSITIVE_EQUALS` for `src/**` and `scripts/**`, including tests.
  2. A new block for `src/**/*.{ts,tsx}`, ignoring tests, `__tests__` and `src/lib/clipboard/**`, holds `INSENSITIVE_EQUALS` + clipboard + toast. It also applies to the root runtime files.
  3. Block 2 (components/hooks) adds clipboard + toast; its fetch entries stay as they are.
  4. `copySecretWithoutClear` is restricted with `no-restricted-imports` (`patterns: [{ group: ["@/lib/clipboard/copy-secret", "**/lib/clipboard/copy-secret"], importNames: ["copySecretWithoutClear"] }]`). The `**/` group also catches relative specifiers (R4-sec-F1). in a separate block over the same non-test `src/**` scope. It is a different rule key, so it does not interact with the `no-restricted-syntax` replacement. This catches aliased imports and use by reference (R3-N3).
  5. A file-scoped block turns `no-restricted-imports` off for `src/components/vault/recovery-key-dialog.tsx` alone, the sanctioned non-clearing caller. It is an audit surface like the `no-console` sinks, and it re-declares no `no-restricted-syntax` set.
- **Clipboard selectors:**
  - `MemberExpression[property.name='clipboard']`
  - `MemberExpression[property.value='clipboard']`
  - `ObjectPattern > Property[key.name='clipboard']`
  - `ObjectPattern > Property[key.value='clipboard']`
  - `MemberExpression[property.name='execCommand']`
  - `CallExpression[callee.object.property.name='clipboardData'][callee.property.name='setData']`
- **Known bypasses:** computed or template property names, `Reflect.get`, aliases (`const cd = e.clipboardData`), untyped navigator aliases, and a dynamic `import()` of `copy-secret`. Recovery path: review.
- **Self-test.** `scripts/__tests__/eslint-clipboard-and-toast.test.mjs` lints fixture text with the repo config through the `ESLint` API.
  - Fixtures: `src/lib/x.ts`, `src/app/x/page.tsx`, `src/components/x.tsx`, `src/hooks/x.ts`, root `proxy.ts`, `instrumentation-client.ts` and `sentry.server.config.ts`.
  - Deny: the full selector × fixture matrix. Every clipboard and toast selector is tested on every fixture, because each block replaces `no-restricted-syntax` on its own (R3-T3-5).
  - Deny, `copySecretWithoutClear`, in a component fixture:
    - a named import;
    - an aliased import (`as c`);
    - a namespace import;
    - a relative-path import (`../../lib/clipboard/copy-secret`);
    - use by reference.
  - Allow:
    - `src/lib/clipboard/x.ts`;
    - `src/components/x.test.tsx`;
    - `clipboardData.getData` in a component;
    - `copySecretWithoutClear` imported in `src/components/vault/recovery-key-dialog.tsx`, paired with deny controls in that same file path for `navigator.clipboard.writeText` and `fetch(`.
  - Regression:
    - `fetch()` in a component is still reported;
    - insensitive-equals is still reported in a test file and in `src/lib/clipboard/x.ts`.

**Acceptance, per converted site:**

- the clipboard receives the URL;
- the clear is scheduled;
- a rejected write produces the site's non-OK feedback and no creation-failure toast;
- on post-create sites, `onCreated` is called once.

Lint and the self-test are green.

### C5 — User-facing toast strings are translated

**Member set** (R2-F6, R2-T2-12):

- `git grep -nE "toast\.(error|success|info|warning|message)\(\s*[\"'\`]"` → `create-delegation-dialog.tsx` lines 213 and 236.
- `git grep -nE "toast(\.\w+)?\([^)]*(\?\?|\|\||\?)\s*[\"'\`]"` → line 233. The `message` there is an untranslated server string; map it through `apiErrorToI18nKey` and `tApi`.

**Lint.** Deny a string or template literal when it appears as `toast(...)` or `toast.<m>(...)`'s first argument, directly or through a `ConditionalExpression` or `LogicalExpression` arm. The rule goes in the same blocks as C4.

**Self-test.**

- Deny:
  - a direct literal;
  - a template literal;
  - a `??` arm;
  - a ternary arm;
  - a bare `toast("x")`.
- Allow: `toast.error(t("k"))`.

### C6 — One unlock-error mapping

**Member set.** `git grep -n "VaultUnlockError" -- 'src/**' ':!*.test.*' ':!src/lib/vault/**'` finds:

- the passphrase, passkey and auto-unlock paths in `vault-lock-screen.tsx`;
- `team-create-dialog.tsx`.

**Defect.** The auto-unlock path renders every error other than UNAUTHORIZED as "account locked".

**Signature.** Exported from `vault-lock-screen.tsx`:

```ts
resolveUnlockError(
  err: unknown,
  msgs: {
    lockedUntil: (lockedUntil: string | null | undefined) => string;
    rateLimited: string;
    unavailable: string;
    fallback: string;
  },
): { kind: "sessionExpired" } | { kind: "message"; message: string }
```

**Consumers** (R2-F3, R2-S7):

| Consumer | On `sessionExpired` | On `message` |
|---|---|---|
| Passphrase | `setSessionExpired(true)`; `setPassphrase("")` | `setError(message)`; `setPassphrase("")` |
| Passkey | `setSessionExpired(true)` | `setError(message)` |
| Auto-unlock (passkey strings) | `setSessionExpired(true)` | `setError(message)` |
| `team-create-dialog` | Unchanged UI (`setOpen(false)` + sessionExpired toast), plus an explicit `reset()` call, because a direct `setOpen(false)` does not fire `onOpenChange` (R3-N3) | Inline `setUnlockError(message)` (unchanged); `setPassphrase("")` |

**Tests:**

- one per code: UNAUTHORIZED; ACCOUNT_LOCKED with and without a date; RATE_LIMIT_EXCEEDED; SERVICE_UNAVAILABLE; an unknown code; a non-`VaultUnlockError`;
- sentinel cases: an unknown code containing a sentinel, and an Error whose message is a sentinel, both return `msgs.fallback` and the sentinel does not appear;
- an auto-unlock render test for RATE_LIMIT_EXCEEDED showing rate-limited (red on the current code);
- lock screen after UNAUTHORIZED: the session-expired card is shown and the passphrase field is absent. The `setPassphrase("")` in the table is defence in depth and is not observable there (R3-T3-3).
- `team-create-dialog` after UNAUTHORIZED (R4-F4-1):
  1. With the vault UNLOCKED, type a team name.
  2. Switch the vault to LOCKED and make `unlock` reject with UNAUTHORIZED, then submit.
  3. Reopen the dialog with the vault UNLOCKED.
  4. Expect the team-name input to be empty. This fails on current code, which does not call `reset()` on that path.

  An empty passphrase is a positive control only: current code already clears it.
- the `team-create-dialog` error is rendered inline.

### C7 — State updaters are pure

**Member set.** The gate below finds three sites:

- `notification-bell.tsx` `deleteNotification`
- `entry-history-section.tsx` `toggleReveal`
- `use-local-storage.ts` `setValue`

**Fixes and tests:**

- **notification-bell.**
  - Fix: `notificationsRef` is assigned in an effect after each commit. `deleteNotification` reads the removed item from the ref, then makes two separate updates: one filtering the item out of the list, and one clamped decrement of the unread count.
  - Test: render under `<StrictMode>` with initial unread ≥2, delete an unread item, and expect the count to drop by exactly 1 (red on the current code, R2-T2-7). Pair it with a read-item deletion that leaves the count unchanged.
- **entry-history-section.**
  - Fix: adopt the `useRevealSet` timer-map pattern (`src/hooks/vault/use-reveal-timeout.ts`). A manual hide cancels the pending timer.
  - Tests (R2-T2-6):
    - reveal → advance T → masked;
    - reveal → advance T/2 → hide → reveal → advance T/2+1 → still revealed (red on the current code) → advance to T after the second reveal → masked.
- **use-local-storage** (R2-F4, R2-T2-8).
  - Fix: the updater is pure. `setValue` sets a `pendingWriteRef` outside the updater, and an effect keyed on `storedValue` writes and then clears it. Only values produced by `setValue` are ever persisted.
  - Tests, with a spy on `localStorage.setItem`, run through `renderHook(..., { reactStrictMode: true })`. The double-invoked updater is what makes the write-count test red on current code (R3-T3-4):
    - mounting with no stored item → no write;
    - mounting with a stored item → no write;
    - a functional update right after hydration (the `use-sidebar-sections-state` ordering) → exactly one write, carrying the hydrated value merged with the update.

**Gate.** `scripts/checks/check-state-updater-purity.mjs` (TypeScript compiler API), run from `pre-pr.sh` as `run_step "Static: state-updater purity"`.

- **What counts as an updater:** a `set[A-Z]*` call, other than `setTimeout`/`setInterval`/`setImmediate`, with a single inline function argument.
- **What it flags:** an updater body that calls a setter, a timer, `toast`, storage, `fetch`/`fetchApi`, or an `on*` callback.
- **Control class:** best-effort tripwire. Known bypasses: setters not named `set*`, and updaters passed by reference.
- **Self-test:** `scripts/__tests__/check-state-updater-purity.test.mjs`.
  - Deny: one fixture per side-effect kind.
  - Allow: a pure updater; `setTimeout(() => setX(v), ms)`; `setTimeout(() => setX(v))`.
  - Refuse: an unparseable file and an empty file list.

### C8 — Dead branches

- **`share-send-view.tsx`.** Extract `ProtectedDownloadButton({ token, accessToken, filename })`. It owns the `downloadError` state and banner (R2-F12) and is rendered only when `accessToken` is set. Remove the `hardNavigate` branch and its import. The existing error tests stay green.
- **`grant-card.tsx`.** Remove the copy path (C4).

### C9 — Custom-field type change carries a stale boolean

Changing a field away from BOOLEAN clears its value. A test for BOOLEAN→TEXT fails on the current code.

### C10 — Stale `it.todo`

In `copy-reprompt-surfaces.test.tsx`, replace the stale todo with a comment pointing at the `password-card.test.tsx` tests that now cover it.

### C11 — A committed mutation is never reported as failed because its response body could not be read

Added in Phase 3 round 2 (user decision: "セキュリティ、あるべき設計").

**Class.** A client mutation (POST/PUT/PATCH/DELETE through `fetchApi`) whose server-side write has already committed (`res.ok`) is reported as failed — or skips its completion (list refresh, `onSuccess`, form reset) — because a later step threw. The usual cause is the response body read: `await res.json()` sits in the same `try` as the mutation, and that try's catch reports failure. For endpoints that mint a once-shown secret (API keys, SCIM/SA/operator/JIT tokens, invite links, share URLs), the secret is lost and the user is told nothing was created.

The class has expanded with each sweep, so its closing artifact is a mutation-verified CI guard:

| When | Members |
|---|---|
| plan C4 | create-grant, team-invite |
| Phase 2 lateral sweep | passkey sign-in ×2 |
| Phase 3 round 2 | api-key, SCIM, SA token, JIT approve |

**Design.**

- **Single reader.** Every client read of a mutation's response body goes through `parseJsonBodyOnce` (`src/lib/http/read-api-error-body.ts`), which never rejects and returns `null` for an unreadable body. Its doc comment is widened from error-path-only to every mutation response.
- **Ordering.** After `res.ok`, completion runs before the body is read. Completion is the list refresh, `onSuccess`, the form or dialog state reset, and the success signal.
- **Unreadable 2xx body, once-shown-secret sites.** Show "created, but the secret could not be shown — revoke it and create a new one". Show no link or token, and copy nothing.
- **Unreadable 2xx body, other sites.** Show the site's normal success feedback; the body was not needed for it.

**Gate.** `scripts/checks/check-mutation-response-read.mjs`, a ts-morph AST scan over client code: `src/components`, `src/hooks`, `src/app/**` (route handlers under `src/app/api` excluded), and `src/lib` minus server modules. A `src/lib` module counts as server code only when it has a value import of `server-only`, `next/headers` or `@/lib/prisma`; every other module is scanned, so the scope fails closed (D23).

- **What it denies.** A `.json()` call on a value that comes from a mutating `fetchApi` call.
- **When a call is mutating.** The method is resolved from the options literal. A method the scan cannot resolve statically, including a spread or a variable, counts as mutating, so the gate fails closed.
- **When it passes.** The `.json()` call is replaced by `parseJsonBodyOnce(res)`.
- **Control class.** A fail-closed verification gate adjudicated by the TypeScript AST.
- **Known bypasses.** The response is aliased through a function boundary, or a raw `fetch` is used. Raw `fetch` is already banned in client code by eslint (`CallExpression[callee.name='fetch']`).
- **Self-test.** `scripts/__tests__/check-mutation-response-read.test.mjs`:
  - deny cases: a literal POST; an unresolvable method; a `.then(r => r.json())` form;
  - allow cases: a GET; `parseJsonBodyOnce`;
  - refusals: an empty file set and a parse error.
- **Wiring.** A `pre-pr.sh` `queue_step`, which the `static-checks` job runs.

**Member set.** The gate's own output on the tree at the start of C11, recorded in the deviation log, plus each member's triage.

**Acceptance.**

- The gate is green on the tree.
- The gate is red-proven on a scratch copy that reintroduces a bare `.json()`.
- Each once-shown-secret site has a test in which an unreadable 2xx body:
  - shows the created-but-unavailable message;
  - completes the flow;
  - shows and copies no secret.
- An allow pin keeps the valid body's behaviour.

## Testing strategy

- **Per contract:** as above.
- **Red-proofs:** every red-proof runs on a scratchpad copy through a scratch config that sets `resolve.alias` and `root`, with `--no-fsModuleCache`. The unmutated control runs first, and each result is judged by exit code.
- **Full checks:**
  - `npx vitest run`;
  - the shard+merge coverage path;
  - `npx next build`;
  - `npm run lint`;
  - `bash scripts/pre-pr.sh`.
- **CI budget.** Record wall times before and after for each `app-test` shard (15 min cap) and for `app-coverage` (10 min cap).
  - If a shard exceeds 10 min, go to 4 shards. Change every place together: the matrix, `--shard=…/N`, the job `name` (pinned by `check-required-aggregate.test.mjs`), the blob glob `blob-*-N.json`, and the blob count check (R2-T2-9).
  - If `app-coverage` exceeds 7 min, raise its cap and record the measurement.
  - Per-test timeouts (R4-T4-4). C3 grows the input of the `check-fail-closed-routes-have-test.test.mjs` real-repo case. That case has a 60 s limit, and it hit that limit once under full-suite coverage load (round-3 measurement).
    - After C3, record its duration in a CI-equivalent run: `--coverage --shard=k/3`, 4 CPUs, verbose reporter.
    - If it exceeds 30 s, or any shard hits a per-test timeout, move the file to a no-coverage job beside `rls-gate-fixtures`. `scripts/` is outside `coverage.include`, so nothing is lost. Exclude it from `app-test` with `--exclude`.
- **Manual (VE2),** recorded in the PR body:
  1. Chrome: copy a share link, stay on the tab for 30 s, then paste. The clipboard is cleared.
  2. Chrome: copy, switch to another app, wait 35 s, return to the tab, then paste elsewhere. The clipboard is cleared after the refocus.
  3. Chrome: copy, switch to another tab, wait 35 s, return. Same result as step 2 (R2-F5).
  4. Firefox: repeat step 1. The clipboard is NOT cleared. This is the documented residual (R3-N1); record what is observed.
  5. Safari: create an emergency-access grant. The not-copied message is shown with the inline link.

## Considerations & constraints

- **Anti-Deferral: manual copy from read-only fields** (`share-dialog`, `send-dialog`, `team-invite-by-email-section`, `create-grant-dialog`). Accepted.
  - **Reason:** the field is the user's deliberate recovery path, and programmatic clearing cannot reach a copy the user makes by hand.
  - **Cost of the alternative:** hiding the field removes the recovery path that C4 depends on.
  - **Mitigation:** the button is the default path.
- **Scope contract:**
  - **SC1.** The global aggregate floors are unchanged and must still be met after the scope expansion (C2 Headroom).
  - **SC2.** No repo-wide per-file branch floor. Branch floors apply only to the C2b keys and the existing named keys in `vitest.config.ts`. A repo-wide floor needs its own headroom study.
  - **SC3.** `next.config.ts`, `prisma.config.ts` and the vitest configs are build and tooling configuration and stay outside R-1.

## User operation scenarios

- **Copy and paste a share link.** Share an entry, copy the link and paste it into a chat. The paste works.
  - Chromium: the clipboard is cleared after 30 s, or on the next return to the tab.
  - Firefox and Safari: the clipboard is not cleared (documented residual).
- **Emergency-access grant in Safari.** The clipboard write is refused. The user sees "Grant created. Copy the invite link below." with the link. Pressing Esc and reopening shows a blank form.
- **Passkey sign-in during rate limiting.** The user sees "rate limited", not "account locked".
- **Delete an unread notification in dev (StrictMode)** with 3 unread. The count goes from 3 to 2.
- **Re-reveal a history password.** Reveal it, hide it, reveal it again. It stays visible for the full timeout.

## Go/No-Go Gate

| ID  | Subject                                                            | Status |
|-----|--------------------------------------------------------------------|--------|
| C1  | Coverage measures every member (shared module, 2 layers, filters)  | locked |
| C2  | Per-file floor, security ratchets, ignore-hint gate, headroom      | locked |
| C3  | Raise every below-target file to ≥65 with quality bar              | locked |
| C4  | Secret URLs via copySecretToClipboard, refocus clear, lint         | locked |
| C5  | Translated toast strings + lint                                    | locked |
| C6  | Single unlock-error mapping (4 consumers)                          | locked |
| C7  | Pure state updaters + AST gate                                     | locked |
| C8  | Dead branches                                                      | locked |
| C9  | Custom-field type change clears stale boolean                      | locked |
| C10 | Stale it.todo                                                      | locked |
| C11 | Mutation responses read through parseJsonBodyOnce + AST gate       | locked |

## Implementation Checklist

**Below-target member set (C3).** 145 files, listed in `close-coverage-and-clipboard-gaps-below-target.txt`. It was derived with the replacing config, and the coverage key count equals the member count (1,120).

**Batches.** Each batch owns a disjoint set of files.

- **A — Coverage infra (C1, C2c, quality-bar scanner, wiring).**
  - `vitest.config.ts`: `include`, `exclude` and `reporter`; `COVERAGE_THRESHOLDS` exported. `perFile` and the C2b keys are added later, after the C3 measurement.
  - `scripts/checks/lib/coverage-members.mjs`
  - `scripts/checks/check-coverage-scope.mjs`, with its self-test
  - `scripts/checks/check-coverage-ignore-hints.mjs`, with its self-test
  - `scripts/checks/scan-test-assertions.mjs`, with its self-test
  - `.github/workflows/ci.yml`: the `changes.app` filter, and the `app-coverage` step that runs `check-coverage-scope`
  - `scripts/pre-pr.sh`: `app_paths`, plus `run_step` lines for ignore-hints and state-updater-purity
- **B — Clipboard, toasts and dead branches (C4, C4b, C5, C8, C10).**
  - Clipboard sites: `share-dialog.tsx`, `send-dialog.tsx`, `create-grant-dialog.tsx`, `grant-card.tsx`, `team-invite-by-email-section.tsx`, and their tests
  - `src/lib/clipboard/copy-secret.ts` and its test
  - `create-delegation-dialog.tsx`
  - `share-send-view.tsx`
  - `src/app/[locale]/dashboard/emergency-access/page.tsx` (the `Grant.token` removal, plus the C3 test)
  - `messages/{en,ja}/EmergencyAccess.json`, and the delegation dialog's namespace files
  - `eslint.config.mjs` and `scripts/__tests__/eslint-clipboard-and-toast.test.mjs`
  - `copy-reprompt-surfaces.test.tsx`
- **C — Unlock mapping and pure updaters (C6, C7 fixes plus gate, C9).**
  - `vault-lock-screen.tsx`
  - `team-create-dialog.tsx` (plus the C3 raise)
  - `notification-bell.tsx`
  - `entry-history-section.tsx`
  - `use-local-storage.ts` (plus the C3 raise; replaces the existing test)
  - `entry-custom-fields-totp-section.tsx`
  - `scripts/checks/check-state-updater-purity.mjs`, with its self-test
- **D — C3 lib, hooks and root.**
  - Store-backed modules: `rotate-key-server.ts`, `delegation.ts`, `team-attachment-lock.ts`
  - Other lib and hooks: `extension-connect-request.ts`, `access-request-state.ts`, `vault-list-adapter.ts`, `form-scope-config.ts`, `use-entry-actions.ts`
  - The three type-only modules (directive removal)
  - `instrumentation-client.ts`
- **E — C3 components.** The rest of the below-target `src/components/**` files, excluding `grant-card` and `team-create-dialog`.
- **F — C3 logic-heavy pages (characterise, then extract).** `share-links`, `emergency-access/[id]/vault`, `recovery`, `audit-logs`, `admin/teams/[teamId]/general/profile`, `emergency-access/invite/[token]`, `vault-reset/admin`, `admin/tenant/teams` (pages), and `src/app/s/[token]/page.tsx`.
- **G — C3 remaining `src/app/[locale]/dashboard/**` files and `src/app/[locale]/*` root files.** Excludes F's pages and the emergency-access page that B owns.
- **H — C3 remaining `src/app/[locale]/{admin,auth,…}/**`, `src/app/layout.tsx`, `src/app/manifest.ts` and `src/app/s/layout.tsx`.**
- **Orchestrator.**
  - C2a `perFile` and the C2b ratchets, after measurement
  - The C2a red-proof and headroom
  - The CI budget measurement
  - The full suite, build and pre-pr runs
  - Commits

**Reuse inventory.** These must be reused, not reimplemented:

- `copySecretToClipboard` and `reportCopyOutcome` (`src/lib/clipboard`)
- `formatLockedUntil` (`vault-lock-screen.tsx`)
- `useRevealSet` timers (`src/hooks/vault/use-reveal-timeout.ts`)
- `apiErrorToI18nKey`
- Test helpers in `src/__tests__/helpers/`: `mock-clipboard`, `mock-translator`, `mock-prisma`, `mock-app-navigation`, `passkey-reauth-mocks`, `request-builder`
- Page-test models: `admin/layout.test.tsx` and `s/[token]/page.test.tsx`

**CI gate parity.**

- `npm run typecheck:test` runs in CI. Every batch must keep its test files type-clean.
- The new static gates run through `pre-pr.sh` `run_step`, which the `static-checks` job executes.
- Deferred parity gap: `check-coverage-scope.mjs` on the merged summary. Reason: it needs the merged coverage blob that only `app-coverage` produces. The local equivalent is the shard+merge command in C2a.
