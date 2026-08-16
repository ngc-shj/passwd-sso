# Plan Review: fix-extension-console-warnings

Date: 2026-08-16
Review round: 1

## Changes from Previous Round

Initial review. Three expert sub-agents (Functionality / Security / Testing) reviewed Revision 1
of the plan in parallel. Ollama was unavailable, so Step 1-3 pre-screening was skipped and the
Step 1-5 merge was performed manually via the experts' JSON finding indices.

## Merge method

Mechanical join on the three fenced-json indices (same file, line within ±5, similar root cause),
then manual prose merge. Where two or more experts reached the same root cause from different
perspectives, the merged severity takes the **floor of the highest** contributing severity
(perspective convergence as a severity signal).

| Merged | Func | Sec | Test | Root cause | Final |
|---|---|---|---|---|---|
| M1 | F1 Critical | S3 Major | F7 Minor(adj) | Stale `node_modules`; `dist/` evidence unsound | **Critical** |
| M2 | F2 Major | — | F1 Critical | R19 inverted; wrong file named, 5 omitted | **Critical** |
| M3 | F5 Minor | S2 Major | — | `warnBackground(err.message)` breaks closed union, leaks plaintext | **Major** |
| M4 | F4 Major | S5 Major(adj) | — | Generation resume points incomplete; abandoned-after-`removeAll` wipe | **Major** |
| M5 | F3 Major | — | — | Member set omits `invalidateContextMenu` callers; "undebounced" false | **Major** |
| M6 | — | S1 Critical (escalate) | — | Click-time host never re-validated → credential to wrong origin | **Critical** |
| M7 | — | S4 Minor | F4 Major | Grep scope / source-grep fallback overstates control class | **Major** |
| M8 | F7 Minor(adj) | — | F2 Critical | T1 cannot construct the race; no cardinality floor | **Critical** |
| M9 | F8 Minor(adj) | — | F5 Major | C3 gate: own-throw untested, zero-HTML unreached, path-filter gated | **Major** |
| M10 | — | — | F3 Major | AC1.4 unassertable; no ordering/CC/ID/disabled coverage | **Major** |
| M11 | — | — | F6 Minor | T3 rejection fixture swallowed by existing try/catch | **Minor** |
| M12 | F6 Minor | — | — | Warning counts unreproducible | **Minor** |

## Orchestrator verification

Every finding below was independently confirmed against the source before acceptance. Two of them
refute claims the orchestrator itself wrote in Revision 1.

| Claim | Verification | Result |
|---|---|---|
| 5 pkgs `invalid`, lockfile correct | `npm ls`; `package-lock.json` | **Confirmed** — stale `node_modules`, not supply chain. `overrides` pins only nested `rollup` |
| `create` mock already conforms | `context-menu.test.ts:13` | **Confirmed** — Revision 1's claim was FALSE |
| 5 files have bare `create: vi.fn()` | `grep` over `__tests__` | **Confirmed** — all 5 sit beside a callback-invoking `removeAll` |
| T1 recipe collapses to one rebuild | existing `debounces rapid calls` test asserts `getCachedEntries` called **once** for 3 calls | **Confirmed** |
| No CC/IDENTITY fixtures | `mockEntries` lines 41-44 = 2 LOGIN entries | **Confirmed** — 5 of 6 colliding IDs on unexecuted paths |
| `invalidateContextMenu` callers omitted | `index.ts:364` (lock), `index.ts:2171` (unlock) | **Confirmed** |
| `warnBackground` closed unions | `log.ts:8-17` + header comment | **Confirmed** — closure deliberate re vault plaintext |
| Context-menu skips origin check | `index.ts:1418-1430` comment; guard `typeof enforceSenderHost === "string"` | **Confirmed** |
| Nothing downstream catches it | `autofill-lib.ts:14-19` returns `true` for top frame unconditionally | **Confirmed** |
| Problem B survives vite 8 | `npm ci` → rebuild → 4 + 5 preload links, all `crossorigin` | **Confirmed** |
| `modulePreload: false` works on vite 8 | probe: applied, rebuilt | **Confirmed** — 0 links, 1 script tag each |

## Security Findings

**S1 — Critical (escalate: true).** `handleContextMenuClick` never re-validates the clicked tab's
host. The context-menu path passes `enforceSenderHost: undefined` to `performAutofillForEntry`,
whose origin re-binding check is guarded on `typeof … === "string"` — so `ORIGIN_MISMATCH` never
fires for this caller. `isFrameAllowedToFill` returns `true` unconditionally for the top frame.
A credential for host A can be typed into host B's form. The plan's FR2 ("newest wins") governs
which rebuild's writes survive; it says nothing about the interval between the last rebuild and
the click. R51 (decision bound to a name, not the object used), R42 (autofill entry points class,
context menu the fail-open member), R55 (`undefined` spelling both "trusted UI" and "host unknown").
**Disposition: ACCEPTED — new contract C5**, plus FR5, VC4, AD4, RK4, SC5, scenario 7, tests T6a-T6d,
manual M4. Escalated to the user, who chose to include it in this PR.

**S2 — Major.** `warnBackground(event, code)` takes two closed unions; Revision 1's
`err.message` argument does not typecheck, and `log.ts`'s header states the closure exists because
an error message can embed decrypted vault plaintext. **Disposition: ACCEPTED** — extend both unions
by literal (`"context-menu-create-failed"`, `"duplicate-id"`), never widen to `string`; NFR4 added;
forbidden pattern added for the widening.

**S3 — Major.** C4 framed the version discrepancy as build reproducibility only. **Disposition:
ACCEPTED with correction** — the supply-chain reading was investigated and *ruled out* on evidence
(lockfile pins the correct versions; `overrides` scopes only a nested `rollup`; five packages stale
tree-wide = not-installed-since-bump signature). C4 records the resolution and is now locked.

**S4 — Minor.** Forbidden-pattern grep scoped to `context-menu.ts` while derived member 13 lives in
`index.ts`. **Disposition: ACCEPTED** — scope widened to `extension/src/**/*.ts` minus `__tests__`;
merged with test-F4 into M7.

**S5 — Major (Adjacent).** Generation check specified only after awaits, so a superseded task runs
`removeAll` at task entry. **Disposition: ACCEPTED** — merged into M4; C1 invariant 4 now requires
the check at task entry *and* after every await, invariant 7 adds the no-destructive-mutation
clause and the ordering argument.

**No security finding on C2.** `modulePreload: false` is security-neutral: chunks are packaged in
the CRX and integrity-protected by the extension signature; SRI is neither present nor applicable;
CSP admits the same set. Recorded so it is not re-litigated.

## Functionality Findings

**F1 — Critical.** Whole devDependency tree stale (5 packages; vite 6.4.2 vs lockfile 8.2.1), and
the gitignored `dist/` that is Problem B's only evidence was built from it. **Disposition:
ACCEPTED and RESOLVED** — `npm ci` run; zero `invalid`; rebuilt; Problem B re-derived and confirmed
present on vite 8.2.1 (branch (a) of the expert's own fix); `modulePreload: false` probed on the
real toolchain. C4 locked. Had branch (b) obtained, C2/C3 would have been dropped.

**F2 — Major.** Consumer-4 walkthrough asserted a mock defect that does not exist. **Disposition:
ACCEPTED** — merged with test-F1 into M2; obligation promoted to new contract C6 with the true
6-file member set; AC6.4 adds the `beforeEach` re-arm symmetry the expert identified as the real
hazard.

**F3 — Major.** R42 member set omits `invalidateContextMenu` call sites `index.ts:364` and
`index.ts:2171`; "undebounced" mechanism false. **Disposition: ACCEPTED** — member table extended
to 20 members with a wrapper-layer grep shipped in the contract; the mechanism corrected to
synchronous `lastMenuHost = null` guard-defeat; scenarios 2 and 3 rewritten.

**F4 — Major.** Generation resume-point enumeration incomplete; abandoned-after-`removeAll` leaves
a wiped menu; disabled path creates orphaned children even without a race; control class
overstated. **Disposition: ACCEPTED** — invariants 4/6/7/8/9 rewritten; control class split into a
`best-effort tripwire` (routing, with bypasses enumerated) and a `fail-closed verification gate`
(generation); FR2 extended; FR4 given an explicit correction exception.

**F5 — Minor.** Merged into M3 (see S2).

**F6 — Minor.** Warning counts unreproducible. **Disposition: ACCEPTED** — counts dropped; replaced
by the verified qualitative claim (two families, two defects). No contract depended on them.

**F7/F8 — Minor (Adjacent).** Merged into M8 and M9.

## Testing Findings

**F1 — Critical.** R19 claim inverted; the five files with bare `create: vi.fn()` all
`await import("../background/index")`, and `index.ts:730` calls `setupContextMenu()` **unawaited** —
so a pending `createMenuItem` becomes a floating promise and the suites go **green with a wedged
chain**, not red. **Disposition: ACCEPTED** — contract C6; AC6.3 requires per-clause prove-red with
an explicit short timeout so a hang names itself; AC6.5 requires module-state reset (RT11).

**F2 — Critical.** T1's construction cannot interleave the rebuilds: one shared `debounceTimer`
means the second call cancels the first, proven by the existing `debounces rapid calls` test.
**Disposition: ACCEPTED** — T1 rewritten to drive the two genuinely concurrent entry points
(`updateContextMenuForTab` + `invalidateContextMenu`, i.e. the vault-unlock path), with fake timers,
`DEBOUNCE_MS` imported not hardcoded, a **cardinality floor asserted before the invariant**, and
per-mechanism prove-red (serialization and generation token reverted separately).

**F3 — Major.** AC1.4 "byte-identical" unassertable; suite uses order-blind `.find()`, has no
CC/IDENTITY fixtures, no disabled-path coverage. **Disposition: ACCEPTED** — AC1.4 replaced with an
exact ordered-ID-sequence oracle against a hand-written array; fixtures extended; disabled case
added; three prove-red mutations; non-empty guard (R55); 5-vs-6 cap boundary.

**F4 — Major.** T5's source-grep fallback overstates C1's control class. **Disposition: ACCEPTED** —
fallback deleted; T5 is behavioral only; toggle-on allow side added (RT10); merged with S4 into M7.

**F5 — Major.** C3's invariant 2 has no executing acceptance criterion; zero-HTML case unreached;
CI path-filter gated. **Disposition: ACCEPTED** — AC3.3 gains a scanned-count assertion, AC3.4
(zero HTML) and AC3.5 (injected throw) added; invariant 3 requires printing the count; CI wiring
and its `extension/**` filter scope recorded, with SC6 stating the non-widening decision.

**F6 — Minor.** T3's `getCachedEntries` rejection is swallowed by an existing try/catch, so the
chain is never at risk. **Disposition: ACCEPTED** — fixture switched to `isContextMenuEnabled` /
throwing `removeAll`; assertion strengthened to the guarded side effect (RT8); generation-bump
boundary stated.

**F7 — Minor (Adjacent).** Merged into M1.

## Adjacent Findings

- Sec S5 → Functionality (generation guard entry condition) — accepted into M4.
- Func F7 → Testing (T1 cardinality floor) — accepted into M8.
- Func F8 → Testing (C3 glob coverage) — accepted into M9.
- Test F7 → Functionality (dependency reconciliation) — accepted into M1.

All four adjacent findings were routed to the owning expert's merged finding rather than dropped.

## Quality Warnings

None. No finding was flagged VAGUE / NO-EVIDENCE / UNTESTED-CLAIM; every finding cited a concrete
file and line, and the orchestrator reproduced each one against the source.

## Round 1 outcome

12 merged findings: **4 Critical, 6 Major, 2 Minor.** All 12 reflected in Revision 2. Two of the
Criticals (M2, M8) and one Major (M5) are corrections to false claims in Revision 1 — the plan
asserted things about the test corpus and the call graph that the code refutes.

Plan changes: 1 new contract for a security defect (C5), 1 new contract for the test-mock member set
(C6), 1 contract resolved and locked (C4), 1 requirement added (FR5), 1 non-functional requirement
added (NFR4), 1 verification constraint added (VC4), 1 Anti-Deferral entry added (AD4), 2 scope-out
entries added (SC5, SC6), 1 risk added (RK4), 1 scenario added (7), and the entire testing strategy
rebuilt.

**Gate status**: C4 locked. C1/C2/C3/C5/C6 pending Round 2.

## Recurring Issue Check

### Functionality expert

R1: OK (checked `withSigningLock` at `passkey-provider.ts:78-87` — same idiom, different shape, not
a reimplementation) · R2: OK · R3: OK · R4-R8: N/A · R9: FINDING F4 · R10-R15: N/A · R16: FINDING F1 ·
R17: OK · R18: N/A · R19: FINDING F2 · R20-R28: N/A · R29: FINDINGS F2, F3, F6 (all 30 cited line
numbers verified correct) · R30-R33: N/A · R34: OK · R35: OK · R36: OK (strongest section) · R37: N/A ·
R38: FINDING F4 · R39-R41: N/A/OK · R42: FINDING F3 · R43-R48: N/A · R49: FINDING F4 · R50: FINDING F1 ·
R51-R54: N/A · R55: OK · R56: N/A · R57: N/A · RS1-RS6: N/A · RT1: Adjacent · RT2: OK · RT3: N/A ·
RT4: Adjacent · RT5-RT7: OK · RT8: N/A · RT9: N/A · RT10: Adjacent · RT11: N/A

### Security expert

R1-R2: Not triggered · R3: FINDING S1 · R4-R28: N/A or not triggered (R25 considered — SW-restart
state loss contributes to S1's window) · R29: FINDING S3 · R30-R37: not triggered (R36 considered) ·
R38: FINDING S5 · R39-R40: N/A · R41: FINDING S2 · R42: FINDING S1 · R43: FINDING S2 · R44-R46: N/A ·
R47: considered · R48: considered (S1 fix must reuse `isHostMatch`) · R49: FINDINGS S2, S4 ·
R50: considered · R51: FINDING S1 · R52-R53: N/A · R54: considered (folded into S1) · R55: FINDING S1 ·
R56-R57: N/A · RS1: N/A · RS2: N/A · RS3: considered · RS4: FINDING S2 · RS5-RS6: N/A · RT1: N/A ·
RT2: considered · RT3: N/A · RT4: N/A · RT5: considered · RT6: N/A · RT7: considered · RT8: FINDING S1 ·
RT9: N/A · RT10: FINDING S1/S4 · RT11: N/A

### Testing expert

R1-R2: Not triggered · R3: FINDING F1 · R4-R15: N/A · R16: FINDING F5(b) · R17: FINDING F1 · R18: N/A ·
R19: FINDING F1 · R20-R28: N/A · R29: FINDINGS F1, F7 · R30-R32: N/A · R33: considered · R34: OK ·
R35: OK · R36: OK · R37: N/A · R38: considered · R39-R46: N/A (R44 considered) · R47: FINDINGS F4, F5 ·
R48: N/A · R49: FINDING F4 · R50: FINDINGS F5, F7 · R51-R54: N/A · R55: FINDINGS F5(a), F3 · R56-R57: N/A ·
RS1-RS6: N/A · RT1: assessed, no finding (plan's call-log reasoning sound) · RT2: OK · RT3: FINDING F2 ·
RT4: FINDING F2 · RT5: OK · RT6: OK · RT7: FINDING F5(a) · RT8: FINDING F6 · RT9: N/A · RT10: FINDING F4 ·
RT11: assessed, folded into F2's fix

---

# Round 2

Date: 2026-08-16
Review round: 2 (incremental)

## Changes from Previous Round

Revision 2 was reviewed by the same three experts. All Round-1 findings were verified as resolved,
with two carrying residual defects. Contracts C5 and C6 were reviewed for the first time, at
Round-1 depth, since both were created in response to Round-1 findings.

## Merge (manual — Ollama unavailable)

| Merged | Func | Sec | Test | Root cause | Final |
|---|---|---|---|---|---|
| N1 | — | S6 Critical (escalate) | — | C5 bound to `tab.url`; menu items appear in every frame | **Critical** |
| N2 | F12 Major | — | — | C5 deny never reaches the user; `ORIGIN_MISMATCH` unmapped | **Major** |
| N3 | F13 Major | — | — | `tab.url` may be unpopulated without host permissions (R52) | **Major** |
| N4 | F9 Major | — | — | Hardcoded `"duplicate-id"` collides with orphan-parent failure | **Major** |
| N5 | F11 Major | S6 (partial) | — | Guard runs after fetch+decrypt; walkthrough claimed no consumer change | **Major** |
| N6 | — | S7 Major | — | CC/Identity residual understated; bounding delivery fact unrecorded | **Major** |
| N7 | — | — | F2 Major | T6a asserts above the guard; stub bypasses the production primitive | **Major** |
| N8 | — | — | F3 Major | T6d circular; `isHostMatch` asymmetry unpinned | **Major** |
| N9 | — | — | F1 Critical | AC6.4's both-settings invariant false (verified by execution) | **Critical** |
| N10 | F14 Minor | — | F5 (adj) | `disableContextMenu` generation semantics unstated | **Major** |
| N11 | F15 Minor | — | F5 (adj) | Which `isContextMenuEnabled` read is authoritative | **Major** |
| N12 | — | — | F4 Minor | AC1.4 array omits `psso-parent` | **Minor** |
| N13 | — | S8 Minor | — | C5 forbidden pattern cannot express its own defect | **Minor** |
| N14 | F10 Major | — | — | C6 member set / baseline drift | **WITHDRAWN — see below** |

## Orchestrator verification

| Claim | Result |
|---|---|
| `documentUrlPatterns` absent repo-wide | **Confirmed** — menu items appear in all frames |
| `index.ts:2529-2540` rejects `tab.url` binding by name | **Confirmed** — verbatim |
| Wrapper discards `{ ok, error }` | **Confirmed** at `index.ts:683-685` |
| `ORIGIN_MISMATCH` absent from `ERROR_KEY_MAP` | **Confirmed** |
| `isHostMatch` asymmetric (`t.endsWith('.' + e)`) | **Confirmed** at `url-matching.ts:17-22` |
| `extractHost` returns null for non-http(s) | **Confirmed** — deny primitive already exists |
| AC1.4 sequence is 8 elements with `psso-parent` first | **Confirmed by execution** |
| T1 construction interleaves | **Confirmed by execution** — duplicates reproduced on unfixed code |
| Baseline 59 files / 940 tests | **Confirmed** — stable across three runs |

**N14 withdrawn.** The functionality reviewer found a seventh test file (`race-probe.test.ts`) and a
60/941 baseline. That file was the orchestrator's own race probe, present only while its run was in
flight and removed before the review completed; the "1 failed" was the probe's own assertion. The
tracked corpus is six files and the baseline is 59/940, re-verified three times and independently
confirmed by the testing reviewer, who also verified the tree clean. No plan change. Recorded rather
than silently dropped, since the finding was accurate about what the reviewer observed.

## Disposition

All 13 substantive findings reflected in Revision 3. N1 was escalated to the user, who chose to
include frame binding in this PR. N3 became `PC5.1`, the single item still gating C5.

**Saturation assessment.** Not saturated at Round 2: N1 is a Critical against the design itself
(criterion 3 fails), so the early exit does not apply. Revision 3 resolves it. The remaining open
item is `PC5.1`, which is not a finding but a precondition requiring a real browser — Phase 2 work
by definition (criterion 4b). Per the user's decision, the plan proceeds to Phase 2, with C5
locking once PC5.1 is answered.

## Recurring Issue Check — Round 2

### Functionality expert
R1: OK · R2: OK · R3: FINDING F10 (withdrawn) · R9: OK · R19: FINDING F10 (withdrawn) ·
R29: FINDING F10 (withdrawn — baseline verified correct) · R37: FINDING F12 · R38: FINDING F14 ·
R41: FINDING F13 · R42: FINDINGS F10 (withdrawn), F13 · R48: FINDING F11 · R49: OK · R50: OK ·
R51: OK · R52: FINDING F13 · R55: FINDING F9 · all others N/A or OK.

### Security expert
R3: FINDING S6 · R29: OK (all citations reproduce) · R42: FINDING S6 · R43: FINDING S6 ·
R47: FINDING S8 · R48: FINDING S6 · R49: FINDING S8 · R51: FINDING S6 · R54: considered ·
R55: OK for invariant 2, FINDING S6 one level down · R57: FINDING S6 · RS3: OK · RS4: OK ·
RT8: OK · RT10: OK · all others N/A. S2/S4/S5 re-verified complete; S3 rule-out agreed.

### Testing expert
R3: OK · R16: OK (CI verified at `ci.yml:355-375`) · R19: OK (member set complete) ·
R29: FINDINGS F1, F3, F4 · R42: OK · R47: OK · R48: FINDING F3 · R49: OK · R50: FINDING F1 ·
R55: OK · RT1: FINDINGS F2, F3 · RT2: OK (T1 verified constructible by execution) · RT3: OK ·
RT4: OK (cardinality floor reachable — `getCachedEntries` = 2 measured) · RT5: FINDING F2 ·
RT7: FINDING F1 · RT8: FINDING F2 · RT10: OK · RT11: OK · all others N/A.
