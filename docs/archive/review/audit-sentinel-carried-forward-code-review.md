# Code Review: audit-sentinel-carried-forward

Date: 2026-09-04
Review round: 1
Branch: `fix/audit-sentinel-carried-forward-cf11-cf17`
Base: `1628b97fe` · Reviewed at `429d13533` (**6** commits: `b4fa914f2` plan, `f4e50a70b` implementation, **four** Phase-2 self-check fixes — `383e378f5`, `a2c387214`, `975f30d08`, `429d13533`)

## Changes from Previous Round

Initial code review. Three experts ran in parallel against the full 61-file diff
(+4650/-168). **Two findings, both Major, both from the Testing expert.**
Functionality and Security each returned **No findings** — after substantive
verification rather than by inspection; see their sections.

Round 1 here is incremental verification on top of Phase 2's Step 2-5 self-R-check,
which had already fired six findings (F1–F6 in the deviation log) and fixed them.

**Ollama was unavailable** (HTTP 400 from the OpenAI-compatible endpoint), so
Step 3-2's pre-screening and per-expert seeds were skipped and all three experts
took the documented fallback: full-diff review. `merge-findings` did run and
returned no quality warnings.

## Functionality Findings

**No findings.**

Verification performed rather than asserted: every Implementation Checklist file
diffed and read; every re-runnable "Derived figures" command re-executed (31
expressions / 28 files, 9 slice sites, 8 `set_config` sites, `MCP_SCOPES` 9/142,
`SA_TOKEN_SCOPES` 10/158, the 200-repeat 2999, the 112/78 policy-cast split, the
15/11/4 CI-gate parity) and matched; `npx tsc --noEmit` clean; the
**26** non-integration changed test files run together — **921 tests**, green (re-measured
by the orchestrator; the reviewer's own subset figure is not reproduced here); the parity,
migration-transaction, destructive-migration and bound-unknown-ip gates run
directly against the tree. The forbidden patterns have zero residue in `src/`.
The CFP1–CFP4 / D1–D12 / F1–F6 dispositions all check out against the code.

## Security Findings

**No findings.**

Seven named surfaces were each verified to a conclusion rather than to an
absence. The three that changed what is known:

- **`pgConstraintName` has no attacker channel.** The candidate list excludes
  `cause.detail`, so the `DETAIL: Failing row contains (…)` line — which does
  echo attacker-supplied row values — is never parsed. The constraint name in
  Postgres's primary error line is schema-derived. The classifier is
  additionally gated on SQLSTATE 23514, and its control class is detection-only:
  every path consulting it has already had the write refused by the real CHECK.
- **The retained `reason` cannot reach a formula-injection sink.** The CSV export
  writes `JSON.stringify(log.metadata ?? {})` as a single cell, so the leading
  byte is always `{`, defeating `csv-escape.ts`'s trigger set regardless of
  content. The CLI report prints `reason` only as one of three canonical enum
  strings; the attacker-influenced field there is `claim`, already escaped.
- **The one look-alike the propagation search surfaced was run down to a
  negative.** `src/app/api/teams/[teamId]/webhooks/route.ts:44`'s `events` array
  takes no dedup — not a finding: the column is `String[]` with no width, and
  dispatch selects via `events: { has: … }`, so duplicates cannot double-deliver.

The gate reordering in `consent/route.ts` sits BEHIND the session check, so the
enumeration surface is bounded to an authenticated principal, and the new gates
are client-independent, so they cannot probe for a client or its allowlist.
`oauth-server.ts:269-270`'s unconditional non-S256 rejection was read directly,
confirming CFP2 rather than taking the deviation log's word for it.

## Testing Findings

### T-F1 — Major — the `audit.mocked.test.ts` twin cannot fail for the reason it claims

`src/__tests__/audit.mocked.test.ts:173-192`. The docblock called this the R19
twin proving "the two trees must agree that `_originalSize` is bytes, not UTF-16
code units". Its fixture is `{ data: "x".repeat(15_000) }` — pure ASCII, for
which `Buffer.byteLength(json,"utf8") === json.length` always. Verified by
execution: `15011 / 15011 / identical=true`. Reverting `src/lib/audit/audit.ts`'s
byte comparison to `json.length` left the assertion computing the same number and
staying green. The comment even admitted the coincidence while still calling the
tightened assertion the twin's proof.

**Status: fixed.**

### T-F2 — Major — CFP3's Anti-Deferral cost claim was inaccurate

`docs/archive/review/audit-sentinel-carried-forward-deviation.md`. The recorded
cost said the route "has no harness" for driving the real limiter and that
building one "means unpicking a module-scope mock the rest of the file depends
on". Both halves are false — vitest mocks are per file, and two existing
integration suites already drive `createRateLimiter` and real route handlers
unmocked. The consequence is not cosmetic: an overstated cost is how a deferral
outlives its reason.

**Status: fixed — and the deferral was closed rather than restated.**

## Adjacent Findings

- Functionality → Security: `[Adjacent] R9` SC7's `enqueueAudit` `$transaction`
  GUC fold; `[Adjacent] R43` C1's `isIpInCidr` normalization as a policy-boundary
  widening (CFP4); `[Adjacent] R47` `pgConstraintName`'s surface-form parse.
  **All three were independently examined by the Security expert and cleared** —
  a three-way convergence in the "checked clean" direction, recorded because the
  routing worked as intended rather than because anything was found.
- Security → Testing: `[Adjacent] Minor` CFP3's residual. Converges with T-F2,
  which is the same subject reached from the other side.

## Quality Warnings

None. `merge-findings` ran and reported both findings pass the gate: each cites a
specific file and line, each carries execution evidence (T-F1 the byte-count
run, T-F2 the exact existing files and lines that demonstrate the harness), and
each proposes a concrete fix with a red-proof method.

## Recurring Issue Check

### Functionality expert

R1 [Checked] · R2 [Checked — F5 already fixed the one real hit] · R3 [Checked — zero forbidden-pattern residue] · R4 [N/A] · R5 [Checked] · R6 [N/A] · R7 [Checked — no route/selector renames; E2E grep empty] · R8 [N/A — no `.tsx` in the diff] · R9 [Adjacent — SC7] · R10 [Checked] · R11 [N/A] · R12 [Checked — the three tables are `satisfies Record<…>`-enforced] · R13, R14 [N/A] · R15 [Checked] · R16 [N/A] · R17 [Checked — every "MUST be reused" helper reused] · R18 [N/A] · R19 [Checked — all twin trees updated] · R20 [N/A] · R21 [Checked — sub-agent tests use by-value/by-count assertions with positive controls] · R22 [Checked] · R23 [N/A] · R24 [Checked — additive-only CHECKs, pre-flighted at 0 rows] · R25–R28 [N/A] · R29 [Checked — citation mapping table and derived figures re-run and matched] · R30–R33 [N/A] · R34 [Checked — SC2, SC5, SC7, SC9 all carry Anti-Deferral records] · R35 [N/A] · R36 [Checked — D10 fixed by rewording, not suppressing] · R37 [Checked] · R38 [Checked] · R39 [N/A] · R40 [Checked — the new reason verified write-to-read end to end] · R41 [N/A] · R42 [Checked — the 3-member constraint set verified against `pg_constraint` by execution] · R43 [Adjacent — CFP4] · R44 [Checked] · R45, R46 [N/A] · R47 [Adjacent] · R48 [Checked] · R49 [Checked] · R50 [Checked] · R51 [N/A] · R52 [Checked — the sink refusal covers all 126 call sites by construction] · R53, R54 [N/A] · R55 [Checked] · R56, R57 [N/A]

### Security expert

R1 [Checked] · R2 [N/A] · R3 [Checked — no other raw IP-header reader, no other PKCE ingress, no un-deduped scope site with a security consequence] · R4–R8 [N/A] · R9 [Checked — SC7 not reintroduced] · R10–R16 [N/A] · R17 [Checked] · R18 [N/A] · R19 [Checked — twin trees run, 289 green] · R20–R28 [N/A] · R29 [Checked — derived figures re-run; `oauth-server.ts:270-271` read directly] · R30–R41 [N/A] · R42 [Checked — no fourth sentinel constraint exists] · R43 [Checked — the normalization widening is the plan's accepted, parity-guarded decision] · R44–R46 [N/A] · R47 [Checked — gated behind the real SQLSTATE, detection-only] · R48 [N/A — one adjudicator per predicate after CFP2] · R49 [Checked] · R50 [Checked — gates executed, not inferred] · R51–R54 [N/A] · R55 [Checked] · R56, R57 [N/A] · RS1 [N/A] · RS2 [Checked — the limiter was strengthened] · RS3 [Checked] · RS4, RS5 [N/A] · RS6 [Checked — the CSV path is structurally immune]

### Testing expert

R1–R18, R20–R28, R30–R57 [Not re-derived — incremental verification on Phase 2's full pass; no incidental hits] · R19 [Checked, hook + manual] · **R29 [Fired — T-F2]** · RS1–RS6 [N/A — security scope] · RT1 [Checked — `pgConstraintName` is tied to a REAL raised Postgres error by the integration suite, so the hand-written fixtures are not its only tie to reality] · RT2 [Checked] · RT3 [Not re-derived] · RT4 [N/A — no race-shaped tests] · RT5 [Checked] · RT6 [Checked — all 9 new exports covered in the same diff] · RT7 [Checked — every new guard has a committed case that makes it fail] · RT8 [Checked — deny arms assert the mutation, not only the status] · **RT9 [Fired — T-F1]** · RT10 [Checked, hook + manual — boundary-adjacent allow arms throughout] · RT11 [Checked — every new fixture is marker-scoped, in `finally`, with VC2 drain detection]

## Environment Verification Report

Phase 1 declared five verification-environment constraints. Each contract's
acceptance paths classify as:

| Constraint | Subject | Status |
|---|---|---|
| **VC1** — no reverse proxy in dev | C1's trusted-proxy XFF paths as a full proxied request | `blocked-deferred` → Phase 1 VC1; C1 adds no parsing path, and every XFF value source is `verified-local` at the unit level (`src/lib/auth/policy/ip-access.test.ts`, `src/__tests__/lib/ip-access.test.ts`, 289 tests) |
| **VC2** — integration tests and the compose workers cannot share a database | every C2/C3/C5 acceptance path touching `audit_outbox` | `verified-local` — `docker compose stop audit-outbox-worker retention-gc-worker` then `npm run test:integration`, 106 files / 651 tests. The Testing expert enumerated the new assertions and confirmed every emit-side one reads `audit_outbox`, never `audit_logs` |
| **VC3** — the dev database is shared and live | C2's constraint-drop red proofs; any fixture that can COMMIT sentinel-scoped rows | `verified-local` — the deny arms are rejected INSERTs that write nothing (run on dev); the two red proofs that mutate source ran in **detached git worktrees**, and both were removed |
| **VC4** — `prisma migrate dev` times out on its post-apply prompt | C2's migration rollout | `verified-local` — the migration applied, then the run timed out on the prompt exactly as predicted; verified via `pg_constraint` (all three CHECK names present) and `_prisma_migrations` |
| **VC5** — no SAML IdP in dev | C3 as a real SSO round trip | `blocked-deferred` → Phase 1 VC5, and the plan's own Anti-Deferral (the state is unreachable in-app, SC8). C3 is `verified-local` at unit and integration level: both constraint-firing paths are driven by value against a real database |

No `blocked-deferred` path lacks a Phase 1 constraint link.

## Resolution Status

### T-F1 Major — the twin cannot fail for the byte-vs-code-unit reason it claims

- **Action**: added a multi-byte case to `src/__tests__/audit.mocked.test.ts`
  mirroring the co-located tree's CF17 pin — `"あ".repeat(10_228)`, whose JSON
  sits UNDER `METADATA_MAX_BYTES` in code units and roughly 3× over it in bytes.
  It asserts `_truncated`, the exact byte count, and explicitly that
  `_originalSize` is **not** the code-unit count. The ASCII case is kept, with
  its comment corrected to say what it does and does not show.
- **Red-proved by execution** in a detached worktree, one mutation: reverting
  `src/lib/audit/audit.ts`'s `Buffer.byteLength` to `json.length` reds **exactly
  the new case** (1 failed / 29 passed) and leaves the ASCII case green —
  confirming the finding's diagnosis as well as the fix.
- **Modified**: `src/__tests__/audit.mocked.test.ts` — the ASCII truncation case's comment, and a new multi-byte truncation case beside it.

### T-F2 Major — CFP3's Anti-Deferral cost claim was inaccurate

- **Action**: the deferral was **closed**, not restated. Added
  `src/__tests__/db-integration/mcp-token-ip-rate-capacity.integration.test.ts`,
  which drives the real `POST /api/mcp/token` against the real limiter to `max`
  and `max + 1`, plus a second case proving the bound is per-IP rather than
  global. `MCP_TOKEN_IP_RATE_MAX` / `MCP_TOKEN_IP_RATE_WINDOW_MS` moved to
  `src/lib/constants/auth/mcp.ts` so the route and the test read one number.
- **Boundary and tie stated**: the cap is the number of requests ADMITTED —
  request `max` is the last allowed, `max + 1` the first refused.
- **Allow side paired with deny side**: the first request must be allowed. The
  limiter is `failClosedOnRedisError: true`, so an unreachable Redis refuses
  everything and would satisfy the deny assertion alone; the allow arm is what
  rules that out.
- **Fails loudly rather than skipping**: a Redis outage reds the allowed arm with
  a message naming the request index, instead of passing vacuously.
- **Does not delete what made the defect visible**: the `unknown`-bucket identity
  assertion in `route.test.ts` is untouched; the new file deliberately does not
  exhaust that shared key, and says why.
- **Red-proved by execution**, one mutation per clause, in a detached worktree:
  moving the constant alone stays green (both sides read it — the property CFP3
  asked for); decoupling the route's bound from the constant reds both cases;
  making the bucket key global reds only the per-IP case.
- **Modified**: `src/lib/constants/auth/mcp.ts` (the two new capacity constants), `src/app/api/mcp/token/route.ts` (`ipRateLimiter`'s config),
  `src/__tests__/db-integration/mcp-token-ip-rate-capacity.integration.test.ts` (new),
  `docs/archive/review/audit-sentinel-carried-forward-deviation.md` (CFP3 rewritten as closed)

## Termination Check

Round 1 produced two Major findings, both fixed. Neither fix is an inline minor:
T-F2 touches a rate-limiting path, which the tightening-only skip's closed list
names explicitly as a security boundary. **Round 2 is therefore required**, not
optional, and the skip is unavailable.

No R42 class in this branch expanded its member set across rounds, so the
mutation-verified-CI-guard convergence condition does not apply.

## Citation gate disposition (R29, mechanical half)

`verify-references.sh --base 1628b97fe --strict` reports 101 references: 10 OK,
12 SHIFTED, 79 unresolvable because the Phase-1 artifacts cite bare filenames the
gate cannot resolve to a path (pre-existing style, not corrected here).

**All 12 SHIFTED are deliberate and were re-verified by reading the working
tree**, one line at a time. The gate compares every citation against the base
ref, and the deviation log's citation-drift table records BOTH columns on
purpose — "Cited (at `1628b97fe`)" and "Now". Entries in the first column must
differ from HEAD, and entries in the second must differ from the base. There is
no way to satisfy a base-anchored gate with a document whose subject is the
movement itself.

Re-read against the working tree, each resolving to what the prose claims:
`tenant-rls.ts:128`/`:136`/`:138`, `auth.ts:71`, `audit.ts:145`,
`auth-adapter.ts:331`, `mcp/token/route.ts:40-43`,
`audit.mocked.test.ts:174`/`:178`/`:202`. One imprecision was found and corrected
by this pass: the nesting-guard citation pointed at the `throw` rather than at
the `if` that decides it, so it now names `:128` with the sentinel refusal's own
line beside it.

---

# Round 2 (incremental)

Date: 2026-09-04 · Reviewed at `61fc67077` · Changes since Round 1: `429d13533..HEAD`, 6 files, +463/-24.

## Changes from Previous Round

Round 1's two Majors were fixed and the fixes reviewed. **Testing found one
Critical and one Major, both inside Round 1's own remedy** — the shape this
branch's Phase 1 recorded as its most expensive recurring failure, arriving once
more. Functionality and Security each returned **No findings**; Security added one
Minor advisory that predates the round.

## Security Findings

**No findings.** Verified by execution rather than inspection:

- **R43** — `windowMs`/`max` are byte-for-byte the previous values, now sourced
  from the new constants. Only the route, the constants file and the new test
  reference them, so nothing couples this limit to another; `tokenRateLimiter`'s
  `max: 10` stays a separate untouched literal.
- **Residency** — the constants file is already imported by two client
  components for unrelated exports. The app was built and `.next/static` grepped
  for `MCP_TOKEN_IP_RATE`: no match, while a sibling string from the same module
  (`credentials:list`) does appear in two client chunks — which validates the
  methodology rather than assuming it. The constant is tree-shaken out.
- **Shared Redis** — after the suite, `redis-cli keys "rl:mcp:token:ip:192.0.2.*"`
  was empty and `rl:mcp:token:ip:unknown` was nil: cleanup works and the shared
  bucket was never touched. `vitest.integration.config.ts` sets `isolate: true`,
  so `__resetThrottleForTests()`'s in-process Map cannot bleed across files.
  Both CI workflows set `REDIS_URL`, so `skipIf(!redisAvailable)` does not
  silently no-op the property in CI — read from the workflow files.

**Minor advisory (declined, with reason).** The new constants — and the
pre-existing `DCR_RATE_LIMIT_*` beside them — live in a module client components
already import. A `.server.ts` split would make the current tree-shaking
guarantee structural rather than incidental. Not taken: the split would be
partial while `DCR_RATE_LIMIT_*` stays, which is a worse state than either end;
a rate-limit capacity is not secret (an attacker measures it by probing, and the
`Retry-After` header discloses the window anyway); and the cited precedent,
`verifier-version.ts`, guards crypto-material versioning, a different
sensitivity class. Recorded here rather than silently dropped.

## Functionality Findings

**No findings.** (See the Round 2 Recurring Issue Check.)

## Testing Findings

### T-F10 — **Critical** — the capacity test's allow arm could not fail for the reason both documents claimed

`src/__tests__/db-integration/mcp-token-ip-rate-capacity.integration.test.ts`.
The loop asserted `not.toBe(429)`. But `checkRateLimitOrFail` renders a
fail-closed refusal as `oauthTemporarilyUnavailable()` — **503**
(`src/lib/http/api-response.ts:187-194`) — which satisfies `not 429` on every
one of the thirty iterations. The file's docblock and the CFP3 entry both
claimed "an unreachable Redis denies immediately — this suite then reds on its
first assertion with a message naming the allowed arm". **False.** The suite red
only at the final boundary, with a generic `expected 503 to be 429` naming
neither the request index nor the arm.

The property the file exists to prove — *the endpoint is not silently
fail-closed* — was therefore asserted nowhere in it. It still failed under a
total outage by luck (503 ≠ 429), but said nothing diagnostic, and a partial
outage or any future non-429 refusal envelope would have passed it vacuously.

The reviewer verified this by execution, short-circuiting `checkRedis()` in a
detached worktree: both cases failed at the boundary assertion, not on request 1
— exactly as predicted and not as documented.

**Status: fixed.**

### T-F11 — Major — `perRunIp()` had no collision guard

Same file. `exhausted` and `fresh` were each one draw from a 254-value space
(`192.0.2.x`), compared with a bare `expect(fresh).not.toBe(exhausted)` and no
retry — a ~0.4% self-inflicted failure per run. The same 254 values also
undercut the file's own claim that randomisation keeps two concurrent working
copies out of each other's buckets: at that width a cross-run collision is a
live probability, not a remote one. Leaked buckets self-heal on the 60 s TTL, so
the consequence is a spurious verdict rather than corruption — but it is a flake
source with no mitigation.

**Status: fixed.**

### Round 1 findings — both re-verified by re-running the claimed proofs

The reviewer re-ran every mutation the Round 1 Resolution Status claimed, in
detached worktrees against the real route and the real dev Redis, and all three
reproduced precisely: the constant moved 30 → 3 stays green; decoupling the
route's bound (`+ 5`) reds both cases; the global bucket key reds only the
per-IP case. T-F1's proof likewise reproduced — 1 failed / 29 passed, the ASCII
case green. **T-F1 and T-F2 are resolved.**

### RT4 / window rollover — measured, no finding

Thirty sequential real requests complete in ~30 ms against a 60,000 ms window —
roughly 2000× headroom, so the rollover RT4 asks about is not reachable at
current request cost. Not asserted anywhere, so a future change adding
synchronous work before the limiter could start flaking with no test-side
signal; recorded rather than filed.

## Adjacent Findings

None new this round.

## Quality Warnings

None.

## Recurring Issue Check — Round 2

### Functionality expert
Round 2's diff is two production lines and otherwise tests and prose; R-rules were checked against that surface. R29 was the round's focus for this expert (every intra-repo citation and derived number in the new prose re-read or re-run).

### Security expert
R43 [Checked — values unchanged, no coupling introduced, residency verified by building and grepping the bundle] · R29 [Checked — every cited location read directly] · RS2 [Checked — the limiter is strengthened, not weakened] · RS3, RS6 [Checked] · all others [N/A or unchanged from Round 1]

### Testing expert
**RT7 [Fired — T-F10: a guard that could not fail for its stated reason]** · **RT4 [Fired — T-F11: a self-flaking draw]** · RT10 [Checked — the allow arm is now boundary-adjacent AND asserts a concrete status] · RT11 [Checked — `afterAll` reclaims every key it created, including the isolation case's two] · RT1, RT5 [Checked — the limiter is genuinely reached; proved by the fail-closed mutation changing the observed status] · R29 [Checked]

## Resolution Status — Round 2

### T-F10 Critical — the allow arm could not distinguish an admitted request from a fail-closed 503

- **Action**: the allow arm now asserts the concrete admitted outcome —
  `400 unsupported_grant_type` — in both cases, with a message naming the
  request index and what each other status would have meant. The docblock's
  "What a failure means" section was rewritten to state what the old form could
  not do, so the record says why the assertion is shaped this way.
- **Boundary and tie**: unchanged and still stated — request `max` is the last
  admitted, `max + 1` the first refused.
- **Allow paired with deny**: this IS the repair to the allow side.
- **Fails loudly**: a fail-closed limiter now reds at the first request rather
  than at the boundary.
- **Nothing deleted that made the defect visible**: the deny assertions and the
  per-IP isolation case are untouched.
- **Red-proved by execution**, one mutation, in a detached worktree: `getRedis()`
  forced to null makes the limiter fail closed, and the suite now reds at
  `request 1 of 30 did not reach the handler (429 = rate-limited, 503 = limiter
  failed closed): expected 503 to be 400` — the exact failure the prose
  describes, which the previous form did not produce.
- **Modified**: `src/__tests__/db-integration/mcp-token-ip-rate-capacity.integration.test.ts` — the docblock's "What a failure means" section, the capacity case's loop assertions, and the isolation case's allow assertion; the CFP3 entry in the deviation log corrected to record that its own claim had been false.

### T-F11 Major — `perRunIp()` had no collision guard

- **Action**: the draw moved from a single RFC 5737 /24 (254 values) to
  198.18.0.0/15, RFC 2544's benchmarking range (~131k values, and semantically
  the range reserved for exactly this kind of device testing). The bare
  inequality assertion became `perRunIpDistinctFrom()`, which retries.
- **Fails loudly**: bounded at eight attempts rather than looping forever, and
  it throws naming the broken entropy source rather than hanging or reporting a
  verdict it cannot support.
- **Modified**: same file — `perRunIp()`, the new `perRunIpDistinctFrom()` helper, and the isolation case's second-address draw.

## Termination Check — Round 2

Two findings, both fixed, both inside Round 1's own remedy. The tightening-only
skip is **unavailable**: T-F10 is Critical, and both findings sit on a
rate-limiting path, which the skip's closed list names as a security boundary.
**Round 3 is required.**

## Round 2 — Functionality Findings

### F-R29-1 — Major — the code-review log stated a test count that was false, twice

`docs/archive/review/audit-sentinel-carried-forward-code-review.md`. Both the
Security Recurring-Issue Check and the Environment Verification Report's VC1 row
cited **433 tests** for the two `ip-access` twin trees. Measured: **289** — which
this branch's own deviation log had already recorded correctly for the identical
pair. The conclusion (the twins pass; VC1 is `verified-local`) was true; the
number offered as its evidence was not.

**Root cause, and it is not a typo.** 433 was a real measurement — the Round 1
Security expert ran it "across the touched trees", a wider set — and it was
copied into a sentence about a narrower subject. That is the same mistake three
more times over in the same document, found by sweeping every stated number
after this one surfaced:

| Claim | Stated | Measured |
|---|---|---|
| the `ip-access` twins | 433 tests | **289** |
| the integration suite, VC2 row | 105 files / 649 tests | **106 / 651** (a file was added after the row was written) |
| commits under review at `429d13533` | 5 ("three Phase-2 fixes") | **6** (four fixes) |
| changed test files run | "23 changed test files (854 tests)" | **26** non-integration changed test files, **921 tests** — the reviewer's 23/854 was a subset it chose, not the changed set |

**Fix**: all four corrected against a live measurement, and the changed-test-file
figure replaced with one the orchestrator re-ran itself rather than one inherited
from a sub-agent's differently-scoped run. The general repair is the rule the
plan already applies to its own Derived figures — **a number is stated only with
the command that produces it, and only about the subject that command measured**
— which this document was not holding itself to.

**Status: fixed.**

### F-R29-2 — Minor — off-by-one in the D12 citation table

`docs/archive/review/audit-sentinel-carried-forward-deviation.md`. The row for
`audit.mocked.test.ts:186` pointed its "now" column at `:192`, which is
`_truncated: true`; the exact-byte-count assertion it describes is at `:193`.
Pre-existing since Phase 2 and not among the twelve citations Round 1 re-verified.

**Fix**: corrected to `:193`. **Status: fixed.**

## Termination Check — Round 2 (final)

Four findings this round: one Critical (T-F10), two Major (T-F11, F-R29-1), one
Minor (F-R29-2). All fixed. Round 3 is required — T-F10 is Critical and both
testing findings sit on a rate-limiting path, which the tightening-only skip's
closed list names as a security boundary.

---

# Round 3 (incremental)

Date: 2026-09-04 · Reviewed at `424de1c20` · Changes since Round 2: `61fc67077..HEAD`, three files, **no production code**.

## Changes from Previous Round

Round 2's four findings were fixed. **Security and Testing returned No findings;
Functionality returned one Major** — again inside the previous round's own
remedy, the third round running.

## Security Findings

**No findings.** The one item with a security dimension was the test's new
address range, and it was run down rather than assumed: `198.18.0.0/15` **is**
listed in the SSRF blocklist (`src/lib/http/external-http.ts:39`), but that list
gates **outbound** fetch targets only — `webhook-dispatcher`, the audit-delivery
and outbox workers, the two favicon proxies — and is never consulted by
`extractClientIp`, `isIpAllowed`, or the limiter this suite exercises. The
coincidence is real and inert, and the two uses share the same "never a real
client" rationale. No overlap with `TRUSTED_PROXIES`' defaults or the Tailscale
ranges. R43: confirmed by reading the diff that no production predicate changed.

Round 2's declined Minor advisory was re-assessed and the decline accepted, with
both supporting facts re-verified.

## Testing Findings

**No findings.** Both Round 2 fixes were verified by independent execution, not
by reading:

- The T-F10 red proof was reproduced byte-for-byte in the reviewer's own detached
  worktree.
- `perRunIp()` was run **200,000 times** against the real `isValidIpAddress`: 0
  invalid, 0 out of range, 102,531 distinct — the birthday-paradox expectation
  for a uniform ~131,072-value space, so the docblock's distribution claim holds
  under execution rather than by arithmetic.
- `perRunIpDistinctFrom` was run 100,000 times: 0 throws. The 8-attempt bound is
  unreachable under a working RNG (~1e-40), which is correct for a
  broken-entropy guard.
- All four of Round 2's corrected numbers were re-run and matched.

The reviewer also asked whether asserting `400` over-constrains the allow arm by
coupling it to the grant-type switch, and answered it by checking: `checkRateLimitOrFail`
returns `null` on allow and attaches nothing to the response, so there is no
nearer observable of admission without either mocking (which this file exists to
avoid) or adding production instrumentation. The coupling is narrow — nothing
sits between the limiter and that switch — and stands.

## Functionality Findings

### F-R30-1 — Major — the fourth-mutation row overclaimed, and the overclaim hid a live instance of the defect it described

`docs/archive/review/audit-sentinel-carried-forward-deviation.md`. The row read
"both cases red at `request 1 of 30 … expected 503 to be 400`". The reviewer ran
the mutation and found case 2 reds at a bare `expected 503 to be 429` instead —
an assertion carrying **no message at all**.

The prose error is the smaller half. The substance is that **T-F10's fix closed
the instance and not the class**: the loop received a diagnostic message and the
file's other six assertions did not, so the exact defect T-F10 was written up to
remove — a generic `expected N to be M` naming neither the arm nor what the
observed status meant — was still live in the same file, masked only by case 1
failing first and by this row overstating what case 2 produced.

**Status: fixed.**

## Adjacent Findings

None.

## Quality Warnings

None.

## Recurring Issue Check — Round 3

### Security expert
R43 [Checked — no production predicate changed, confirmed by reading the diff] · R29 [Checked — the 503 rationale verified against `api-response.ts:187-194`, `rate-limit-audit.ts:254-257`, and all three `envelope: "oauth"` call sites in the route] · all others [N/A — no production code in the diff]

### Functionality expert
**R29 [Fired — F-R30-1]**, plus nine other numeric and citation claims re-run and matched. All others [N/A or unchanged].

### Testing expert
RT7 [Checked — the red proof independently reproduced] · RT10 [Checked — the allow arm is the nearest observable available to a no-mock design] · RT11 [Checked — `usedKeys` is pushed before any request that could increment the bucket, so a mid-test throw still leaves everything reclaimable; no residue observed after the reviewer's own run] · RT4 [Checked — `perRunIp`'s distribution measured over 200k draws] · R29 [Checked]

## Resolution Status — Round 3

### F-R30-1 Major — the instance was fixed, the class was not

- **Action, taken over the class rather than the two assertions the finding
  named**: all seven assertions in the file now carry a diagnosis, rendered by a
  single `diagnose()` helper so what 400/429/503 each mean is stated once instead
  of seven times. Each message names the arm that failed — "request N of 30 was
  not admitted", "the exhausted address was not refused, so the precondition for
  this case never held", "the second address was refused, so the bound is not
  per-IP".
- **Allow paired with deny**: unchanged; the suite still passes green, verified.
- **Red-proved by execution**, same mutation, in a detached worktree: `getRedis()`
  forced to null now reds **both** cases with their own self-describing messages —
  case 1 `request 1 of 30 was not admitted … expected 503 to be 400`, case 2
  `the exhausted address was not refused … expected 503 to be 429`. Previously
  case 2 produced a bare `expected 503 to be 429`.
- **Fails loudly**: a future status outside {400, 429, 503} now fails with a
  message that says what the three known ones would have meant.
- **Nothing deleted**: only messages added; every assertion and its subject are
  unchanged.
- **The deviation log's row corrected** to state the two cases' actual, different
  signatures rather than one shared string, with a note recording that it had
  overclaimed.
- **Modified**: `src/__tests__/db-integration/mcp-token-ip-rate-capacity.integration.test.ts` — the new `diagnose()` helper, and all seven assertions across both cases; the CFP3 entry in the deviation log.

## Termination Check — Round 3

One Major, fixed. It sits on a rate-limiting path, so the tightening-only skip is
unavailable and **Round 4 is required**.

---

# Round 4 (incremental)

Date: 2026-09-05 · Reviewed at `900b983e2` · Changes since Round 3: `424de1c20..HEAD`, two files, **no production code**.

## Changes from Previous Round

Round 3's Major (F-R30-1) was fixed by closing the class rather than the two
assertions the finding named. **All three experts found the fix correct and
complete.** Two Minors surfaced, and the two experts converged on the same one.

## Security Findings

**No findings.** Two narrow checks, both established rather than assumed:

- **No production code in the diff** — confirmed by reading `--stat`: nothing
  under `src/lib/`, `src/app/`, `prisma/` or `scripts/`.
- **The new assertion messages leak nothing into CI logs.** `diagnose()` and its
  call sites interpolate only the loop index, `MCP_TOKEN_IP_RATE_MAX`, and fixed
  prose — no token, no bucket key, no address, no response body.

Round 3's SSRF-blocklist conclusion was independently re-derived from the code
rather than read back from the log: `BLOCKED_CIDRS` has **zero** references
outside `external-http.ts`, and its five consumers are exactly
`webhook-dispatcher.ts`, the audit-delivery and outbox workers, and the two
favicon **routes** (`favicon-proxy.ts` mentions the helper only in a comment).
The record matches.

## Functionality Findings

### F-R31-1 — Minor — a line-range citation overreached by one blank line

`docs/archive/review/audit-sentinel-carried-forward-code-review.md`. The Round 3
"Modified" list cited `:191-195`; the edited statement ends at `:194` and `:195`
is an untouched blank line, while every other range in the same list stops at its
statement's closing `;`. **Status: fixed** — the same class the document had
already fixed once as F-R29-2, one round after promising a sweep.

The expert also reproduced the Round 3 mutation independently (isolated worktree,
`getRedis()` → null) and matched both messages verbatim, re-derived `perRunIp()`'s
distinctness over 200,000 draws (**102,464** distinct against the doc's 102,531 —
both inside the birthday-paradox band of ≈102,585 for a 131,072-value space, i.e.
a re-rolled random draw rather than a discrepancy), and confirmed
`perRunIpDistinctFrom` throws 0 times in 100,000 runs.

## Testing Findings

### T-R31-1 — Minor — `diagnose()`'s status legend is inert at the three `json.error` sites

`src/__tests__/db-integration/mcp-token-ip-rate-capacity.integration.test.ts`.
The three-status legend is live information at the four **status** assertions,
where the status is genuinely unknown before the call. At the three **`json.error`**
assertions it is not: each runs only because the status assertion above it
already passed, and `expect().toBe()` throws synchronously — so the status is
already pinned and the legend answers a settled question. Not misleading today,
but it stops being inert the moment the grant-type switch grows a second 400.

**Both experts raised this independently** — the Functionality expert reached it
from the "is `diagnose()` the right shape?" question and the Testing expert from
the assertion sweep. Perspective convergence on a Minor.

**Status: fixed** — the three `json.error` assertions now carry a short message
naming the already-known status and the mismatch actually being pinned; the
helper's docblock records why it is used at some sites and not others.

The expert also swept the six sibling test files this branch touched for the same
class and found none — and said why the one near-miss
(`access-request-approve-scope-dedup.integration.test.ts`'s bare status
assertions) is not the same shape: CF16's failure surfaces as a thrown Prisma
error carrying the constraint name, not as a status the test could misread.

## Adjacent Findings

None.

## Quality Warnings

None.

## Recurring Issue Check — Round 4

### Security expert
R29 [Checked — every claim in the added prose re-derived from code] · all others [N/A — no production code in the diff]

### Functionality expert
**R29 [Fired — F-R31-1]**, with the mutation reproduced and three numeric claims re-derived · all others [N/A or unchanged]

### Testing expert
RT7 [Checked — red proof independently reproduced byte for byte] · RT9 [Checked — the class swept across all six sibling files this branch touched] · **R37 [Fired — T-R31-1: a message that does not characterise what it pins]** · R29 [Checked] · all others [Checked or N/A]

## Resolution Status — Round 4

### F-R31-1 Minor — citation overreach
- **Action**: `:191-195` → `:191-194`, verified by re-reading the file.

### T-R31-1 Minor — the status legend at the `json.error` sites
- **Action**: the three `json.error` assertions take a site-specific message
  naming the already-confirmed status and the string mismatch being pinned. The
  four status assertions keep `diagnose()` unchanged.
- **Nothing deleted**: every assertion, subject and matcher is unchanged; this is
  message text only.
- **Verified by execution**: the suite is green, and re-running the `getRedis()`
  → null mutation produces byte-identical messages at the two status assertions —
  confirming the change is confined to the sites it names.
- **Modified**: `src/__tests__/db-integration/mcp-token-ip-rate-capacity.integration.test.ts` — `diagnose()`'s docblock, and the three `json.error` assertion messages.

## Termination Check — Round 4

Two Minors, both fixed. The tightening-only skip's first two conditions hold —
both findings sit inside Round 3's fix scope, and both are inline minors (a
document line number and assertion message text, which the skip's own list names).
**Condition 3 does not hold**: the file under change is the rate-limiting
capacity suite, and the skip's closed list names rate-limiting explicitly. The
skip is unavailable by the letter of its own rule, whatever the composition risk
of a message string actually is. **Round 5 is required.**

---

# Round 5 (incremental)

Date: 2026-09-05 · Reviewed at `c3eca5921` · Changes since Round 4: `900b983e2..HEAD`, two files, **no production code**.

## Changes from Previous Round

Round 4's two Minors were fixed. Security and Functionality found the fixes
correct. Testing found the same defect class for the **third time** — and this
time it was introduced in the very commit that fixed its second occurrence.

## Security Findings

**No findings.** Scope established by reading `--stat`: nothing under `src/lib/`,
`src/app/`, `prisma/` or `scripts/`. The three rewritten messages interpolate only
a loop counter and fixed status literals — no token, bucket key, IP address or
response body. The Round 4 log's `BLOCKED_CIDRS` claim was re-derived rather than
read back, and the "five consumers" count was confirmed **including** the
indirect one: `audit-outbox-worker.ts` does not import the guard, but reaches it
through `DELIVERERS` imported from `audit-delivery.ts`.

## Testing Findings

All four checks the round asked for held: no assertion's subject, matcher or
strictness moved (only message arguments changed, confirmed by `git diff -U0`);
each of the three new messages describes a state genuinely already pinned by the
status assertion above it, with no intervening code; the docblock's
synchronous-throw premise was verified against this project's actual config
(`vitest.config.ts` and `setup.ts` carry no `expect.soft`, `expect.configure` or
`expect.extend` override); and the birthday-paradox band was recomputed
independently — for N = 131,072 and n = 200,000 the expected distinct count is
**102,573** with σ ≈ **113**, so the two cited figures sit 109 and 42 from the
mean, inside one σ.

### T-R32-1 / F-R32-2 — Minor — two more "Modified" citations, the third and fourth instances of one class

`docs/archive/review/audit-sentinel-carried-forward-code-review.md`. Round 4's
Resolution Status cited `:104-115` for the `diagnose()` docblock change; the diff
is a pure insertion at `109`, and `104-108` is untouched prose from a different
paragraph. Correct range: `109-115`.

The Functionality expert independently found a **fourth**: the `:191-194` range
Round 4 had just corrected was already stale against HEAD, moved by this round's
own edits to the same file.

**Both fixed by changing the mechanism, not the numbers** — see below.

## Functionality Findings

**F-R32-1** (the `:104-115` overreach, converging with Testing's T-R32-1) and
**F-R32-2** (the `:191-194` range gone stale within the round that corrected it).
Both Minor, both members of the class disposed of below. The expert also
re-derived the birthday-paradox expectation independently — 131,072 ×
(1 − e^(−200000/131072)) = **102,573** — and corrected its own first pass on the
`BLOCKED_CIDRS` consumer count before reporting, having initially found four and
then traced the outbox worker's indirect route through `DELIVERERS`.

## Adjacent Findings

None.

## Quality Warnings

None.

## Resolution Status — Round 5

### T-R32-1 Minor — and the class behind it

- **What happened four times.** F-R29-2 (Round 2), F-R31-1 (Round 4), T-R32-1
  and F-R32-2 (both Round 5) are one defect: a hand-written line range in this
  document's `Modified:` entries that does not match what was edited. The third
  instance was introduced **in the commit that fixed the second**.
- **The fourth is the sharpest evidence, and it is not a miscount at all.**
  F-R32-2 is the range `:191-194` — the one Round 4 corrected from `:191-195`
  after careful re-reading. It was right for the commit it was written against
  and had already gone stale by the end of the same round, because this round's
  own edits to that file inserted seven lines above it and moved the statement to
  `:202-205`. No amount of care at write time prevents that. A citation that
  correct-at-write-time cannot keep is not a citation with a bug; it is the wrong
  kind of citation.
- **Why fixing the number again would be wrong.** Three occurrences is the signal
  that the anchor is a symptom. And the deeper problem is not miscounting: a
  post-change line range describes a file *as it was at the end of one round*, in
  a document that outlives every later round. Four of the six `Modified:` entries
  point at the same file, which subsequent rounds edited twice more — so the
  Round 1 and Round 2 ranges were already stale before anyone looked, and would
  go stale again on the next edit no matter how carefully each was checked.
  Perpetually re-verifying them is the treadmill; the citation gate cannot help,
  because these are post-change positions and it compares against the base ref.
- **Mechanism change**: all six `Modified:` entries now name **what** was changed
  — the helper, the docblock section, the loop's assertions, the isolation case's
  draw — instead of where. A name does not drift when a line is inserted above
  it, and it tells a reader more than an offset does. The class is closed by
  construction rather than by another correction.
- **Nothing deleted**: every entry still says which files changed and which part
  of each; only the perishable coordinate is gone.
- **Boundary stated**: this applies to `Modified:` entries, which describe
  post-change state. The deviation log's citation-drift **mapping table** keeps
  its line numbers deliberately — that table's whole subject is where things
  moved, and it is explicitly anchored to two named commits.

## Termination Check — Round 5

One Minor, closed at the class level. The change is confined to this review
document's own prose — it touches no test, no production code, and no security
boundary — so the tightening-only skip's three conditions all hold: inside the
prior round's fix scope, inline minor (documentation wording), and no
security-boundary contact.

**Skip taken. No Round 6.**

## Tightening-only skip — Round 5

Findings applied directly (no Round 6 review):
- [T-R32-1] [F-R32-1] [F-R32-2] [Minor] `Modified:` line-range citations replaced by named subjects across all six entries — `docs/archive/review/audit-sentinel-carried-forward-code-review.md` — applied as one class-level mechanism change rather than the three single-range corrections the findings proposed.

Justification: the finding is scoped within Round 4's fix range, is an inline
minor (documentation wording only), and touches no item on the security-boundary
list — the edited artifact is the review log itself, not the rate-limiting suite
it describes.
