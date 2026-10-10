# Code Review: pin-first-autofill-send
Date: 2026-10-10
Review round: 1

## Changes from Previous Round
Initial review of the Phase 2 diff (`main...HEAD`). The Phase 2 self-R-check was clean across all three experts. Local LLM pre-screening and the functionality and testing seeds were unusable (empty, or truncated mid-analysis), so those two experts reviewed the full diff. The security seed was "No findings", and the security expert did not rely on it.

## Functionality Findings
- **F-F1 [Major]** — `ORIGIN_MISMATCH`'s display string ("…since the menu was opened") was written for the context menu. C1/C3 now make the code reachable from a popup Fill: a malformed `expectedOrigin`, or a popup CC/Identity probe off the expected origin. There the string reads as a non-sequitur. (`extension/src/messages/en.json`, `ja.json`)

## Security Findings
No findings. The expert traced every origin kind × entry type against C1-C7 and re-derived the 27-member message partition by hand. It confirmed that every change narrows R43.

Not filed (Finding Floor 3): `resolveSenderMatchUrl` would treat a subframe whose origin is `"null"` as same-origin with an opaque top document. That needs an http(s) content-script frame inside an `about:blank` top tab, which the manifest's matches never produce, and it affects only suggestion matching, never secret release.

## Testing Findings
- **F-T1 [Major]** — Two negative tests waited a fixed real-time 20 ms before asserting "nothing happened": the `KEEPALIVE_PING` allow row in `background.test.ts`, and the C7 no-url badge test in `background/inline-matches.test.ts`.
- **F-T2 [Major, RT1]** — The D12 test answered a `documentIds: ["doc-7"]` probe with a *different* document (`doc-7-new`) through `setDocumentAnswer`. Chrome cannot produce that shape: it returns no result for a document that no longer exists.

## Adjacent Findings
None.

## Quality Warnings
None. Each finding cites a file and line, and the orchestrator re-verified each against the code.

## Recurring Issue Check
### Functionality expert
R1-R57: no instances beyond F-F1. Checked: R10 (D1 module), R36, R37 (F-F1 filed as a context mismatch rather than jargon), R40 (`expectedOrigin` honoured by its sole producer), R42 (AST partition test), R50, and D1-D5 against the diff. Implementation Checklist vs diff: every file present; `autofill-request-origin.ts` is D1.

### Security expert
R1 Checked · R2-R16 N/A · R17 Checked — helpers adopted at every call site · R18 Checked — 27/27 partition · R19-R28 N/A · R29 Checked · R30-R33 N/A · R34 Checked · R35 N/A · R36 Checked · R37-R41 N/A · R42 Checked — hand re-derivation · R43 Checked — narrows only · R44-R46 N/A · R47 Checked — `getURL("")` prefix anchored to this extension id · R48 Checked — push `host` / pull `frameHost` deliberately distinct · R49 Checked · R50 N/A · R51 Checked · R52-R57 N/A · RS1-RS2 N/A · RS3 Checked · RS4-RS6 N/A

### Testing expert
RT1 Finding F-T2 · RT4 adjacent to F-T1, not scored · RT6 Checked · RT7 Checked · RT8 Checked · RT9 Checked · RT10 Checked · RT11 Checked · R1-R57 no further instances.

## Environment Verification Report
- **VE1** (real browser: iframe login via popup, context menu, save banner, popup card fill): `blocked-deferred`. This is the Phase 1 constraint VE1, a manual test that the user runs on the tailscale `:8443` test pages before merge. The scenarios are the plan's User operation scenarios 2-6.
- **VE2** (navigation race): `verified-local` via the chrome-mock tests, run with `cd extension && npx vitest run` (1309 passed).

## Resolution Status

### F-F1 [Major] Popup-reachable ORIGIN_MISMATCH used context-menu copy
- **Action:** reworded neutrally: "The page may have changed after you chose it." / 「選択した後にページが変わった可能性があります。」. This is still correct for the context menu. The code and protocol are unchanged, and the tests assert codes, not copy.
- **Modified files:** `extension/src/messages/en.json`, `extension/src/messages/ja.json`.

### F-T1 [Major] Sleep-based negative assertions
- **Action:** each negative is now ordered after a positive control on the same path, with no wall-clock wait.
  - `KEEPALIVE_PING`: a `GET_STATUS` dispatched after it must answer first.
  - Badge: a legitimate request from tab 2, sent after the spoofed tab-1 request. The test waits for tab 2's badge, then asserts that no tab-1 badge was set.
- **Red proofs**, on scratch copies:
  - `KEEPALIVE_PING` answering → the test fails.
  - The handler reading `message.url` → the badge test fails, 3/3 runs.
  - The first rewrite of the badge test, which counted badges on a single tab, passed under that mutation because `vi.waitFor` returned on the spoofed badge before the control's landed. That is why the control moved to a second tab.
- **Modified files:** `extension/src/__tests__/background.test.ts`, `extension/src/__tests__/background/inline-matches.test.ts`.

### F-T2 [Major] D12 test used an impossible probe shape
- **Action:** D12 now models what Chrome produces. The frame holds a new same-host document (`queueFrameAnswer`), so the `documentIds: [doc-7]` probe finds nothing. The test asserts that neither an injection nor a send reaches `doc-7-new`.
- **Removed:** `setDocumentAnswer`, whose only use was that shape.
- **Red proof:** probing the content path by frame, without the documentId check (main's D12 behaviour) → the test fails.
- `pinDocument`'s `probed.documentId !== origin.documentId` check stays as defence in depth, documented in code. No Chrome contract produces a different id for a `documentIds` probe, so there is no realistic test input for it.
- **Modified files:** `extension/src/__tests__/background.test.ts`, `extension/src/__tests__/helpers/execute-script-mock.ts`.

---

# Code Review: pin-first-autofill-send
Date: 2026-10-10
Review round: 2

## Changes from Previous Round
- Round 1's fixes (`cd057aa23`) changed copy and tests only; no production `.ts` was touched.
- **F-F1, F-T1, F-T2:** resolved. The functionality, security and testing experts each verified them independently. The testing expert re-derived the ordering guarantees from `handleMessage` / `updateBadgeForTab`, and ran the suite 5× with no flakes.

## Functionality Findings
No findings. All five `ORIGIN_MISMATCH` sites read correctly with the new copy.

## Security Findings
No findings.
- R43: no production change, so there was nothing to widen.
- `pinDocument`'s documentId-equality branch is unreachable under the Chrome contract. Removing `setDocumentAnswer` therefore costs no coverage of a reachable path.

## Testing Findings
- **F-T3 [Major]** — `clickMenuItem` waited a fixed 30 ms before negative assertions. This is the same failure mode as F-T1:
  - in three new tests: the Identity and CC "not the click host" tests, and the Identity probe-empty test;
  - in three pre-existing context-menu deny tests: the cross-origin subframe, navigated-away and no-click-host tests.

  The expert suggested a follow-up. The orchestrator fixed all six here instead (pre-existing defects in changed files are in scope).

## Recurring Issue Check
### Functionality expert
R1-R57: no instances. R36/R37 copy checked; R40 re-verified.
### Security expert
R1 Checked · R17 Checked · R43 Checked — no production diff · R47/R48/R49/R51 Checked — untouched · RS3 Checked — `setDocumentAnswer` removal leaves no reachable branch uncovered · others N/A
### Testing expert
RT1 Checked · RT4 adjacent to F-T3 · RT5 Checked · RT7 Checked — ordering re-derived from code · RT8 Checked · RT9 Checked · RT11 Checked · R1-R57: F-T3 only

## Resolution Status

### F-T3 [Major] Sleep-based negatives behind `clickMenuItem`
- **Action:** `clickMenuItem` now waits until the click's one observable outcome occurs: a fill message (`AUTOFILL_FILL` / `AUTOFILL_CC_FILL` / `AUTOFILL_IDENTITY_FILL`) or the failure badge (`"!"`) that `notifyFillFailure` sets. Every caller gains this; a negative assertion after it is ordered behind the handler's completion.
- **Red proof** (scratch copy): an `acceptsDocument` that always accepts → both "not the click host" deny tests fail.
- **Modified file:** `extension/src/__tests__/background.test.ts` (`clickMenuItem`, `clickOutcomes`).
- **Not changed:** one other fixed 30 ms wait remains in `background.test.ts`, the pre-existing token-refresh test "does not retry account A's 401 under account B's token". It has no click outcome to wait on, and a microtask drain is not a faithful replacement if that path uses short timers. It is outside this change's subject and is reported to the user.

---

# Code Review: pin-first-autofill-send
Date: 2026-10-10
Review round: 3

## Changes from Previous Round
F-T3 resolved (`905858e6c`). The experts independently verified the following:
- no production code changed;
- every exercised click shape ends in exactly one outcome;
- a deny test cannot pass on a failure badge while a fill lands later, because `acceptsDocument` gates each send before it happens and the only other `"!"` setter is the vault-locked badge;
- `FILL_MESSAGE_TYPES` is the closed class of fill types: LOGIN, CC and Identity. PASSKEY entries get no menu item.

## Functionality Findings
No findings.

## Security Findings
No findings. R43: no production diff.

## Testing Findings
- **F-T4 [Minor]** — `clickMenuItem`'s comment claimed that every click ends in one outcome. That holds only for the entry-item shapes the helper is used with. The open-popup id, separators, a non-UUID suffix and a missing tab id have no outcome; they would time out, so a vacuous pass is not possible.

## Recurring Issue Check
### Functionality expert
R1-R57 no instances · R17 Checked — all 10 call sites use the helper · R34 Checked — the remaining token-refresh wait is named, with its reason · R40/R42 Checked
### Security expert
R42 Checked — `FILL_MESSAGE_TYPES` re-derived from the menu prefixes · R43 Checked — no production diff · R47/R48/R51 N/A — untouched · RS1-RS6 N/A
### Testing expert
R1-R57 no instances · RT1 Checked · RT3 Checked · RT4 Checked — the subject of F-T3; re-run 5× · RT5 Checked · RT7 Checked · RT8 Checked · RT10 Checked · RT11 Checked

## Tightening-only skip — Round 3
Findings applied directly (no Round 4 review):
- **[F-T4] [Minor]** `clickMenuItem` comment overstated its precondition (`extension/src/__tests__/background.test.ts`, `clickMenuItem`). The comment now names the entry-item shape the helper is used with, and says that other menu ids would time out.

Justification: F-T4 is within Round 2's fix scope, is an inline comment-wording change, and touches no security boundary.

## Final state
- `cd extension && npx vitest run`: 1309 passed.
- `npx tsc --noEmit`, `npm run build`, `node scripts/checks/lint-extension.mjs`: pass.
- `scripts/pre-pr.sh`: passed (76/76) on the implementation state. It re-runs at push.
