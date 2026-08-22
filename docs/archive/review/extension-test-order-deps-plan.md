# Plan: extension-test-order-deps

Fix order-dependent test failures in the `extension/` vitest suite (issue #784).

## Project context

- Type: `mixed` (browser extension — TypeScript, MV3 service worker + content scripts; this task touches only test files and the vitest config)
- Test infrastructure: `unit tests + CI/CD` (vitest 4.1.10; CI job "Extension: Test → Build"; local gate `scripts/pre-pr.sh` step "Extension: Test" runs `cd extension && npm test`)
- Verification environment constraints: none — every contract in this plan is `verifiable-local` (all evidence is produced by `npx vitest run` variants inside `extension/`). No paid-tier, hardware, or multi-tenant path is involved.

## Objective

`npx vitest run --sequence.shuffle` must be green for any seed, and stay green:
the suite must not depend on test execution order, and a regression must be
detected by the standing gates (dev runs / pre-pr / CI) rather than by an
unrelated PR author.

## Established facts (measured on this branch, extension/ at af1d00362)

All commands below were run and their outputs recorded; re-run to reproduce (R29).

1. **The failure class is IN-FILE test-order dependence, not cross-file leakage.**
   - `npx vitest run --sequence.shuffle.files=true --sequence.shuffle.tests=false --sequence.seed=<s>` → green for s ∈ {42, 999, 12345} (1029/1029).
   - `npx vitest run --sequence.shuffle.files=false --sequence.shuffle.tests=true --sequence.seed=12345` → 3 files / 5 tests fail — the same 5 that fail with full shuffle at that seed.
2. **`isolate: true` is a no-op.** vitest 4 defaults `isolate` to `true`
   (verified empirically: `createVitest('test',{}).config.isolate === true` on
   the installed 4.1.10). The root config's explicit `isolate: true` is
   documentation, not behavior. Cross-file JS state cannot leak today; the
   issue's leading hypothesis is refuted.
3. **vitest prints the seed on every shuffled run** (`Running tests with seed "N"`),
   so a randomly-seeded gate failure is always reproducible.
4. **Shuffle does not change suite duration** (measured ~6.2–7.2 s both ways; same
   1029 tests, same workers).
5. **The pre-pr plain-run failure is explainable without shuffle — as a
   hypothesis (M3) until Phase 2 proves it.** pre-pr deletes
   `extension/node_modules/.vitest` (timing cache → file order changes,
   harmless per fact 1) and runs the suite concurrently with `next build` etc.
   Under CPU load, fire-and-forget async work in `background/index` interleaves
   differently between tests of the SAME file, misaligning `mockResolvedValueOnce`
   queues (mechanism M3 below) — which yields exactly the observed
   `NO_PASSWORD` shape. This closure claim is HYPOTHESIZED, not established:
   the order-axis sweep cannot sample load-dependent interleaving, so C1
   carries a dedicated M3 derivation + deterministic red-proof (C1-I3/A3m) and
   C4 carries a full `scripts/pre-pr.sh` green run as evidence. If the
   deterministic M3 red-proof cannot be built for a file, that is a named
   deviation-log entry and the claim stays "hypothesized" in the PR body.

## Root-cause mechanisms identified so far

- **M1 — persistent mock override in a test body.**
  `extension/src/__tests__/background/totp-handlers.test.ts` line 327 as of `af1d00362` (pre-fix; the fix moved this line)
  `totpMock.generateTOTPCode.mockReturnValue("654321")` (no `Once`). The file's
  `beforeEach` runs `vi.clearAllMocks()`, which clears call history but does NOT
  restore return values/implementations. Any test that runs after this one sees
  `"654321"` — matching the seed-12345 failure (`expected "123456", got "654321"`).
- **M2 — unrestored spy.**
  `extension/src/__tests__/background/totp-handlers.test.ts` line 204 as of `af1d00362` (pre-fix; the fix moved this line)
  `vi.spyOn(Date, "now").mockReturnValue(59_000)` with no `mockRestore()` /
  `restoreAllMocks` anywhere in the file. Every later test in the file runs at a
  frozen clock.
- **M3 — positional `mockResolvedValueOnce` queues racing fire-and-forget async.**
  Tests enqueue exactly-ordered Once values (e.g., `[blob JSON, overview JSON]`)
  while the background module performs unawaited async work (overview refresh
  after unlock, alarms) that can consume a queue slot between the intended
  consumers. Which consumer gets which value depends on interleaving — i.e.,
  on machine load, not test order. Deterministic fix: key the mock's response
  on its input (ciphertext → plaintext map) instead of call position.
- **M4 (dpop-key.test.ts, to be confirmed in Phase 2)** — the whole file (10
  tests) fails or passes together under in-file shuffle (seeds 2, 6, 7),
  indicating shared IDB/module-scope key-cache state with an implicit "clean
  boot first / delete last" order assumption.

Victim tests are downstream of the culprit test; per-file diagnosis in Phase 2
must name the culprit (the test or setup that leaves state), not just patch the
victim's assertion.

## Member-set derivation (R42)

The invariant is universally quantified: "no test in `extension/` observes state
mutated by another test." The class is defined by dynamic behavior, so the
authoritative member-set derivation is dynamic (execution under permuted order);
static greps only build the candidate worklist. This ordering is deliberate
(gate-mechanism over spelling enumeration): the standing gate (C3) adjudicates
actual execution and therefore also catches spellings no static pattern lists.

**Set A — dynamic victims** (9-seed sweep; command:
`for s in 1 2 3 4 5 6 7 8 12345; do npx vitest run --sequence.shuffle.files=false --sequence.shuffle.tests=true --sequence.seed=$s; done`, collect `FAIL` lines):

| File | Failing tests observed |
|---|---|
| `src/__tests__/background.test.ts` | `fetches and decrypts password overviews` (all 9 seeds), `autofills successfully`, `autofills with blob username fallback…`, `includes text custom fields…` |
| `src/__tests__/background/totp-handlers.test.ts` | `returns TOTP code when blob contains totp data` |
| `src/__tests__/content/form-detector-entry.test.ts` | `dispatching 'Extension context invalidated' calls every destroy once…` |
| `src/__tests__/login-detector.test.ts` | `ignores unrelated messages`, `does not show banner for PSSO_SHOW_SAVE_BANNER with action=none` |
| `src/__tests__/dpop-key.test.ts` | all 10 tests (file-wide, seeds 2/6/7) |

Phase 2 widens this with a 50-seed sweep (see C1 acceptance) — the 9-seed set is
a lower bound, not the member set; per-seed failure sets varied (1–14 tests in
the issue's own measurements), so more victims are expected.

**Set B — static candidates** (commands run from `extension/src/__tests__/`):

- `vi.spyOn` without any `restoreAllMocks|mockRestore` in the same file
  (`for f in $(grep -rl 'vi\.spyOn(' .); do grep -qE 'restoreAllMocks|mockRestore' "$f" || echo "$f"; done`):
  `log.test.ts`, `content/form-detector.test.ts`, `background/totp-handlers.test.ts`
- Persistent (`Once`-less) override inside a test body — ANY handle spelling,
  not just the object-of-mocks form (review round 1 closed a spelling hole:
  the narrower `*Mock(s).method.mockX` grep missed direct `vi.fn()` handles).
  Derivation: `grep -rn --include='*.test.ts*' -E '\.(mockReturnValue|mockResolvedValue|mockRejectedValue|mockImplementation)\(' .`
  — the include filter is `*.test.ts*` deliberately: it must admit every file
  vitest's default include admits, and the suite has 7 `.test.tsx` files
  (popup/, options/) that a `*.test.ts` filter silently drops (round-2 found 5
  of them carrying hits, incl. M1-shaped test-body overrides in
  `popup/App.test.tsx` under a clearAllMocks-only beforeEach). Classify each
  hit by enclosing scope (test body vs. beforeEach/module scope).
  Object-of-mocks hits: `background-commands.test.ts`,
  `background/swFetch-dpop.test.ts`, `background/team-entries.test.ts`,
  `background/totp-handlers.test.ts`, `background.test.ts`. Direct-handle hits
  verified in round 1: `lib/messaging.test.ts` (lines 18, 38 — M1-shaped,
  `beforeEach` runs `clearAllMocks` only → real-leak candidate);
  `lib/session-storage.test.ts` (inside `beforeEach` → contained);
  `webauthn-bridge-lib.test.ts` (per-test recreation + `afterEach`
  restore/unstub → contained). Round-2 `.tsx` hits: `popup/LoginPrompt.test.tsx`,
  `popup/App.test.tsx` (lines 167, 204 — real-leak candidates),
  `popup/VaultUnlock.test.tsx`, `popup/MatchList.test.tsx`,
  `options/App.test.tsx`. Phase 2 re-runs the widened grep and classifies
  every hit.
- **M3 candidates** (positional Once queues racing fire-and-forget async):
  EVERY file containing `mockResolvedValueOnce` is a candidate — the set is
  input-derived (`grep -rl 'mockResolvedValueOnce' .` → 12 files at plan
  time), NOT filtered by a name-supplied fire-and-forget module list, because
  such a list under-derives (round-2 found unawaited consumers outside
  `background/index`, e.g. `extension/src/content/token-bridge-lib.ts:102`'s
  `void handlePostMessage(event)`, and React-effect consumers in popup tests).
  Each candidate gets a C2 classification row (`m3-race` / `contained —
  consumer awaited / no fire-and-forget import`); one-line contained verdicts
  suffice. Reconciliation counts against this grep's own output, which cannot
  under-derive its left side.
- `vi.stubGlobal` without `unstubAllGlobals`: 23 files — MOSTLY benign (stubbing
  in `beforeEach` re-stubs every test; per-file isolation contains the rest).
  Derivation: `for f in $(grep -rl 'vi\.stubGlobal(' .); do grep -q 'unstubAllGlobals' "$f" || echo "$f"; done | wc -l` → 23.
  ALL 23 get a C2 classification row (per C2's coverage clause); mid-file
  stubs are the ones expected to classify as other-than-`contained`.
- Module-scope `let` in test files: 10 files (candidate shared mutable state).
  Derivation: `grep -rln --include='*.test.ts*' -E '^let ' .` → 10 files incl.
  `options/App.test.tsx` (the round-1 count of 9 used the narrower
  `*.test.ts` filter).

A member in the dynamic set that no static pattern catches is expected (that is
why the gate is dynamic); a static candidate that never fails dynamically is
fixed only when the leak is real (see C2), not to satisfy the grep.

## Technical approach

Two legs, in this order:

1. **Root-cause fixes per file (C1, C2)** — diagnose each dynamic victim file,
   name the culprit test/setup, remove the leak (restore spies, `Once` or
   `beforeEach`-scoped overrides, input-keyed mock implementations, explicit
   IDB/module-state reset). No blanket config flags: `restoreMocks: true` /
   `mockReset: true` at config level would also wipe module-scope defaults set
   once per file load in `vi.hoisted` factories (e.g., the
   `mockReturnValue("123456")` default in totp-handlers), breaking
   currently-green default-order tests — per-file evaluation is required, so
   the fix stays per-file.
2. **Standing mechanism-level gate (C3)** — enable `sequence.shuffle` in
   `extension/vitest.config.ts` so every run (dev, pre-pr, CI — all reach the
   suite via `npm test` → `vitest run`) executes a fresh random order and
   prints its seed. This gates the CLASS (any future order dependence),
   not the instances fixed here. (User decision 2026-08-22: config-level
   always-on, not CI-only.)

Explicitly rejected:
- `isolate: true` in extension config — proven no-op (Established fact 2);
  adding it would misdocument the fix.
- Config-level `restoreMocks`/`mockReset`/`unstubGlobals` — see leg 1.
- `.skip`/loosened assertions on victim tests — masking, not fixing (R36).

## Contracts

### C1 — Per-file order-independence fixes for dynamic victims

- **Signature**: edits confined to `extension/src/__tests__/**` test files named
  in Set A (plus any new victims surfaced by the Phase 2 50-seed sweep).
  No production source (`extension/src/**` outside `__tests__`) changes.
- **Invariants** (app-enforced — the enforcing runtime check is the C3 gate):
  - I1: every test in a fixed file passes with `--sequence.shuffle.files=false
    --sequence.shuffle.tests=true` for every recorded failing seed of that file.
  - I2: each fix names its culprit (the state left behind and by whom) in the
    Phase 2 deviation log; "reordered assertions until green" is not a fix.
  - I3: mock responses that multiple async consumers race for are keyed on
    input, not call position (M3), in the files where M3 is diagnosed (M3
    candidate derivation is in Set B). The keyed mock's MISS behavior is
    specified, not left open: an unmapped input THROWS with the offending
    input named in the message (fail loudly — a silent default hides
    mock-reality divergence), and the key map covers every input the
    background path can request during the test window INCLUDING the
    fire-and-forget consumers (overview refresh after unlock). Because a
    throw inside an unawaited consumer would surface as an unhandled
    rejection attributed to an arbitrary test, each M3 fix also
    deterministically flushes the fire-and-forget consumer before the test
    ends (`await` the observable completion or `vi.waitFor` on an observable
    condition — never a bare setTimeout sleep), so a miss reds THE test that
    caused it. NOTE: this end-of-test flush exists for miss-ATTRIBUTION; it
    is distinct from A3m's steal-window flush (red-proof mechanism) — do not
    conflate the two.
  - I4: in every test file edited under C1/C2, assertions are unchanged or
    strengthened, AND no new early-exit or skip invocation (including
    destructured `TestContext.skip` — `({ skip }) => { skip(); … }`) is
    introduced ahead of them — verified by inspection of the PR diff. The
    early-exit clause exists because an inserted `skip()` leaves every
    assertion textually unchanged while making them unreachable. Scope is the
    edited-file set (the diff itself), not just Set A victims: culprit tests
    are the most-edited tests and their own assertions (e.g., the "654321"
    expectation at the M1 site) must survive the fix. Weakening or deleting
    an assertion to get a seed green is suppression, not a fix (R36).
- **Control class (R49)**: not a control — bug fixes. The controlling gate is C3.
- **Acceptance**:
  - A1: for each seed s ∈ {1,2,3,4,5,6,7,8,12345}: in-file-shuffle run at seed s
    is green (1029/1029).
  - A2: 50-seed sweep (`--sequence.shuffle` full, seeds 1..50) green.
  - A3: red-proof per file-level fix (RT7): on a scratch copy (git stash /
    worktree — never by mutating the working tree's fix), reverting that file's
    fix re-reds at least one recorded seed. Record seed and failing test name.
    Re-seed fallback: shuffled order is a function of seed + test set, so if a
    recorded seed no longer reds after the revert (test count/name changes
    shifted the permutation), sweep seeds 1..50 for a fresh red and record the
    new seed — the red-proof is never dropped, only re-seeded. Deny = leak
    present reds; allow = leak removed greens at the SAME seed; both runs
    recorded every time. Exhaustion exit: if all 50 seeds green on the
    reverted copy, widen once (seeds 51..200); if still no red, record a
    named deviation-log entry with the file, the revert, and the sweep bound
    (fail loudly) — never a silently assumed proof. A red found at any width
    still runs both directions at that seed.
  - A3m: per-MECHANISM red-proof for M3 fixes (order-axis seeds cannot red on
    interleaving): on the scratch copy, revert to the positional Once queue
    AND deterministically flush the fire-and-forget consumer AT THE STEAL
    WINDOW — immediately after the action that schedules the fire-and-forget
    work (e.g., right after `unlockVault()`), BEFORE the first intended
    consumer runs — so the background consumer is forced to take a queue slot
    ahead of the intended one and the misalignment reds EVERY run, not
    probabilistically → deny. A flush placed after the assertions would find
    the queue already drained in order and green the deny run for a
    construction reason, not because M3 is absent. With the input-keyed mock
    in place, the IDENTICAL test body (same flush, same placement — the pair
    differs ONLY in positional-queue vs. input-keyed mock) greens → allow.
    I3's end-of-test flush serves miss-attribution and is not this red-proof.
    If the deterministic pair cannot be constructed because the fire-and-
    forget consumer provably never reaches the mocked decrypt, that is the
    hypothesis DISPROVEN — record it; any other unconstructible case is a
    named deviation-log entry (and fact 5 stays "hypothesized"), never a
    silent skip.
  - A4: default-order run (`npx vitest run`, shuffle disabled via CLI seed
    equivalence is NOT needed — run BEFORE C3 lands or with
    `--sequence.shuffle=false`) remains green — fixes must not trade one
    order's green for another's.

### C2 — Leak-pattern cleanup in static candidates

- **Signature**: for each Set B candidate file, Phase 2 classifies the pattern
  occurrence as `real-leak` (state escapes the test that created it),
  `m3-race` (positional queue racing fire-and-forget async), or `contained`
  (re-established every test by `beforeEach`, or scoped by `mockRestore` in an
  `afterEach`). `real-leak`/`m3-race` occurrences are fixed like C1;
  `contained` ones are left untouched (no retrofitting — coding-style rule).
- **Coverage**: the classification table covers EVERY Set B candidate — all
  spyOn-without-restore files, all widened-grep persistent-override files, all
  M3-candidate files, ALL 23 stubGlobal files, and all 10 module-scope-`let`
  files (a `contained — beforeEach stub` / `contained — reassigned per test`
  one-liner suffices for the benign majority). The enumeration is the five
  Set B bullets, each of which now records its derivation command — the
  reconciliation's left side. A Set B candidate absent from the table is
  itself a deviation-log entry — a skipped candidate fails loudly instead of
  silently dropping out of the audit.
- **Invariant** (app-enforced): a `real-leak`/`m3-race` classification with no
  fix, or a fix with no classification, is a deviation-log entry, not a silent
  skip.
- **Acceptance**: classification table (file × occurrence × verdict × action)
  in the deviation log, row count reconciled against the Set B derivation
  commands' output; fixed files inherit C1's A1–A4 (and A3m where `m3-race`)
  evidence.

### C3 — Standing shuffle gate in vitest config

- **Signature**: `extension/vitest.config.ts` gains `test.sequence.shuffle: true`
  (shuffles both file order and in-file order; file order additionally guards
  any future cross-file channel). The diff to `extension/vitest.config.ts` is
  EXACTLY that single gate line — any other hunk in that file is a named
  deviation-log entry, whatever its spelling (mechanism-level exclusivity:
  the check is diff-shape, not key-name, so unenumerated gate-neutralizing
  keys — `exclude:`, `include:`, `passWithNoTests:`, … — cannot ride along
  un-adjudicated; the key-enumerated forbidden patterns below remain as
  high-risk callouts). The single plan-foreseen exception is the
  Testing-strategy `setupFiles` addition (`src/__tests__/setup.ts`): if that
  contingency is taken, the hunk is admitted WITH its own red-proof and
  full-sweep evidence and is still recorded as a named entry — any other
  hunk remains a deviation. No change to `package.json` scripts, pre-pr, or
  CI workflows — they inherit via `npm test`.
- **Control class (R49)**: **best-effort tripwire.** Each run samples ONE
  ordering from a space of ~1029! permutations; a single green proves nothing
  about unsampled orders, and load-dependent interleavings (M3) are outside the
  sampled axis entirely. Known bypasses: (a) an order dependence that fails only
  under orderings rarer than the sampling rate — quantified: the ~69 shuffled
  acceptance runs detect (at 95% confidence) only members firing in ≥ ~4.3% of
  random orderings ((1−p)^69 ≤ 0.05 ⇒ p ≥ 1−0.05^(1/69)); a 1%-firing member
  escapes with ~50% probability and then reds ~1 in 100 future CI/pre-pr runs.
  A post-merge tail-trip is therefore EXPECTED behavior of the gate (triage:
  reproduce via the printed seed, fix the member), not a gate regression. The
  standing gate keeps accumulating samples — that is the closure mechanism for
  the tail. (b) a race that needs CPU contention (M3 axis — covered by A3m and
  the C4 pre-pr run, not by shuffling). (c) an in-band per-suite opt-out:
  vitest resolves shuffle as `this.shuffle ?? options.shuffle ??
  currentSuite?.options?.shuffle ?? config.sequence.shuffle`, so
  `describe("x", { shuffle: false }, …)` or the `describe.shuffle` chainable
  deterministically exempts a suite from the gate. This spelling is
  author-controllable and is therefore in the forbidden-pattern list below; it
  survives only by appearing in a reviewable diff. Recovery path when the gate
  trips: the printed seed (`Running tests with seed "N"`) reproduces the
  failure deterministically via `npx vitest run --sequence.shuffle --sequence.seed=N`.
- **Adjudication authority (R47)**: the vitest runner executing the real test
  code — execution-based for everything that RUNS. Four surface-form residues
  remain and are handled as forbidden patterns, because they sit outside the
  runner's exit-code reach: a test that never runs (suppression spellings), a
  suite that opts out (bypass (c)), a failure absorbed by re-running
  (`retry`/`repeats` — the run happens, but the exit code the consumers
  adjudicate no longer carries it), and a sample space frozen to one
  permutation (committed seed pinning — the run happens shuffled and prints a
  seed, but every run samples the SAME ordering, so the accumulating-samples
  closure mechanism dies invisibly). Runtime suspension is closed by
  construction: `vi.setConfig`'s RuntimeConfig exposes `sequence.hooks` only —
  no runtime shuffle opt-out exists (verified against the installed 4.1.10).
- **Invariants**:
  - I1 (app-enforced): every standing consumer of the suite (dev `npm test`,
    `test:watch`, pre-pr "Extension: Test", CI "Extension: Test") runs shuffled
    with a printed seed. Consumer walkthrough below.
  - I2: the gate can fail (RT7) — red-proven by mutation (see acceptance).
- **Consumer-flow walkthrough** (the "shape" consumed here is the config):
  - Consumer `npm test` / `npm run test:watch` (extension/package.json) reads
    `vitest.config.ts` `test.sequence` and needs no other field — shuffle and
    seed-printing are runner-internal.
  - Consumer pre-pr step "Extension: Test" (`scripts/pre-pr.sh` → `bash -c 'cd
    extension && npm test'`) consumes only the exit code; the seed line reaches
    its captured log output for reproduction. No pre-pr edit needed.
  - Consumer CI job "Extension: Test" runs the same `npm test`; the seed line
    lands in the job log. No workflow edit needed.
  - A developer reproducing a red run reads the seed from the log and passes
    `--sequence.seed=N` — CLI overrides config, no code change needed.
- **Forbidden patterns** (in this PR's diff):
  - pattern: `isolate` (in `extension/vitest.config.ts`) — reason: proven no-op for this class; would misdocument the fix
  - pattern: `--(sequence\.(shuffle|seed)|retry|repeats)` (in `extension/package.json`, `scripts/pre-pr.sh`, `.github/workflows/*`) — reason: the gate lives in vitest.config.ts once; per-consumer flags drift (R33). `--sequence.seed` committed in a consumer file pins every standing run to ONE permutation (vitest generates a random seed only when none is supplied: `resolved.sequence.seed ??= Date.now()`), killing the accumulating-samples closure mechanism while the gate still LOOKS on (shuffled order, seed printed); `--retry`/`--repeats` in the `test` script absorbs failures for every consumer. Allow path: ad-hoc CLI `--sequence.seed=N` on a developer's shell for bisection touches no committed file and is the intended repro flow; the forbidden surface is committed files that standing consumers execute
  - pattern: `\.(skip|skipIf|todo|fails|runIf|only)\s*\(` newly added under `extension/src/__tests__/` — reason: suppression spellings the execution gate structurally cannot catch (a masked test never runs); `it.fails` is the worst (a red test reports green with no skip marker). Allow path: a genuinely needed conditional skip requires a deviation-log entry naming the condition (R36)
  - pattern: `(skip|todo|fails|only)\s*:\s*true` newly added under `extension/src/__tests__/` — reason: options-object spelling of the same suppression class (`only: true` narrows the suite; CI's `allowOnly=false` catches it there, but local pre-pr runs without `CI` would not)
  - pattern: `(retry|repeats)\s*:` newly added under `extension/src/__tests__/` or in `extension/vitest.config.ts` — reason: retry re-runs a failing test until green with no skip marker, laundering exactly the intermittent tail-trips (bypass (a)) and M3-class races the gate exists to accumulate; the standing consumers adjudicate only the exit code, which retry absorbs. Allow path: a genuinely needed retry requires a deviation-log entry naming the nondeterminism source and an issue link. (Verified: current corpus has no `retry:`/`repeats:` occurrences, so no false-positive baseline)
  - pattern: `shuffle` (bare token) newly added under `extension/src/__tests__/`, plus `(shuffle|seed|sequencer)\s*:` in `extension/vitest.config.ts` outside the single `sequence.shuffle` gate line — reason: per-suite opt-out overrides the config gate in-band (control-class bypass (c)); a config-level `seed:` pins the gate to one frozen permutation (same neutralization as the consumer-file `--sequence.seed` row); and a config-level `sequencer:` silently un-randomizes the FILE-order axis while in-file shuffle and seed printing keep the gate looking on (the boolean-shuffle path assigns RandomSequencer only under `if (!resolved.sequence?.sequencer)`). Corpus verified — zero occurrences of any of the three tokens in tests, config, or package.json today. The bare token is deliberate — the runner reads `options.shuffle` at any key position, so an anchored regex (`\{\s*shuffle`) misses `{ concurrent: true, shuffle: false }`. Deny boundary and allow path: an options-position or chainable occurrence (`{ …shuffle… }`, `describe.shuffle`) is the forbidden thing; a comment/string match (e.g., an optional culprit-naming comment such as "leak surfaced by the shuffle gate at seed N" — the MANDATED location for culprit naming is I2's deviation log, not code comments) is a named false positive, flagged and passed at the same diff inspection C1-I4 performs, never silently ignored and never an automatic reject. Local bisection uses CLI `--sequence.seed=N`, which touches no committed file
  - pattern: `await new Promise\(\s*\(?r(esolve)?\)?\s*=>\s*setTimeout` newly added under `extension/src/__tests__/` — reason: widening a race window instead of removing the race (common testing rule; use input-keyed mocks or `vi.waitFor` on an observable condition)
  - Un-greppable residues, covered by C1-I4 diff inspection because no pattern can match an absence or a destructured binding: assertion deletion/weakening in any edited test file, and `TestContext.skip` in destructured form (`it("x", ({ skip }) => { skip(); … })` — no `.skip(` substring; the `ctx.skip()` property-access form does match the dot pattern).
- **Acceptance**:
  - A5: 10 consecutive `npx vitest run` (config shuffle active, random seeds)
    green; seeds recorded from output. The 10 recorded seeds MUST be pairwise
    distinct — a repeated seed is adjudicated as seed-pinning or a capture
    failure and fails this acceptance loudly (10 samples of one permutation
    are vacuous soak evidence), never averaged away.
  - A6: gate red-proof (RT7, both directions every time): on a scratch copy,
    revert `totp-handlers.test.ts`'s ENTIRE C1 fix (same mechanics as A3 — a
    point-mutation could be neutralized by the fix's own afterEach hooks or by
    a permutation shift) and run with a recorded failing seed (e.g., 12345) →
    the gate MUST fail; restore the fix → the same seed MUST pass. Both runs
    executed, both outputs recorded. Re-seed fallback and exhaustion exit as
    in A3: if no recorded seed reds the reverted copy, sweep seeds 1..50 (then
    51..200 once) for a fresh red and run both directions at that seed —
    MUST-fail stays MUST-fail; full exhaustion is a named deviation-log entry,
    never an assumed proof.
  - A7: `npm test` wall-clock before/after within noise — LIKE-FOR-LIKE: both
    numbers from an idle machine. Before = fact 4's idle measurement (or a
    fresh idle `npx vitest run --sequence.shuffle=false`); after = idle
    config-shuffled `npm test`. A8's pre-pr step duration is reported
    separately as contended-environment context, never as an A7 operand
    (idle-vs-loaded is not a comparison). Report both numbers; if the
    idle-vs-idle delta is materially worse, report to the user before merging
    (issue #784 asks for this explicitly).

### C4 — Issue closure evidence

- **Signature**: PR description links issue #784 and carries: the mechanism
  writeup (M1–M4 as diagnosed; M3 marked "verified" only if A3m ran, else
  "hypothesized"), the seed-sweep evidence, and the A5–A8 gate evidence.
  (PR body in English; backtick `#784`.)
- **Acceptance**:
  - all acceptance IDs A1–A4, A3m, A5–A8 present with commands and outputs
    (A3m may instead be a named deviation-log entry per its fallback — the
    entry, not silence, is what satisfies the clause).
  - A8: one full `scripts/pre-pr.sh` run green after all fixes — fact 5 names
    pre-pr's parallel load as the reproducing environment for the M3 axis, so
    the closure evidence includes that environment, not only idle-machine
    vitest runs. The "Extension: Test" step duration from this run is recorded
    as contended-environment context (A7's operands are both idle-machine).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------------------------------------------------|--------|
| C1 | Per-file order-independence fixes (dynamic victims) | locked |
| C2 | Leak-pattern cleanup in static candidates           | locked |
| C3 | Standing shuffle gate in vitest config              | locked |
| C4 | Issue closure evidence                              | locked |

## Testing strategy

- Unit of proof is the (seed, test) pair: every fix is red-proven against a
  recorded seed on a scratch copy (C1-A3, C3-A6), never by mutating the real
  working tree (established feedback rule).
- Sweep breadth: 9 recorded seeds (regression) + 50-seed sweep (discovery)
  + 10 random-seed runs (gate soak). ~70 runs × ~7 s ≈ 8–9 min locally.
- Evidence capture: this environment's rtk output proxy compresses Bash
  output and can strip the `Running tests with seed "N"` line. All acceptance
  runs redirect output to a file (`> log 2>&1`, or use `rtk proxy`) and grep
  the FILE for the seed line; a missing seed line is a capture failure to
  re-run, never "vitest didn't print it". Exit codes pass through rtk
  unmodified, so pass/fail adjudication is unaffected.
- Default order must stay green throughout (C1-A4) — checked at each fix batch.
- No new test infrastructure files unless a shared teardown proves necessary
  during Phase 2; if one is added (`src/__tests__/setup.ts` +
  `setupFiles`), it ships with its own red-proof and its effect on all 61
  files is verified by the full sweep, and fake-indexeddb/auto load order is
  preserved (it must load first — background SW startup throws
  `ReferenceError: indexedDB` otherwise, per the existing config comment).

## Considerations & constraints

- **Latent members vs. always-on gate**: enabling C3 with unfixed latent
  order-dependences would red unrelated PRs at random — the exact pain #784
  reports. Mitigation: C1/C2 fix everything the 50-seed sweep and the static
  audit surface BEFORE C3 merges in the same PR; the gate then protects against
  NEW regressions. Residual risk (rare orderings) is accepted and documented in
  C3's control class; the printed seed makes any future trip a 1-command repro
  instead of a lost debugging cycle.
- **Watch-mode ergonomics**: `test:watch` also shuffles. Accepted — a dev who
  needs a stable order for bisection passes `--sequence.seed=N`.
- **Production-code races**: if Phase 2 diagnosis shows a genuine production
  bug (e.g., an unawaited promise in `background/index` that misbehaves beyond
  tests), it is reported to the user and filed — NOT fixed in this PR
  (no unrequested scope; test-side determinism via input-keyed mocks is
  sufficient for this task).
- **jsdom files**: `dpop-key.test.ts` and `webauthn-bridge-lib.test.ts` run
  under jsdom via `environmentMatchGlobs`; fixes must not change their
  environment assignment.

### Scope contract

| ID | Deferred item | Owner |
|-----|---------------|-------|
| SC1 | Root (`src/`) and `cli/` vitest suites' order hygiene | future issue if ever observed (root config already `isolate: true`, different suite) |
| SC2 | Refactoring production `background/index` fire-and-forget async | report-only in this PR; separate issue if confirmed as a production defect. Triage classification is pre-committed: if the Phase 2 diagnosis confirms the race is reachable with real (non-mock) decrypt inputs, the filed issue is labeled `security` and states the credential-mis-delivery hypothesis explicitly (unawaited async consuming decrypt results in a password manager's service worker — OWASP A04 class); if the coupling is mock-positional only, the issue notes that and closes the hypothesis |
| SC3 | `environmentMatchGlobs` deprecation (vitest 4) migration | untouched here; config modernization is not this fix |
| SC4 | Root vitest.config.ts shuffle gate for `src/` suite | out of scope; #784 is extension-only |

## Implementation Checklist

Phase 2 Step 2-1 impact analysis (2026-08-22). Baseline 50-seed full-shuffle
sweep (`--sequence.shuffle --sequence.seed=1..50`): **49/50 seeds red**, 24
distinct failing tests in **5 files** — same 5 files as the 9-seed Set A
(no new victim files; per-test seed frequencies recorded in the sweep log).

Files that must change:
- `extension/src/__tests__/background/totp-handlers.test.ts` — victim ×23 seeds (M1 L327, M2 L204, M3 Once queues)
- `extension/src/__tests__/background.test.ts` — 8 distinct victim tests, "fetches and decrypts password overviews" red in 48/50 seeds (M1 + M3)
- `extension/src/__tests__/dpop-key.test.ts` — all 10 tests fail together in 14/50 seeds (M4: shared fake-IDB "psso-ext" DB + in-process key cache; order assumption between clean-boot/delete tests and the rest)
- `extension/src/__tests__/content/form-detector-entry.test.ts` — victim ×23 seeds (M5 hypothesis: window "error" listeners from prior test's module import accumulate on the shared jsdom window; both handlers fire → destroy counted twice)
- `extension/src/__tests__/login-detector.test.ts` — 4 victim tests (leaked chrome.onMessage listeners / missing cleanup() in some tests)
- `extension/src/__tests__/lib/messaging.test.ts` — static real-leak candidate (L18/L38 Once-less overrides, clearAllMocks-only beforeEach)
- `extension/src/__tests__/popup/App.test.tsx` — static real-leak candidate (L167/L204)
- `extension/vitest.config.ts` — C3 gate line ONLY (exclusivity clause)
- C2 classification table → `extension-test-order-deps-deviation.md`

Reuse / patterns:
- No shared test-helper dir exists in extension; `setupFiles: fake-indexeddb/auto` must stay first. setup.ts contingency only per C3 exclusivity clause.
- Fix vocabulary: `mockXxxOnce` or beforeEach re-establishment (M1); `mockRestore`/`vi.restoreAllMocks` in afterEach (M2); input-keyed mock with throw-on-miss + steal-window/end-of-test flush (M3, I3); explicit listener/DB teardown (M4/M5).
- Single test tree (`extension/src/__tests__` only) — no parallel test trees (R19 checked). Production `.js`/`-lib.ts` twins NOT touched (test-only diff).

CI gate parity: extension CI job = `npm test` + `npm run build` (`.github/workflows/ci.yml:373-374` at `af1d00362`); pre-pr runs both ("Extension: Test" batch 1, "Extension: Build" batch 2) — no parity gap. No new files added, so no new-file-pattern gates fire. Config diff is `extension/vitest.config.ts` (inside CI's `extension/**` filter — gate change is exercised by CI).

## User operation scenarios

1. Developer runs `cd extension && npm test` on a feature branch → order is
   random; a leak introduced by their new test fails within a few runs locally
   instead of surfacing on someone else's PR; the log's seed line reproduces it.
2. pre-pr runs the extension step under full parallel load → M3-class races no
   longer depend on interleaving because mock responses are input-keyed; a red
   here prints the seed into the step log pre-pr already captures.
3. CI "Extension: Test" reds on a PR → author copies the seed from the job log,
   runs `npx vitest run --sequence.shuffle --sequence.seed=N` locally, gets the
   same failure deterministically.
