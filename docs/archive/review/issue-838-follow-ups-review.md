# Plan Review: issue-838-follow-ups

Date: 2026-09-17 (round 1) · Plan: `docs/archive/review/issue-838-follow-ups-plan.md`
Review round: 1

## Changes from Previous Round

Initial review. Three experts (functionality, security, testing) reviewed the plan in parallel;
Ollama pre-screening ran first and produced one Minor (the `owningTenantOf` relocation's importers
— resolved: the function is module-private, `grep -rn owningTenantOf src scripts` names only
`src/lib/tenant-context.ts`). The Security expert flagged two Criticals with `escalate: true`; the
Opus escalation tier was launched for those and is recorded separately below.

Finding IDs are prefixed by expert: `F-` functionality, `S-` security, `T-` testing.

## Functionality Findings

- **F-F1 (Major, design)** — C3's non-literal-load member set is unsupported and incomplete. The
  plan cited "the probe in the review record", which did not exist, and the set missed
  `src/lib/blob-store/runtime-module.ts:16,20` (`createRequire` bound to a local, then
  `requireModule(moduleName)`). Resolution: pending — folded into the Opus escalation's member-set
  re-derivation (S-F1), since both concern the same allowlist.
- **F-F2 (Major, design)** — C3 item 7 would have rewritten the gate header down to two residual
  entries, dropping three live client-propagation members (`this`, spread-before-client, unprovable
  receiver) plus the BYPASS_PURPOSE file scope and the file-keyed `INDIRECT_CALLBACK_ALLOWLIST`.
  Resolution: **fixed in plan** — item 7 now drops only what C3 closes and keeps the rest verbatim.
- **F-F3 (Major, design)** — `A-C3-4`'s "seed a shared stub" did not cover
  `TENANT_CONTEXT_ALLOWED` (`scripts/__tests__/check-bypass-rls.test.mjs:66-79`), a fixture that
  writes `src/lib/tenant-context.ts` itself and declares neither helper. Resolution: **fixed in
  plan** — the harness copies the real declaring files, and that fixture appends the real
  declarations through one helper (see T-F4).
- **F-F4 (Major, design)** — an unconditional `env`/`printenv` refusal would refuse
  `env DEBUG=1 cmd "$_CRED"`, a sanctioned Pattern C shape. Resolution: **fixed in plan** — the
  refusal is scoped to the bare form, with an allow cell.
- **F-F5 (Minor, prose, [Adjacent])** — C2's classifier would fail the gate for a future non-shell
  hook (`node foo.mjs`). Resolution: **fixed in plan** — non-shell operands are recorded and
  reported, not failed; only unclassifiable commands fail.

## Security Findings

- **S-F1 (Critical, design, escalate: true)** — `NON_LITERAL_LOAD_ALLOWLIST` keyed by file +
  specifier source text exempts any later call site in the same file reusing the same spelling.
  Status: **escalated to the Opus tier** (open).
- **S-F2 (Critical, design, escalate: true)** — a helper reached through a non-literal member name
  (`mod[n](…)`) yields neither a language-service reference nor a name match, so C3 items 3–6 are
  all silent. Status: **escalated to the Opus tier** (open).
- **S-F3 (Major, design)** — `cmdBackfillOwningColumn` was not specified to call
  `validateActorLabel`, the control that keeps a `--by` label from spoofing `signin` or carrying
  bidi/control characters into audit metadata (its three existing call sites:
  `scripts/tenant-domain.ts:923,1298,1730`). Resolution: **fixed in plan** — validation before the
  client is built, plus acceptance cell A-C4-2c.
- **S-F4 (Minor, prose)** — the widened printer list omitted equally cheap forms (`tr`, `iconv`,
  `jq`, `xargs`, `column`, `fold`, `fmt`, `nl`, `pr`, `less`, `more`) and nameref indirection
  (`declare -n ref=_CRED`). Resolution: **fixed in plan** — folded into item 6's list and item 4.
- **S-F5 (Minor, design)** — the printer regex's window stops only at `|`, so widening to
  general-purpose tools (`sed`, `awk`, `head`…) would refuse `sed -i … cfg; curl -u "u:$_CRED" …`.
  Resolution: **fixed in plan** — the window is the simple command (`| ; & && ||`, newline), with a
  semicolon-joined allow cell.
- **S-F6 (Minor, prose)** — a blind backslash-newline strip diverges from bash inside single
  quotes. Resolution: **fixed in plan** — normalisation skips single-quoted spans; allow cell added.
- **S-F7 (Minor, design)** — C2's classifier left compound (`&&`) and `$CLAUDE_PROJECT_DIR`-style
  wired commands unspecified. Resolution: **fixed in plan** — both are unclassifiable and fail, with
  a cell each.
- **S-F8 (Minor, [Adjacent])** — the backfill's candidate enumeration had no stated bound, unlike
  `preflight`'s `PREFLIGHT_FOLD_SCAN_LIMIT`. Resolution: **fixed in plan** — keyset pages over
  `users.id` with a fixed page size, `--limit` capping candidates.

## Testing Findings

- **T-F1 (Major, design)** — no acceptance cell for "no `.claude/settings.json` at all", which is
  the state of every one of the existing fixtures (`check-no-pipe-into-grep-q.test.mjs:47-51`
  creates only `scripts/`). Resolution: **fixed in plan** — A-C2-1b pins the allow side.
- **T-F2 (Major, design)** — the self-test suite's own runtime had no budget, and the plan said
  "dozens of spawns" for what is measured at 142 tests / 28.7 s over 123 spawns, inside an
  `app-ci` coverage step already at ~13–14 min against a 20 min cap. Resolution: **fixed in plan**
  — measured figures recorded, a 2× budget stated, and a fallback named if the budget is exceeded.
- **T-F3 (Major, design)** — C3 item 6's allow branch ("resolves to a different declaration
  passes") had no fixture. Resolution: **fixed in plan** — added to A-C3-2.
- **T-F4 (Major, design)** — hand-written stub helper declarations would become load-bearing for
  reference resolution with no sync check against the real declarations (RT1). Resolution: **fixed
  in plan** — the harness copies the real files instead of stubbing.
- **T-F5 (Minor, prose)** — "the red proof is the old gate" conflated a one-off proof with a
  persisted regression test. Resolution: **fixed in plan** — A-C3-1 splits the two.
- **T-F6 (Minor, prose)** — C1 item 8's message change obsoletes an existing pinned assertion
  (`block-bare-decrypt-hook.test.mjs:260-265`). Resolution: **fixed in plan** — A-C1-3 names it.
- **T-F7 (Major, design)** — `--limit` and the multi-membership flag had no acceptance cell.
  Resolution: **fixed in plan** — A-C4-2b.

## Adjacent Findings

- F-F5 (functionality → security/testing): C2 classifier failing on a future non-shell hook.
- S-F8 (security → functionality): unbounded candidate enumeration in the backfill.

Both are routed and resolved in the plan as recorded above.

## Quality Warnings

None recorded: the merge ran as the mechanical json-index join (Ollama's `merge-findings` was not
used for this round; the three experts' indices had no overlapping (file, line ±5) pairs, so no
convergence floor applied).

## Escalation (Security, Opus tier)

Launched for S-F1 and S-F2 with the member-set question F-F1 raises. All probes ran in the
scratchpad against fixture trees and the real tree; the probe scripts are carried into Phase 2's
review artifact.

- **S-F1 — Confirmed / Refined (Critical).** The member set was incomplete in both directions: the
  plan's syntactic pattern `createRequire(...)(…)` matches none of the real sites (all four spell it
  `const req = createRequire(x); req(y)`), and the real enumeration is `src/i18n/messages.ts:93,111`,
  `src/lib/crypto/crypto-client.ts:150`, `src/lib/key-provider/{aws-sm,azure-kv,gcp-sm}-provider.ts`,
  `src/lib/blob-store/runtime-module.ts:20`. More important than the count: `requireOptionalModule`
  is an EXPORTED module-loading capability, so allowlisting its one line — by file, text, or call
  site — licenses every caller in `src/` to load any module name. Resolution: **allowlist removed
  entirely**; the specifier's checker TYPE decides, and the wrapper's parameter narrows to a literal
  union so TypeScript enforces the same rule on future callers. Plan item 5 rewritten.
- **S-F2 — Confirmed / Refined (Critical).** Probe output: `export *` itself, `ns[n](…)`,
  `Object.values`/spread/`Reflect.get` over a namespace, and a `globalThis` hand-off produce ZERO
  language-service references, so the round-1 cross-check would have been silent on all of them.
  Resolution: refusal moves to the receiver's TYPE — Rule A (a helper-carrying value may appear only
  as the receiver of a literal member read; measured 0 hits on the real tree) and Rule B (an
  `any`-typed receiver with a non-literal key; measured 2 hits, both literal-union keys, both pass).
  Plan item 6 rewritten; `export *` gets its own refusal (5b).
- **S-F3 — new Critical, raised and resolved in this round.** The plan asserted item 3 subsumed
  quoted/computed destructuring keys. The probe shows `const { "withBypassRls": wb } = await
  import("@/lib/tenant-rls")` yields no reference AND no symbol on the key node, and the existing
  syntactic pass misses it too (`check-bypass-rls.mjs:440-460, 500-520`). Left as written, the plan
  would have declared a class closed that stays open — this gate's own recurring failure. Resolution:
  item 3's claim corrected, new item 5c resolves the property symbol from the pattern's type or
  refuses.
- **S-F4 — Major.** `require("node:module")` in the three key-provider files yields an `any` module
  object, so an `any` callee can load by value invisibly to a spelling-based rule. Resolution: item
  5's rule judges the SPECIFIER's type regardless of the callee, so today's literal arguments pass
  and a non-literal one through the same `any` callee is refused — no edit to those files.
- **S-F5 — Minor.** The plan's ≈3.4 s Program figure understates what the escalation measured
  (≈10 s build, ≈15.5 s with a per-identifier type query). Resolution: both figures recorded, a 30 s
  gate budget stated, and Phase 2 must re-measure per rule rather than carry either number forward.

Unverified and carried into Phase 2: an ambient `.d.ts` / `declare module` declaration typing a value
as the helper module. Rule A is expected to cover it; no probe demonstrated it. Recorded in the C3
control-class paragraph.

Round 1 status after the escalation: all three Criticals are resolved IN THE PLAN. Round 2 re-reviews
the rewritten C3 before the Go/No-Go gate flips.

## Recurring Issue Check

### Functionality expert

R1 no violation (`owningTenantOf` consolidation is the de-duplication). R2 n/a. R3 n/a. R4 n/a
(no new mutation paths beyond the reviewed audit emits). R5 n/a (C4's write path is
transactional). R6 n/a. R7 n/a. R8 n/a. R9 n/a (C4 uses `logAuditInTx`, in-tx by design). R10 not
evidenced (`owning-tenant-rule.ts` is a leaf). R11 n/a. R12 n/a. R13 n/a. R14 n/a. R15 n/a. R16
addressed (E2). R17 n/a. R18 triggered → F-F1. R19 see F-F3. R20 n/a. R21 n/a. R22 n/a. R23 n/a.
R24 n/a (Q11 deferred as SC5). R25 n/a. R26 n/a. R27 n/a. R28 n/a. R29 violated → F-F1. R30 n/a.
R31 satisfied (dry-run default, `--apply` + confirm). R32 n/a. R33 n/a. R34 satisfied (SC1–SC5).
R35 n/a (E1). R36 no violation. R37 n/a. R38 n/a. R39 n/a. R40 checked — the C4 consumer-flow
walkthrough matches `emitRealignment`'s read shape. R41 see F-F4. R42 violated → F-F1, F-F2. R43
none found. R44 addressed by C1 item 8 and C2 item 2. R45 addressed (interleaved measurement).
R46 addressed (`scope-bindings.mjs` stays). R47 the point of C3. R48 addressed by C4's
consolidation. R49 see F-F2. R50 n/a (E1–E3 stated). R51 satisfied (per-user re-read then write).
R52 F-F3 is a concrete instance. R53 addressed. R54 n/a. R55 n/a. R56 n/a. R57 n/a.

### Security expert

R1 not triggered. R2 not triggered. R3 triggered → S-F3. R4 n/a. R5 not triggered. R6 n/a. R7 n/a.
R8 n/a. R9 n/a. R10 not triggered. R11 n/a. R12 not triggered. R13 n/a. R14 n/a. R15 n/a. R16
touched by E2. R17 triggered → S-F3. R18 triggered → S-F1. R19 out of scope. R20 n/a. R21 n/a.
R22 not triggered. R23 n/a. R24 n/a. R25 n/a. R26–R28 n/a. R29 not separately audited. R30 n/a.
R31 not triggered (dry-run default). R32 n/a. R33 n/a. R34 not triggered. R35 n/a. R36 not
triggered. R37 not triggered. R38 n/a. R39 n/a. R40 not triggered. R41 touched by S-F1/S-F2. R42
central → S-F1, S-F2. R43 not triggered. R44 addressed by the plan itself. R45 addressed by R-4.
R46 not triggered. R47 triggered → S-F1, S-F2. R48 not triggered. R49 triggered → S-F1, S-F2. R50
not triggered. R51 not triggered. R52 not triggered. R53 addressed. R54 n/a. R55 not triggered.
R56 n/a. R57 n/a. RS1 n/a. RS2 n/a. RS3 triggered → S-F3. RS4 not triggered. RS5 not triggered
beyond S-F3. RS6 not triggered.

### Testing expert

R1–R44 n/a for a testing-strategy review except: R29 citations re-derived against the repo (CI
timings, the `tenant-context.ts` re-export) — all confirmed. R45 partially triggered → T-F2. R46
n/a. R47 n/a. R48 n/a (correctness scope). R49 n/a. R50 n/a. R51 n/a. R52 n/a. R53 partially
triggered → T-F2. R54–R57 n/a. RT1 triggered → T-F4. RT2 all findings grounded in read files or
measured runs. RT3 n/a. RT4 n/a. RT5 satisfied (all three suites spawn the real script). RT6 n/a
(`owningTenantOf` has A-C4-1). RT7 satisfied structurally; phrasing fixed by T-F5. RT8 none found.
RT9 n/a. RT10 triggered → T-F1, T-F3. RT11 none found (every harness uses `mkdtempSync` +
`afterEach` cleanup).

---

# Round 2

Date: 2026-09-23 · incremental review of the revised plan (C1 items rescoped, C2 classification
split three ways, C3 rewritten by the escalation, C4 extended).

## Changes from Previous Round

Round 1's 25 findings were all reflected in the plan. Round 2 reviewed that revision. It produced
17 findings, three of them Critical — every Critical against C3's rewrite, i.e. against the fix for
round 1's Criticals rather than against the original design.

## Functionality Findings (round 2)

- **F-R2-1 (Major)** — `OptionalModuleName` narrowing breaks `tsc --noEmit`: `runtime-module.test.ts`
  calls the real export with `"example-module"` / `"missing-module"`. The plan's "no call-site
  change" claim was wrong. **Fixed**: the test is named as a required edit; production callers stay.
- **F-R2-2 (Major)** — reproduced false negative: `awk -F'|' '{print}' <<<"$_CRED"` escapes the
  widened printer rule, because the quoted `|` closes the match window. **Fixed by mechanism
  change**: C1's predicates move into a quote-aware scanner; `grep` leaves the hook.
- **F-R2-3 (Major)** — item 5's "any callee" branch had no arity bound and no cost budget.
  **Fixed**: bounded to one-argument calls; folded into the per-rule measurement.
- **F-R2-4 (Minor)** — `@aws-sdk/client-secrets-manager` was attributed to `s3-destination.ts`; it
  belongs to `key-provider/aws-sm-provider.ts` and is not a `requireOptionalModule` caller.
  **Fixed**: the union is three literals.
- **F-R2-5 (Minor)** — item 7 left the header's round-13 "specifier is a literal" paragraph stale.
  **Fixed**: named for rewrite.
- **F-R2-6 (Minor)** — the dry-run listing read did not say it runs bypassed. **Fixed**.
- Confirmed correct by the reviewer: Rule A refuses nothing on the real tree; C4's keyset paging is
  expressible on the schema; `owningTenantOf`'s oldest-first contract matches the relocated
  signature; item 7's drop list maps 1:1 onto what the new items close.

## Security Findings (round 2)

- **S2-F1 (Critical, escalate)** — the performance fallback ("narrow Rule A to files importing a
  helper-exporting module") reopens SC4's propagation class inside the rule that replaced
  spelling-based detection. **Fixed**: narrowing by import graph is forbidden; only syntactic
  positions may be narrowed, every file stays scanned.
- **S2-F2 (Critical, escalate)** — "carries a helper" was unspecified for unions (a synthetic
  property symbol never equals a helper symbol) and for generic wrappers. **Fixed**: decided over
  declaration sets; the generic case is stated and given fixtures.
- **S2-F4 (Critical, escalate)** — the test-only env flag would suspend the Program pass through
  ambient state (R54), guarded only by `CI=true`, unlike the cited precedent which relocates a scan
  root without removing a predicate. **Fixed**: the flag is removed entirely; the runtime lever is
  the harness, never the rule.
- **S2-F3 (Major)** — item 5's literal-type rule refuses `messages.ts`'s template specifier, which
  the member-set table claimed passes. **Fixed**: the template static-head algorithm is written out
  with boundary fixtures.
- **S2-F5 (Major)** — a single-quote parity counter desyncs on an apostrophe inside a double-quoted
  word. **Fixed by the same mechanism change as F-R2-2**; an allow cell pins it.
- Verified by the reviewer, not findings: path aliases and symlinks are re-resolved per run
  (`preserveSymlinks` is off); C2/C4's cited helpers match the tree.

## Testing Findings (round 2)

- **T2-F1 (Major)** — C1 item 1 had no red-provable cell of its own. **Fixed**: A-C1-1 now spans
  items 1–7, with a mutation per item.
- **T2-F2 (Major)** — fixture-tree Program cost is not the real-tree cost (no `node_modules` above
  `mkdtemp`), so the budget rested on the wrong measurement. **Fixed**: Phase 2 measures one fixture
  spawn first and may add an ambient stub for external types.
- **T2-F3 (Major)** — the disable flag had no acceptance criteria. **Resolved by deletion** (S2-F4).
- **T2-F4 (Major)** — same as F-R2-1, from the test side. **Fixed**.
- **T2-F5 (Major)** — divergent fixtures cross tenants, so tenant-scoped cleanup leaks rows and
  system-wide counts contaminate later files. **Fixed**: A-C4-2d requires delta assertions and
  cleanup by user id across both tenants.
- **T2-F6 (Major)** — 5b and 5c had no allow cells. **Fixed**: A-C3-2c.

## Round 2 status

Every round-2 finding is reflected in the plan. Two of the three Criticals were closed by REMOVING
something the plan had added (the import-graph narrowing, the disable flag); one by specifying a
predicate over declaration sets. C1's mechanism changed as a result of a reproduced false negative,
which is new surface, so round 3 reviews the revision rather than treating round 2 as the exit.

---

# Round 3

Date: 2026-09-23 · incremental review of the revision that followed round 2 (C1's scanner mechanism,
C3's declaration-set Rule A, the two deletions).

Experts were asked to classify each concern as SPEC (the plan text is wrong or under-determined, one
sentence fixes it) or EXECUTION (only building and running settles it — then name the acceptance
cell instead of asking for prose). That split is what makes this round's exit decision legible.

## Findings and resolutions

Security (2 Critical, both SPEC, both `escalate: false` — the reviewer characterised root cause and
fix completely, so no higher tier was launched):

- **S3-F1 (Critical)** — the scanner contract tracked quote state only. `echo $(true | false)
  "$_CRED"` is ONE simple command to bash and prints the credential; a quote-only segmenter splits it
  at the nested `|` and neither fragment matches item 6. Verified with a real bash probe.
  **Fixed**: the scanner tracks three dimensions — quote state, nesting depth (`$( )`, backticks,
  subshells, scanned recursively), heredoc body — and splits only at unquoted, unnested operators.
- **S3-F2 (Critical)** — the template static-head algorithm treated a head ending mid-segment
  (`../../lib/tenant-${x}`) as a directory, so the containment check looked under a directory that
  does not exist and passed, while the substitution could complete to `tenant-rls.ts`.
  **Fixed**: a head that does not end in `/` is refused, with a boundary fixture.
- Verified by the reviewer, not findings: both round-2 deletions hold (a whole-plan grep for
  narrowings, flags, env vars and opt-outs found none), and the declaration-set formulation closes
  the union/decoy case.

Functionality (4 Major, 1 Minor, all SPEC):

- **F-R3-1 / F-R3-3** — same root cause as S3-F1: `$( )` nesting and the heredoc body-consumption
  rule were unspecified. **Fixed** in the same rewrite; the heredoc rule now states terminator
  matching, `<<-` tab stripping and stacked-heredoc order.
- **F-R3-2 (Major)** — the mechanism change covered items 1–8 but left the hook's other three grep
  predicates unaddressed while forbidding `grep` outright: decrypt detection, the occurrence-count
  decoy gate, and Shape 2's clipboard sinks. **Fixed**: all three migrate to the same scanner with
  behaviour preserved, and the existing Shape-2 cells are the proof.
- **F-R3-4 (Major)** — the `any`-callee/one-argument subject also selects calls that are not module
  loads, with no allowlist and no stated remedy. **Fixed**: residual stated, remedy is typing the
  callee.
- **F-R3-5 (Minor)** — `s3-destination.ts` was cited under the wrong directory and the caller line
  numbers were stale. **Fixed**: cited by subject, not by line; Phase 2 re-derives.

Testing (2 Major, 3 Minor, all SPEC):

- **T3-F1** — item 8's refusal had no red proof. **Fixed**: A-C1-1 now spans items 1–8.
- **T3-F2** — every C1 cell was end to end, so a subtly wrong parser could pass for the wrong reason.
  **Fixed**: A-C1-0 requires segmentation-level unit cells at the scanner's own boundary.
- **T3-F3 / T3-F4 / T3-F5** — item 4 had no named cell; the 200 KB cell stated no verdict; the three
  hook counts were never exercised together. **Fixed** in A-C3-1, A-C1-4, A-C2-1b.
- Reviewer confirmed C4's delta contract is non-vacuous and matches an existing cross-tenant cleanup
  pattern in `src/__tests__/db-integration/`.

## Exit decision: saturation, after round 3

Round 3 is the exit. Recorded against the criteria:

1. Three rounds completed.
2. No Critical or Major finding is open — every round-3 finding is reflected in the plan, and none
   carries an Anti-Deferral disposition. `## Carried-Forward Plan Findings` is therefore absent:
   nothing was deferred.
3. Strictly read, criterion 3 does NOT hold: round 3's findings were design-level, not prose-only.
   The exit is taken deliberately anyway, and this is the reason. Across the three rounds the
   findings changed character rather than count (25 → 17 → 12): round 1 questioned the APPROACH
   (allowlist keying, what a reference proves), round 2 questioned the MECHANISM the approach
   implies, and round 3 found only under-specified details of that mechanism — each one decidable by
   writing the code and running a fixture (a nested `$( )`, a heredoc terminator, a path head that
   does not end in `/`). Round 3's own reviewers marked every finding SPEC-or-EXECUTION and confirmed
   the approach itself correct in three separate "Confirmed correct" sections. Specifying further
   costs a round per detail and buys what one fixture settles in seconds, which is the loop this exit
   exists for.
4. The remaining risk is named rather than hidden: the scanner's exact segmentation behaviour, the
   Program's per-rule cost, and the ambient `.d.ts` residual are all carried as Phase 2 acceptance
   cells (A-C1-0/1/3, A-C3-1/2b/3/5, and the C3 control-class paragraph), not as open questions.

Every contract flips to `locked` in the plan's Go/No-Go gate on this call. Phase 2 implements against
those acceptance cells, and Phase 3 reviews the code — where a mis-parse is a failing test rather
than a paragraph.
