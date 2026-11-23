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

- **class 9 — untranslated or raw text reaching the user.** The password and team edit loaders rendered `err.message`, which includes the JSON.parse SyntaxError carrying a prefix of the decrypted plaintext. Both now show translated keys.
- **class 13 — a committed server action reported as a failure.** The passkey sign-in button and the security-key form treated a blocked `sessionStorage` write, or an unreadable PRF body, after a successful verify as a sign-in failure.
- **class 5 (prop-controlled dialogs).** `share-dialog` kept the previous share's access password (and copied, expiry and maxViews state) across reopen.
- **class 7 — dirty check.** `directory-sync-card` never enabled Save for a credentials-only edit.
- **class 3 — divergent error-code mappings.**
  - `auto-extension-connect` offered a retry for `PASSKEY_REAUTH_UNAVAILABLE`/`CREDENTIAL_MISMATCH`. The mapping is now shared as `passkeyReauthDeadEndKey`.
  - `passkey-credentials-card` mapped a 429 to "service unavailable".
- **class 12 — tests asserting nothing.** 15 weak or decorative tests across 14 files were fixed. The other 71 scanner hits were triaged as false positives; the scanner-tuning proposals are recorded.
- **class 6, class 8, class 10, class 11 — no new defects.** Each scanner was proven on its pre-fix seed.

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

## D21 — Phase 2 self-R-check (Step 2-5)

**Mechanical pre-steps.** These checks ran; every hit was triaged as follows:
- **check-timing-safe (2 Critical):** false positives. One is an empty-token presence check; the other is a test mock comparing a cookie name.
- **check-propagation (223 Major):** name collisions, not real hits. Local `handleSubmit`/`handleVerify` functions in unrelated files, and coverage-include path strings left in docs.
- **check-hardcoded-reuse (4 non-test):** coincidental values with different meanings (an input type, an HTTP status, a Web Crypto algorithm name, an extension delay).
- **check-orphaned-checks:** the new `scripts/__tests__` self-tests run through the vitest include glob in app-test.
- **check-deployment-artifact:** Tier-2. The manual-test artifact carries the Adversarial section.
- **check-markdown-autolinks:** fixed in this log.
- **Clean:** check-suppression, check-race-vacuous-guard and check-deny-only-guard; the input-validation and event-dispatch checks also exited 0.

**Sub-agent findings:**
- **Security, R49/R3 (Major), fixed.** The README, README.ja, SECURITY.md, docs/security/considerations (en and ja), docs/setup/docker, docs/architecture/feature-gap-analysis and the use-entry-actions comment still promised an unconditional 30 s clipboard clear. They now state it is an attempt that takes effect on Chromium only. The extension and CLI claims describe separate implementations and were left unchanged.
- **Testing, RT7 (Minor), fixed.** Five pool-factory accept cases asserted nothing. Each now asserts the pool holds the accepted value. `scan-test-assertions` over all 170 changed test files reports 0 findings.
- **Functionality:** pending at the time of this entry.

**Pre-PR gate:** `scripts/pre-pr.sh` reports 99/99 passed on HEAD 68ae9286e.
- **Functionality — R17 (Major), fixed.** `passkeyReauthDeadEndKey` was adopted by 3 of its 4 consumers. `signin-reauth-panel` still invited a retry for UNAUTHORIZED, PASSKEY_REAUTH_UNAVAILABLE and PASSKEY_REAUTH_CREDENTIAL_MISMATCH. It now shows the dead-end message, and the sign-in page supplies those labels. Red-proof: the pre-fix panel fails all three new cases.
- **Functionality — R2 (Major), fixed.** The recovery flow and its page compared against a literal 10. Both now use `PASSPHRASE_MIN_LENGTH`, like the sibling flows.

## D22 — Coverage measured at HEAD (supersedes D16's numbers)

- **Run:** single-process `vitest run --coverage`, all thresholds active, HEAD 82290f40a (Phase 3 round-1 testing review).
- **Result:** exit 0; 1,293 files / 27,344 tests; 1,130 files measured.
- **Aggregate:** 92.13 statements / 93.35 lines / 85.05 branches, against floors of 75 / 75 / 65.
- **Lowest file:** `src/lib/blob-store/stream.ts` at 65.62%, against the perFile floor of 60.
- **Security-directory globs:** each clears its floor by +2.0 to +4.2 points.
- **Exact-path ratchets:** all 13 exact-path threshold keys clear their floors. That is the 9 pre-existing keys plus the 4 added in C2b.
- **Reproducing command:** from the repo root at 82290f40a, `npx vitest run --coverage --coverage.reportsDirectory=<dir>`, then read `<dir>/coverage-summary.json`.
- **Second run:** a run of `vitest run src --coverage` on a `git archive` snapshot of 82290f40a reproduced 1,130 measured files, `stream.ts` at 65.62%, and the glob margins. Its aggregate was 92.08 / 93.30 / 85.04, because `scripts/__tests__` was excluded.
- **Why D16 is superseded:** D16's figures came from a run made before `perFile` was enrolled. In that run `service-account-card.tsx` stood at 19.71%, mid-edit.

## D23 — C11: member set, and the gate extended to `src/lib`

- **Initial member set:** the gate's output at the start of C11 was 52 reads in 31 files. Scratch record: `scratchpad/c11/gate-member-set.txt`.
- **Migration:** every member reads through `parseJsonBodyOnce`.
  - **Once-shown-secret sites:** 13 sites, such as API keys, SCIM/SA/operator/JIT tokens, invite links, share links and webhook secrets. They say the item was created but the value cannot be shown, and copy nothing.
  - **Other sites:** they keep their normal success feedback.
- **Scope extension:** the plan named only `src/components`, `src/hooks` and `src/app/**`. That left the vault key-changing flows in `src/lib/vault/vault-context.tsx` outside the gate, so the deny roots now include `src/lib`.
  - **Exempt as server code:** a module with a value import of `server-only`, `next/headers` or `@/lib/prisma`. Type-only imports do not count.
  - **Why not `"use client"`:** it would miss `passkey-reauth-client.ts`. The import graph is undecidable without a Program.
  - **Why the exemption loses nothing:** `fetchApi` throws when `window` is undefined.
  - **Result on the tree:** 373 files denied and 45 exempt.
- **New members found by the extension:** 12.
  - **`rotateKey` success read.** Committed. The client now always switches to the key, salt and wrap it sent. The key version comes from the server when present, otherwise from the client's own `newKeyVersion`. An unreadable body returns `ROTATION_EFFECTS_UNAVAILABLE`, and the dialog adds a persistent "review other sessions and tokens" warning.
  - **passkey-reauth verify.** Committed; an unreadable body gives `{ok:true, verifiedAt:null}`.
  - **Error paths.** setup, the unlock paths, `changePassphrase`, migrate, rotate and the reauth options all keep failure semantics through `readApiErrorBody`. An unreadable setup error no longer throws a raw SyntaxError. An unreadable `unlockWithPasskey` verify now zeroes `prfOutput`.
- **Ledger:** `scratchpad/c11b/ledger.md`, 11 rows. Every control exits 0 and every mutant exits 1, including the pre-change gate on a reintroduced rotate `res.json()`.

## D24 — C11 generalised: a key-changing mutation with an indeterminate outcome locks the vault

- **The gap.** C11 covers an unreadable **2xx** body. The `src/lib` sweep (D23) found its non-2xx twin. A change-passphrase or rotate-key POST can commit and still return to the client as a fetch rejection, a proxy 502/504, or a 5xx without an envelope.
  - **Old behaviour:** the client kept its old salt, wrap and key.
  - **Consequence:** after a committed passphrase change, `verifyPassphrase` kept accepting the old passphrase until the vault locked. After a committed rotation, the client kept encrypting under a key whose rows no longer exist.
- **Design.**
  - **Definite refusal:** an envelope whose code is on the route's allow-list of pre-commit refusals. The allow-lists come from enumerating both routes; the enumeration is recorded in a comment in `vault-context.tsx`. The vault stays unlocked and the existing error is shown.
  - **Indeterminate (everything else):** `lock()`, then throw `VaultChangeOutcomeUnknownError`. The dialogs show a persistent toast telling the user to unlock with the new passphrase, or with the old one if that fails. The next unlock reads the authoritative wrap from the server.
  - **SESSION_INVALIDATE_FAILED:** unchanged, still committed with a warning.
  - **INTERNAL_ERROR:** deliberately left off the allow-list. A 500 does not prove a rollback, and a wrong lock costs only one unlock.
  - **rotateKey:** zeroes `newSecretKey` in a `finally` on every path.
- **Checked and not members:**
  - **recovery reset and vault reset:** they run from the lock screen, hold no key in memory, and hard-reload on success. A retry succeeds, because the server re-reads the snapshot and does the compare-and-swap.
- **Members added in this pass:**
  - **setup:** a zeroization gap.
  - **recovery-key generation:** an unknown outcome may have replaced the recovery wrap.
- **Ledger:** `scratchpad/c11c/ledger.md`.
  - The pre-fix copy is red on 8 tests.
  - Allow-list mutants:
    - `overlock` (empty allow-list): red on 3 tests;
    - `siflock` (SESSION_INVALIDATE_FAILED treated as indeterminate): red on 1;
    - `nofinally` (no zeroing in `finally`): red on 1.
  - The dialogs without the new branch are red on 2 tests.
- **setup:** a `try/finally` now zeroes `secretKey` and `ecdhPrivBytes` on every path. The pre-fix copy is red on fetch reject and on 409. The `setupnocopy` mutant is red on the success pin.
- **recovery-key generation:**
  - **Allow-list.** Built from the codes `recovery-key/generate` emits before its single `user.update`. The route enumeration is recorded in a comment in `recovery-key-dialog.tsx`.
  - **Unknown outcome.** Gives `outcomeUnknown`: the dialog shows no key, does not claim success, and tells the user to generate a new key now because the previous one may no longer work.
  - **Red-proofs:**
    - the pre-fix dialog: red on 5 tests;
    - the `overunknown` mutant (allow-list emptied): red on 4;
    - the `overallow` mutant (any code treated as a refusal): red on 1.
- **Side-fix:** `attachment-section.test.tsx` was intermittently flaky. It compared the length of random ciphertext after decoding it as UTF-8, and decoding can merge bytes into one character. It now compares bytes.

## D25 — Round-3 simplify: one stored-verifier check, refusal lists corrected

- **One verifier check.** The stored-passphrase-verifier check is now `checkStoredVerifier` (`src/lib/vault/stored-verifier-server.ts`).
  - Before, it was copied in five places: change-passphrase, rotate-key, recovery-key/generate, recovery-key/recover (verify and reset) and travel-mode/disable. The pepper-missing audit (`VERIFIER_PEPPER_MISSING`) is now written in one place.
  - The copies were byte-identical apart from each route's own not-set mapping, which every route keeps.
  - Red-proof: dropping the audit call fails the helper's test.
- **Proxy list corrected.** `PROXY_PRE_ROUTE_REFUSALS` is the codes the proxy actually emits: UNAUTHORIZED, ACCESS_DENIED, SERVICE_UNAVAILABLE, PASSKEY_REQUIRED (`api-route.ts`) and INVALID_ORIGIN (`csrf.ts`).
  - The earlier list also claimed FORBIDDEN. Neither the proxy nor the three vault routes emit it; this was checked by grep.
  - So the vault refusal sets lose FORBIDDEN. That is the safe direction, because an unlisted code is treated as an unknown outcome and locks the vault.
  - The team rotate list keeps FORBIDDEN explicitly, because `requireTeamPermission` emits it.
  - A set-equality script confirms there are no other changes.
- **Cleanup.** `CHANGE_PASSPHRASE_REFUSALS` was removed: it had become an empty copy of the shared set.
- **Side-fix (`notification-bell.tsx`).** The full suite under pre-pr load failed "deletes an unread notification… decrements the badge" once.
  - **Cause:** a real race, not a test defect. `deleteNotification` looked the deleted item up through a ref that a passive `useEffect` syncs after commit, so a click landing before that effect ran found no item, and the badge was never decremented.
  - **Fix:** the caller now passes the rendered item it clicked, and the ref and its effect are removed.
  - **Test:** the existing StrictMode double-decrement pin stays green. No deterministic red-proof was possible, because testing-library's `act` flushes passive effects before the click; the fix removes the timing window rather than narrowing it.
