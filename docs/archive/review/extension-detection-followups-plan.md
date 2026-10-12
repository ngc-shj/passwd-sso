# Plan: extension-detection-followups

PR 1 of 3, as the user decided after round 3. It covers #883 (split expiry read as combined, plus the region rule for expiry picks), #881 (stale context menu on the same host), and #875 (the inline CC / identity detectors miss reveals made by an attribute change alone). The other two PRs:

- **#884**: hidden-field autofill (fill-time visibility on every path).
- **#885**: lock-spanning background operations (vault epoch).

Finding IDs refer to `extension-detection-followups-review.md`.

## Project context

- **Type:** `mixed`. A Manifest V3 browser extension (`extension/`, CRXJS + Vite + TypeScript) inside the web-app repo. Only `extension/` changes.
- **Test infrastructure:** `unit tests only` (vitest + jsdom), run in CI. There is no extension E2E.
  - `extension/tsconfig.json` excludes `src/__tests__`.
  - jsdom has no `CSS.escape`, so `getHintString` skips `<label for>` text in tests; fixtures wrap the input in its `<label>`.
- **Verification environment constraints:**
  - **VE1:** real-browser behaviour needs the installed extension: fill into expiry inputs, the rendered Chrome context menu, and the dropdown on a field revealed by an attribute change.
    - Status: manual and `blocked-deferred` to the user.
    - Setup: tailscale-served scratch pages, as for #880 / #882, on a port other than 8443-8445.
    - Cost-justification: jsdom has no layout and `chrome.contextMenus` is mocked. Unit tests pin the logic; VE1 pins the integration.

## Objective

- **#883:** expiry is filled into the right fields.
  - Split expiry inputs (`Expiry month`/`Expiry year`, `expiry_mm`/`expiry_yy`, an `Expiry date` label over `[MM]` and `[YY]`, 有効期限（月）/（年）) get month and year separately.
  - Combined fields still get `MM/YY`.
  - No expiry value is taken from outside the card's own scope, or from a date-of-birth or other date field that shares the card's form.
- **#881:** the context menu reflects the entry cache after the cache changes, without a host change.
- **#875:** a CC or identity field revealed by an attribute change alone gets the inline dropdown on focus.

## Requirements

- **FR1 (#883):** expiry roles are chosen only from usable fields owned by the card number's form (`el.form === cardNumber.form`, which means form-less fields for a form-less card number) (F-S15). Picks are ranked by **proximity**, not by first match:
  1. deepest common ancestor with the reference field;
  2. then following before preceding;
  3. then document-order distance.
- **FR2 (#883):** the steps run in order:
  1. **Tier 1:** the context single-part month and the context single-part year nearest the card number. If both are found, the expiry is split. Exception: when neither part came from autocomplete, a combined candidate nearer the card number than the nearer member of the pair wins instead (R5-F2).
  2. **Combined:** used when tier 1 found neither part. The context **input** nearest the card number that names both parts or neither.
  3. **Tier 2:** when exactly one part was found, the missing part is a field **immediately beside** it in document order. The usual side is tried first: after a month, before a year. Then the other side (R5-F1). A neighbour counts only if it loosely names only the missing part. An anchor outside the card number's form has no neighbour (F-S16). Otherwise the part stays empty (R4-F1, F-S14).
  4. **Tier 3:** when nothing was found, today's strict patterns pick the nearest single-part field for each part.

  A field naming both parts (生年月日, `YYYY/MM/DD`) is never a single-part pick, and no element takes two roles.
- **FR3 (#883):** a year written into an input that asks for two digits (`maxLength === 2`, or a `yy` hint without `yyyy`) gets the last two digits (R3-T7).
- **FR4 (#881):** a change to the menu-relevant content of the entry cache rebuilds the context menu for the active tab, even on the same host.
- **FR5 (#881):** a rebuild never causes a further rebuild by itself, and a rebuild superseded midway never leaves a partial menu.
- **FR6 (#881):** no menu entry item is created once the vault is locked, including by a rebuild that was in flight at lock time. This applies to the menu sink only; the class is covered in #885.
- **FR7 (#875):** the CC and identity detectors rescan after attribute-only mutations whose target is an input/select, or contains one.
- **NF1 (#875):** attribute-only batches arm at most one trailing rescan per `ATTR_RESCAN_DELAY_MS` (100 ms) per detector. The timer is not re-armed while armed. Focus-driven and childList rescans are not rate-bounded: a page can trigger them programmatically, but the cost stays in its own tab.
- **NF2 (#875):** focusing a member field never scans.

## Technical approach

### #883: proximity-ranked, tiered expiry picks (prototype-validated)

The scratch prototype `scratchpad/c1proto2` (v3) passes:

- 69 fixtures: the round-3 set, the reviewers' break and probe fixtures, the R4/R5 pinning fixtures, the F-S18 probes and the R6-F1/F2 cases;
- the existing content suite (456 tests);
- the mutation table under Testing strategy, where every mutation turns a named fixture red.

All of this lives in `detectCreditCardFields`, the single adjudicator.

- **Autocomplete keeps priority.** The regex step runs only when `cc-exp` did not decide the format and the month and year are not both decided.
- **An autocomplete month or year** is that role's tier-1 pick and the tier-2 anchor (R3-F4, R4-F3).

- **Patterns (module-private in `cc-field-detection-lib.ts`):**
  - `MONTH_TOKEN = /(?:^|[^a-z0-9])(?:month|mm)(?![a-z0-9])/`.
  - `YEAR_TOKEN = /(?:^|[^a-z0-9])(?:years?|yy|yyyy|yr)(?![a-z0-9])/`.
  - Both are delimiter-aware, because `_` is a word character.
  - `CC_DETECT_RE` and `CARD_NEIGHBOUR_PATTERNS` are unchanged, so the direct-autofill twin's inputs are unchanged.
- **Predicates:**
  - `strict(h, part)` = `CC_DETECT_RE.expiry<Part>` or the JA 月 / 年 pattern (today's patterns).
  - `context(h)` = `CC_EXPIRY_RE`, or `CC_EXPIRY_JA_RE`, or `/cc.?exp/`, or a strict EN month or year match.
  - `names(h, part)` = `strict`, or (token and `context`).
  - `loose(h, part)` = `strict`, or the token.
  - **Token vocabulary (F-S17, F-S18):** a bare month/year token counts only when the hint consists of expiry vocabulary. Every word longer than two characters with no digits must be in `exp expiry expire expires expiration card valid thru date month year years yyyy`. After removing 有効期限 / 月 / 年 / brackets, the hint must contain no other CJK text.
    - This is an allow-list, not a list of excluded subjects, so any dated field about something else is out: birth, passport, arrival, check-in, start, graduation...
    - Short words and words with digits are neutral (`ey`, `y2`, `2025`).
    - Strict patterns are exempt, so everything today's patterns claim is unchanged.
    - **Decoration words** (`required optional please enter select your the`) are neutral too. A bracketed name (`order[payment][expiry_mm]`) is judged by its last segment (R6-F2).
  - **Other-part test uses the raw token (R6-F1):** `raw(h, part)` = `strict` or the token, without the vocabulary gate. "Single-part for P" excludes any field whose `raw` names the other part. A combined candidate needs `raw(month) === raw(year)`. As a result, a decorated or namespaced combined field (`Expiry month/year (required)`, `checkout[card_expiry]`) stays combined. The vocabulary gate applies only to *claiming* a single part.
- **Pool:** the card number's form fields, sorted into document order with `compareDocumentPosition`. `visibleFields` lists inputs before selects, so its order is not document order.
- **Tiers:** as in FR2. "Single-part for P" means the field names P (by `names` in tier 1, by `loose` in tier 2, by `strict` in tier 3) and does not name the other part.
- **Year formatting:** `writeExpiryPart` writes `year.slice(-2)` into an input that wants two digits (FR3). Selects keep `normalizeYearValue`.

### #881: versioned cache and generation-safe menu rebuilds

- **`background/index.ts`:**
  - One writer, `setCachedEntries(entries: DecryptedEntry[] | null): number`. Before overwriting, it compares the incoming entries with the current `cachedEntries` over the menu view: `id`, `teamId`, `entryType`, `title`, `username`, `urlHost`, `additionalUrlHosts`. No copy is kept. When the value is null or the view changed, it increments `cacheVersion` and calls `refreshContextMenu()`. It returns the version.
  - `getCachedSnapshot(): Promise<{ entries; version }>` returns the entries together with the version they were stored under.
  - `getCachedEntries()` returns `(await getCachedSnapshot()).entries`.
  - `FETCH_PASSWORDS` and `invalidateCache` write through `setCachedEntries`.
  - No epoch is added here; that is #885.
- **`background/context-menu.ts`:**
  - **Deps:** `ContextMenuDeps` replaces `getCachedEntries` with `getCachedSnapshot` and adds `getCacheVersion: () => number`.
  - **Same-host skip:** applies only when both the host and the version are unchanged.
  - **After the snapshot resolves:** abandon if the rebuild is no longer current. If the vault is locked, set `lastMenuHost = null` before returning, so the next refresh rebuilds in full (FR6, R4-F5). Otherwise record `lastMenuCacheVersion = snapshot.version`.
  - **Serialized-task wrapper:** sets `lastMenuHost = null` when a task ends while no longer current. Tasks are serialized, so the next task has not started yet.
  - **`refreshContextMenu()` (new):** rebuilds for the active tab through the debounce, without clearing the host.
  - **`invalidateContextMenu()`:**
    - claims `nextGeneration()` synchronously (F-S2);
    - clears `lastMenuHost`;
    - then calls `refreshContextMenu()`.

### #875: filtered, rate-bounded attribute rescan

- **`OBSERVED_ATTRIBUTES` (`fill-sequence-lib.ts`):** gains `type` and is exported.
  - `open` is not needed here: `isElementVisible` reads only the field's own style, so fields inside a closed `<dialog>` are already members.
  - #884 records that an ancestor-aware rule would need `open`.
- **`content/rescan-scheduler.ts` (new, leaf module):** `createRescanScheduler(rescan, { delayMs, recentMs })` provides:
  - `runNow()`;
  - `noteAttributeChange()`, which arms the timer if it is not armed and stamps `Date.now()`;
  - `flushForFocus(): boolean`, which runs if a rescan is pending, or if a change was noted within `recentMs` (`ATTR_RECENT_MS` = 1000);
  - `cancel()`.
- **CC and identity detectors:**
  - **Observer:** observes `childList`, `subtree`, `attributes`, `attributeFilter: [...OBSERVED_ATTRIBUTES]`.
  - **Added nodes:** `runNow()`.
  - **Attribute-only batch** whose target is, or contains, an input/select: `noteAttributeChange()`.
  - **Focus on a non-member:** drain `observer.takeRecords()` through the same handler, then call `flushForFocus()`, then re-check.
  - **`destroy()`:** `cancel()`.

## Contracts

### C1: proximity-ranked, tiered expiry picks (#883)

- **Signature:** unchanged, `detectCreditCardFields(root: ParentNode): CreditCardFormFields | null`.
- **Invariants (app-enforced):**
  - No expiry role comes from a field owned by another form. When the card number is in a form, no role comes from a form-less field either.
  - No element takes two roles.
  - A field naming both parts is never a single-part pick.
  - A partner without context is only an immediate neighbour. The usual side is tried first, and the anchor must be inside the pool.
  - A token counts only on a hint made of expiry vocabulary.
  - A combined candidate must be an input.
  - A combined field is chosen only when tier 1 found neither part.
  - The CVV step, `cardBlock`, LOGIN eligibility and `CC_DETECT_RE` are unchanged.
- **Member set (R42):**
  - `grep -rn "CC_EXPIRY_RE\|CC_EXPIRY_MONTH_JA_RE\|CC_EXPIRY_YEAR_JA_RE\|CC_DETECT_RE.expiry" extension/src --include='*.ts' | grep -v __tests__` → `cc-field-detection-lib.ts` (the expiry steps) and `cc-patterns.ts` (definitions and `CARD_NEIGHBOUR_PATTERNS`).
  - Format consumers: `grep -rln "expiryCombined\|expiryFormat" extension/src --include='*.ts' | grep -v __tests__` → `cc-field-detection-lib.ts` and `autofill-cc-lib.ts`.
- **Control class:** `best-effort tripwire`. Gaps are listed in SC3.
- **Forbidden pattern:** `findFieldByRegex\(visibleFields, CC_(EXPIRY_RE|DETECT_RE\.expiry)`. A first match ignores both the form and proximity.
- **Acceptance.** The 69 prototype fixtures, ported verbatim from `scratchpad/c1proto2/src/__tests__/proto/c1.test.ts`. They run through the regex path, and each fixture label wraps its input. The groups below list representative cases. Round-5 additions:
  - JA with year before month: split (R5-F1).
  - A passport month/year after a combined card expiry, flat and in fieldsets: combined (R5-F2).
  - An autocomplete month outside the form: no year partner (F-S16, F-S16b).
  - `Passport expiry (MM)` and `Birth year` beside the month: not claimed (F-S17).
  - `Arrival month`, `Graduation year`, `Check-in year` and `Start month` next to an unlabelled partner: not claimed (F-S18).
  - Decorated or namespaced combined fields stay combined. Bracketed and decorated split fields are split (R6-F1, R6-F2).
  - The pinning fixtures R5-T1 to R5-T6.
  - Expiry outside a form that wraps only the card number: none (R5-F3, SC3).
  - **Split:**
    - `Expiry month`/`Expiry year`
    - `expiry_mm`/`expiry_yy`
    - `Expiry date` label over `[MM]`, with `[YY]` beside it
    - 有効期限（月）/（年） inputs
    - selects labelled 月 / 年, in a form, and in a `<div>` checkout with a CVC neighbour
    - `cc_month`/`cc_year`
    - an `Expiry month`/`Expiry year` pair followed by a later `Expiration date`
    - an `Expiry month` select with an `expiry_yr` input
    - the year in the next row (R4-F2)
    - an autocomplete month followed by `[YY]` (R4-F3)
    - a DOB year before `Expiry month` + `[YY]`, as an input and as a select (R4-F1)
  - **Combined:**
    - `expiry` with `MM/YY`
    - `expire` with `MM/YY`
    - `Expiry month/year`
    - `Expiration date`
    - 有効期限（月/年）
    - `Expiry date (MM/YY)` with placeholder `2025年`
    - `cc-exp` with `MM / YY` and no autocomplete
    - a card-row `Expiry` with `MM/YY`
    - the card's `Expiry date` beats an earlier coupon expiry (R4-F4)
  - **Partial / none:**
    - `exp_mmyy` → none
    - `expMonth` / `expYr` → month only (SC3)
    - `Expiry month` + an unlabelled year → month only (P3)
    - an unlabelled month + `Expiry year` → year only (P4)
    - `Expiry month` beside a `YYYY/MM/DD` field → month only (R4-T2)
  - **Not claimed** (each with a card-side control that asserts format and element identity):
    - `Passport expiry` in a separate form before a `cc_month`/`cc_year` card form
    - `Passport expiry` in the same flat form as that card form
    - `Birth month` in a separate form before that card form (guards against tokens being applied page-wide; F-S10)
    - 生年月日 in a separate form before a 有効期限（月）/（年） card form
    - 生年月日 in the same flat form as that card form
    - EN `Birth month`/`Birth year` selects in the same form as an `Expiry date` input, which stays combined
    - JA 生年月日 年/月 selects in a separate fieldset, and in the same flat form, as `card_exp` `mm/yy`, which stays combined
    - `delivery_date` `YYYY/MM/DD` before `Expiry month`/`Expiry year` selects, which stay split
    - a form-less card number in a wrapper that also holds another form's 月/年 selects: none claimed
    - a form-less lone card number with `Month`/`Year` selects and an earlier `birth_month`: none claimed
    - JA DOB fieldset vs. a card fieldset, both with context-free 月/年 selects: the card's selects are picked (R4-T1)
    - a form-less 誕生月 or passport field outside a card form: not claimed (P1, P2)
  - **Fill:**
    - Split forms get `"02"` and `"2030"`.
    - A `[YY]` input, or one with `maxLength=2`, gets `"30"`. A `placeholder="YYYY"` input gets `"2030"`, the allow side of M7 (R5-T7).
    - The `expire` `MM/YY` form gets `"02/30"`.

### C2: versioned cache and generation-safe menu rebuild (#881)

- **Signatures:**
  - `setCachedEntries(entries: DecryptedEntry[] | null): number` (module-private)
  - `getCachedSnapshot(): Promise<{ entries: DecryptedEntry[]; version: number }>`
  - `ContextMenuDeps.getCachedSnapshot`
  - `ContextMenuDeps.getCacheVersion: () => number`
  - `export function refreshContextMenu(): void`
- **Invariants (app-enforced):**
  - Every write to `cachedEntries` goes through `setCachedEntries`. Member set: `grep -n "cachedEntries = " extension/src/background/*.ts` → `invalidateCache`, `getCachedEntries`, `FETCH_PASSWORDS`.
  - The menu records the version of the entries it built from.
  - A task that ends non-current leaves `lastMenuHost` null.
  - No entry item is created after the vault is seen locked.
- **Control class:** `fail-closed verification gate` for the post-snapshot lock re-check and the synchronous generation claim (menu sink only; other sinks are #885). The rest is UI freshness.
- **Forbidden pattern:** `^\s*cachedEntries =` — a write outside `setCachedEntries` skips the version. Allowed only inside it.
- **Consumer walkthrough:**
  - `doUpdateMenu` reads `getCacheVersion()` before the skip and `{ entries, version }` after it.
  - `updateBadgeForTab` reads the variable directly and writes nothing.
  - The remaining `getCachedEntries()` callers get an array, as before.
- **Acceptance:**
  1. A version bump on the same host rebuilds the menu, and the new entry is present. Paired with: the same version does not rebuild.
  2. A rebuild whose snapshot bumps the version and synchronously calls `refreshContextMenu()` makes exactly one `removeAll` (fake timers, advance ≥ 2×`DEBOUNCE_MS`).
  3. **Superseded build (R2-T3, R3-T4):**
     - Setup: the build waits on a gated snapshot after recording the host; `refreshContextMenu()` is called on the same host with an unchanged version; the gate is released only after ≥ `DEBOUNCE_MS`.
     - Result: after the last `removeAll`, the creates include the parent, the entry items and `psso-open-popup`.
  4. **Lock re-check in isolation:** `isVaultUnlocked` flips to false while the snapshot is gated, without `invalidateContextMenu`. No entry-id create is made.
  5. **Generation claim in isolation (R3-T4):**
     - Setup: the old snapshot holds X and the new one holds Y; `invalidateContextMenu()` is called while the vault stays unlocked; the gate is released before `DEBOUNCE_MS`, or `tabs.query` resolves to `[]`.
     - Result: no X id is created.
  6. **Snapshot version recorded:** the snapshot resolves `{version: 1}` while `getCacheVersion()` returns 2. A following refresh on the same host rebuilds.
  7. **Refetch content (background.test.ts):**
     - Identical `FETCH_PASSWORDS` responses cause no `removeAll` after the mocks are cleared.
     - A change to one menu-view field rebuilds, parametrized over `id`, `entryType`, `title`, `username`, `urlHost`, `additionalUrlHosts`.
     - `teamId` is covered in `background/team-entries.test.ts`, which has the team harness (R3-T6).
  8. `FETCH_PASSWORDS` with a new entry creates that entry's item, after the UNLOCK cascade settles and the mocks are cleared.
  9. `invalidateCache` through login-save schedules a rebuild (not the lock path).

### C3: filtered, rate-bounded attribute rescan (#875)

- **Signatures:**
  - `export const OBSERVED_ATTRIBUTES: readonly string[]` (adds `type`)
  - `export const ATTR_RESCAN_DELAY_MS = 100`
  - `export const ATTR_RECENT_MS = 1000`
  - `export type RescanScheduler = { runNow(): void; noteAttributeChange(): void; flushForFocus(): boolean; cancel(): void }`
  - `export function createRescanScheduler(rescan: () => void, opts: { delayMs: number; recentMs: number }): RescanScheduler`
- **Invariants (app-enforced):** NF1 and NF2. Member set: `grep -ln "new MutationObserver" extension/src/content/*.ts` returns four files.
  - **Members:** `cc-form-detector-lib.ts` and `identity-form-detector-lib.ts`.
  - **`fill-sequence-lib.ts`:** already observes attributes and gains `type`.
  - **`form-detector-lib.ts`:** excluded, because the LOGIN trigger is decided at focus and `trackedInputs` is never read.
- **Control class:** not a control (display only). The visual-safety gates in `requestMatches` run after any flush.
- **Forbidden pattern:** `observe\(document\.body, \{ childList: true, subtree: true \}\)` in the two member files.
- **Acceptance:**
  - **Reveal:** parametrized over `hidden`, `style="display:none"`, a `class` with a `<style>` rule, `disabled`, `readonly`, and `type="hidden"`, each set on the field itself. Before the reveal, focus makes 0 requests. After the reveal and the delay, focus makes 1.
  - **Reveal, then focus after one microtask but before the delay:** 1 request.
  - **Same task, field hidden in the initial markup, no earlier attribute change:** reveal plus `.focus()` gives 1 request.
  - **Focus matrix:**
    - member with a rescan pending: 0 scans, and the timer stays armed;
    - non-member with a rescan pending: 1 scan;
    - non-member with nothing pending or recent: 0 scans;
    - non-member within `ATTR_RECENT_MS` after the timer fired: 1 scan.
  - **Rate:**
    - mutations spread over microtasks in one window give exactly 1 scan (as a delta after init);
    - two windows give 2;
    - one mutation every 50 ms for 500 ms gives at least 4;
    - 99 ms gives 0 scans, and 1 ms more gives 1.
  - **Filter:** a `class` mutation on an element containing no input makes 0 scans. Paired with: the same mutation on a form container makes 1 scan.
  - **Destroy:** 1 timer before `destroy()`, 0 after.

## Testing strategy

- **C1:**
  - Detection fixtures go in `cc-form-detector.test.ts`, as a table.
  - Fill cases go in `autofill-cc.test.ts`.
  - **Red-proofs.** Each mutation is caught by at least one named fixture (R4-T3, R5-T*). M1–M17 except M7 were executed on the prototype, and every one turned its listed fixtures red. Phase 2 re-runs them against the real code.

    | Mutation | Catching fixture(s) |
    |---|---|
    | M1: drop the form filter | P1, P2, the other form inside the wrapper, R5-F3 |
    | M2: drop proximity entirely | R4-T1, coupon, flat passport, R5-T6 |
    | M2a: drop the depth key only | R5-T3 |
    | M2b: invert the distance key | later `Expiration date`, R5-F2, R5-T6 |
    | M3: drop the both-parts exclusion | every combined case, JA DOB + `card_exp`, R5-F2, R5-T2 |
    | M4: drop the exclusion in tier 2 only | R4-T2 |
    | M5: replace adjacency with the nearest loose field | R4-T2 |
    | M6: combined always first | later `Expiration date`, flat passport |
    | M7: drop the two-digit year | `[YY]` fill (allow side: `YYYY`) |
    | M8: drop the exclusion in tier 3 only | R5-T2 |
    | M9: drop the document-order sort | R4-T2, R5-T1 |
    | M10: allow a combined select | R5-T4, F-S17 Q4c |
    | M11: swap the side preference | R5-T1b, R5-T5 |
    | M12: drop the expiry-vocabulary check | F-S17 Q3, Q4c, F-S18 Q7, Q8, Q9, Q12 |
    | M13: anchor outside the pool falls back to index −1 | F-S16b |
    | M14: drop the pair-vs-combined comparison | R5-F2 (flat and fieldsets) |
    | M15: use the gated token for the other-part test | R6-F1 billing prefix |
    | M16: drop the bracket-segment rule | R6-F2 bracketed split |
    | M17: drop the decoration words | R6-F2 `Expiry date (required)` `[MM][YY]` |
- **C2:**
  - **`context-menu.test.ts`:**
    - Every `getCachedEntries` override and assertion moves to `getCachedSnapshot`. Gate: `grep -n "getCachedEntries" extension/src/__tests__/context-menu.test.ts` returns nothing (R2-T1).
    - `createDeps` gains the two new deps.
    - The "runs both rebuilds to completion" test is re-asserted for the abandoned first build.
    - Timers are faked with `advanceTimersByTimeAsync`. `afterEach` restores real timers and disables the menu.
  - **`background.test.ts` / `background/team-entries.test.ts`:** acceptance items 7–9.
  - **Red-proof:** each item, by removing its guard or call.
- **C3:**
  - Scheduler units in `rescan-scheduler.test.ts`.
  - Detector lifecycle tests in `cc-identity-detector.test.ts`:
    - fake `setTimeout`, `clearTimeout` and `Date` only;
    - a `ccClaimedFields` `vi.fn(real)` partial mock;
    - one live detector per count test;
    - an `afterEach` destroy registry.
  - **Red-proof:** remove the attribute options, the filter, `takeRecords`, the recent window, and `cancel`.
- **Full run:**
  - `cd extension && npx vitest run`, twice;
  - `npx tsc --noEmit -p .`;
  - `npm run build`;
  - `scripts/pre-pr.sh`.

## Considerations & constraints

### Scope contract

- **SC1:** `form-detector-lib.ts`'s observer and `trackedInputs` are dead code. Cleanup is a future issue.
- **SC2:** these reveals produce no mutation on an input or its container, so they are not observed:
  - `<html>`-level class changes;
  - Popover API;
  - pure CSS;
  - sibling combinators and `:has()` driven from another subtree.

  No owner is filed. This is the same class as the fill path's `WAITING_POLL_MS`.
- **SC3:** expiry heuristic gaps. No owner is filed; best effort.
  - camelCase names lose their boundary when lowercased (`expYr`);
  - fused tokens (`exp_mmyy`);
  - a partner without context that is not the immediate neighbour stays empty (P3/P4, as today);
  - a form-less card number shares the page's form-less fields, so an unrelated form-less expiry can still win (P5, as today);
  - **deliberate narrowing (R5-F3):** expiry fields outside a `<form>` that wraps only the card number are no longer claimed. Today's code claims them, so this is a regression on that uncommon markup. It is accepted because admitting form-less fields next to a card in a form would bring back the P1/P2 claims (a form-less 誕生月 / passport field), which the security review ranked higher. The R5-F3 fixture pins the narrowing;
  - inside one flat form, a context-free `誕生月` can be tier 3's nearest pick when the card's own month/year fields have no context and sit farther away.
- **SC4:** **#884**: hidden-field autofill, covering every fill path.
- **SC5:** **#885**: lock-spanning background operations, including the cache write, inline matches, `FETCH_PASSWORDS`, login-save, passkey and unlock. In this PR, FR6 covers only the context-menu sink.

## User operation scenarios

- A checkout with `Expiry month`/`Expiry year`, or `expiry_mm`/`expiry_yy`, gets `02` / `2030`. `[MM]`/`[YY]` gets `02` / `30`.
- A Japanese checkout has registration with 生年月日 and payment with 有効期限（月）/（年）, or with `card_exp` `mm/yy`. The birth date is untouched.
- A passport form sits before a `cc_month`/`cc_year` card form. The passport field is untouched.
- A new LOGIN entry is created in the web app while a tab is open, and the popup is opened and closed. A right-click shows the new entry.
- The user locks during a menu rebuild. The menu shows only the locked item.
- An SPA un-hides the card number and focuses it in the same task. The CC dropdown appears.
- A carousel that animates style or class with no inputs causes no rescans.

## Go/No-Go Gate

| ID  | Subject                                                 | Status  |
|-----|---------------------------------------------------------|---------|
| C1  | proximity-ranked, tiered expiry picks                   | locked  |
| C2  | versioned cache + generation-safe menu rebuild          | locked  |
| C3  | filtered, rate-bounded attribute rescan                 | locked  |

## Carried-Forward Plan Findings

- **TR6 (testing expert, round 6, not delivered).** The review of prototype v3 to v5 was stopped when the user chose to proceed to implementation (review artifact, "Round 6 and Phase 1 exit").
  - **Anti-Deferral:** this is not a skip. The same review runs in Phase 3 against the real code, with the M1–M17 mutation table re-executed there.
  - **Settled by:** Phase 2 re-running M1–M17 against the real `cc-field-detection-lib.ts`, and Phase 3 finding no testing Major.
