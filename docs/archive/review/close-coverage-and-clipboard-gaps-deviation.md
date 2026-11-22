# Coding Deviation Log: close-coverage-and-clipboard-gaps

## D1 — use-local-storage: `seenValueRef` added on top of the planned `pendingWriteRef` (C7)

- **Planned:** C7 specified `pendingWriteRef` on its own.
- **Why it was not enough:** under StrictMode, React re-runs the mount effects while the ref is already set. The effect then persisted the default before the queued update landed, which produced two writes, the first of them wrong.
- **What was added:** `seenValueRef` makes the effect write only when `storedValue` actually changed.
- **Side effect:** a `setValue` that returns an identical value (`Object.is`) no longer writes. Before this change it did.
- **Open edge case for Phase 3:** `setValue(prev => prev)` leaves `pendingWriteRef` set. A later key change would then write the hydrated value back. The written value equals what is already stored.

## D2 — the state-updater purity gate uses ts-morph via `scripts/checks/lib/ast-project.mjs` (C7)

- **Planned:** the plan said "TypeScript compiler API".
- **What was done:** the gate uses ts-morph, the AST layer the sibling gates already share. ts-morph is built on the compiler API.
- **Checking order:** storage, toast, fetch and `on*` calls are checked before the `set[A-Z]` setter match. Without that, `localStorage.setItem` would be classified as a setter.

## D3 — `rotate-key-server.ts`: dead `cekRewrapsFailed` increment removed (found by batch D, fixed by the orchestrator)

- **What was dead:** the increment ran immediately before a throw that aborts the transaction.
- **Why the value is always 0:** a committed rotation cannot carry a failure.
- **What changed:** the field is now a documented constant 0. It stays in the API response shape, which the rotate-key route and the integration tests consume.

## D4 — `instrumentation-client.ts` test lives in `src/__tests__/` (C3)

- **Reason:** vitest `test.include` covers only `src/**`, so a test placed at the repo root would never run. This follows the existing `sentry-config.test.ts` model.

## D5 — delegation test now uses real crypto (C3)

- **What changed:** the existing `delegation.test.ts` mocked `@/lib/crypto/crypto-server`. That mock was replaced with the real module and the setup.ts keys, per the "never mock crypto primitives" rule.
- **Side-fix:** the test's audit mock exported `logAuditAsync`, but the module calls `logAuditAsyncBothScopes`. The mock now exports the function the module actually calls.

## D6 — `extension-connect-request.test.ts` environment changed from node to jsdom (C3)

- **Reason:** `requestExtensionConnect` needs `window`, so the test could not exercise it under node.
- **Boundary:** `window.postMessage` is spied as the browser boundary.

## Deferred parity gap

- **Gate:** `node scripts/checks/check-coverage-scope.mjs coverage/coverage-summary.json`.
- **Reason:** it needs the merged coverage blob, which only the CI `app-coverage` job produces.
- **Local equivalent:** the shard+merge command recorded under C2a.

## D7 — thresholds kept inline in vitest.config.ts; no named `COVERAGE_THRESHOLDS` export (C1)

- **What the plan said:** export `COVERAGE_THRESHOLDS` from `vitest.config.ts`.
- **Why that was dropped:** a named export next to the default export made Rolldown print a `MIXED_EXPORTS` warning on every vitest start. It also left `check-vitest-coverage-include.mjs` reading "0 thresholds keyed", because its parser expects an inline `thresholds: {…}` object. That is a silent loss of its check 2.
- **What was done instead:** the object stays inline. The self-test still reads the enforced thresholds: it re-imports the config with `VITEST_COVERAGE_SHARD` cleared (`vi.stubEnv` + `vi.resetModules`).
- **Result:** the self-test passes under `VITEST_COVERAGE_SHARD=1` (32 tests), and `check-vitest-coverage-include.mjs` reports 12 threshold keys again.
- **Identity pin:** with no separate object left to compare, the planned identity check is now the `"1"` case asserting `thresholds` is undefined, paired with the `""` case reading the live object.

## D8 — pre-pr gates use `queue_step`, not `run_step` (C2c, C7)

- **What was done:** `queue_step` is the batched scheduler every sibling static gate already uses, so the new gates follow it.
- **Meta-gate:** the meta-gate reads only `run_step … bash -c` lines, so it is unaffected.

## D9 — side-fix: `password-analyzer.test.ts` "resolves after specified time" asserted nothing

- **How it was found:** batch A's `scan-test-assertions` sweep flagged it.
- **Fix:** the test now asserts the promise is still pending at 99 ms and resolved at 100 ms.

## D10 — create-grant: created-state feedback is shown inline, not as a toast (C4)

- The dialog now stays open in its created state, which already shows the link. A toast would repeat the same message.
- The status line inside the dialog shows one of `grantCreatedWithLink`, `grantCreatedLinkNotCopied` or `grantCreatedLinkUnavailable`.

## D11 — side-fix: the E2E page object follows the new create-grant flow (R19)

- **Why:** `e2e/page-objects/emergency-access.page.ts` waited for the dialog to close after Create. The dialog now stays open, so that wait would have failed.
- **What it does now:** it waits for `#grant-invite-url`, clicks Done, and then waits for the dialog to close.

## D12 — create-delegation-dialog: a refused response shows the mapped API error, not the server message (C5)

- **Change:** the refused-response branch now shows `tApi(apiErrorToI18nKey(body?.error))`.
- **Why:** this removes the untranslated `details.message` from the UI, which is the third C5 member (R2-F6).
- **Coverage note:** the `buildEntriesFailed` branch (selected ids missing from the loaded entries) still has no test. The component itself is above the coverage target.

## D13 — page extraction (C3): eight hooks and one shared fixture added

- **Hooks:** state, effects and handlers moved out of 8 "use client" pages into hooks under `src/hooks/{share,vault,team}/`. JSX and selectors are unchanged. Each page got characterisation tests that were green before extraction and stayed green after.
- **Pages with no E2E safety net:** `emergency-access/[id]/vault`, `emergency-access/invite/[token]` and `vault-reset/admin` have no E2E spec, so for them the characterisation tests are the only guard on the extraction. Each runs the real crypto round-trip.
- **Shared fixture:** `src/__tests__/helpers/emergency-vault-fixtures.ts` builds real-crypto grantee vault payloads. It was added so the page test and the hook test do not each carry a copy.
- **eslint-disable removed:** the profile page's `eslint-disable-line react-hooks/exhaustive-deps` is gone. `fetchTeam` is now a `useCallback([teamId])`.
- **R19 side-fix:** `src/__tests__/ui/audit-log-action-groups.test.ts` reads source text. It now also reads the hook that holds the action groups.
