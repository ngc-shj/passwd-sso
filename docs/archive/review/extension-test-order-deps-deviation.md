# Coding Deviation Log: extension-test-order-deps

## Acceptance evidence (executed 2026-08-22; all outputs file-captured per the rtk evidence-capture rule)

| ID | Command / procedure | Result |
|----|---------------------|--------|
| A1 | `npx vitest run --sequence.shuffle.files=false --sequence.shuffle.tests=true --sequence.seed=$s` for s ∈ {1..8, 12345} | 9/9 GREEN (1029/1029 each) |
| A2 | `npx vitest run --sequence.shuffle --sequence.seed=$s` for s ∈ {1..50} | 50/50 GREEN (baseline before fixes: 49/50 RED) |
| A3 | Per-file pre-fix red seeds recorded before each fix, re-run green after, per batch reports (e.g. totp-handlers seeds 3/9/11/12/14/17/18/20/22/24/25/28; background 28/30 seeds; dpop-key 2/6/7/16/24/28/30/31/40/52; form-detector-entry 12 seeds; login-detector 15 seeds). Provenance of seeds > 50 (e.g. dpop-key's 52, login-detector's 53/71/78): the fix batches ran PER-FILE discovery sweeps (`npx vitest run src/__tests__/<file> --sequence.shuffle.tests=true --sequence.seed=N`) beyond the plan's suite-level 1..50 sweep, widening until the failure surfaced repeatedly — commands and logs in the batch scratch logs | all recorded seeds GREEN post-fix |
| A3m | Scratch worktree; deny = pre-fix positional totp-handlers + steal-window `vi.waitFor` flush after `unlockVault()` in "does not include totpCode when totp is absent" → `{ok:false}` (NO_PASSWORD shape) 3/3 runs; allow = keyed file + byte-identical flush → 3/3 GREEN | deny RED 3/3, allow GREEN 3/3 → **M3 VERIFIED** |
| A4 | `npx vitest run --sequence.shuffle=false` (CLI override of the config gate) | GREEN, no seed line (shuffle off confirmed) |
| A5 | 10 consecutive `npx vitest run` (config shuffle, random seeds) | 10/10 GREEN; seeds 1787352720534, 1787352727780, 1787352734668, 1787352742181, 1787352749156, 1787352756253, 1787352763816, 1787352771470, 1787352778721, 1787352785764 — pairwise distinct |
| A6 | Scratch worktree with the gate config: revert `totp-handlers.test.ts` to its pre-fix state → `--sequence.shuffle --sequence.seed=12345` exits 1, sole failure in that file ("returns TOTP code…"); restore fix → same seed exits 0 (1029/1029) | deny RED / allow GREEN |
| A7 | Idle-machine like-for-like: before = fact 4 (~6.2–7.2 s, pre-fix); after = A5 walls 6.8–7.7 s (idle, shuffled) | within noise — no material regression (issue `#784`'s perf question answered) |
| A8 | `bash ~/.claude/hooks/check-pre-pr.sh run` (full parallel batch incl. "Extension: Test" — the environment fact 5 names) | 62/62 checks PASSED |

Post-A-run addition (self-R-check R1 fix): the duplicated keyed-decrypt logic
was extracted to `extension/src/__tests__/helpers/keyed-decrypt-mock.ts`
(shared by background.test.ts and totp-handlers.test.ts); after extraction:
tsc clean, 3 shuffled runs per file GREEN, full suite GREEN (seed
1787376666155). The helpers/ file is not matched by vitest's test include
(`*.test.*`), so the 61-file count is unchanged.

## D0 — A3m executed: M3 VERIFIED (fact 5 upgraded from "hypothesized")

A3m ran on a scratch git worktree (detached, node_modules symlinked, removed
after): deny = pre-fix positional totp-handlers + steal-window `vi.waitFor`
flush inserted after `unlockVault()` in "does not include totpCode when totp
is absent" → RED 3/3 runs with exactly the pre-pr failure shape
(`{ok:false}` vs `{ok:true}`, NO_PASSWORD); allow = fixed input-keyed file +
byte-identical flush → GREEN 3/3. The pair differs only in positional-queue
vs keyed mock, as C1-A3m requires. Logs: scratchpad `a3m-deny-{1..3}.log`,
`a3m-allow-{1..3}.log`. Consequence: C4's PR body marks M3 "verified".

## D0b — totp-handlers I3 conversion applied by the orchestrator post-batch

Batch 1 fixed totp-handlers' M1/M2 but left its positional decryptData
queues; since fact 5 diagnoses M3 in this exact file (the pre-pr NO_PASSWORD
failure), the orchestrator applied the input-keyed conversion (mirroring
background.test.ts's pattern) before acceptance. 17 shuffle seeds + default
order + full suite green after conversion.

## D0c — citation-rot gate scope: review artifact excluded

`verify-references.sh --strict` runs over the plan + deviation log (green,
2/2 ok after annotating pre-fix line citations as historical). The review
artifact is excluded: it preserves expert outputs verbatim (Step 1-5
obligation), and their citations (node_modules dist paths, short-path
file:line evidence) are historical review evidence, not live contracts —
rewriting them would falsify the record.

## D1 — I3 end-of-test flush not added to M3-fixed tests (deviation from C1-I3 letter)

C1-I3 requires each M3 fix to "deterministically flush the fire-and-forget
consumer before the test ends" so a keyed-mock miss reds the causing test.
Neither `background.test.ts` nor `background/totp-handlers.test.ts` adds a
per-test flush. Rationale: the flush's purpose is miss-ATTRIBUTION (a throw in
an unawaited consumer would surface as an unhandled rejection on an arbitrary
test). Both files' `beforeEach` unconditionally map `"11"` — verified by
reading `background/index.ts` → `invalidateContextMenu` → `doUpdateMenu` →
`getCachedEntries` → `decryptOverviews` to be the ONLY ciphertext the
fire-and-forget consumer ever requests — so the consumer structurally cannot
hit the miss path and the attribution hazard the flush guards against is
unreachable. The A3m red-proof (deny/allow pair with a steal-window flush on a
scratch worktree) separately proves the mechanism; see the acceptance
evidence. Anti-Deferral: cost of adding a `vi.waitFor` flush to every M3 test
≈ +200 ms × ~40 tests per run for a hazard shown unreachable; benefit none
while `"11"` is beforeEach-mapped. Revisit if a future fetch stub introduces a
second consumer-visible ciphertext.

## D2 — C1-I3 member set: inline-matches / team-entries classified `contained`, not converted

`background/inline-matches.test.ts` and `background/team-entries.test.ts` are
B3 (mockResolvedValueOnce) candidates that import `background/index`. C2
classification (Batch 3): their helpers reset AND re-queue the decryptData
mock at the start of every test; 30–60 shuffled seeds green; team-entries'
one persistent override (L343) resolves to a value identical to the hoisted
default (no observable escape). I3's conversion obligation applies "in the
files where M3 is diagnosed" — M3 is diagnosed in `background.test.ts`
(observed slot-steal: base-default overview leaked into `allowedHosts`) and
`totp-handlers.test.ts` (issue #784's observed pre-pr NO_PASSWORD); both are
converted. The two `contained` files retain a theoretical load-axis exposure
(a stray 200 ms debounce timer from a prior test consuming a queued Once
mid-test); the standing shuffle gate plus pre-pr (A8 environment) are the
detection path. Anti-Deferral: converting two more files rewrites their
helper-based fixture architecture for a mechanism never observed there;
cost-benefit favors gate coverage. Revisit on the first gate trip in either
file.

## D3 — Batch-3 process deviations from the delegation contract (both remediated)

(a) A throwaway probe test (`zzz-clearmocks-probe.test.ts`) was briefly
created inside the real tree instead of the scratchpad (used to verify that
`vi.clearAllMocks()` does not clear queued `mockXxxOnce` values). Deleted by
the same agent; orchestrator verified absence (`git status` clean, no `zzz*`
files) and ran the mandatory R21 residue grep over the full diff — clean.
(b) `content/form-detector.test.ts`'s red-proof reverted the fix on the real
file via a captured+reversed patch instead of a scratch copy; the fix was
restored immediately and the orchestrator verified the final diff contains
exactly the intended two-line change (spy captured + `mockRestore()`), no
residue. Both are process violations of the "throwaway copies under the
scratchpad only" instruction — recorded here so Phase 3 reviews the affected
files with that knowledge; neither left artifacts in the tree.

## D4 — login-detector mechanism differs from the plan's hypothesis

Plan hypothesized leaked `chrome.runtime.onMessage` listeners. Actual
diagnosis (Batch 2): (root) `mockSendMessage.mockImplementation(...)` set by
5 tests, never restored — `clearAllMocks` clears calls, not implementations;
(cascade) victims' assertion throws skipped their trailing
`cleanup.destroy()`, leaking document-level submit/click listeners into the
next test. Fix closes the class: `mockSendMessage.mockReset()` in the local
beforeEach + afterEach-guaranteed `currentCleanup?.destroy()` so cleanup
survives assertion failures. No contract change — diagnosis refinement only.

## D5 — SC2 pre-committed triage executed: security hypothesis CLOSED

The M3 fire-and-forget consumer is real production code
(`background/index.ts`: UNLOCK_VAULT → `invalidateContextMenu()` → 200 ms
debounce → `doUpdateMenu` → `getCachedEntries()` → `decryptOverviews()`), but
in production `decryptData` is `crypto.subtle.decrypt` — a pure function of
its actual ciphertext input. There is no shared position-based response slot
to race for, so credential/overview mis-association cannot occur; the only
effect is a possible redundant idempotent fetch+decrypt. Per SC2's
pre-committed branch: mock-positional only → hypothesis noted and closed; no
`security`-labeled issue filed.

## D6 — dpop-key culprit is test-fixture schema racing, wider than the plan's M4 sketch

The all-or-nothing failure was NOT cache/order semantics but two ad hoc
`indexedDB.open("psso-ext", 1)` calls without `onupgradeneeded`: whichever
connection first bumps 0→1 wins the upgrade event; a bare open winning it
creates no `dpop-keys` store, and every later open at the same version gets
`NotFoundError` forever. Fix: schema-safe shared `openTestDb()` helper
(mirrors production `openDb()`) + awaited per-test `deleteTestDb()` baseline.
Production `src/lib/dpop-key.ts` untouched (its `openDb()` already carries
the handler).

## D7 — form-detector-entry: production error handler does not self-remove (report-only)

`content/form-detector.ts` registers `window.addEventListener("error", …)` at
import with no removal — benign in production (one registration per frame
load), but it is what leaks across tests sharing one jsdom window. Test-only
fix (track + remove listeners in afterEach); production untouched per SC2's
no-unrequested-scope rule.

## C2 classification table (final, all five Set B subsets — reconciled)

Derivations re-run at implementation time from `extension/src/__tests__/`:
B1 spyOn-without-restore = 3, B2 widened-override hit files = 28, B3
mockResolvedValueOnce = 12, B4 stubGlobal-without-unstub = 23, B5
module-scope `let` = 10. Verdicts:

### real-leak (fixed)
| File | Occurrence | Mechanism | Fix |
|---|---|---|---|
| background/totp-handlers.test.ts | `generateTOTPCode.mockReturnValue("654321")` in test body | M1 | `mockReturnValueOnce` |
| background/totp-handlers.test.ts | `vi.spyOn(Date,"now")` unrestored | M2 | captured spy + `mockRestore()` in `finally` |
| background/totp-handlers.test.ts | positional decryptData Once queues (6 sites) | M3 (issue #784 pre-pr NO_PASSWORD shape) | input-keyed `setDecryptedPlaintext` + throw-on-miss (orchestrator, post-batch) |
| background.test.ts | `stubLoginFetch` helper `mockReset()` + Once queues; `"succeeds via sendMessage…"` `mockReset()`; `"still fills a CREDIT_CARD…"` persistent `mockResolvedValue`; 6 Once chains | M1+M3 | input-keyed `setDecryptedPlaintext` + throw-on-miss; hazardous `mockReset()`s removed |
| dpop-key.test.ts | 2 raw `indexedDB.open` without `onupgradeneeded` | M4 (schema-upgrade race) | schema-safe `openTestDb()` + awaited per-test DB delete |
| content/form-detector-entry.test.ts | entry-point `window` "error" listeners never removed across tests | M5 (DOM listener leak) | tracked listeners removed in afterEach |
| login-detector.test.ts | `mockSendMessage.mockImplementation` ×5 in test bodies | M1-shaped | `mockReset()` in local beforeEach |
| login-detector.test.ts | `mockFindPasswordInputs`/`mockFindUsernameInput` `mockReturnValue` in test bodies (~8 sites) | M1-shaped (latent — every consuming test sets its own values) | `mockReset()` for both added beside `mockSendMessage.mockReset()` (Phase 3 R1 finding) |
| login-detector.test.ts | document submit/click listeners leak when assertion throws before `cleanup.destroy()` | cascade of above | afterEach-guaranteed `currentCleanup?.destroy()` |
| lib/messaging.test.ts | L18/L38/L51 persistent sendMessage overrides | M1 (latent — no seed reproduces; victim assertion absent) | `…Once` conversions |
| popup/App.test.tsx | 5 persistent sendMessage overrides incl. never-settling promise | M1 (latent) | `mockSendMessage.mockReset()` in beforeEach |
| content/form-detector.test.ts | `vi.spyOn(window,"getComputedStyle")` unrestored | M2-shaped (latent — fallthrough transparent) | captured spy + `mockRestore()` |
| context-menu.test.ts | `tabs.query.mockResolvedValue` persistent ×3, consumed by beforeEach's own `invalidateContextMenu()` | M1-shaped (latent) | `tabs.query.mockResolvedValue([])` re-established in beforeEach |

### m3-race
None beyond the two converted files: every other B3 file's queue is per-test
fresh or 1:1-consumed (see D2 for the two `contained` borderline files).

### contained (untouched — one row per remaining candidate)
api.test.ts (per-test `installChromeMock` factory) · background-commands.test.ts
(restoreAllMocks afterEach + factory) · background-login-save.test.ts
(`createDeps()` factory) · background-passkey-provider.test.ts (same) ·
background/inline-matches.test.ts (helpers reset+re-queue per test; D2) ·
background/log.test.ts (restoreAllMocks afterEach) ·
background/start-connect.test.ts (per-test deps) · background/swFetch-dpop.test.ts
(explicit mockReset + default re-set every beforeEach) ·
background/team-entries.test.ts (helpers re-queue; L343 value = default; D2) ·
content/autofill-cc.test.ts, content/autofill-identity.test.ts,
content/select-diag.test.ts, lib/totp.test.ts (restoreAllMocks afterEach) ·
content/token-bridge.test.ts, content/token-bridge-user-activation.test.ts
(per-test mock recreation) · content/ui/suggestion-dropdown.test.ts
(module-init stub, never mutated) · content/form-detector-inline.test.ts
(mockReset + fresh stub every beforeEach) · content/cc-identity-detector.test.ts
(`installChrome()` per test) · lib/storage.test.ts, lib/disconnect-reason.test.ts
(recreated every beforeEach) · lib/session-storage.test.ts (default impl reset
in beforeEach) · options/App.test.tsx (all mocks reset every beforeEach) ·
popup/LoginPrompt.test.tsx (fresh stubGlobal per beforeEach) ·
popup/MatchList.test.tsx (1:1 Once consumption; 30 seeds green) ·
popup/VaultUnlock.test.tsx (each reaching test sets its own value; 15 seeds
green) · webauthn-bridge-lib.test.ts (per-test recreation + restore/unstub
afterEach) · log.test.ts (describe-scope console spy, uniform for all tests) ·
content/form-detector.test.ts remaining spyOn sites (per-test-local DOM
elements) · background/totp-handlers.test.ts and background.test.ts chrome mocks (fresh
factory every beforeEach) · background.test.ts "tab event badge updates" beforeEach
(unconditional `mockResolvedValue` re-establishment — composes with keyed
impl in either order).

Additional mechanism note (Batch 3): `vi.clearAllMocks()` does NOT clear
queued-but-unconsumed `mockXxxOnce` values (only `mockReset()` does). Every
B3 file was checked for over-provisioned queues; none found. The standing
gate covers this class dynamically.
