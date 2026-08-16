# Plan: fix-extension-console-warnings

**Revision 3** — incorporates two rounds of review from three expert reviewers each. See
`fix-extension-console-warnings-review.md` for all findings and their dispositions.

Changes in Revision 2 (Round 1): new contract **C5** (credential release host binding — a security
defect Revision 1 did not address); dependency staleness resolved by `npm ci` and the toolchain
re-probed; the R42 member set re-derived to include the wrapper layer; the testing strategy rebuilt
after two of its three load-bearing claims were refuted.

Changes in Revision 3 (Round 2), every one of them a correction to something Revision 2 asserted:

- **C5 rebound from the tab to the frame.** Menu items appear in every frame, so `tab.url` was the
  wrong subject; the repo's own content path rejects that binding by name. C5 now resolves
  `info.frameUrl ?? info.pageUrl ?? tab.url` and threads `info.frameId` through to delivery.
- **C5 now reports denials to the user.** The wrapper discarded `{ ok, error }` and
  `ORIGIN_MISMATCH` is absent from `ERROR_KEY_MAP`, so a denied fill would have been completely
  silent.
- **`PC5.1` added**: the manifest declares no `tabs` permission, so whether `tab.url` is even
  populated on a default install must be probed before C5 locks (R52).
- **C1 invariant 5** now classifies `lastError` instead of hardcoding `"duplicate-id"`, which would
  have collided with the orphan-parent failure invariant 8 itself introduces.
- **AC1.4's expected array derived by execution** (8 elements, `psso-parent` first) — FR4's prose
  said 7.
- **AC6.4's "passes under both settings" removed**: verified false by execution.
- **T6 split across two layers** — the Revision 2 assertions sat above the guard they tested.
- Contracts C1/C2/C3/C6 locked; C5 pending on PC5.1 alone.

## Project context

- **Type**: browser extension (MV3, Chrome/Edge) inside a mixed monorepo (`extension/` subtree of passwd-sso)
- **Test infrastructure**: unit tests (vitest 4.1.10) + CI. Runner config `extension/vitest.config.ts`; `context-menu.test.ts` carries `@vitest-environment jsdom` per-file. Baseline verified on the reconciled toolchain: **59 files, 940 tests, all passing**. No E2E / no real-browser automation.
- **Toolchain (reconciled — see C4)**: `vite@8.2.1`, `@crxjs/vite-plugin@2.7.1`, `vitest@4.1.10`, resolved by `npm ci` from `package-lock.json`. `npm ls` reports zero `invalid`. Every build-output claim below was re-derived against this tree; Revision 1's claims were derived from a stale `node_modules` (vite 6.4.2) and are superseded.
- **Verification environment constraints**:
  - `VC1` — **No automated real-browser harness.** No Puppeteer/Playwright/WebDriver runner loads the unpacked extension. `chrome.contextMenus` duplicate-ID errors surface only as `chrome.runtime.lastError` in a real browser; the test mock has no ID registry and cannot reproduce them. Classification of "no duplicate-ID error in the real browser": **blocked-deferred** (AD1).
  - `VC2` — **modulepreload warnings come from Chrome's preload scanner, not from any JS-observable API.** No unit test can assert their absence; only the built HTML can be asserted. The *build output shape* is `verifiable-CI`; the *absence of the console warning* is **blocked-deferred** (AD2).
  - `VC3` — Chrome and Edge may differ in whether the cross-world preload warning fires. Cross-browser confirmation is manual-only. **blocked-deferred** (AD3).
  - `VC4` — **The credential-release path (C5) cannot be verified end-to-end without a real browser.** A unit test can assert that `handleContextMenuClick` passes the clicked tab's host into `performAutofill`, but not that Chrome actually delivers a stale menu against a navigated tab. Classification: the *host-binding logic* is `verifiable-CI`; the *real stale-menu-then-navigate sequence* is **blocked-deferred** (AD4).

## Objective

Eliminate the 25 observed console warnings by fixing the two defects they report — not by suppressing the messages — and close the credential-misrouting defect that reviewing Problem A surfaced.

Problem A's rebuild race and C5's missing click-time host check are **two halves of one hazard**: the race makes the menu's contents wrong, and the missing check means nothing catches a wrong entry at release time. Fixing only the race would leave the second half open while creating the impression the class was closed. That is why they ship together (user decision, recorded).

## Problem analysis

### Problem A — `Cannot create item with duplicate id psso-*`

Observed colliding IDs: `psso-cc-sep`, `psso-cc-<uuid>`, `psso-id-sep`, `psso-id-<uuid>`, `psso-login-sep`, `psso-open-popup`. Note the shape: **both fixed IDs and per-entry UUID IDs collide**, which rules out "two code paths chose the same constant" and points at one code path running twice concurrently.

> **On warning counts.** Revision 1 partitioned the 25 warnings as "8 + 17". Neither figure is reproducible from the repo, and both were observed against a build produced by the stale toolchain (see C4). The counts are dropped: no contract, invariant, or acceptance criterion depended on them. What is load-bearing and verified is the *composition* — two independent warning families from two independent defects, both confirmed present in the current build.

Root cause, at `extension/src/background/context-menu.ts` (all line numbers verified against the current file):

1. **The serialization primitive does not serialize.** `resetMenuWithParent()` (line 37) intends to be a mutex:

   ```ts
   const run = async () => {
     if (resetInFlight) await resetInFlight;   // reads the guard INSIDE run()
     ...
   };
   resetInFlight = run().finally(...);          // assigns AFTER run() has already started
   ```

   `run()` executes synchronously until its first `await`, so the `if (resetInFlight)` check reads the *previous* value, and line 54 immediately overwrites it. Two callers arriving in the same tick both observe the same prior value and both proceed. The guard is vacuous.

2. **The create calls are fire-and-forget.** `doUpdateMenu()` (line 76) awaits the reset, then issues 12 `chrome.contextMenus.create(...)` calls without awaiting their callbacks (lines 99-216). `doUpdateMenu` resolves while those creates are still in flight in the browser process.

3. **There is an `await` between the host guard and the writes.** Line 93 (`if (host === lastMenuHost) return`) and line 96 (`lastMenuHost = host`) precede `await deps.getCachedEntries()` on line 121. A second invocation with a different host passes the guard, sets `lastMenuHost`, and enters its own create batch while the first is suspended. Both then create the same fixed IDs and the same entry UUIDs — exactly the observed set.

**What makes the race reachable** (corrected — Revision 1 misstated this): `invalidateContextMenu()` (line 278) is **not** undebounced; it calls `updateContextMenuForTab`, which is debounced at line 71. Its actual contribution is that it sets `lastMenuHost = null` **synchronously** at line 279, defeating the same-host early-return at line 93 for any rebuild already in flight. The mechanism is guard-defeat, not debounce-bypass. This matters because "fix it by debouncing `invalidateContextMenu`" would change nothing.

**User-visible impact beyond console noise**: when a create fails with a duplicate ID, that item is missing from the menu. A stale item from the previous host can survive while the new host's item is rejected — the menu then offers credentials for the wrong site, or omits the correct one. C5 addresses what happens when such an item is clicked.

### Problem B — modulepreload `cross-world extension resource mismatch` + `preloaded but not used`

**Re-derived against the reconciled toolchain** (vite 8.2.1 / crxjs 2.7.1), after `rm -rf dist && npm run build`:

```
dist/src/options/index.html:4 modulepreload links
dist/src/popup/index.html:5  modulepreload links
```

Each carries `crossorigin`, as does the entry `<script type="module">`:

```html
<script type="module" crossorigin src="/assets/index.html-DutBQRC5.js"></script>
<link rel="modulepreload" crossorigin href="/assets/i18n-BL3VCp4Q.js">
```

The vite 6 → 8 upgrade changed the chunk split (different chunk names and counts) but **not** the `crossorigin` emission. Problem B is therefore real on the shipping toolchain, not an artifact of the stale tree.

Root cause: Vite emits `crossorigin` because its default assumption is an HTTP-served page where CORS applies. Under `chrome-extension://`, a `crossorigin` (anonymous) fetch lands in a different request world than the module graph's own credentialed fetch, so Chrome's preload cache never matches the preloaded response to the actual request — producing first "cross-world extension resource mismatch", then "preloaded but not used" when the unmatched entry expires. The modules still load correctly via the module graph, so this is **not a functional break**; it is a duplicated fetch per chunk on every popup open.

`extension/vite.config.ts` sets no `build.modulePreload`, so Vite's default (preload links emitted) applies.

## Requirements

### Functional

- **FR1** — No `Cannot create item with duplicate id` error for any interleaving of the menu-mutating entry points.
- **FR2** — The menu's final state is that of the **most recent** request. A superseded in-flight rebuild must neither leave stale-host items behind nor have its own items win over a newer one, **and must not destructively clear a menu a newer request already built**.
- **FR3** — No `modulepreload` warning family appears in the console for any extension HTML page.
- **FR4** — Existing behavior preserved: item ordering (**parent** → logins → cc-sep → credit cards → id-sep → identities → login-sep → open-popup — eight positions, with `psso-parent` first; see AC1.4's executed derivation), the `MAX_ITEMS = 5` cap per section, placeholder items, teamId encoding, and the `enableContextMenu` off-switch. **Exception, deliberate**: the disabled-path orphan-create defect described in C1 invariant 8 is *fixed*, not preserved. FR4 pins current behavior except where a contract names a correction.
- **FR5** *(new)* — A credential is released only to a page whose host matches the entry's host(s). Where the clicked tab's host cannot be determined, the fill is denied.

### Non-functional

- **NFR1** — No suppression as a substitute for a fix: no `void chrome.runtime.lastError` to silence a real collision, no console filter, no try/catch that discards the signal without preventing the cause.
- **NFR2** — No unbounded queue and no lock that can wedge. A rebuild that throws must release the serialization primitive.
- **NFR3** — Bundle behavior unchanged: same chunks, same order, no added runtime waterfall.
- **NFR4** *(new)* — No vault plaintext (entry titles, usernames, decrypted fields) may reach a log sink. `src/background/log.ts`'s closed-union contract is a control, not a style choice, and must not be widened to `string`.

## Technical approach

### Problem A: replace the broken mutex with a generation token + real serialization

1. **Serialize correctly** — chain assigned synchronously at call time, so same-tick callers chain rather than race:

   ```ts
   let menuChain: Promise<void> = Promise.resolve();
   function serializeMenuTask(task: () => Promise<void>): Promise<void> {
     const next = menuChain.then(task, task);   // run regardless of prior rejection
     menuChain = next.catch(() => {});          // a rejection must not poison the chain
     return next;
   }
   ```

   Prior art: `withSigningLock` at `src/background/passkey-provider.ts:78-87` uses the same assign-synchronously shape, keyed per-entry via a `Map`. `serializeMenuTask` is a single global chain — a different shape for a different need, so this is not a reimplementation of a shared helper, but the existing code is the reference for the idiom.

2. **Superseded rebuilds abandon their writes** — a monotonic counter bumped by every request and re-checked at task entry *and* after every await:

   ```ts
   let menuGeneration = 0;
   // caller: const myGen = ++menuGeneration;
   // writer: if (myGen !== menuGeneration) return;  // at entry AND after each await
   ```

3. **Await the create callbacks**, so a task genuinely completes before the next task's `removeAll` runs:

   ```ts
   function createMenuItem(props: chrome.contextMenus.CreateProperties): Promise<void> {
     return new Promise((resolve) => {
       chrome.contextMenus.create(props, () => {
         // Reading lastError is required by the Chrome API to avoid the "unchecked
         // runtime.lastError" console noise. The value is CLASSIFIED and logged as a
         // fixed code, never as a message: a duplicate-ID here means serialization
         // regressed and must stay observable (NFR1), while log.ts's closed unions
         // keep the message body — which can embed entry titles and usernames —
         // out of the console (NFR4).
         const err = chrome.runtime.lastError;
         if (err) warnBackground("context-menu-create-failed", "duplicate-id");
         resolve();
       });
     });
   }
   ```

   Revision 1's sketch passed `err.message` here. That does not typecheck — `warnBackground(event: BackgroundWarnEvent, code: BackgroundErrorCode)` takes two closed unions — and the header of `src/background/log.ts` states the closure is deliberate precisely because a message can embed decrypted vault plaintext. Both unions are extended by literal (see C1 invariant 5); neither is widened to `string`.

### Problem B: disable Vite's preload link emission

```ts
build: { outDir: "dist", emptyOutDir: true, modulePreload: false }
```

**Probed on the reconciled toolchain** (not assumed): applying it and rebuilding drops both pages to 0 preload links while each retains exactly one entry `<script type="module">`. Chunk set unchanged.

Rationale for `modulePreload: false` over alternatives:

- **vs. a post-build HTML transform stripping `crossorigin`**: the transform would have to rewrite the script tag and every link, and would silently stop matching when Vite changes its emitted attribute set. Disabling emission removes the links at the source.
- **vs. leaving it**: each unmatched preload is a duplicated fetch of every shared chunk on every popup open.
- **Cost**: losing parallel prefetch of the dependency graph. For local-disk `chrome-extension://` resources that are *currently not being used anyway* because of the mismatch, this is nil.

The `polyfill` sub-option is irrelevant: MV3 requires Chrome 88+, which supports modulepreload natively.

### C5: bind credential release to the clicked frame's host

`handleContextMenuClick` (line 229) currently reads `info.menuItemId`, parses `entryId`/`teamId`, and calls `deps.performAutofill(entryId, tab.id, teamId)` — never comparing the clicked tab's host against the entry's. That call reaches `performAutofillForEntry` with `enforceSenderHost` **undefined**, and `index.ts` documents the reason:

> popup/context-menu callers pass undefined because the user picked the entry in trusted UI.

The origin re-binding check is guarded by `typeof enforceSenderHost === "string"`, so the context-menu path skips it entirely. Downstream, `isFrameAllowedToFill` (`src/content/autofill-lib.ts:14-19`) returns `true` unconditionally for the top frame. Nothing on the path checks the host.

The "trusted UI" rationale holds for the popup, whose list is rendered live from the current tab at click time. It does not hold for the context menu, whose items are **persisted browser state** built earlier, for a possibly different host — the menu lags the active tab by the 200 ms debounce, by the `lastMenuHost` early-return, and across service-worker termination (Chrome retains menu registrations; RK2). Redirect-driven flows (OAuth, SSO, payment interstitials) navigate the top frame under page control, with no user action.

The fix threads the clicked tab's current host through as `enforceSenderHost`, reusing the existing `isHostMatch` semantics rather than introducing a second host-comparison (R48).

## Contracts

### C1 — `context-menu.ts`: serialized, generation-guarded menu rebuild

**Signatures** (module-internal unless marked exported):

```ts
function serializeMenuTask(task: () => Promise<void>): Promise<void>
function createMenuItem(props: chrome.contextMenus.CreateProperties): Promise<void>
function removeAllMenuItems(): Promise<void>
export function setupContextMenu(): Promise<void>            // unchanged
export function updateContextMenuForTab(tabId: number, url: string | undefined): void  // unchanged
export function invalidateContextMenu(): void                // unchanged
export function initContextMenu(d: ContextMenuDeps): void    // unchanged
export function handleContextMenuClick(info, tab): void      // signature unchanged; body changed by C5
export function disableContextMenu(): Promise<void>          // NEW — routes index.ts's toggle-off through the chain
```

`ContextMenuDeps` gains one member for C5 (see C5's signature block).

**Control class** — split, because the two obligations have different enforcement strength (Revision 1 declared a single `enforceable boundary`, which overstated the grep's reach):

- **Routing obligation** (`every menu mutation goes through the helpers`): `best-effort tripwire`, not a boundary. The forbidden-pattern grep is a surface-form check over a language a parser defines (R47). **Known bypasses, enumerated**: bracket notation (`chrome["contextMenus"].removeAll()`), aliasing (`const cm = chrome.contextMenus`), and a mutation introduced in a file the glob does not cover. The real recovery path is code review plus the behavioral test in T5.
- **Generation obligation** (`a superseded task writes nothing`): `fail-closed verification gate`. It cannot pass without deciding — every resume point re-checks — and an abandoned task denies (writes nothing) rather than proceeding. The grep cannot see a missing generation check, so this clause rests on review plus T1/T2.

**Adjudication authority**: the Chrome extension process's menu-ID registry, consulted at decision time via `chrome.runtime.lastError` in `createMenuItem`'s callback, and surfaced as a classified log code (invariant 5) so a serialization regression reports itself in the field.

**Invariants**:

1. *(app-enforced)* Every `chrome.contextMenus.create` / `removeAll` in `context-menu.ts` executes inside a task passed to `serializeMenuTask`.
2. *(app-enforced)* `serializeMenuTask` assigns the new chain handle **synchronously**, before the task's first await can interleave. This is the precise defect being fixed; moving the assignment after an await reintroduces it.
3. *(app-enforced)* The stored chain handle carries `.catch()`, so a rejected task cannot wedge subsequent tasks (NFR2).
4. *(app-enforced)* A rebuild task re-checks its generation token **at task entry and after every `await`**, returning without writing when superseded. The resume points, enumerated from the code rather than from a summary: task entry; after `deps.isContextMenuEnabled()`; after each `removeChildItems()` (lines 80, 87, 95); after `deps.getCachedEntries()` (line 121); and after every `createMenuItem`.
5. *(app-enforced)* `chrome.runtime.lastError` is read in every `create`/`removeAll` callback and a non-null value is **logged as a classified code** — never as a message (NFR1 + NFR4). `BackgroundWarnEvent` gains `"context-menu-create-failed"`; `BackgroundErrorCode` gains `"duplicate-id"` **and `"orphan-parent"`**. Neither union is widened to `string`.

   **Classification, not a hardcoded code.** `chrome.contextMenus.create` sets `lastError` for at least three distinct causes: a duplicate ID, an invalid/missing `parentId`, and an invalid property set. Emitting `"duplicate-id"` for all of them would make one code carry both "the mutex regressed" and "the parent was missing" — an in-band sentinel collision (R55), and the second is exactly what invariant 8's disabled path produces today, so the pairing is not hypothetical. AD1's mitigation ("a residual collision reports itself in the field") depends on telling them apart. The callback therefore substring-tests `lastError.message` against the two known Chrome shapes and returns `"unknown"` for anything else **without ever passing `message` to `warnBackground`** — testing a string inside the sink is not forwarding it, and `log.ts`'s no-free-form-slot contract is preserved. Note `classifyError` (`log.ts:24`) is unusable here: `lastError` is `{ message?: string }`, not an `Error`, so it would return `"unknown"` for every input.

   **Boundary and tie**: where a message matches both shapes, `"duplicate-id"` wins — it is the invariant this contract exists to protect. `lastError` present with `message` absent *or* empty-string routes to `"unknown"` (an empty string is a representable value distinct from absent, and `if (!message)` and `typeof message === "string"` classify the two oppositely). Where `lastError` is absent, `warnBackground` is **not** called at all.
6. *(app-enforced)* `lastMenuHost` — including the `= null` assignments on the early-return paths at lines 81 and 89 — is written only by a task holding the current generation.
7. *(app-enforced)* An abandoned task performs **no destructive mutation after losing its check**. The ordering argument FR2 actually rests on: because tasks are serialized on one chain, a task that loses its generation can only have run its `removeAll` *before* the superseding task's own `removeAll`, so the newest task's rebuild is always last.
8. *(app-enforced, behavior correction)* `doUpdateMenu` consults `isContextMenuEnabled()` and returns before creating any child. Today only `resetMenuWithParent` checks it (line 40), so with the toggle off the parent is skipped while `doUpdateMenu` still creates children against `parentId: PARENT_ID` — orphaned-parent create failures on the **non-racing** disabled path. This is a fix; FR4's "preserve the off-switch" means the corrected behavior.

   **Which read is authoritative.** The fixed path now reads the toggle twice per rebuild — at `resetMenuWithParent` (line 40) and again in `doUpdateMenu` — with an `await` between them, so a toggle flipped in that window could otherwise yield a parent with no children or the inverse. **The `doUpdateMenu` read is authoritative for children; the `resetMenuWithParent` read is authoritative for the parent.** Both read the same `cachedEnableContextMenu` (`index.ts:847`), which the storage listener mutates synchronously before dispatching, so the second read is the fresher one and a mid-rebuild flip-to-off correctly suppresses children. A flip-to-on mid-rebuild produces a parent-less child set, which invariant 8's early return prevents by re-checking before any create.

   **`setupContextMenu` under a disabled toggle keeps its current behavior**: `removeAll` still runs, only the parent create is skipped. This is preserved deliberately — RK2's self-correction argument depends on `removeAll` running on every startup, including for users whose toggle is off but whose menu items survived a service-worker restart from a period when it was on. A "skip `removeAll` when already disabled" optimization is therefore forbidden. Where `isContextMenuEnabled()` *rejects* (T3 establishes it as a rejection source), the `removeAll` still runs — an undecidable setting must not leave stale credentials in the menu.
9. *(app-enforced)* Where `deps` is null, a task returns before mutating. `resetMenuWithParent` currently defaults `enabled = true` in that case (line 40).
10. *(app-enforced)* **`disableContextMenu` is generation-exempt.** It bumps the counter — so any in-flight rebuild is superseded and abandons — but does **not** re-check it, so a teardown always completes. Consumer 3's "both take generation tokens" is corrected accordingly: the two directions are not symmetric. Were the teardown to re-check, a rebuild queued behind it would supersede the teardown and rebuild the menu despite the setting being off, i.e. the toggle would silently not take effect. The exemption covers the counter only: `disableContextMenu` still runs inside `serializeMenuTask`, so invariant 1's routing obligation and the `removeAll` ordering RK2 depends on are untouched. **Tie**: when a toggle-off and a rebuild are issued in the same tick (the storage listener at `index.ts:865` fires synchronously and can be followed immediately by a tab-switch), the chain runs them in arrival order and the final state matches the *setting*, not the arrival order, because the rebuild re-checks `isContextMenuEnabled()` per invariant 8.

**Member-set derivation (R42)** — the class is "call sites that cause a Chrome context-menu mutation". Revision 1 derived only the *direct* set; a syntactic grep on `chrome.contextMenus` cannot see call sites that mutate through the module's own wrappers, which is where the plan's own headline reproducer lives. Both greps ship in the contract so they re-run:

```bash
# Direct members
grep -rn 'chrome\.contextMenus\.\(create\|removeAll\|remove\|update\)' extension/src --include=*.ts | grep -v __tests__
# Indirect members (wrapper layer)
grep -rn 'setupContextMenu\|updateContextMenuForTab\|invalidateContextMenu\|disableContextMenu' extension/src --include=*.ts | grep -v __tests__ | grep -v 'context-menu\.ts:'
```

Direct members (12 in `context-menu.ts` at lines 42, 44, 99, 110, 138, 152, 164, 173, 185, 194, 205, 211) all route through the chain. Plus:

| # | Site | Disposition |
|---|------|-------------|
| 13 | `index.ts:867` bare `chrome.contextMenus.removeAll()` (toggle-off) | **cross-file direct member** — replace with `disableContextMenu()` |
| 14 | `index.ts:730` `setupContextMenu()` (onInstalled) | wrapper member — takes a generation token |
| 15 | `index.ts:733` `setupContextMenu()` (onStartup) | wrapper member |
| 16 | `index.ts:738` `updateContextMenuForTab()` (onActivated) | wrapper member |
| 17 | `index.ts:749` `updateContextMenuForTab()` (onUpdated) | wrapper member |
| 18 | `index.ts:869/871` toggle-on rebuild | wrapper member |
| 19 | **`index.ts:364` `invalidateContextMenu()` — vault LOCK path (`clearVault`)** | **omitted in Revision 1** |
| 20 | **`index.ts:2171` `invalidateContextMenu()` — UNLOCK_VAULT handler** | **omitted in Revision 1** |

Members 19 and 20 are the omission that mattered: member 20 is the vault-unlock path this plan names as the primary reproducer (scenario 2), and member 19 is its mirror on lock, which additionally interleaves with `invalidateCache()` and `persistState()` on the same tick. Both must draw from the same counter, so a lock and a subsequent unlock cannot have the lock's rebuild win.

Indirect-spelling sweep (bracket notation / aliasing) returns only type-position references:

```bash
grep -rn 'contextMenus' extension/src --include=*.ts | grep -v __tests__ | grep -v 'chrome\.contextMenus\.'
```
→ `chrome.contextMenus.OnClickData`, `chrome.contextMenus.CreateProperties` only. This establishes the current state; it is what a regression would change, which is why the tripwire's bypasses are enumerated above rather than assumed closed.

**Forbidden patterns**:

- `pattern: chrome\.contextMenus\.(create|removeAll|remove|update)\(` anywhere in `extension/src/**/*.ts` except `__tests__` and the `createMenuItem`/`removeAllMenuItems` helper bodies — reason: invariant 1. Scoped repo-wide, not to `context-menu.ts`, because the derived fail-open member 13 lives in `index.ts`. Zero files matched must exit non-zero.
- `pattern: resetInFlight` — reason: the broken mutex must be gone, not renamed.
- `pattern: void chrome\.runtime\.lastError` — reason: discards the signal that proves the fix works (NFR1).
- `pattern: BackgroundErrorCode\s*=\s*string` / `BackgroundWarnEvent\s*=\s*string` — reason: widening either union to `string` restores the free-form slot log.ts exists to eliminate (NFR4).

**Acceptance criteria**:

- AC1.1 — Two rebuilds for *different* hosts, the second issued while the first is suspended on `getCachedEntries()`, produce exactly one surviving item set — the second host's — and no ID is passed to `create` twice across the sequence.
- AC1.2 — `setupContextMenu()` concurrent with an in-flight rebuild produces no repeated ID.
- AC1.3 — A rebuild whose awaited dependency rejects does not prevent the next rebuild from completing, and the next rebuild's expected `create` calls actually occur.
- AC1.4 — For the non-racing case, the **exact ordered ID sequence** matches this array, which was **derived by executing the oracle against pre-change code** (not transcribed from FR4's prose, and never regenerated from `create.mock.calls`) with a fixture of 1 LOGIN + 1 CREDIT_CARD + 1 IDENTITY:

  ```
  ["psso-parent","psso-login-L1","psso-cc-sep","psso-cc-C1","psso-id-sep","psso-id-I1","psso-login-sep","psso-open-popup"]
  ```

  **Eight** positions, not the seven FR4's prose enumerates: `psso-parent` is created by `resetMenuWithParent` (line 44) into the same `create` log the oracle captures. An implementer transcribing FR4 would write a 7-element array, `toEqual` would fail, and the natural repair — regenerating from observed output — is the snapshot route this criterion forbids. Assert the array length before `toEqual` so a truncated sequence names itself, and keep the non-empty guard (R55). Revision 1's "byte-identical to current behavior" was not an assertable predicate; this is.

  **Stability across the refactor**: this sequence holds only while the parent create and the child creates sit in the same serialized task. C1 keeps them together (`removeAllMenuItems` + parent create inside `resetMenuWithParent`, children in the same `doUpdateMenu` task). If implementation splits them, the array must be re-derived post-change rather than adjusted to fit.
- AC1.5 — `index.ts` contains no direct `chrome.contextMenus` mutation; toggle-off routes through `disableContextMenu()`, asserted behaviorally (T5), not by source grep.
- AC1.6 — With the toggle off, no child item is created (invariant 8's correction).
- AC1.7 — A superseded task performs no `removeAll` after the winning task has completed (invariant 7).

**Consumer-flow walkthrough**:

- *Consumer 1 — `handleContextMenuClick` (`context-menu.ts:229`)* reads `info.menuItemId` and uses it to match `OPEN_POPUP_ID` exactly, or to strip one of the three prefixes and parse the remainder as `teamId:entryId` / `entryId` via `UUID_RE`. **The ID format is a contract, not an implementation detail** — `encodeMenuEntryId` is unchanged by C1. C5 changes what this consumer does *after* parsing, not how it parses.
- *Consumer 2 — `index.ts:806` `onClicked.addListener(handleContextMenuClick)`* — reads only the listener reference; unchanged.
- *Consumer 3 — `index.ts:865-874` (`enableContextMenu` storage listener)* — off-path reads the new `disableContextMenu(): Promise<void>`; on-path already routes through C1's exports. Both take generation tokens.
- *Consumer 4 — the test tree* — see C6, which owns the mock contract. Revision 1 placed this obligation here on a **false premise** (it claimed `context-menu.test.ts`'s `create` mock was a bare `vi.fn()`; it is not — `context-menu.test.ts:13` already reads `create: vi.fn((_props, cb?) => cb?.())`). The real obligation is a different, larger member set, so it is promoted to its own contract.

**Status**: **locked** (Round 2).

### C5 — Credential release bound to the clicked **frame's** host *(new)*

> **Revision 3 correction.** Revision 2 bound this contract to `tab.url` — the tab's top-level
> host. That is the wrong subject. Menu items are registered with `contexts: ["editable"]` and
> **no `documentUrlPatterns`** (verified absent repo-wide), so they appear on an editable field in
> *every* frame, including a cross-origin iframe. The click, and the fill that follows it, can
> therefore occur in a frame `tab.url` does not describe. The repo already rejects this binding by
> name on the sibling content path (`index.ts:2529-2540`): *"Use `_sender.url` … rather than
> `_sender.tab.url` (the top-level tab URL): content scripts run in all frames, so a cross-origin
> subframe's fill must be checked against that subframe's own origin."* C5 now binds to the frame.

**Signatures**:

```ts
// ContextMenuDeps — note the RETURN TYPE change (see invariant 7):
performAutofill: (
  entryId: string,
  tabId: number,
  teamId?: string,
  enforceSenderHost?: string,
  frameId?: number,
) => Promise<{ ok: boolean; error?: string }>
// handleContextMenuClick resolves the clicked FRAME's host and passes it, with the frameId, through.
```

`handleContextMenuClick` keeps its `void` return — `chrome.contextMenus.onClicked.addListener`
(`index.ts:806`) ignores return values, so the promise is handled internally rather than by making
the listener async.

**Control class** — split, mirroring C1 rather than declaring one class over both obligations:

- **Runtime gate** (the host comparison): `fail-closed verification gate`. It cannot pass without deciding — every context-menu-initiated fill either resolves a frame host and matches it, or denies. Bypassable only by editing the gate.
- **Routing obligation** (the call site passes the host): `best-effort tripwire`. A regex cannot express "called without a host argument" (see Forbidden patterns), so this clause rests on the type system and T6e, not on grep.

**Adjudication authority**: `isHostMatch` in `src/lib/url-matching.ts` — the same predicate the
content path uses at `index.ts:1585`, reused rather than reimplemented, so one predicate decides
host equivalence everywhere (R48). **Its argument order is load-bearing**: `isHostMatch(entryHost, tabHost)`
returns `t.endsWith('.' + e)`, so `isHostMatch("example.com", "app.example.com")` is `true` while
`isHostMatch("app.example.com", "example.com")` is `false`. Swapping the arguments would deny every
legitimate subdomain fill.

**Invariants**:

1. *(app-enforced)* A LOGIN fill initiated from the context menu passes the clicked **frame's** host as `enforceSenderHost`, resolved as `info.frameUrl ?? info.pageUrl ?? tab.url` in that precedence, so the existing `ORIGIN_MISMATCH` check fires against the document the user actually pointed at.
2. *(app-enforced)* Where `info.frameId` is a number, it is threaded to `performAutofillForEntry`'s `frameId` parameter so **delivery is frame-scoped**, matching the existing call shape at `index.ts:2549-2556`. Without this the gate adjudicates one document while `sendFillMessage` broadcasts tab-wide (`index.ts:1454-1457`, `index.ts:1720`) and `injectDirectAutofill`'s fallback targets the top frame (`index.ts:1741-1745`) — the gate and the delivery would disagree about the subject.
3. *(app-enforced)* Where none of the three URLs yields a host via `extractHost`, the fill is **denied**. `undefined` must not be reachable from this path: it spells "trusted UI, skip the check", and reusing it for "host unknown" is an in-band sentinel collision (R55). Note `extractHost` already returns `null` for non-http(s) schemes (`url-matching.ts:1-10`), so `chrome://` and `file://` land in the deny branch through the existing primitive rather than a new scheme test.
4. *(app-enforced)* **Top-frame clicks must not fall into the deny branch.** Chrome omits `frameUrl` when the click is in the top frame (`frameId === 0`), so the precedence in invariant 1 must resolve through `pageUrl`/`tab.url` for that case. This is the clause that keeps the ordinary fill working; without it every top-frame fill breaks.
5. *(app-enforced)* Host equivalence is decided by `isHostMatch(entryHost, resolvedHost)` in that argument order. An entry with `additionalUrlHosts` matches on any one, mirroring `entryHosts.some(...)` at `index.ts:1585`.
6. *(accepted residual, stated with its bound)* CREDIT_CARD and IDENTITY remain hostless by design (`index.ts:1580` scopes the check to LOGIN), so a stale CC/Identity item can still fill after a navigation. **The bound**: CC/Identity are delivered by `sendSensitiveFillMessage` with `{ frameId: frameId ?? 0 }` (`index.ts:1467-1468`) — top frame only, never tab-wide. That bound is what keeps the residual small, and it must not be removed silently (see Forbidden patterns). Unchanged from today and not widened here. Note scenario 7's own worked example (a payment interstitial) lands in this residual rather than in the fix, which is stated so the scenario is not read as fully covered. If the residual is judged unacceptable the remedy is item staleness, not host binding — SC5.
7. *(app-enforced)* **The denial reaches the user.** `deps.performAutofill` returns `{ ok, error }` rather than `void`; the wrapper at `index.ts:682-690` returns `performAutofillForEntry`'s result instead of discarding it; and `handleContextMenuClick` surfaces a non-ok outcome via `chrome.notifications`. Today the wrapper is `async (entryId, tabId, teamId) => { await performAutofillForEntry(...) }` and the click handler ends in `.catch(() => {})`, so a denied fill would be **completely silent** — the user right-clicks, picks a credential, and nothing happens with no indication why. This realizes RK4 directly. `ORIGIN_MISMATCH` is additionally **absent from `ERROR_KEY_MAP`** (`src/lib/error-messages.ts`, verified — all 17 entries checked), so `humanizeError` falls through to `return code` and would render the raw identifier; C5 adds the mapping plus its `_locales` strings for every shipped locale.
8. *(app-enforced)* The deny path must distinguish **"this credential is for a different site"** from **"cannot verify this page"** (invariant 3's unresolvable case). Two different denials that both render as one message is the same collision invariant 3 forbids, one level up at the UI.

**Preconditions to establish before implementation** (recorded rather than assumed):

- `PC5.1` — **RESOLVED.** The question was whether `tab.url` / `info.pageUrl` is populated without host permissions: the manifest declares no `tabs` permission and only `optional_host_permissions` (`manifest.config.ts:16-17`), so if the gate's inputs were empty on a default install, invariant 3 would deny **every** click — a fail-closed control denying a whole class of principals (R52).

  **Resolution, from the API contract rather than a probe** (`@types/chrome`, `OnClickData`): `frameUrl` is *"The URL of the frame of the element where the context menu was clicked"* and `pageUrl` is *"The URL of the page where the menu item was clicked"*. Both are **properties of the click event**, delivered by Chrome to the listener — they are not read from the `Tab` object and carry no `tabs`-permission precondition. `Tab.url` is the field that requires `tabs` or a matching host permission; it is last in C5's precedence and is therefore only a fallback.

  Consequence: `info.frameUrl ?? info.pageUrl ?? tab.url` resolves a host from event-supplied data on every ordinary click, regardless of granted permissions, so the R52 failure mode does not arise. `pageUrl`'s documented exception — *"not set if the click occurred in a context where there is no current page, such as in a launcher context menu"* — cannot occur here: these items are registered with `contexts: ["editable"]`, which requires an editable element in a page. The deny branch (invariant 3) therefore covers a genuinely unresolvable click rather than the common case. M4 confirms in a real browser as defense in depth, but the contract no longer rests on it.

**Forbidden patterns**:

- `pattern: sendFillMessage` used for CREDIT_CARD or IDENTITY delivery — reason: invariant 6's bound. Replacing `sendSensitiveFillMessage` with the tab-wide sender would broadcast card number and CVV to every frame, which `index.ts:1459-1466` warns against.
- ~~`performAutofill\([^)]*\)`~~ **removed.** `[^)]*` matches the correct call and the broken call identically, so the pattern fires on fixed and unfixed code alike — it cannot fail for the reason it claims (RT7). The routing obligation rests on the `ContextMenuDeps` type signature (a positional misplacement is a compile error) and on T6e.

**Acceptance criteria**:

- AC5.1 *(deny, at the production layer)* — A click on a menu item whose entry host does not match the clicked frame's host does **not** send a fill message. Asserted in `background.test.ts` against the real `performAutofillForEntry` — `chrome.tabs.sendMessage` not called with `type: AUTOFILL_FILL` — not against a `performAutofill` stub (see the walkthrough's Consumer 4 for why the layer matters).
- AC5.2 *(allow, pinned, same layer)* — A matching click produces exactly one `AUTOFILL_FILL` `sendMessage` carrying the enumerated payload — `username`, `password`, `totpCode`, `customFields`, `allowedHosts` — to the expected frame. Enumerated, not "byte-identical to today's": Revision 1's "byte-identical" phrasing was rejected at AC1.4 as unassertable and must not return here.
- AC5.3 — Unresolvable host (none of `frameUrl`/`pageUrl`/`tab.url` yields a host) → denied, distinguishably from a mismatch (invariant 8).
- AC5.4 *(subdomain oracle, hand-written)* — Expected values are **written by hand, never computed from `isHostMatch`** (a test comparing `isHostMatch(a,b)` to `isHostMatch(a,b)` is an identity true of any implementation, including a broken one). The table, each a separate assertion:

  | entry host | frame host | expected |
  |---|---|---|
  | `example.com` | `app.example.com` | allow |
  | `app.example.com` | `example.com` | **deny** (the argument-order oracle) |
  | `example.com` | `notexample.com` | deny |
  | `example.com` | `example.com.evil.com` | deny |
  | `example.com` | `example.com` | allow (via the `e === t` branch) |

  Two allows and three denies, so an always-deny fix fails. `normalizeHost` strips `www.`, so entry `www.example.com` / frame `example.com` is allow.
- AC5.5 — A top-frame click (no `frameUrl`) resolves through `pageUrl`/`tab.url` and fills normally (invariant 4).
- AC5.6 — A denied fill produces a user-visible notification; a successful fill produces **none** (invariant 7's allow side, so a fix that notifies unconditionally fails). `humanizeError("ORIGIN_MISMATCH")` returns a mapped string, not the raw code.

**Consumer-flow walkthrough**:

- *Consumer 1 — `performAutofillForEntry` (`index.ts:1418`)* reads `enforceSenderHost` and, when it is a string and `entryType === LOGIN`, requires `entryHosts.some((h) => isHostMatch(h, enforceSenderHost))` before releasing the password, returning `ORIGIN_MISMATCH` otherwise. The parameter, guard, and error code all exist today (`index.ts:1418-1430`, `1580-1589`). **Correction to Revision 2**, which claimed "no change to the consumer is required": the guard sits at line 1581, *after* the entry has been fetched (`swFetch`, line 1487) and both blobs decrypted (line 1508). The deny still holds — no fill message is sent — but a denied click still costs a server round-trip and a vault decryption, and holds plaintext in the SW heap. Revision 3 does **not** add a pre-fetch filter: doing so would introduce a second adjudicator for one predicate (R48) and the cached overview can be stale relative to the server copy. The ordering is recorded so no reader believes the guard gates the fetch, and the cost is accepted (see SC7).
- *Consumer 2 — `deps.performAutofill` wiring (`index.ts:682-690`)* — gains the `enforceSenderHost` and `frameId` pass-throughs **and** returns the result rather than discarding it (invariant 7).
- *Consumer 3 — `injectDirectAutofill` (`index.ts:1741-1745`)* — reads `executeTarget`, which is `{ tabId }` (top frame) for context-menu fills today. Once invariant 2 threads `frameId`, `executeTarget` becomes `{ tabId, frameIds: [frameId] }` so the fallback follows the click. **Named explicitly** so a host-only fix cannot be read as complete: without it the fallback writes into a frame the gate never adjudicated.
- *Consumer 4 — the test tree* — `context-menu.test.ts` stubs `performAutofill` as `vi.fn().mockResolvedValue(undefined)` (line 56), which never reaches `index.ts`. An assertion there is about *arguments passed to a stub*, not a suppressed side effect, and it would stay green if the implementation passed the host in the wrong positional slot — `performAutofillForEntry` takes six positional parameters and the adapter already passes `undefined` for `targetHint`. AC5.1/AC5.2 therefore live in `background.test.ts`, which imports the real module (RT5/RT8).

**Status**: **locked** — PC5.1 resolved from the `OnClickData` API contract (see Preconditions).

### C2 — `vite.config.ts`: disable modulepreload link emission

```ts
build: { outDir: "dist", emptyOutDir: true, modulePreload: false }
```

**Control class**: `detection or audit only` at runtime (it denies nothing; it changes emitted HTML). Its verification (C3) is a `fail-closed verification gate`. **Adjudication authority**: the built `dist/**/*.html`, read after `npm run build`.

**Invariants**:

1. *(build-enforced)* No `<link rel="modulepreload">` in any `dist/**/*.html`.
2. *(app-enforced)* Every chunk formerly preloaded is still reachable through the module graph — the popup and options pages still render.

**Forbidden patterns**:

- `pattern: rel="modulepreload"` in `dist/**/*.html` — reason: invariant 1.
- `pattern: modulePreload:\s*true` in `extension/vite.config.ts` — reason: re-enables Problem B.

**Acceptance criteria**:

- AC2.1 — After `npm run build`, no `dist/**/*.html` contains `rel="modulepreload"`. **Probed on the reconciled toolchain: 4 and 5 links before → 0 and 0 after.**
- AC2.2 — Each of `dist/src/popup/index.html` and `dist/src/options/index.html` still contains exactly one `<script type="module" src="/assets/...">`. **Probed: 1 and 1 after the change.**
- AC2.3 — The emitted `dist/assets/*.js` chunk set is unchanged by the flag (it governs link emission, not chunking). Any delta must be explained.
- AC2.4 — M2 (manual) confirms the warnings are gone in a real browser, since VC2 blocks asserting that automatically.

**Status**: **locked** — re-derived against vite 8.2.1 and probed, not carried over from the stale build.

### C3 — Build-output assertion for C2

> **Revised after implementation.** This contract was locked as
> `check-no-modulepreload.mjs`, a single-purpose gate. During the simplify pass a
> second defect surfaced on the same subject — `public/.DS_Store` was being copied
> into `dist/` by every `vite build`, and `emptyOutDir` does not clear dotfiles, so
> it reached a hand-built extension archive. There is no packaging script to fix
> instead, so the check belongs on the directory the build owns. The script was
> widened and renamed accordingly; the text below describes what shipped.

`extension/scripts/check-dist-hygiene.mjs` (this contract creates `extension/scripts/`), wired as:

```json
"build": "tsc && vite build && node scripts/check-dist-hygiene.mjs"
```

**Control class**: `fail-closed verification gate`. Missing `dist/`, zero HTML files found, or an internal throw must **exit non-zero** — "examined nothing" must not be spelled the same as "found nothing" (R55). **Adjudication authority**: the filesystem, via a single directory walk of `dist/` serving both checks.

**Invariants**:

1. *(app-enforced)* Exits non-zero when `dist/` is absent, when the walk finds zero HTML files, or when any HTML file contains a preload link.
2. *(app-enforced)* The script's own failure (throw, bad path, rejected promise) exits non-zero. No `catch { process.exit(0) }`; an `unhandledRejection` handler or a top-level try/catch that re-exits non-zero is required.
3. *(app-enforced)* The script prints the count of HTML files scanned, so a reviewer can distinguish "clean" from "scanned nothing".
4. *(app-enforced, added post-lock)* Exits non-zero when the walk finds an OS/editor junk file (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `.AppleDouble`) at any depth. Matched on basename, recursively — a junk file nested under `dist/assets/` is packaged exactly like one at the top level.

**Forbidden patterns**:

- `pattern: process\.exit\(0\)` inside a catch block — reason: invariant 2.

**Acceptance criteria**:

- AC3.1 *(prove-red)* — Reinstating `modulePreload: true` makes the check exit non-zero.
- AC3.2 — `dist/` deleted → exits non-zero.
- AC3.3 — On the fixed build, exits zero **and** reports a non-zero scanned count (the count is what distinguishes this from a broken glob).
- AC3.4 — `dist/` present with `.js` chunks but zero `.html` files (`rm dist/**/*.html`) → exits non-zero. AC3.2's whole-directory deletion does not reach this case.
- AC3.5 — An injected throw in the walk → exits non-zero. This executes invariant 2 rather than grepping the script's own source for it.
- AC3.6 *(added post-lock)* — A junk file at the top level of `dist/` → exits non-zero. **Verified against the real defect, not a synthetic fixture**: the check failed on the actual `.DS_Store` on its first run.
- AC3.7 *(added post-lock)* — A junk file nested under `dist/assets/` → exits non-zero, proving the walk recurses rather than scanning one level.

**Source-side fix, recorded because the gate alone would not have been enough**: `public/.DS_Store` was deleted. The gate catches the symptom in `dist/`, but `vite build` copies `public/` verbatim, so leaving the source in place would have reddened the build on every run rather than preventing the defect. Both were needed; a future Finder visit to `public/` recreates the source and the gate is what will catch it.

**CI wiring** *(recorded, since the gate's reach is part of the contract)*: the check rides `extension-ci`'s `npm run build` (`.github/workflows/ci.yml:363`), which is gated by the `extension/**` path filter (`ci.yml:59-60`). A root-tooling or dependency change that alters emitted HTML without touching `extension/**` therefore skips this gate. Accepted with that scope stated; widening the filter is out of scope (SC6).

**Status**: **locked** (Round 2).

### C4 — Dependency-tree reconciliation *(resolved during Round 1; recorded for audit)*

**Finding**: `npm ls` reported **five** packages `invalid` — `@crxjs/vite-plugin` (2.3.0 vs declared `^2.7.1`), `vite` (6.4.2 vs `^8.2.1`), `@tailwindcss/vite`, `@vitejs/plugin-react`, `vitest`. Revision 1 named only the first and read it as a possible supply-chain concern.

**Resolution**: `package-lock.json` already pinned the **correct** versions (`vite` 8.2.1, `@crxjs/vite-plugin` 2.7.1, `vitest` 4.1.10). The `overrides` block at `package.json:19-25` scopes only a nested `rollup` under `@crxjs/vite-plugin` and is not a downgrade mechanism. The cause was an un-refreshed `node_modules` — dependency bumps landed in `package.json`/lockfile (`e2be439c chore(deps-dev): bump the npm-extension-general group`) without a subsequent install in this working copy. A tree-wide, lockfile-consistent staleness is the not-installed-since-the-bumps signature, not tampering.

**Action taken**: `npm ci` → `npm ls` reports zero `invalid`. `rm -rf dist && npm run build` → rebuilt. Test baseline re-established: 59 files / 940 tests passing on vitest 4.1.10.

**Consequence for C2/C3** — the branch this contract existed to decide: Problem B **still reproduces** on vite 8.2.1 (4 + 5 preload links, all `crossorigin`). The vite 6 → 8 jump changed the chunk split but not the emission policy, so C2's analysis and remedy stand on re-derived evidence. Had the warnings been absent under vite 8, C2/C3 would have been dropped rather than retained.

**Acceptance criteria**:

- AC4.1 — `npm ls` reports zero `invalid` in `extension/`. ✅ met.
- AC4.2 — The `dist/` that C2/C3 are validated against is produced by the reconciled tree, with the versions recorded. ✅ met (vite 8.2.1 / crxjs 2.7.1, recorded in Project context).
- AC4.3 — CI's `npm ci` resolves the same versions as local. CI is authoritative where they differ.

**Status**: **locked** (resolved and verified).

### C6 — Test-mock contract for the awaited create callback *(new — replaces C1's false Consumer-4 claim)*

Once `createMenuItem` awaits `chrome.contextMenus.create`'s callback, any mock that does not invoke that callback leaves a promise pending forever.

**Member-set derivation (R42), test tree** — Revision 1 asserted the wrong member and prescribed a no-op. Derived mechanically:

```bash
grep -rn 'contextMenus' -A6 extension/src/__tests__ | grep -E 'create:|removeAll:'
```

| File | `create` mock | Needs change |
|---|---|---|
| `src/__tests__/context-menu.test.ts:13` | `vi.fn((_props, cb?) => cb?.())` | **No — already conforms** |
| `src/__tests__/background.test.ts:130` | `vi.fn()` | **Yes** |
| `src/__tests__/background-commands.test.ts:92` | `vi.fn()` | **Yes** |
| `src/__tests__/background/inline-matches.test.ts:88` | `vi.fn()` | **Yes** |
| `src/__tests__/background/totp-handlers.test.ts:76` | `vi.fn()` | **Yes** |
| `src/__tests__/background/team-entries.test.ts:85` | `vi.fn()` | **Yes** |

All six already stub `removeAll: vi.fn((cb?) => cb?.())` — the callback-taking primitive that already existed. The `create` counterpart was propagated to exactly one file. That is R19/R3 in its plain form, and Revision 1 inverted which side of it was stale.

**Why this is not merely a hang**: the five files `await import("../background/index")`, and `index.ts:730/733` call `setupContextMenu()` **unawaited**. A never-resolving `createMenuItem` therefore becomes a floating pending promise, not a failing assertion — the suites likely go **green** while `menuChain` is wedged forever, silently no-opping every later menu operation in that file. A false green is worse than a hang.

**Invariants**:

1. *(app-enforced)* Every `contextMenus.create` mock invokes its callback when one is passed, and tolerates its absence (`cb?.()`).
2. *(app-enforced)* A wedged chain cannot be spelled the same as a completed one — the suites must fail, not hang indefinitely, when a callback is dropped.

**Acceptance criteria**:

- AC6.1 — All five bare mocks updated to `vi.fn((_props: unknown, cb?: () => void) => cb?.())`, mirroring the `removeAll` stub beside each.
- AC6.2 *(allow, pinned)* — All six suites pass with their existing assertion sets **unchanged**. The stub adds callback invocation only; it must not alter any `create.mock.calls` content, so `context-menu.test.ts`'s existing `psso-login-e1` / `psso-parent` / 5-item-cap assertions are the pinned no-op case.
- AC6.3 *(prove-red, per clause)* — (i) leave one of the five bare and confirm that suite fails (run with an explicit short test timeout so the hang names itself); (ii) separately revert the callback in `context-menu.test.ts` and confirm *its* rebuild tests redden, establishing the stub is load-bearing there too.
- AC6.4 — `create`'s implementation is re-armed in `beforeEach` alongside `removeAll` (`context-menu.test.ts:66`), so the two are symmetric. Today `create`'s implementation survives only because `vi.clearAllMocks()` clears history but not implementations, and `vitest.config.ts` sets neither `mockReset` nor `restoreMocks`.

  **Correction to Revision 2**, which required "the suite passes under both settings". That was verified by execution and is **false**: setting `mockReset: true` fails all 19 tests in `context-menu.test.ts` with `TypeError: Cannot read properties of undefined (reading 'then')` at `context-menu.ts:281` — `mockReset` strips `chrome.tabs.query`'s `mockResolvedValue([])`, so `invalidateContextMenu()` in `beforeEach` (line 69) dereferences `undefined.then`. Re-arming `create` and `removeAll` does not address `tabs.query`, `action.openPopup`, or the `createDeps` mocks, so the criterion was unsatisfiable by its own prescribed fix and would have been marked met on a green run under the current config — passing vacuously for a reason it never tested (RT7).

  The obligation is therefore bounded to what the fix can satisfy: `create` re-armed symmetrically with `removeAll`, red-proven by deleting that re-arm alone and confirming the rebuild tests redden while the `psso-parent` assertions stay green. The suite's dependence on `vitest.config.ts` setting neither `mockReset` nor `restoreMocks` is stated explicitly and guarded by a forbidden pattern on adding either to that file, rather than papered over by a both-settings claim nothing enforces. **Boundary**: the re-arm must precede `initContextMenu`/`invalidateContextMenu` at lines 68-69, or setup throws before any test body runs.
- AC6.5 — Module state (`menuChain`, `menuGeneration`, `lastMenuHost`, `debounceTimer`) is reset between tests, so a wedged chain from one test cannot silently no-op the next (RT11).

**Status**: **locked** (Round 2).

## Testing strategy

Revision 1's strategy rested on three claims; two were refuted. It is rebuilt below.

### The race tests (T1/T2) — construction corrected

**Why Revision 1's T1 could not work**: it specified "issue rebuild for host A, let it suspend, issue rebuild for host B". Both would go through `updateContextMenuForTab`, which shares one module-level `debounceTimer` (line 70-73) — the second call **cancels the first**, so only one rebuild runs. The existing test `debounces rapid calls` (`context-menu.test.ts:208-217`) proves this: three rapid calls → `getCachedEntries` called exactly **once**. The invariant "no ID appears twice" would then hold trivially on broken *and* fixed code — a vacuous pass (RT4), and prove-red would have been impossible by that recipe.

**Corrected construction** — drive the two *genuinely concurrent* entry points, which the plan's own scenario 2 already identifies:

- **T1 (AC1.1)** — Rebuild A via `updateContextMenuForTab(1, "https://a.example")`, advanced past `DEBOUNCE_MS` so it enters `doUpdateMenu` and suspends on a deferred `getCachedEntries`. Rebuild B via the second entry point — `invalidateContextMenu()` with `chrome.tabs.query` stubbed to host B (the vault-unlock path, member 20). Then resolve A's deferral, then B's.
  - **Cardinality floor, asserted before the invariant** (this is what makes the test falsifiable): `getCachedEntries` called exactly **2** times, and at least one `create` bearing host A's item set occurred. Without this, "no duplicate ID" is unfalsifiable over an empty call log.
  - Then: no ID passed to `create` twice; surviving items are host B's.
  - Timers: `vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)`. `DEBOUNCE_MS` imported or re-derived, never hardcoded as `200` (RT3 — the existing file's `300` literal is the pattern not to extend).
  - **Prove-red, per mechanism**: (i) revert only `serializeMenuTask`'s chaining, keep the generation token → the duplicate-ID assertion must redden; (ii) revert only the generation token, keep serialization → the "surviving items are host B's" assertion must redden. Two mutations, two distinct assertions. If (ii) reddens nothing, the generation token is untested.
  - **Boundary/tie**: when A and B carry the *same* host, `lastMenuHost` short-circuits at line 93 — assert B is skipped, so the test does not accidentally require two rebuilds.
- **T2 (AC1.2)** — `setupContextMenu()` interleaved with an in-flight rebuild; same no-duplicate-ID assertion plus the same cardinality floor.
- **T2b (AC1.7)** — A superseded task must not `removeAll` after the winner completed: assert the winner's item set survives to the end of the run.

### T3 (AC1.3) — rejection fixture corrected

Revision 1 used a rejecting `getCachedEntries`. That cannot reject the chain: `doUpdateMenu` already wraps it in a `try/catch` that swallows everything (lines 120, 217-219). The test would pass identically with or without `serializeMenuTask`'s `.catch()`.

Use a rejection that actually reaches the chain — `isContextMenuEnabled` (awaited at line 40, outside any try/catch) or a throwing `removeAll`. Assert the *next* rebuild's expected `create` call occurs (not merely that a promise settled — a settled promise is satisfied by a task that returned early having written nothing, RT8). **Prove-red**: remove `.catch()` from the stored chain handle → the second rebuild's creates never occur. **Boundary**: state whether a rejecting task still bumps `menuGeneration`, and therefore whether a task queued behind it is considered superseded.

### T4 (AC1.4) — regression oracle replaced

Revision 1 delegated FR4 entirely to "the existing suite passes unmodified". The existing suite cannot carry that weight:

- Every assertion uses `createCalls.find(...)` (lines 97, 113, 129, 142, 163) or `.filter(...)` (line 188) — **order-blind by construction**. No test asserts the section ordering FR4 names.
- `mockEntries` (lines 41-44) contains **only two LOGIN entries**. `CREDIT_CARD` and `IDENTITY` never appear, so `psso-cc-sep`, `psso-id-sep`, and the `💳`/`👤` paths (lines 162-201) never execute — **5 of the 6 colliding IDs in the bug report are on paths the suite never runs**.
- No test sets `isContextMenuEnabled` to `false`, so the disabled branch (lines 48-50) is uncovered.

Replace with an exact-sequence oracle: capture `create.mock.calls.map((c) => c[0].id)` and assert `toEqual` against a **hand-written** expected array (not snapshot-generated, or it records today's behavior including a regression introduced in the same commit). Extend `mockEntries` with at least one `CREDIT_CARD` and one `IDENTITY`. Add a disabled-toggle case.

- **Prove-red, per clause**: (i) swap the credit-card and identity blocks in `context-menu.ts` → ordering assertion reddens (the current `find`-based suite survives this mutation, which is what proves the new oracle is load-bearing); (ii) delete the `cc-sep` create → a different assertion reddens; (iii) flip the `isContextMenuEnabled` handling → the disabled-path assertion reddens.
- **Fail-loudly**: assert the captured sequence is non-empty before comparing, so a rebuild that never ran cannot satisfy an empty comparison (R55).
- **Boundary**: assert the 5-item cap at exactly 5 and exactly 6 matching entries, naming which survive — `slice(0, MAX_ITEMS)` (line 148) is the boundary the generation re-check now interleaves with.

### T5 (AC1.5/AC1.6) — behavioral, no source-grep fallback

Revision 1 permitted a source-reading gate as a fallback. Dropped: a text grep for "`index.ts` contains no direct `chrome.contextMenus` mutation" is a surface-form check (R47) defeated by bracket notation, aliasing, or a new file — and AC1.5 guards member 13, the member whose omission the plan itself calls fail-open.

Drive the `enableContextMenu → false` storage change in `background.test.ts` (it already imports `background/index` and stubs `storage.onChanged`) and assert `removeAll` ran **through the chain**. **Allow side (RT10)**: toggling back to `true` must rebuild, asserted with a real `create` call — otherwise a fix that disables and never re-enables passes the deny half. **Fail-loudly**: assert `disableContextMenu` resolves to a function before driving the toggle, so a rename turns the test red rather than into a no-op. **Boundary**: toggle flipped off *while* a rebuild is suspended (scenario 3) — state whether the in-flight rebuild is abandoned or completes and is then cleared.

### T6 (C5) — credential host binding, **split across two layers**

The layer matters and Revision 2 got it wrong. In `context-menu.test.ts`, `performAutofill` is
`vi.fn().mockResolvedValue(undefined)` (line 56) — a stub that never reaches `index.ts`. An
assertion there is about *arguments passed to a stub*, not about a suppressed side effect, so it
cannot satisfy AC5.1's absent-mutation requirement (RT8) and it bypasses the deciding primitive at
`index.ts:1580-1589` (RT5). Worse, `performAutofillForEntry` takes six positional parameters and
the adapter already passes `undefined` for `targetHint`, so an implementation that threads the host
into the *wrong slot* would keep a `toHaveBeenCalledWith` assertion green and still release the
credential.

**Layer 1 — `context-menu.test.ts` (resolution contract only):**

- **T6a** — the clicked frame's host reaches `performAutofill` in the named parameter, via a stub typed against the real `ContextMenuDeps` so a positional misplacement is a **compile error** rather than a green test.
- **T6c (AC5.3)** — unresolvable host (no `frameUrl`/`pageUrl`/`tab.url`) → denied, distinguishably from a mismatch.
- **T6e (AC5.5)** — top-frame click (no `frameUrl`) resolves via `pageUrl`/`tab.url` and proceeds.

**Layer 2 — `background.test.ts` (the real guard; it already `await import`s `background/index`):**

- **T6f (AC5.1, deny)** — a host-mismatched context-menu click → assert `chrome.tabs.sendMessage` was **not** called with `type: AUTOFILL_FILL`. This is the genuine absent mutation, reached through the production guard.
- **T6g (AC5.2, allow, pinned)** — a matching click → exactly one `AUTOFILL_FILL` `sendMessage` carrying the enumerated payload (`username`, `password`, `totpCode`, `customFields`, `allowedHosts`) to the expected frame. Enumerated, not "byte-identical to today's" — that phrasing was rejected at AC1.4 and must not return. Assert `sendMessage` was called at least once before asserting its payload, so an unrelated wiring break cannot satisfy T6f vacuously.
- **T6h (AC5.6)** — a denied fill produces a user-visible notification and `humanizeError("ORIGIN_MISMATCH")` returns a mapped string; a successful fill produces **no** notification.
- **Boundary**: a CC/IDENTITY click on a mismatched host still sends `AUTOFILL_CC_FILL` (invariant 6's accepted residual) — pinned as an explicit *allow*, or the residual becomes silently untested.

**T6d (AC5.4) — subdomain oracle, hand-written.** Assert against the five-row table in AC5.4, with
expected values **written by hand**, never computed from `isHostMatch`. A test comparing
`isHostMatch(a,b)` to `isHostMatch(a,b)` is an identity true of every implementation including a
broken one (RT1), and it cannot detect the drift it exists to catch because there is only one
adjudicator consulted twice. T6d keeps consulting the real `isHostMatch` on the production path —
do not stub it, which would trade a tautology for an RT5 bypass; only the *expected* side is
hand-written.

**Prove-red, per clause** (each a separate mutation, run and observed):

1. Drop the `enforceSenderHost` pass-through → T6f reddens.
2. Hardcode the guard to always deny → T6g reddens.
3. Pass the host in the **wrong positional slot** → T6f reddens while T6a stays green. This is the mutation that proves the two-layer split was necessary; if T6f does not redden here, layer 2 is not reaching the real guard.
4. Swap `isHostMatch`'s two arguments at the call site → T6d's `app.example.com` / `example.com` deny row flips to allow and reddens. A circular oracle would stay green.
5. Drop the `frameId` pass-through → assert `sendMessage` was called **with** `{ frameId }`, not merely called; that assertion reddens.
6. Make the unresolvable-host branch fall through to `undefined` → T6c reddens.
7. Revert the wrapper at `index.ts:682-690` to discarding the result → T6h reddens.

### C6 mock work

Per AC6.1-AC6.5 above.

### Build-level

C3 per AC3.1-AC3.5.

### Manual (VC1/VC3/VC4 — documented, not automated)

- **M1** — Load unpacked in Chrome, DevTools on the service worker: switch tabs rapidly across ≥3 hosts; toggle `enableContextMenu` during a switch; lock/unlock the vault during a switch. Expect zero `Cannot create item with duplicate id`.
- **M2** — Open popup and options page; expect zero `modulepreload` warnings in each page's own console.
- **M3** — Repeat M2 in Edge (VC3).
- **M4** *(new, C5)* — Open the context menu on host A, navigate the tab to host B without closing the menu, click the host-A item. Expect no fill and an `ORIGIN_MISMATCH`-consistent outcome.

## Considerations & constraints

### Scope contract

- **SC1** — `chrome.runtime.lastError` handling in other background modules is out of scope; only `context-menu.ts` and the `index.ts` call sites named in C1's member table are touched.
- **SC2** — The `<script type="module" crossorigin>` attribute on the entry script is deliberately left in place: only the *preload* lands in the wrong world. If M2 shows warnings persisting after C2, this returns to scope.
- **SC3** — Upgrading `@crxjs/vite-plugin` or `vite` beyond what the lockfile already pins is out of scope. C4 reconciled the installed tree to the lockfile; it did not change the lockfile.
- **SC4** — No real-browser E2E harness is introduced. VC1/VC4 stand; M1 and M4 remain manual.
- **SC5** *(new)* — Bounding context-menu item **staleness** (expiring items after N seconds, or rebuilding on menu-open) is out of scope. C5 closes the LOGIN release path; the CC/Identity residual (C5 invariant 6) is what a staleness bound would address. **Cost of doing it now**: a menu-age mechanism touching every rebuild path plus a new expiry timer in an MV3 worker that is itself terminated unpredictably — a larger change than C5 itself, on a path C5 already bounds to the top frame. **Cost of deferring**: a stale CC/Identity item remains fillable after a navigation, bounded by `sendSensitiveFillMessage`'s `frameId ?? 0` (top frame only) and by requiring a user click. **Mitigation**: C5 invariant 6 records the bound and a forbidden pattern prevents its silent removal. Owned by: file an issue if the residual is judged unacceptable.
- **SC6** *(new)* — Widening CI's `extension/**` path filter so C3 runs on root-tooling changes is out of scope. Recorded in C3's CI wiring note.
- **SC7** *(new)* — Moving the origin check **before** the fetch/decrypt in `performAutofillForEntry` is out of scope. The guard sits at `index.ts:1581`, after `swFetch` (line 1487) and `decryptData` (line 1508), so a denied click costs a server round-trip and a vault decryption and briefly holds plaintext in the SW heap. **Cost of doing it now**: a pre-fetch filter would be a second adjudicator for one predicate (R48), and the cached overview it would read can be stale relative to the server copy — a wrong pre-filter denies a legitimate fill. **Cost of deferring**: wasted round-trip on denied clicks; the deny itself holds, so no credential is released. **Mitigation**: recorded in C5's Consumer-1 walkthrough so no reader believes the guard gates the fetch. Owned by: revisit if denied clicks become common enough to matter.

### Anti-Deferral entries

- **AD1** (VC1) — *Automated verification that no duplicate-ID error reaches the real Chrome registry is deferred.* **Cost now**: a Playwright/Puppeteer extension harness in a repo that has none — new dep, new CI job, new flake surface, for one assertion. **Cost of deferring**: the unit tests assert on the call log rather than Chrome's actual rejection, so a fix that serializes correctly in JS but still collides due to mismodelled Chrome behavior would pass CI. **Mitigation**: M1 is mandatory before merge, and C1 invariant 5 logs any real-world `lastError` as a classified code, so a residual collision reports itself in the field.
- **AD2** (VC2) — *Automated assertion of console-warning absence is deferred.* **Cost now**: the same harness plus console interception. **Cost of deferring**: low — C3 asserts the proximate cause (the emitted link) in CI, and the warning is a deterministic function of the link's presence. **Note**: AD2's adequacy is entirely contingent on C3 being sound, which is why C3 gained AC3.3's scanned-count, AC3.4, and AC3.5.
- **AD3** (VC3) — *Edge confirmation is manual (M3).* **Cost now**: a second browser in a harness that does not exist. **Cost of deferring**: low — Edge shares Chromium's preload scanner, and the fix removes the link entirely rather than relying on browser-specific matching.
- **AD4** *(new)* (VC4) — *The real stale-menu-then-navigate sequence for C5 is verified manually (M4), not automatically.* **Cost now**: the same absent harness, plus orchestrating a real navigation between menu-open and click. **Cost of deferring**: the host-binding *logic* is fully unit-tested (T6a-T6d), so what goes unverified is only that Chrome delivers the stale menu as expected — the code path is exercised either way. **Mitigation**: M4 before merge; the deny path fails closed, so an unexpected Chrome behavior yields a refused fill rather than a leaked credential.

### Risks

- **RK1** — Serializing rebuilds adds latency under rapid tab switching. Mitigated by the generation token: superseded rebuilds abandon early rather than each running to completion. Worst case bounded by one full rebuild.
- **RK2** — MV3 service-worker termination mid-chain resets `menuChain`/`menuGeneration` while Chrome retains registered menu items. This is why `removeAll` must remain the first step of every rebuild — each rebuild is self-correcting against surviving state. A "skip removeAll if nothing changed" optimization would break this.
- **RK3** — `modulePreload: false` is global to the Vite build, affecting popup, options, and any future HTML entry. That is intended (all are `chrome-extension://` pages), but a future non-extension page built from this config would inherit it.
- **RK4** *(new)* — C5 adds a deny path to a flow that previously always proceeded. A bug in host resolution would break legitimate autofill, which is a usability regression on a core feature. This is why AC5.2 pins the allow side with a payload assertion and T6's prove-red requires clause (iii).

## User operation scenarios

1. **Rapid tab switching across hosts** — cycling github.com / mail.google.com / an intranet host under 200 ms each. Debounce collapses most, but the trailing pair overlaps through `getCachedEntries()`. Primary reproducer for Problem A via the tab-switch door.
2. **Vault unlock while browsing** — unlocking from the popup while a tab-switch rebuild is in flight. `invalidateContextMenu()` (member 20, `index.ts:2171`) nulls `lastMenuHost` synchronously, defeating the same-host guard for the in-flight rebuild. This is the second concurrent entry point T1 uses.
3. **Vault lock while browsing** — the mirror path (member 19, `index.ts:364`), which additionally interleaves with `invalidateCache()` and `persistState()` on the same tick.
4. **Toggling the context-menu setting** — turning `enableContextMenu` off mid-rebuild; `index.ts:867`'s bare `removeAll` (member 13) wipes the parent while creates are queued against it. Independently, the disabled path creates orphaned children even without a race (C1 invariant 8).
5. **Opening the popup repeatedly** — each open re-fetches every shared chunk twice (unmatched preload + module graph). Problem B's user-visible cost.
6. **Team entry present for the current host** — menu IDs carry `teamId:entryId`; a rebuild race that drops the team item leaves the personal item selected instead.
7. **Redirect during an open menu** *(C5)* — the context menu is opened on host A; the tab navigates (OAuth/SSO/payment interstitial) under page control; the user clicks the host-A item. Today the credential is released to host B with no check on the path. This is C5's reason to exist.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `context-menu.ts` serialized + generation-guarded rebuild (incl. members 13, 19, 20) | **locked** |
| C2 | `vite.config.ts` `modulePreload: false` | **locked** |
| C3 | Build-output assertion that no modulepreload link is emitted | **locked** |
| C4 | Dependency-tree reconciliation | **locked** |
| C5 | Credential release bound to the clicked **frame's** host | **locked** |
| C6 | Test-mock contract for the awaited create callback (6-file member set) | **locked** |

All six contracts are locked after two review rounds. C2 and C4 rest on executed probes rather than
inference; C1's race is reproduced (see below); C6's member set was re-derived independently by two
reviewers and agrees.

**C5 remains `pending` on exactly one open item — `PC5.1`**: whether `tab.url` / `info.pageUrl` is
populated on a default install that has granted no optional host permissions. This is a real-browser
question (the manifest declares no `tabs` permission), and it decides between "C5 denies the hostile
case" and "C5 denies every click for most users" (R52). It is the first task of Phase 2, before the
C5 code is written. Every other C5 clause is settled.

## Evidence: Problem A reproduced

The race is not inferred. Running the T1 construction against **unmodified** code produces:

```
getCachedEntries calls: 2
ids: ["psso-parent","psso-parent","psso-login-e2","psso-login-sep","psso-open-popup",
      "psso-login-e1","psso-login-sep","psso-open-popup"]
DUPLICATES: ["psso-parent","psso-login-sep","psso-open-popup"]
```

Two facts this pins, beyond the console warnings:

1. The duplicate IDs are the reported ones — `psso-login-sep` and `psso-open-popup` each created twice.
2. **The stale item wins position.** Host B's item (`psso-login-e2`) is created first, then host A's
   stale `psso-login-e1` is appended *after* — so the menu ends up offering the previous host's
   credential alongside the current one. That is Problem A and C5's threat model meeting in one
   observed trace.

The construction works because `invalidateContextMenu`'s `chrome.tabs.query(...).then(...)` defers
`updateContextMenuForTab` into a later microtask, by which time rebuild A's `setTimeout` has already
fired — clearing an already-fired timer is a no-op, so B arms a *fresh* timer instead of cancelling A.
This mechanism was verified independently by two reviewers.
