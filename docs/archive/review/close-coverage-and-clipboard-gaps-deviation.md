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

## D14 — side-fix class: dialog closes that bypass the onOpenChange reset (found by batch E)

- **Defect:** a dialog's `onOpenChange` reset is skipped when a button closes the dialog by calling the raw open-setter with `false`. Changing a controlled `open` prop does not fire `onOpenChange`.
- **Member set:** an AST scan (scratchpad `dialog-close-bypass.ts`) returned 17 candidates, each triaged by hand.
- **Real defects, both fixed** with a reopen test that is red on the pre-fix copy:
  - `travel-mode-card` Cancel kept the typed master passphrase.
  - `service-account-card` create Cancel kept a cancelled form.
- **Not defects:** the other 15 candidates. The direct close sits inside the reset function itself, or the opener re-initialises state before opening.
- **Scanner blind spot (for Phase 3):** the scanner only matches dialogs whose `open` is local state with a `setX` setter. Dialogs whose open state a parent passes down as a prop were not swept.

## D15 — side-fix: team-policy-settings CIDR edits

- **Save never enabled:** a CIDR-only edit left Save disabled, because the parsed list lived outside the dirty-checked `policy`. The textarea now writes the parsed list into `policy.teamAllowedCidrs`.
- **Limit check never fired:** the MAX_CIDRS check had been reading a stale value. With the live value it now fires, so the plan also renders its error, which had never been shown. The message key already existed.

## D16 — Floors enrolled (C2) and the CI-path red-proof

- **Global aggregate after C3:** 91.66 statements / 92.86 lines / 84.52 branches.
- **Floors enrolled:** `perFile` 60/60, plus seven security-directory globs and four exact-path security modules, each set at the measured value minus 2.
- **CI path, 3 shards plus merge:** every shard passed (152 s, 102 s, 126 s at 4 workers). The merge passed the floors, and `check-coverage-scope` reported OK for all 1,128 members.
- **C2a red-proof** (shard → merge, scratch config narrowed to `team-attachment-lock.ts`):
  - allow run: exit 0, with 1 summary key;
  - skipping its test: exit 1, with "does not meet per-file threshold (60%) for src/lib/team/team-attachment-lock.ts".
- **check-vitest-coverage-include.mjs:** check 2 now resolves glob threshold keys instead of reporting them as missing files. Red on a scratch config naming `src/lib/vaultx/**` (exit 1); green on the real config.
- **R4-T4-4:** check-fail-closed-routes-have-test's real-repo case took 18.4 s under coverage, which is under the 30 s rule, so it stays in app-test.

## D17 — Lateral propagation (requested by the user): 13 defect classes swept

Every class was swept from a code-derived member set. Each fixed member has a test that fails on the pre-fix copy.

- **#9 — untranslated or raw text reaching the user.** The password and team edit loaders rendered `err.message`, which includes the JSON.parse SyntaxError carrying a prefix of the decrypted plaintext. Both now show translated keys.
- **#13 — a committed server action reported as a failure.** The passkey sign-in button and the security-key form treated a blocked `sessionStorage` write, or an unreadable PRF body, after a successful verify as a sign-in failure.
- **#5 (prop-controlled dialogs).** `share-dialog` kept the previous share's access password (and copied, expiry and maxViews state) across reopen.
- **#7 — dirty check.** `directory-sync-card` never enabled Save for a credentials-only edit.
- **#3 — divergent error-code mappings.**
  - `auto-extension-connect` offered a retry for `PASSKEY_REAUTH_UNAVAILABLE`/`CREDENTIAL_MISMATCH`. The mapping is now shared as `passkeyReauthDeadEndKey`.
  - `passkey-credentials-card` mapped a 429 to "service unavailable".
- **#12 — tests asserting nothing.** 15 weak or decorative tests across 14 files were fixed. The other 71 scanner hits were triaged as false positives; the scanner-tuning proposals are recorded.
- **#6, #8, #10, #11 — no new defects.** Each scanner was proven on its pre-fix seed.

## D18 — Codex security review (requested by the user)

The branch diff was reviewed by Codex in three partitions (clipboard and share; auth and vault; CI gates) through `codex exec --sandbox read-only`, because `codex review --base` does not accept a focus prompt. All 16 findings were adjudicated against the code:

- **Fixed:** the rotate-key invalidation scope is now `allTenants`, matching the other four vault-secret flows. Also fixed:
  - Send and share dialogs: an in-flight create plus close no longer leaks the late result into a closed dialog; share secrets are cleared on close.
  - Share gate input is masked.
  - Team invite link has an explicit Done.
  - The refocus-retry digest is bounded to 10 minutes.
  - The lint exemption is narrowed to `copy-secret.ts`, and dynamic import/require of it is refused.
  - The team-create passphrase is cleared on success.
  - The lock-screen flag removal is guarded.
  - Key buffers are zeroised in the recovery, emergency invite and emergency vault hooks.
  - `check-vitest-coverage-include` fails closed on an unparseable config.
  - The coverage member set rejects imports of unmeasured files.
- **Rejected:**
  - "Fail closed when invalidation fails after rotation." Rotation has already committed, and a non-2xx response would leave the client on the old key. The documented policy (whitepaper §6.1.c) is to return 2xx with `invalidationFailed`, write an audit record and show a persistent banner.
  - Computed or aliased clipboard access. This stays a documented tripwire residual.
- **Copy wording (user decision):** the copy toast no longer promises a clear. Firefox and Safari never clear the clipboard.
- **Follow-on fixes found while fixing the above:**
  - change-passphrase and recover now adopt the committed state when only invalidation failed (`SESSION_INVALIDATE_FAILED`).
  - Travel-mode enable leads an expired session to sign-in.

## D19 — side-fix: check-e2e-selectors "moved, not removed" detection never worked

- **Defect:** sections 2, 3, 5, 6 and 7 filtered diff headers with BRE `grep -v '^\+\+\+'`. GNU grep reads `\+` as the repetition operator, so the pattern matched every line and emptied the added-line set. Every relocated or re-indented class or id was reported as removed.
- **Prior partial fix:** the file's own NOTE (section 4) documents this pitfall, but only that one site had been fixed.
- **Fix:** all five sites now use `grep -vE`.
- **Self-test:** M1–M4 cover moved versus truly removed, for both class and id. The pre-fix gate fails M1 and M3; the fixed gate passes all 8.

## D20 — Integration suite on the shared dev DB

- `npm run test:integration` ran with the outbox and retention workers stopped and restarted afterwards: 170 of 174 files pass.
- **4 files fail on pre-existing dev-DB state, not on this change.** This branch touches no anchor or key-provider production code.
  - audit-anchor ×3: the precondition guard found one foreign published anchor row.
  - cloud-key-provider-warm: two TeamWebhook rows are encrypted under a key this environment cannot decrypt.
- **Not cleaned up:** the DB is shared with the :3000 instance, so the rows were left in place pending the user's permission.
- **Changed rotate-key tests:** the four rotate-key integration files pass (32 tests).
