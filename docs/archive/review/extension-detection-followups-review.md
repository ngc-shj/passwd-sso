# Plan Review: extension-detection-followups
Date: 2026-10-12
Review round: 1

## Changes from Previous Round
Initial review. The local LLM pre-screen (`pre-review.sh plan`) reported no issues.

## Functionality Findings
- **F-F1 [Major, design, R42]:** the month and year regexes are asymmetric. "Expiry month/year", "Expire MM/YY" and a 年-only placeholder named one part only, so the original "exactly one" rule would split combined fields.
  - **Resolved:** C1 uses symmetric `namesMonth`/`namesYear` token patterns, verified with node over 15 sample hints, and adds combined controls.
- **F-F2 [Minor, design]:** a skipped single-part match kept the search going. **Resolved:** the first block-preferred expiry match decides (C1).
- **F-F3 [Major, design]:** a refresh that supersedes an in-flight build, combined with the same-host/version skip, leaves a partial menu. **Resolved:** the completion wrapper nulls `lastMenuHost` when the task ends non-current (C2).
- **F-F4 [Minor, design]:** the version re-record must sit behind the generation check. **Resolved:** the version is recorded from the snapshot after `isCurrent` (C2).
- **F-F5 [Minor, prose]:** `updateBadgeForTab` reads the variable directly. **Resolved:** the walkthrough is fixed.
- **F-F6 [Minor, design]:** every TTL refetch rebuilt the menu. **Resolved:** the version bumps only on a menu-view change.
- **F-F7 [Major, design, R42]:** the reveal attribute set was incomplete. **Partly resolved:**
  - `type` is added.
  - `open` is rejected: `isElementVisible` (field-query-lib.ts) reads the field's own computed style, and `display` is not inherited, so fields inside a closed `<dialog>`/`<details>` are already members. The testing expert's jsdom probe (T1) confirms this.
  - Popover is recorded in SC2.
- **F-F8 [Minor, design]:** `readonly string[]` is not assignable to `attributeFilter`. **Resolved:** each call site spreads it.
- **F-F9 [Minor, design]:** unfiltered attribute rescans ran on every animated page. **Resolved:** only records whose target is or contains an input/select are counted.
- **F-F10 [Minor, design]:** a transition reveal could be missed for good. **Resolved:** `flushForFocus` also runs within `ATTR_RECENT_MS` of an attribute change; the remainder is in SC2.

## Security Findings
- **F-S1 [Major, design, R43/R42/R34]:** combined search past a rejected match, plus the bare 月/年 split fallback, could claim non-card fields (passport expiry, 生年月日). **Resolved:** the first block-preferred match decides, and the split steps prefer the block (C1 and its acceptance cases).
- **F-S2 [Minor, design, R38]:** an in-flight rebuild could list entries after lock. **Resolved:** `invalidateContextMenu` claims a generation synchronously, and the vault is re-checked after the snapshot (C2).
- **F-S3 [Minor, design, R39/R34]:** a fetch begun before lock could repopulate the cache. **Resolved:** `vaultEpoch` guards `setCachedEntries` (C2).
- **F-S4 [Minor, adjacent]:** a version read after the fetch could hide a newer write. **Resolved:** `getCachedSnapshot` returns `{entries, version}`.
- **C3:** no security finding. The visual-safety gates still run after any flush. NF1 wording was corrected (prose).

## Testing Findings
- **T1 [Critical, design, RT7]:** a reveal fixture hidden on its container passes unfixed. **Resolved:** the fixtures hide the field itself.
- **T2 [Major]:** the detector tests were placed in files without a harness. **Resolved:** they move to `cc-identity-detector.test.ts`.
- **T3 [Major, RT7/RT4]:** the storm test was vacuous. **Resolved:** mutations are spread across microtasks; tests for exact counts, two windows, starvation and the 99/100 ms boundary.
- **T4 [Major]:** flush timing, and reveal plus focus in the same task. **Resolved:** `takeRecords()` on non-member focus; both cases are in acceptance.
- **T5 [Major]:** NF2 was untested. **Resolved:** the three-case focus matrix.
- **T6 [Major]:** spy traps. **Resolved:** a `ccClaimedFields` partial mock, one live detector, deltas after init.
- **T7 [Major]:** the self-refetch test was vacuous. **Resolved:** a re-entrant snapshot mock, the same host, bounded timer advance.
- **T8 [Major]:** the FETCH test could be satisfied by UNLOCK. **Resolved:** settle, clear, then assert the new entry's id.
- **T9 [Major]:** no control for `expire` + `MM/YY`. **Resolved:** added; the symmetric tokens classify it combined.
- **T10 [Minor]:** the combined controls bypassed the regex step. **Resolved:** regex-path fixtures.
- **T11 [Minor]:** the destroy test could not detect a missing `cancel()`. **Resolved:** timer count.
- **T12 [Minor]:** teardown on failure. **Resolved:** `afterEach` registry.
- **T13 [Minor]:** only `style` was tested. **Resolved:** all reveal attributes are parametrized.
- **T14 [Minor]:** harness hazards. **Resolved:** `createDeps`, timer restore, full suite run twice.
- **T15 [Minor]:** no test for the `invalidateCache` rebuild. **Resolved:** added.

## Adjacent Findings
- T1, T4 and T9 were adjacent to functionality and are folded into C1/C3 above. F-S4 was adjacent to functionality and is folded into C2.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R1 Checked · R2 Checked (single `OBSERVED_ATTRIBUTES`; F-F8 is about its type) · R3–R28 Checked/N/A (extension only; no DB/API/migration/i18n/env/route surface) · R29 Checked (all greps re-run, counts match) · R30–R41 N/A/Checked · R42 F-F1, F-F7 · R43–R57 Checked/N/A (C2 cycle terminates; F-F3 is about partial state, not a loop)

### Security expert
- R1 n/a · R2 OK · R3 F-S1 · R4–R9 n/a · R10 OK · R11–R18 n/a · R19 n/a · R20–R28 n/a · R29 OK · R30–R33 n/a · R34 F-S1 (JA select variant), F-S3 · R35 OK (VE1) · R36–R37 n/a · R38 F-S2 · R39 F-S3 · R40–R41 n/a · R42 F-S1 split-step gap · R43 F-S1 · R44–R47 n/a · R48 OK (one adjudicator) · R49 NF1 wording · R50 n/a · R51 OK (click-time host re-resolved) · R52–R54 n/a · R55 n/a · R56–R57 n/a
- RS1 n/a · RS2 n/a · RS3 OK · RS4 OK · RS5 n/a · RS6 n/a

### Testing expert
- R1 n/a · R2 OK · R3 OK · R4–R6 n/a · R7 n/a · R8–R9 n/a · R10 OK · R11–R12 n/a · R13 FR4 termination needs T7 · R14–R18 n/a · R19 T14 · R20–R28 n/a · R29 OK · R30–R33 n/a · R34 OK · R35 OK · R36–R41 n/a · R42 OK · R43–R48 n/a · R49 OK · R50 T1 · R51–R57 n/a
- RT1 T6, T7 · RT2 OK (probe-confirmed) · RT3 import `ATTR_RESCAN_DELAY_MS`/`DEBOUNCE_MS` · RT4 T3 · RT5 T6 · RT6 T5, T15 · RT7 T1, T3, T4, T7, T8, T11 · RT8 T8 · RT9 n/a · RT10 T5, T9, T10, T13 · RT11 T12, T14

---

# Round 2
Date: 2026-10-12

## Changes from Previous Round
C1 was redesigned. The month/year picks now decide first, within a containment region (`cardRegion`: the card number's form, else the lowest ancestor that holds a neighbour). The tokens are delimiter-aware. C2 now returns `[]` / `VAULT_LOCKED` across a lock, and compares the incoming entries with the current cache in place of a fingerprint copy. C3 uses `Date.now()` as its clock. The tests were tightened per R2-T*.

## Functionality Findings
- **R2-F1 [Major, R42]** `\bmm\b` misses `expiry_mm`. **Resolved:** delimiter-aware `CC_MONTH_TOKEN_RE` / `CC_YEAR_TOKEN_RE`; node check over 17 hints.
- **R2-F2 [Major]** The format decision and the pickers used different patterns. **Resolved:** the pickers use the same `namesMonth` / `namesYear`, and two distinct picks decide split.
- **R2-F3 [Major, R42]** The block predicate was blind to 月-only fields in markup without a form. **Resolved:** `cardRegion` is containment-based, and its form branch needs no neighbour.
- **R2-F4 [Minor, adjacent]** = F-S6.
- **R2-F5 [Major, escalate]** Pre-existing: a hidden duplicate card form wins detection. **Out of scope → SC4.**
  - **Anti-Deferral:** fixing it changes the admission rule shared by three consumers (CC detection, LOGIN eligibility, fill `accepts`). It is a separate design with its own regression surface.
  - **Cost of deferral:** on pages with two card forms, one hidden, the dropdown and the fill can target the hidden form. This is the behaviour today, and this PR does not make it worse.
  - **Owner:** a follow-up issue, filed with the user's approval when the PR opens.
- **R2-F6 [Minor, prose]** Reveals through a sibling selector or `:has()`. **Resolved:** recorded in SC2.

## Security Findings
- **F-S5 [Major, R43]** Picks fell back outside an existing block. **Resolved:** with a region present, only in-region candidates are considered (C1). The fixtures put a passport field before the card form, in a separate form.
- **F-S6 [Minor, R38]** A stale fetch was still returned to callers. **Resolved:** the snapshot returns `[]` on a stale epoch, and `FETCH_PASSWORDS` returns `VAULT_LOCKED`.
- **F-S7 [Minor, R39]** The fingerprint was a second copy of the data. **Resolved:** the comparison runs against the current cache; there is no copy.
- **F-S8 [Minor, prose, R49]** NF1 wording. **Resolved.**

## Testing Findings
- **R2-T1 [Major]** `getCachedEntries` → `getCachedSnapshot` migration in tests. **Resolved:** a grep gate, plus a re-assertion of the abandoned-build test.
- **R2-T2 [Major]** The two lock guards masked each other. **Resolved:** each guard is tested in isolation.
- **R2-T3 [Major]** The superseded-build conditions were not specified. **Resolved:** the conditions are now in the acceptance criteria.
- **R2-T4 [Major]** The passport-after fixture was vacuous. **Resolved:** the fixture moved before the card form, in a separate form, plus the F-F2 later-match fixture.
- **R2-T5 [Major]** The epoch test had no observable. **Resolved:** a lock → A → unlock → B observation.
- **R2-T6 / R2-T7 / R2-T8 / R2-T9 / R2-T10 [Minor]** **Resolved:** the login-save path, a parametrized fingerprint fixture, the snapshot-version case, the same-task fixture hidden in the initial markup, and a `Date.now()` clock.
- **R2-A1 [Minor, adjacent]** = F-S6.

## Recurring Issue Check (round 2)
### Functionality expert
R1, R2 Checked · R3–R28 N/A/Checked · R29 Checked (greps and node predicates re-run) · R30–R41 N/A/Checked · R42 R2-F1, R2-F3 · R43–R57 Checked/N/A
### Security expert
R1 n/a · R2 OK · R3 F-S5, F-S6 · R4–R33 n/a/OK · R34 OK · R35 OK · R38 F-S6 · R39 F-S7 · R42 consumer set recomputed (menu, inline match, copy, FETCH_PASSWORDS, login-save, passkey-provider) · R43 F-S5 · R48 OK · R49 F-S8 · R51 OK · others n/a; RS1–RS6 n/a/OK
### Testing expert
R13 OK · R19 R2-T1 · R29 OK · R38 R2-T2 · R39 R2-T5 · R43 R2-T4 · R50 OK · others n/a/OK; RT1 R2-T1 · RT2 OK (probes for type records, focusin, takeRecords) · RT6 R2-T8 · RT7 R2-T2..T6, T9, T10 · RT8 R2-T5 · RT10 R2-T4, T7 · others OK/n/a

---

# Round 3
Date: 2026-10-12

## Changes from Previous Round
Round 3 showed that each C1 redesign was producing new regressions: R3-F1 and R3-F2 were caused by round 2's region and bare-token design. The security expert also found two pre-existing classes behind the round-1/2 findings. The user then decided to fix all of it, in three PRs:

- **PR 1** (this plan): #883, #881 and #875.
- **#884**: hidden-field autofill, across all fill paths with one shared predicate (filed).
- **#885**: lock-spanning background operations, 19 members derived from the code (filed).

Changes in this round:

- **C1** was re-derived empirically. A prototype in a scratch copy passed 29 fixtures and the existing content suite (456 tests). It uses a scope found by walking up from the card number, tier-1 context picks, combined only when tier 1 finds no part, and a nearest-partner tier 2. A field naming both parts is never a single-part pick.
- **C2** dropped the epoch guard and the `[]` returns; they belong to #885. The version, the generation and the menu lock re-check remain.
- **FR3** formats a two-digit year (R3-T7).

## Functionality Findings
- **R3-F1 [Major]**: one field was assigned both roles. **Resolved:** no element can hold two roles, and `cc-exp` + `MM / YY` is combined (fixture).
- **R3-F2 [Major]**: a date-of-birth field in the same form beat the expiry field. **Resolved:** the ancestor scope and the tier order. EN and JA same-form fixtures pass in the prototype.
- **R3-F3 [Minor]**: `yr` token. **Resolved:** the delimiter-aware `yr` (`expiry_yr`). camelCase `expYr` is in SC3.
- **R3-F4 [Minor]**: partial autocomplete. **Resolved:** an autocomplete-decided role is that role's tier-1 pick.

## Security Findings
- **F-S9 [Major]**: hidden-field exfiltration. **Moved to #884**, by the user's decision to split.
- **F-S10 [Major]**, **F-S11 [Minor]**: page-wide new tokens, and another form's fields in the region. **Resolved:** the scope admits only same-form-or-no-form fields. Tokens count only with expiry context in tier 1, and as the nearest partner in tier 2. Fixtures cover both.
- **F-S12 [Minor]**, **F-S13 [Minor]**: login-save decrypting after lock, and `[]` read as "no entries". **Moved to #885** (members A11, A16).

## Testing Findings
- **R3-T1 [Major]**: the `exp_mmyy` fixture. **Resolved:** expected "none", recorded in SC3.
- **R3-T2 [Major]**: the not-claimed fixtures were blind to removing the scope. **Resolved:** a `Birth month` fixture, assertions on format and element identity, and a form-less fixture with a CVC neighbour.
- **R3-T3 [Major]**: epoch test timing. **Moved to #885** together with the epoch.
- **R3-T4 [Major]**: release timings. **Resolved:** written into C2 acceptance items 3 and 5.
- **R3-T5 [Minor]**: the epoch observation. **Moved to #885.**
- **R3-T6 [Minor]**: the `teamId` harness. **Resolved:** `team-entries.test.ts`.
- **R3-T7 [Minor]**: YY value. **Resolved:** FR3 writes two digits.

## Recurring Issue Check (round 3)
### Functionality expert
R1, R2 Checked · R29 Checked (node simulation of the decision) · R42 R3-F2 · others N/A/Checked
### Security expert
R2, R10, R29, R35, R48, R51 OK · R3 F-S12 · R34 F-S9 · R38 F-S12, F-S13 · R39 F-S12 · R43 F-S10, F-S11 · R49 F-S9 · R42 cache consumers and fill admission recomputed · others n/a; RS3, RS4 OK
### Testing expert
R29 R3-T1 · R39 R3-T3 · R43 R3-T2 · R50 R3-T1 · others OK/n/a; RT2 R3-T6 · RT4 R3-T4 · RT7 R3-T1..T5 · RT8 R3-T3 · RT10 R3-T2 · others OK/n/a

---

# Round 4
Date: 2026-10-12

## Changes from Previous Round
C1 was replaced by prototype v2 (`scratchpad/c1proto2`):
- Picks come only from fields in the card number's own form, ranked by proximity, instead of an ancestor-scope walk.
- When only one part is found, a missing partner with no context must be the immediate neighbour.

The prototype passes 44 fixtures and the existing content suite (456). Six mutations were executed, and each turns at least one named fixture red. C2 gains R4-F5.

## Functionality Findings
- **R4-F1 [Major]**: a depth tie went to a DOB earlier in document order. **Resolved:** the immediate-neighbour rule; fixtures A2 and its select variant.
- **R4-F2 [Major]**: the scope cut off a year in the next row. **Resolved:** tier 1 is proximity-ranked across the whole form; fixture C.
- **R4-F3 [Minor]**: the autocomplete anchor. **Resolved:** fixture Q.
- **R4-F4 [Minor]**: an earlier coupon expiry won the combined field. **Resolved:** combined is proximity-ranked; fixture P.
- **R4-F5 [Minor]**: a stale host after a lock abandon. **Resolved:** the host is nulled on that branch.

## Security Findings
- **F-S14 [Major]**: the tier-2 loose partner claimed same-form Birth month/year fields. **Resolved:** the immediate-neighbour rule; probes P3 and P4. Mutation M5 turns them red.
- **F-S15 [Minor]**: the prototype was wider than FR1. **Resolved:** a strict form filter (`el.form === cardNumber.form`); probes P1 and P2 (M1). P5 (form-less SPA, same as today) is recorded in SC3.

## Testing Findings
- **R4-T1 [Major]**: nothing pinned the scope walk. **Superseded:** the walk is gone, and its job is now done by proximity. The R4-T1 fixture is added and pins proximity (M2). The `Birth month` annotation is corrected to F-S10.
- **R4-T2 [Major]**: nothing pinned the tier-2 exclusion. **Resolved:** the R4-T2 fixture, under the v2 adjacency rule. It expects month only, and M4 turns it red.
- **R4-T3 [Minor]**: the red-proof table. **Resolved:** M1–M7, each with a named catching fixture.

## Recurring Issue Check (round 4)
### Functionality expert
R1, R2 Checked · R29 Checked (six break fixtures run) · R42 R4-F1 · others N/A/Checked
### Security expert
R2, R10, R35, R38, R39, R42, R48, R51 OK · R29, R49 F-S15 · R43 F-S14 · R3/R34 moved to #884/#885 · others n/a; RS3, RS4 OK
### Testing expert
R29 R4-T1 · R43 R4-T1, R4-T2 · R50 OK (mutations executed) · others OK/n/a; RT7 R4-T1..T3 · others OK/n/a

---

# Round 5
Date: 2026-10-12

## Changes from Previous Round
C1 prototype v3 has three changes:
- **Tier-2 neighbours:** the partner can sit on either side, tried in the usual order (date fields put the month before the year).
- **Anchors:** an anchor outside the form gets no partner.
- **Non-card dates:** hints that name a non-card date subject are excluded when matching by token.
- **Pair vs. combined:** a month/year pair is compared with the combined candidate by proximity.

The prototype now passes 59 fixtures and the existing content suite (456). There are 14 mutations: M1–M6 and M8–M14 were executed, and every one turns at least one named fixture red. M7 (two-digit year) needs the fill code, which Phase 2 adds. C2 and C3 are unchanged; no findings for them this round.

## Functionality Findings
- **R5-F1 [Major]** The one-sided neighbour rule lost the month in JA year-first layouts. **Resolved:** both sides, usual side first. Fixture added; M11 pins the order.
- **R5-F2 [Major]** A passport month/year pair beat a nearer combined card expiry. **Resolved:** the pair is compared with the combined candidate by proximity. Fixtures cover flat markup and fieldsets; M14 pins the comparison.
- **R5-F3 [Minor]** Strict same-form pool drops form-less expiry fields next to a card that is inside a form. **Accepted as a deliberate narrowing** (SC3).
  - **Anti-Deferral:** admitting form-less fields would re-open P1/P2, where a form-less 誕生月 or passport field gets claimed. Both today's code and v2-with-form-less make those claims; the security review ranked them higher.
  - **Cost:** the expiry stays empty on markup where the `<form>` wraps only the card number. That is uncommon, and the user can type the date.
  - **Pin:** the R5-F3 fixture.

## Security Findings
- **F-S16 [Major]** An anchor outside the form fell back to index −1 and took the card form's first field. **Resolved:** no partner for such an anchor. Fixtures F-S16 and F-S16b; M13.
- **F-S17 [Minor]** Token matches had no exclusion for non-card subjects. **Resolved:** `NON_CARD_DATE_RE` applies to token matches only; strict matches are unchanged. Fixtures Q3 and Q4c; M12.

## Testing Findings
- **R5-T1 to R5-T6** These rules were not pinned: document-order sort, tier-3 exclusion, the depth key, input-only combined, side preference, the distance key. **Resolved:** each has a fixture, and each mutation is executed (M9, M8, M2a, M10, M11, M2b).
- **R5-T5** The plan did not state the side rule. **Resolved:** stated in the C1 invariant.
- **R5-T7 [Minor]** The `YYYY` allow-side fill case was missing. **Resolved:** added to the fill acceptance.

## Recurring Issue Check (round 5)
### Functionality expert
R1, R2 Checked · R29 Checked (10 extra fixtures; results compared with today's code) · R42 R5-F2 · others N/A/Checked
### Security expert
R2, R10, R29, R35, R38, R39, R42, R48, R49, R51 OK · R43 F-S16, F-S17 · others n/a; RS3, RS4 OK
### Testing expert
R29 R5-T5 · R43 R5-T2, R5-T3 · R50 OK · others OK/n/a; RT7 R5-T1..T6 · RT10 R5-T7 · others OK/n/a

---

# Round 6 and Phase 1 exit
Date: 2026-10-12

## Round 6 Findings
- **F-S18 [Minor, security]**: the `NON_CARD_DATE_RE` subject list was open-ended. **Resolved:** an expiry-vocabulary allow-list for token matches (prototype v4), Q7/Q8/Q9/Q12 fixtures, and M12.
- **R6-F1 [Major, functionality]**: the vocabulary gate split decorated or namespaced combined fields. **Resolved:** the other-part test uses the raw token (prototype v5), four fixtures, and M15.
- **R6-F2 [Minor, functionality]**: namespaced or decorated split fields stayed combined. **Resolved:** the last bracket segment plus neutral decoration words, two fixtures, and M16/M17.
- **Testing expert round 6**: stopped before reporting, after the user decided to proceed (below).

Prototype v5 passes 69 fixtures and the existing content suite (456). M1–M17 except M7 were executed, and each turns its named fixtures red.

## Exit decision
Phase 1 exits on the user's instruction. The user asked to stop polishing the plan and implement, because implementation surfaces facts faster. The state at exit:
- **C2 and C3**: no findings since round 3. Both are locked.
- **C1**:
  - Every design finding since round 3 was found by running the prototype. Each fix was also validated by running it (fixture plus mutation), not by plan prose. Further plan rounds would review the previous round's prose; the implementation and Phase 3 review the real code.
  - No Critical is open. The round-6 Majors are resolved in the prototype.
- **Carried forward**: the testing expert's unfinished round-6 review of v3 to v5. Phase 3's testing review covers it on the real code.
