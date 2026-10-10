# Plan Review: pin-first-autofill-send
Date: 2026-10-10
Review round: 1

## Changes from Previous Round

Initial review of revision 1. The local LLM pre-screen found 3 issues (AST content-sender test, gate ordering, constants location), which were applied before the expert round. The security expert escalated one Critical; the Opus tier re-ran with the same input and settled it as Major. Revision 2 applies the findings below.

## Functionality Findings

- **F-F1 [Major, design, R29]** — C2 dropped D12's same-host allowance without saying so. **Resolved:** C2 now records this as an intended change, with its cost. The Testing strategy pins the same-host case, and the context-menu path keeps D12's behaviour.
- **F-F2 [Major, design, R42/R3]** — `context-menu.ts` (`ContextMenuDeps.performAutofill`, `handleContextMenuClick`) was not listed among the files to update. **Resolved:** added a "Files to update" section, and C1 names all four callers.
- **F-F3 [Major, design, R42]** — 4 of the 13 gated types (`CLEAR_TOKEN`, `LOCK_VAULT`, `RESET_DPOP_KEY`, `KEEPALIVE_PING`) have no failure response type. **Resolved:** a refusal now reuses the `onMessage` failsafe, extracted as `respondWithFailure`. Its `default` branch already answers these four with `{ type, ok: false, error }`.

## Security Findings

- **F-S1 [Critical→Major after escalation, design, R51/R29/R42/R49]** — The save-banner push checks the host when the tab completes, then sends 500 ms later to `{ frameId: 0 }` without checking again. A post-load redirect delivers the password to an unchecked document; clicking Save then binds the bank password to the attacker host through `SAVE_LOGIN`'s `sender.tab.url`. The plan's SC1 rationale was false: the pull is frame-host gated.
  - **Opus ruling:** real, but Major. The banner does not expose the password, and exploiting it needs a redirect primitive plus two user actions.
  - **Resolved:** SC1 is replaced by contract C6, which probes inside the timer, checks the host, and sends with `{ documentId }`.
- **F-S2 [Minor, design, R47]** — `topFrameHost` matched hostnames only.
  - The Sonnet tier proposed comparing origins. The Opus tier ruled hostname matching sufficient, provided the comparison is exact equality rather than `isHostMatch`.
  - **Resolved, stricter of the two:** C4 now matches `self.origin === topFrameOrigin` exactly. Every other host rule keeps hostname semantics (SC3). Opus's subdomain deny case is in the C4 table.
- **F-S3 [Major, design, R49/R42] (Opus)** — C5 does not name equivalent release paths open to content senders: `AUTOFILL_FROM_CONTENT` for CC/Identity is hostless, and `GET_*_MATCHES` uses content-supplied URLs. **Resolved as named residual SC4**, with a follow-up issue. See the Anti-Deferral entry below.
- **F-S4 [Minor, prose, R49] (Opus)** — The broadcast residual was stated only against page JS. **Resolved:** SC1 now states the renderer-compromise exposure, and that the exposure is pre-existing and not widened.
- **F-S5 [Minor, design] (Opus)** — `OnClickData.frameId` is optional. **Resolved:** C1 specifies `info.frameId ?? 0`.

## Testing Findings

- **F-T1 [Major, design, RT1/RT2]** — `execute-script-mock.ts` keys only on `frameId`, so it cannot simulate a navigation or a `documentIds` target. **Resolved:** the Testing strategy adds a mock-support prerequisite (a per-call document override and `documentIds` handling).
- **F-T2 [Major, design, R42]** — The AST test scope included `public/offscreen.js`, which legitimately sends `KEEPALIVE_PING`. **Resolved:** the scope is now `src/content` only, and offscreen is excluded by name with the reason.
- **F-T3 [Major, design]** — The existing "accepted residual" CC test in `background.test.ts` contradicts C3. **Resolved:** it is listed for rewrite, with a paired allow case.
- **F-T4 [Major, design]** — The existing "always fills the top frame regardless of allowedHosts" test in `autofill.test.ts` contradicts C4. **Resolved:** it is listed for rewrite.

## Adjacent Findings

- [Adjacent, Security] Minor: `extractHost`/`isHostMatch` compare hostnames only across the whole codebase. Recorded as SC3.

## Quality Warnings

None. Every finding cites a file and line, and was checked against the code by the orchestrator: the save-banner timer at `index.ts` lines 926-961, the failsafe `default` branch, and the mock helper.

## Anti-Deferral

### F-S3 [Major] content-sender residuals outside C5 — Out of scope (SC4)
- Why not fixed here:
  - CC and Identity entries are hostless by design. No background check can tell a legitimate inline card pick in an arbitrary frame from a compromised content script, so there is nothing to bind to.
  - Rebinding `GET_*_MATCHES` to sender URLs means re-deriving the same-origin-top fallback, which the content script currently computes, from `sender.url`/`sender.tab.url`. That is a behaviour change to inline suggestions in iframes, unrelated to pinning.
- Cost of deferral: under the compromised-renderer model, entry metadata enumeration, and CC/Identity plaintext reaching the compromised frame's own document. This is unchanged from today; C2 does not widen it.
- Owner: follow-up issue "bind inline-match lookups to browser-set sender URLs".

## Recurring Issue Check

### Functionality expert
R1 Checked — no issue · R2 Checked — no issue · R3 Finding F-F2 · R4-R9 N/A · R10 Checked — no issue · R11 N/A · R12 Checked (see R42) · R13-R16 N/A · R17 N/A · R18 Checked — partition re-derived, matches · R19-R28 N/A · R29 Finding F-F1 · R30 Checked — no issue · R31-R33 N/A · R34 Checked — SC entries reasoned · R35 Checked — VE1 declared · R36-R39 N/A · R40 Checked — topFrameHost optional both sides · R41 N/A · R42 Checked — 13/14 partition exact; F-F2/F-F3 · R43 Checked — narrows only · R44 N/A · R45 Checked — bounded scan · R46 N/A · R47 Checked — single extractHost/isHostMatch · R48 Checked — depth, not divergent semantics · R49 Checked · R50 N/A · R51 Checked — plan is the fix for this class · R52-R54 N/A · R55 Checked — plan removes the undefined-means-popup sentinel · R56-R57 N/A

### Security expert (Sonnet tier)
R1-R28 N/A · R29 Checked — derivations reproduced · R30-R33 N/A · R34 Finding (F-S1) · R35-R41 N/A · R42 Checked — no gap · R43 Checked — no widening · R44-R46 N/A · R47 Finding F-S2; C5 forgeability checked, no finding · R48 N/A · R49 Finding (F-S1) · R50 N/A · R51 Finding (F-S1) · R52-R57 N/A · RS1 N/A · RS2 N/A · RS3 Checked — isValidContentId · RS4-RS6 N/A

### Security expert (Opus tier)
R1 OK · R2 OK · R3 Finding F-S1 · R4-R28 N/A · R29 Finding F-S1 · R30-R41 N/A · R42 Finding F-S1, F-S3 · R43 OK · R44-R46 N/A · R47 OK (sender.url browser-set) · R48 Minor note: push uses pending.host, pull uses pending.frameHost — C6 keeps pending.host, the predicate the push already used · R49 Finding F-S3, F-S4 · R50 N/A · R51 Finding F-S1 · R52-R57 N/A · RS1-RS2 N/A · RS3 OK · RS4-RS6 N/A

### Testing expert
R1-R2 N/A · R3 Checked via F-T3/F-T4 · R4-R11 N/A · R12 Checked — 27/27 · R13-R15 N/A · R16 Checked · R17-R18 N/A · R19 Finding F-T1 · R20-R28 N/A · R29 Checked — claims verified · R30-R34 N/A · R35 Checked — VE1 adequate · R36 risk noted in F-T1/F-T2 · R37-R39 N/A · R40 Checked · R41 N/A · R42 Finding F-T2 · R43-R48 N/A · R49 Checked · R50-R57 N/A · RT1 Finding F-T1 · RT2 Finding F-T1 · RT3 N/A · RT4 Checked — structural, not timing · RT5 Checked · RT6 N/A · RT7 related to F-T3/F-T4 · RT8 Checked — paired with no-side-effect assertions · RT9 N/A · RT10 Checked — paired allow cases · RT11 N/A

---

# Plan Review: pin-first-autofill-send
Date: 2026-10-10
Review round: 2

## Changes from Previous Round

Revision 2 applied every round-1 finding. Its additions: C6 (save-banner pin), the C4 exact-origin match, C5 gate placement and failsafe reuse, the D12 change in C2, a files list, `info.frameId ?? 0`, SC4, and the mock prerequisite. Revision 3 applies this round's testing findings.

## Functionality Findings
No findings. The expert verified that F-F1, F-F2 and F-F3 are resolved against the code. The failsafe returns hardcoded deny shapes for all 13 gated types and reads no hydrated state, so calling it before hydration is safe. The C6 probe-permission and pull-fallback reach rise and fall together.

## Security Findings
No findings. The expert verified that C6 closes the probe→send interval through `documentId`. `pending.host` (push, top frame) and `pending.frameHost` (pull, submitting frame) are correctly different predicates. The C4 exact-origin match fails closed for opaque, IDN and trailing-dot origins. The C5 gate before hydration is a pure narrowing, and `info.frameId ?? 0` narrows the context-menu LOGIN case from a broadcast to a probed frame. SC4 is justified.

## Testing Findings
- **F-T5 [Major, design, R19]** — C1 breaks every exact-positional `performAutofill` assertion in `context-menu.test.ts`. **Resolved:** the Testing strategy now names both describe blocks and requires a non-mechanical rewrite.
- **F-T6 [Major, design, R19]** — The exact-shape AUTOFILL assertion in `MatchList.test.tsx` breaks under `expectedOrigin`. **Resolved:** the test is named.
- **F-T7 [Major, design, RT1/RT2]** — The mock cannot produce an empty `frameIds` probe, which C6's probe-failure row needs. **Resolved:** the mock prerequisite gains a frame-gone override.
- **F-T8 [Minor, design, RT10]** — `KEEPALIVE_PING`'s allow row has no response. **Resolved:** the clause is added.

## Recurring Issue Check
### Functionality expert
R1-R2 N/A · R3 Checked · R4-R11 N/A · R12 Checked — 27/27 · R13-R28 N/A · R29 Checked — re-verified citations · R30-R33 N/A · R34 Checked — SC4 justified · R35 Checked · R36-R37 N/A · R38 Checked — C6 identity check is the superseded guard · R39-R41 N/A · R42 Checked — 13/14 re-derived · R43 Checked — narrows · R44-R46 N/A · R47 Checked · R48 Checked — complementary layers · R49 Checked · R50 N/A · R51 Checked · R52-R54 N/A · R55 Checked — sentinel removed · R56-R57 N/A
### Security expert
R1-R2 N/A · R3 Checked · R4-R28 N/A · R29 Checked · R30-R33 N/A · R34 N/A · R35-R41 N/A · R42 Checked — 27/27 · R43 Checked — no widening · R44-R46 N/A · R47 Checked — browser origin serialization · R48 Checked — host/frameHost are distinct targets · R49 Checked · R50 N/A · R51 Checked · R52-R57 N/A · RS1-RS6 N/A
### Testing expert
R1-R2 N/A · R3 Checked · R4-R18 N/A · R19 Finding F-T5, F-T6 · R20-R28 N/A · R29 Checked — Chrome behaviour claims hold · R30-R41 N/A · R42 Checked · R43-R57 N/A · RT1 Finding F-T7 · RT2 Checked — jsdom `window.origin` settable · RT3-RT4 N/A · RT5 Checked · RT6 Checked · RT7 Checked · RT8 Checked · RT9 N/A · RT10 Finding F-T8 · RT11 N/A

---

# Plan Review: pin-first-autofill-send
Date: 2026-10-10
Review round: 3 (testing expert only — functionality and security returned "No findings" in round 2, and round 3 changed only the Testing strategy)

## Changes from Previous Round
Revision 3 applied F-T5 through F-T8. Revision 4 applies this round's findings.

## Testing Findings
- **F-T9 [Major, design, R19/R42]** — The C5 sender gate refuses the URL-less default sender helpers in 5 test files, whose setup step (`UNLOCK_VAULT`) is extension-page-only. **Resolved:** the Testing strategy now derives the 5 files by command and makes each default sender an extension-page sender.
- **F-T10 [Major, design, R19]** — The C2 `documentId` requirement breaks every allow-side `AUTOFILL_FROM_CONTENT` fixture. **Resolved:** every such fixture gains `documentId`, including `fillFromFrame7`, and the full suite runs right after the fixture update.

The expert verified that every round-2 fix is correct against the test files.

## Saturation call (round 3)
- Rounds completed: 3, so condition 1 holds.
- Open Critical/Major findings: none. F-T9 and F-T10 were resolved in revision 4, so condition 2 holds.
- Findings against the design: none in rounds 2-3. Functionality and security returned "No findings" in round 2, and every round-3 finding concerns test-fixture enumeration. Condition 3 holds.
- Remaining Minor findings: none open. Condition 4 holds.

Further review of fixture completeness is reachable only by executing the suite, which is Phase 2 work by definition. The plan phase is saturated.

## Recurring Issue Check
### Testing expert
R1-R2 N/A · R3 Checked · R4-R18 N/A · R19 Finding F-T9, F-T10 · R20-R28 N/A · R29 Checked — round-2 citations re-verified · R30-R41 N/A · R42 Finding F-T9 (5 files derived) · R43-R57 N/A · RT1 Checked · RT2 Checked · RT3-RT6 N/A · RT7 N/A (not implemented yet) · RT8-RT9 N/A · RT10 Checked · RT11 N/A

---

# Plan Review: pin-first-autofill-send
Date: 2026-10-10
Review round: 4 (C7 added at the user's request: the `GET_*_MATCHES` half of SC4 moved into scope)

## Changes from Previous Round
- Revision 5 adds C7, which makes inline-match lookups use browser-set sender URLs, and FR6.
- SC4 is narrowed to CC/Identity hostlessness, which is a property of the entry type, not a deferral.
- Revision 6 applies this round's findings.

## Functionality Findings
- **F-F4 [Major, design, R40]** — `resolveSenderMatchUrl`'s `string | null` return does not fit its consumers, which take `string`, and `new URL(sender.tab.url)` is unguarded. **Resolved:** each handler short-circuits a null result to its catch-branch response; an absent or unparseable `tab.url` counts as a non-match.
- **F-F5 [Major, design]** — "same as hostless" was wrong for CC/Identity. **Resolved:** a null result means an unknown sender, refused for every kind. Hostless pages still have a `sender.url`, so CC/Identity on them are unchanged.

## Security Findings
- **F-S6 [Minor, design, R49]** — The case of a missing or malformed `sender.tab.url` was undeclared. **Resolved:** declared, with an acceptance row.
- **F-S7 [Minor, prose, R48]** — C7's same-origin fallback looks opposite to `AUTOFILL_FROM_CONTENT`'s frame-URL rationale. **Resolved:** C7 states why they agree on host and requires a code comment saying so.

The expert also verified that C7 does not widen anything (R43): the same-origin case implies host equality, and opaque origins fall through. SC4's claim is accurate.

## Testing Findings
- **F-T11 [Major, design, RT7]** — Mechanically moving the topUrl-precedence tests to frame 0 loses subframe coverage. **Resolved:** they move to same-origin subframe senders.
- **F-T12 [Major, design]** — The badge side effect had no test. **Resolved:** an allow test and a deny test were added.
- **F-T13 [Major, design, RT10]** — No subframe row paired a spoofed message URL with the result. **Resolved:** same-origin and cross-origin spoof rows were added.

## Recurring Issue Check
### Functionality expert
R1-R2 N/A · R3 Checked · R4-R28 N/A · R29 Checked — detector `url`/`topUrl` derivation and consumer signatures re-read · R30-R34 N/A · R35 Checked · R36-R39 N/A · R40 Finding F-F4 · R41 N/A · R42 Checked — `message.url`/`topUrl` consumers = 3 handlers + 3 detectors · R43 Checked — narrows · R44-R46 N/A · R47 Checked · R48 N/A · R49 Checked · R50-R57 N/A
### Security expert
R1 Checked · R2-R28 N/A · R29 Checked · R30-R33 N/A · R34 Checked · R35-R41 N/A · R42 Checked — the 3 message types · R43 Checked — no widening · R44-R46 N/A · R47 Checked · R48 Finding F-S7 · R49 Finding F-S6 · R50-R51 N/A · R52 Checked · R53-R57 N/A · RS1-RS2 N/A · RS3 Checked · RS4-RS6 N/A
### Testing expert
R1-R57 N/A except as cited · RT1 N/A · RT2 Checked — MessageSender fields constructible · RT3-RT4 N/A · RT5 Checked · RT6 N/A · RT7 Finding F-T11 · RT8 Checked · RT9 N/A · RT10 Finding F-T13 · RT11 N/A

---

# Plan Review: pin-first-autofill-send
Date: 2026-10-10
Review round: 5

## Changes from Previous Round
Revision 6 applied round 4 (C7 null handling, the `tab.url` guard, spoof rows, the badge test, subframe test migration). Revision 7 applies this round's testing findings.

## Functionality Findings
No findings. The expert verified F-F4 and F-F5 against the handlers: the three catch-branch literals are identical, the short-circuit skips the badge structurally, and hostless pages keep a `sender.url`.

## Security Findings
No findings. The expert verified F-S6 and F-S7. Re-verified R43: the revision only narrows. The acceptance rows pair each spoof with its legitimate counterpart.

## Testing Findings
- **F-T14 [Major, design/prose, RT7]** — Only one of the two topUrl-precedence tests is genuinely a same-origin subframe; the "frame url is external" test is the spoof C7 closes. **Resolved:** the tests split. The first migrates; the second is replaced by the cross-origin spoof row, with its expectation flipped.
- **F-T15 [Major, design, RT10]** — The no-`sender.url` deny row had no spoofed message URL, so the pre-C7 code produced the same result, and the test would not fail on revert. **Resolved:** every deny row now carries a spoofed URL that the pre-C7 code would honour, and the badge deny test does too.

## Recurring Issue Check
### Functionality expert
R1-R2 N/A · R3 Checked · R4-R28 N/A · R29 Checked · R30-R34 N/A · R35 Checked · R36-R39 N/A · R40 Checked — short-circuit verified · R41 N/A · R42 Checked — 3 handlers + 3 senders · R43 Checked · R44-R46 N/A · R47 Checked · R48 N/A · R49 Checked · R50-R57 N/A
### Security expert
R1 Checked · R2-R28 N/A · R29 Checked · R30-R33 N/A · R34 Checked · R35-R41 N/A · R42 Checked · R43 Checked — no widening · R44-R46 N/A · R47 Checked · R48 Checked · R49 Checked · R50-R51 N/A · R52 Checked · R53-R57 N/A · RS1-RS2 N/A · RS3 Checked · RS4-RS6 N/A
### Testing expert
R1-R18 N/A · R19 Finding F-T14 · R20-R57 N/A · RT1 N/A · RT2 Checked · RT3-RT4 N/A · RT5 Checked · RT6 N/A · RT7 Finding F-T14 · RT8 Checked · RT9 N/A · RT10 Finding F-T15 · RT11 N/A

---

# Plan Review: pin-first-autofill-send
Date: 2026-10-10
Review round: 6 (testing expert only — functionality and security returned "No findings" in round 5, and round 6 changed only C7's test bullets)

## Testing Findings
- The expert verified F-T14 and F-T15. All four C7 deny rows are red-provable against the current `message.topUrl ?? message.url` code.
- **F-T16 [Major, design, R42/RT7]** — The migration rule named only 2 of the `GET_*_MATCHES` tests. Four un-itemised tests would pass vacuously if left unmigrated. **Resolved:** every member of the cited grep migrates to an explicit top-frame sender with the same URL, the four vacuous-risk tests are named, and each migrated test is red-proven.

## Saturation call (round 6)
- Rounds completed: 6, so condition 1 holds.
- Open Critical/Major findings: none; F-T16 was resolved in revision 8. Condition 2 holds.
- The design itself, contracts C1-C7, has drawn no finding since round 5 from functionality or security. Every round-6 finding is test-migration enumeration. The expert labelled F-T16 "design" in the sense of test-strategy design. Its remaining surface — whether every fixture actually exercises its path — is reachable only by executing the suite with red proofs, which is Phase 2 work.
- The orchestrator records this exit as a judgment call on that label, surfaced to the user. It is not a re-labelling of the finding.
- Remaining Minor findings: none open.

## Recurring Issue Check
### Testing expert
R1-R18 N/A · R19 Checked · R20-R41 N/A · R42 Finding F-T16 · R43-R57 N/A · RT1 N/A · RT2 Checked · RT3-RT6 N/A · RT7 Finding F-T16 · RT8-RT9 N/A · RT10 Checked · RT11 N/A
