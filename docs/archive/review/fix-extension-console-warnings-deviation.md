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

**Anti-Deferral**: *Skipped — pre-existing, out of scope.* **Cost of fixing now**: these
are infrastructure gates (ECS deploy rollback, cosign signature enforcement, worker
bundle boot smoke) whose failures are unrelated in both subject and cause to a browser-
extension console-warning fix; diagnosing them means loading an entirely separate
subsystem and would make this PR unreviewable as one change. **Cost of deferring**: the
root suite is not green on `main` today, so this PR neither improves nor worsens that
signal. **Mitigation**: recorded here with the reproducing command so the next reader
does not attribute them to this branch.

## Verification summary

| Gate | Result |
|---|---|
| `tsc --noEmit` (extension) | pass |
| `vitest run` (extension) | **59 files / 953 tests pass** (was 940 — 13 added) |
| `npm run build` (extension, incl. C3 gate) | pass — "3 HTML file(s) scanned, no modulepreload links" |
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

Restored state after every mutation: 32/32 green.
