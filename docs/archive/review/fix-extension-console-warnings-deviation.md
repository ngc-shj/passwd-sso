# Coding Deviation Log: fix-extension-console-warnings

Ollama unavailable — entries recorded directly.

## D1 — C5 invariant 7: badge instead of `chrome.notifications`

**Plan said**: surface a denied fill "via `chrome.notifications`".

**Implemented**: a transient toolbar-badge marker (`!`, red, with the humanized
message as the action title, self-clearing after 4 s via `updateBadgeForTab`).

**Reason**: the extension has no `notifications` permission and no notification code
anywhere. Using it would have required adding a permission to `manifest.config.ts` —
a user-visible privilege expansion, and a scope increase the plan did not authorize,
for a message that lasts a few seconds. The badge is an affordance the extension
already owns (`chrome.action.setBadgeText` is used throughout `updateBadgeForTab` /
`updateBadge`), so the invariant's actual requirement — *the denial reaches the user*
— is met without widening permissions. AC5.6 is satisfied as written: a denied fill
produces a visible marker, a successful one produces none.

## D2 — `disableContextMenu` also cancels the pending debounce timer

**Plan said** (C1 invariant 10): `disableContextMenu` is generation-exempt — it bumps
the counter so an in-flight rebuild abandons, but does not re-check it.

**Implemented**: that, **plus** clearing `debounceTimer` and nulling `lastMenuHost`.

**Reason**: found by a failing test, not by inspection. The counter alone cannot
supersede a task that has *not started*: `updateContextMenuForTab` claims its
generation inside the `setTimeout` callback, so a rebuild queued before the teardown
but fired after it claims a **newer** token and wins — rebuilding the menu the user
just switched off. The plan's invariant 10 was correct about the mechanism it named
and incomplete about the debounce interaction. The test
`tears down without a rebuild resurrecting the menu` pins this and reddens when the
cancellation is removed (prove-red M2).

## D3 — the duplicate-ID race test asserts per-rebuild uniqueness, and is named for what it proves

**Plan said** (T1/AC1.1): "no ID is passed to `create` twice across the sequence".

**Implemented**: the call log is segmented by the interleaved `removeAll` calls and
each segment is required to be internally unique.

**Reason**: Chrome rejects a duplicate id only among *currently registered* items, and
every rebuild begins with `removeAll`. Asserting uniqueness across the whole log would
fail on two legitimate sequential rebuilds (each recreates `psso-parent`), which is
not the defect. Segmenting matches Chrome's actual rejection scope.

**Honesty note, recorded deliberately**: this assertion does **not** redden when
serialization is removed (verified — mutation M1 on the chain left it green). Because
`createMenuItem` awaits each callback, one rebuild's create batch cannot interleave
with another's in the test harness regardless. The test was therefore **renamed** from
"produces no duplicate id…" to "runs both rebuilds to completion without interleaving
their create batches", and a comment states what it does and does not prove, rather
than leaving a decorative assertion under a name implying more. The supersession
behaviour the generation token provides *is* pinned by
`keeps the newest host's items when an older rebuild resolves last`, which reddens
when the guard is disabled (prove-red M1).

### D3a — follow-up: serialization is not observably load-bearing (Phase 3 finding T1)

Phase 3's testing reviewer raised this as a Major: the branch ships two mechanisms and
only one of them is pinned by any test. Confirmed independently, and then investigated
further. **Three separate experiments, all agreeing:**

1. **Reviewer's**: deferring the mock callback (`queueMicrotask`, `setTimeout`) against
   serialization-removed code — traces byte-identical to the fixed code.
2. **Mine, contiguity oracle**: added an assertion that no `removeAll` may fall between
   a rebuild's first and last `create` (ordering, which per-segment uniqueness discards).
   Green with serialization removed. The merged event log is identical either way:
   `["RESET","psso-parent","RESET","psso-parent","psso-login-e2","psso-login-sep","psso-open-popup"]`.
   The test was **reverted rather than shipped** — a second assertion that cannot fail is
   worse than none.
3. **Mine, realistic registry**: a probe modelling Chrome's actual behaviour — async
   `create` callbacks plus a live `Set` of registered IDs that raises
   `Cannot create item with duplicate id …` on collision. Zero duplicate rejections both
   with and without the chain.

**Why**: the generation token supersedes the older rebuild *before* it reaches its create
batch, so there is never a second batch to collide with. Serialization is therefore
**redundant with the generation token** for the duplicate-ID defect, on every path the
tests can reach. It is not dead code — it still guarantees `removeAll`/create ordering
across tasks, which is what makes RK2's self-correction argument well-founded, and it is
what allows `disableContextMenu` to run as one atomic teardown. But the plan's claim that
it is one of *two independently necessary* mechanisms for FR1 is not supported by
evidence.

**Disposition**: kept, with the claim corrected rather than the code changed. Removing it
would make the correctness of the whole design rest on the generation token alone, whose
own resume-point enumeration was a Round-2 finding — a fragile place to put a single point
of failure for a security-adjacent control. The plan's T1 per-mechanism prove-red clause
(plan.md:529, "revert only `serializeMenuTask`'s chaining → the duplicate-ID assertion must
redden") is recorded here as **unsatisfiable as specified**, not as satisfied. What would
settle it: a real-browser harness (blocked, VC1/AD1) or an ordering assertion at a seam the
mock does not flatten.

## D4 — test `extractHost` fixture tightened to mirror production

**Not in the plan.** The existing `createDeps` fixture used
`new URL(url).hostname`, which returns `"settings"` for `chrome://settings` — more
permissive than production `extractHost`, which rejects non-http(s) schemes
(`url-matching.ts:1-10`). The fixture masked the deny path: a `chrome://` click
appeared to resolve a host. Fixed to mirror production semantics. This is an RT1
mock-reality divergence that existed before this change and would have made AC5.3
pass for the wrong reason.

## D5 — `ORIGIN_MISMATCH` / `UNKNOWN_ORIGIN` / `FILL_FAILED` added to `ERROR_KEY_MAP`

Per C5 invariant 7. `ORIGIN_MISMATCH` was absent, so `humanizeError` returned the raw
identifier. Two **distinct** messages were added per invariant 8 — "this credential is
for a different site" vs "could not verify this page" — in both shipped locales
(`en`, `ja`). `FILL_FAILED` reuses the existing `errors.autofillFailed` string.

## D6 — stale comments in `index.ts` corrected

`performAutofillForEntry`'s `enforceSenderHost` doc comment stated that
"popup/context-menu callers pass undefined because the user picked the entry in
trusted UI" — the exact rationale C5 refutes. Also the `executeTarget` and
`sendFillMessage` comments both named the context menu as a no-frameId caller. All
three corrected; leaving them would have left the codebase asserting the opposite of
what it now does (R29: a false reason under a true conclusion is what licenses the
next wrong edit).

## Pre-existing failures — NOT introduced by this change

`npx vitest run` at the repo root reports **16 failures across 4 files**, all under
`scripts/__tests__/`:

- `deploy-rollback.test.mjs` (10)
- `check-fail-closed-routes-have-test.test.mjs` (3)
- `check-worker-bundle-smoke.test.mjs` (2)
- `check-no-pipe-into-grep-q.test.mjs` (1)

**Verified pre-existing**: stashing all changes and re-running the same four files on
`1bf1c338` (the plan commit) reproduces the identical 16 failures. They are deploy /
worker-bundle / shell-gate tests with no import path to `extension/`, which this change
does not touch.

**Diagnosis (not merely "pre-existing")**: verified on a clean `main` checkout with zero
changes applied — the same failures reproduce. `check-no-pipe-into-grep-q` fails with
`MISSED(rc=141)`, i.e. SIGPIPE: the test builds a ~3 MB haystack and asserts `grep -l`'s exit
status under `set -o pipefail`, so the result depends on this machine's pipe buffering rather
than on any repository code. The deploy and worker-bundle suites are in the same class —
infrastructure gates exercising ECS rollout, cosign signature verification, and worker boot,
none of which this branch's files can reach.

**Anti-Deferral**: *Not fixable from this branch — environment-dependent, surfaced to the user.*
**Cost of fixing now**: these
are infrastructure gates (ECS deploy rollback, cosign signature enforcement, worker
bundle boot smoke) whose failures are unrelated in both subject and cause to a browser-
extension console-warning fix; diagnosing them means loading an entirely separate
subsystem and would make this PR unreviewable as one change. **Cost of deferring**: the
root suite is not green on `main` today, so this PR neither improves nor worsens that
signal. **Mitigation**: recorded here with the reproducing command so the next reader
does not attribute them to this branch.

## D7 — Phase 3 findings addressed (T2, T4, T5)

**T2 (Major) — `classifyLastError` had no test.** It is the mechanism AD1's
cost-justification names as its mitigation, so shipping it untested would have made that
Anti-Deferral entry hollow. Added `extension/src/__tests__/log.test.ts` (8 cases) covering
every clause of C1 invariant 5, plus an integration case in `context-menu.test.ts` proving
`createMenuItem`'s callback actually reaches the classifier (RT5 — a log.ts unit test alone
would not).

Prove-red, four separate mutations of the classifier, each reddening a different case:
swap the precedence order; treat empty-string as absent; drop the absent-error guard; alter
the duplicate literal. Plus one on the call site: reverting `createMenuItem` to
`void chrome.runtime.lastError` (the NFR1 regression) reddens the integration case — so the
no-suppression invariant is now enforced by a test rather than only by a grep.

**T4 (Minor) — the test `extractHost` fixture still diverged from production.** D4 tightened
it for schemes but kept `parsed.hostname` raw, while production applies `normalizeHost`
(strips a leading `www.`, lowercases). The fixture's comment claimed to mirror production
and did not. Replaced the hand-written double with the **real** `extractHost` import, and
added a `https://WWW.GitHub.com/login` case. Prove-red: restoring the old fixture reddens
it. This also removes the class of defect rather than the instance — the fixture can no
longer drift from the predicate it stands in for.

**T5 (Minor, QUESTION) — AC6.5's module-state reset.** Answered by experiment rather than
argument. There is no reset hook for `menuChain`/`menuGeneration`; the non-wedge property
comes from two redundant mechanisms — `menuChain.then(task, task)` runs the next task on the
rejection path, and the stored handle's `.catch()` stops a rejection becoming the chain's
terminal state. **Either alone suffices**, which is why removing just one leaves the existing
`does not wedge the chain` test green; removing **both** makes it fail. That is belt-and-braces,
not redundancy to strip. Recorded in a comment on the test so the next reader does not mutate
one, see green, and conclude the test is decorative.

I drafted two further tests during this pass and **deleted both** rather than ship them: a
contiguity oracle for T1 (see D3a) and a separate non-wedge test that turned out not to pin
its mechanism either. An assertion that cannot fail is worse than a missing one, because it
reads as coverage.

**T1 (Major) — see D3a above.** Not fixable by a better test; recorded as an unsatisfiable
plan clause with the evidence.

**T3 (Major) — implemented, see below.**

## T3 — C5 layer-2 tests: IMPLEMENTED (was deferred, now closed)

Initially recorded as an Anti-Deferral entry on fixture-cost grounds. Reconsidered and
built: the cost argument was real but the exposure it accepted — a silent argument
transposition releasing a credential — is not the kind of thing to leave to a manual test.

**What was added** to `extension/src/__tests__/background.test.ts` (10 tests), driving the
real `handleContextMenuClick` through the real `performAutofillForEntry` rather than a
`ContextMenuDeps` stub:

- **Allow, pinned**: a matching frame host produces exactly one `AUTOFILL_FILL`, asserted on
  the payload (`username`) and the frame addressing (`{ frameId: 0 }`) — not `ok: true`.
- **Deny, three shapes**: a cross-origin subframe click whose *top tab* matches the entry
  (the vector Round-2 S6 identified); a tab navigated away from the entry host; and a click
  where no URL yields a host. Each asserts the **absent** `AUTOFILL_FILL` mutation.
- **AC5.4's five-row subdomain oracle**, expectations hand-written, never computed from
  `isHostMatch`: `example.com`/`app.example.com` → fill; `app.example.com`/`example.com` →
  refuse (the argument-order oracle); `notexample.com` → refuse;
  `example.com.evil.com` → refuse; exact match → fill. Two allows, three denies, so an
  always-deny implementation fails.
- **C5 invariant 6's accepted residual, pinned as an explicit allow**: a CC entry still fills
  on a navigated page, and does so **frame-scoped**. Written deliberately with *no* `frameId`,
  because that is the only case where `sendFillMessage` and `sendSensitiveFillMessage` diverge
  — with a frameId present both address the same frame and the test could not tell them apart.

**Harness change**: `chrome.contextMenus.onClicked.addListener` was a bare `vi.fn()`, so the
click handler was uncapturable. It now pushes into `contextMenuClickHandlers`, matching the
file's existing pattern for message/alarm/tab handlers. Menu IDs must be UUID-shaped
(`parseMenuEntryId`), so these tests cannot reuse the content path's `pw-1` convention.

**Prove-red — the result that justifies the layer split.** Three mutations of the adapter at
`index.ts`:

| Mutation | `background.test.ts` | `context-menu.test.ts` (stub layer) |
|---|---|---|
| transpose `teamId` ↔ `enforceSenderHost` | **3 fail** | **34 pass — blind** |
| drop the `enforceSenderHost` pass-through | **5 fail** | — |
| drop the `frameId` pass-through | **1 fail** | — |

The first row is the one that matters. Both parameters are `string | undefined`, so the type
system cannot catch the swap, and the stub-layer suite stays entirely green while a credential
would be released to an unverified host. That is precisely the hazard plan.md:392 named, and
it is now caught.

**Residual after this work**: none for the adapter. The CC/Identity origin residual (C5
invariant 6) remains by design, now with its delivery bound under test.

## D8 — C3 widened to `check-dist-hygiene`, and the `.DS_Store` source removed

**Not in the plan.** Raised by an external review of the branch: a hand-built
`passwd-sso-extension.zip` in the worktree contained `.DS_Store`.

**Root cause, which the report's framing did not reach**: the file was not merely
*in the zip* — its source is `public/.DS_Store`. That path is gitignored, so it never
appears in `git status`, but `vite build` copies `public/` verbatim into `dist/`, and
`emptyOutDir` does **not** clear dotfiles (Vite preserves them). Deleting
`dist/.DS_Store` alone was proven insufficient: it reappeared on the very next
`vite build`.

**Fix, on both ends**:

1. Deleted `public/.DS_Store` — the source. Without this the gate below would redden
   every build rather than prevent the defect.
2. Widened C3's script to reject OS/editor junk anywhere under `dist/`, and renamed it
   `check-dist-hygiene.mjs` since it now serves two checks on one walk. There is no
   packaging script to fix instead, so the check belongs on the directory the build
   owns; a future Finder visit to `public/` recreates the source and this is what
   catches it.
3. Gitignored `passwd-sso-extension*.zip` / `extension/*.zip`.

**On the zip itself**: left in place. It is a stale local artifact predating the
toolchain reconciliation — it carries `index-B2Kp_COK.css`, which no current build
emits — not a release. It is not mine to delete, and it can no longer be committed by
accident.

**Prove-red**: five criteria, each exiting non-zero on its own (C3-a through C3-f in the
table below, minus the shared green case). The junk check needed no synthetic fixture —
it failed against the real `.DS_Store` on its first run.

**Process note**: while checking the gate I read `npm run build 2>&1 | tail -6; echo $?`
as exit 0 and briefly concluded it was fail-open. That was `tail`'s status, not the
build's — the R44 lossy-channel trap, hit while inspecting a gate for exactly that class
of defect. Measured unpiped, it exits 1 correctly.

## Verification summary

| Gate | Result |
|---|---|
| `tsc --noEmit` (extension) | pass |
| `vitest run` (extension) | **61 files / 979 tests pass** (was 59 / 940 — 2 files, 39 tests added) |
| `npm run build` (extension, incl. C3 gate) | pass — "3 HTML file(s) scanned, no modulepreload links, no junk files" |
| `eslint -c eslint.extension.config.mjs` | pass |
| `npm run lint` (root) | pass |
| `npx next build` (root) | pass |
| `npx vitest run` (root) | 16 pre-existing failures, verified against base commit |
| Contract conformance (6 forbidden patterns) | all clean |

### Prove-red executed (each mutation on a scratch copy, production never mutated)

| # | Mutation | Result |
|---|---|---|
| M1 | generation guard always returns true | 1 test reddens |
| M2 | `disableContextMenu` no longer cancels the debounce | 1 test reddens |
| M3 | `doUpdateMenu` skips `isContextMenuEnabled` | 1 test reddens |
| M4 | drop the `enforceSenderHost` pass-through | 7 tests redden |
| M5 | bind to `tab.url` instead of `frameUrl` | 7 tests redden |
| M6 | unresolvable host falls through instead of denying | 2 tests redden |
| M7 | discard the `{ok,error}` result | 1 test reddens |
| C3-a | `modulePreload: true` | gate exits 1 |
| C3-b | `dist/` deleted | gate exits 1 |
| C3-c | `dist/` present, zero HTML files | gate exits 1 |
| C3-d | injected throw in the walk | gate exits 1 |
| C3-e | junk file at the top level of `dist/` | gate exits 1 |
| C3-f | junk file nested under `dist/assets/` | gate exits 1 |
| L1 | `classifyLastError` precedence swapped | 1 test reddens |
| L2 | empty message treated as absent | 1 test reddens |
| L3 | absent-error guard dropped | 2 tests redden |
| L4 | duplicate-id literal altered | 3 tests redden |
| W1 | `createMenuItem` discards `lastError` (NFR1 regression) | 1 test reddens |
| F1 | old raw-`hostname` fixture restored | 1 test reddens |
| P1 | **transpose `teamId` ↔ `enforceSenderHost`** | **3 layer-2 tests redden; stub layer 34/34 green** |
| P2 | drop `enforceSenderHost` at the adapter | 5 layer-2 tests redden |
| P3 | drop `frameId` at the adapter | 1 layer-2 test reddens |
| R1 | route CC through the tab-wide sender | 1 test reddens |

Restored to green after every mutation. **P1 is the load-bearing one**: both parameters are
`string | undefined`, so the type checker cannot see the swap, and the stub-layer suite stays
fully green while a credential would be released to an unverified host.

### Mutations that did NOT redden — recorded, not hidden

| Mutation | Result | Disposition |
|---|---|---|
| `serializeMenuTask` → `return task()` | all green | D3a — serialization is redundant with the generation token for this defect; kept as defence in depth, claim corrected |
| drop the stored handle's `.catch()` | all green | either rejection safeguard alone keeps the chain moving; annotated on the test |
| `then(task, task)` → `then(task)` | all green | same — only removing **both** reddens `does not wedge the chain` |

Three tests were drafted and **deleted** rather than shipped after mutation showed they could
not fail: a contiguity oracle, a second non-wedge test, and an earlier CC residual test that
supplied a `frameId` (which makes the two senders indistinguishable). An assertion that cannot
fail is worse than a missing one, because it reads as coverage.
