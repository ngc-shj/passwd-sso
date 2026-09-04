# Code Review: audit-sentinel-carried-forward

Date: 2026-09-04
Review round: 1
Branch: `fix/audit-sentinel-carried-forward-cf11-cf17`
Base: `1628b97fe` · Reviewed at `429d13533` (5 commits: `b4fa914f2` plan, `f4e50a70b` implementation, three Phase-2 self-check fixes)

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
15/11/4 CI-gate parity) and matched; `npx tsc --noEmit` clean; targeted
`vitest run` across 23 changed test files (854 tests) green; the parity,
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

R1 [Checked] · R2 [N/A] · R3 [Checked — no other raw IP-header reader, no other PKCE ingress, no un-deduped scope site with a security consequence] · R4–R8 [N/A] · R9 [Checked — SC7 not reintroduced] · R10–R16 [N/A] · R17 [Checked] · R18 [N/A] · R19 [Checked — twin trees run, 433 green] · R20–R28 [N/A] · R29 [Checked — derived figures re-run; `oauth-server.ts:270-271` read directly] · R30–R41 [N/A] · R42 [Checked — no fourth sentinel constraint exists] · R43 [Checked — the normalization widening is the plan's accepted, parity-guarded decision] · R44–R46 [N/A] · R47 [Checked — gated behind the real SQLSTATE, detection-only] · R48 [N/A — one adjudicator per predicate after CFP2] · R49 [Checked] · R50 [Checked — gates executed, not inferred] · R51–R54 [N/A] · R55 [Checked] · R56, R57 [N/A] · RS1 [N/A] · RS2 [Checked — the limiter was strengthened] · RS3 [Checked] · RS4, RS5 [N/A] · RS6 [Checked — the CSV path is structurally immune]

### Testing expert

R1–R18, R20–R28, R30–R57 [Not re-derived — incremental verification on Phase 2's full pass; no incidental hits] · R19 [Checked, hook + manual] · **R29 [Fired — T-F2]** · RS1–RS6 [N/A — security scope] · RT1 [Checked — `pgConstraintName` is tied to a REAL raised Postgres error by the integration suite, so the hand-written fixtures are not its only tie to reality] · RT2 [Checked] · RT3 [Not re-derived] · RT4 [N/A — no race-shaped tests] · RT5 [Checked] · RT6 [Checked — all 9 new exports covered in the same diff] · RT7 [Checked — every new guard has a committed case that makes it fail] · RT8 [Checked — deny arms assert the mutation, not only the status] · **RT9 [Fired — T-F1]** · RT10 [Checked, hook + manual — boundary-adjacent allow arms throughout] · RT11 [Checked — every new fixture is marker-scoped, in `finally`, with VC2 drain detection]

## Environment Verification Report

Phase 1 declared five verification-environment constraints. Each contract's
acceptance paths classify as:

| Constraint | Subject | Status |
|---|---|---|
| **VC1** — no reverse proxy in dev | C1's trusted-proxy XFF paths as a full proxied request | `blocked-deferred` → Phase 1 VC1; C1 adds no parsing path, and every XFF value source is `verified-local` at the unit level (`src/lib/auth/policy/ip-access.test.ts`, `src/__tests__/lib/ip-access.test.ts`, 433 tests) |
| **VC2** — integration tests and the compose workers cannot share a database | every C2/C3/C5 acceptance path touching `audit_outbox` | `verified-local` — `docker compose stop audit-outbox-worker retention-gc-worker` then `npm run test:integration`, 105 files / 649 tests. The Testing expert enumerated the new assertions and confirmed every emit-side one reads `audit_outbox`, never `audit_logs` |
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
- **Modified**: `src/__tests__/audit.mocked.test.ts:174-178, 202-247`

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
- **Modified**: `src/lib/constants/auth/mcp.ts`, `src/app/api/mcp/token/route.ts:40-43`,
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
