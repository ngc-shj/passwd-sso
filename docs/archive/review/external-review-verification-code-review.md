# Code Review: external-review-verification

Date: 2026-08-01
Review round: 1
Subject: HEAD `99fa66b47`, branch `fix/harden-cli-tailnet-ssrf`, working tree clean
Scope: adjudication of an external reviewer's 5 claims (overall assessment 8.4/10)

## Changes from Previous Round

Initial review. This is not a branch-diff review — the target is a set of repo-wide
claims made by an external reviewer. Step 3-2 (Ollama seed generation) was skipped:
seeds derive from `git diff main...HEAD`, but none of the 5 claims concern the branch
diff (which is CLI tailnet SSRF hardening). All three experts recorded
`Seed unavailable — no dispositions to record.`

## Claim Adjudication Summary

Verdict key: (a) true and worth fixing — (b) true, not worth fixing — (c) factually
wrong — (d) directionally right, wrong evidence.

| # | Claim | Verdict | What the verification established |
|---|-------|---------|-----------------------------------|
| 1 | `mcp-tokens/[id]/route.ts` 0% coverage | **(a)** | True and **understated**. It is the only genuinely untested route of 212 (6 lack a sibling test; 5 are tested from non-sibling paths). Not a thin wrapper — ~90 lines of hand-duplicated revocation cascade, which has **already drifted** from its tested twin. |
| 2 | `audit-chain-verify` 49% lines / 32% branches | **(d)** | Numbers exact to the decimal (50.50 / 32.39 / 49.47). The diagnosis stops at the percentage and misses two defects: a fail-open in the verifier itself, and an "integration test" that never imports the endpoint. |
| 3 | Coverage thresholds too low; raise to 80/70 + add per-file floors | **(d)** | Two false premises. (i) "statements 60%相当" is not a configured value — there is no `statements` key at all. (ii) Per-file floors **already exist at exactly the proposed 80/70** on exactly the proposed categories. The T8 decision also has recorded history the review does not engage. |
| 4 | `MaxListenersExceededWarning`, nested `vi.mock()` warnings | **(a)** | Real at **full-suite** scope only (0 occurrences in every scoped run). The reviewer's own published repro command **cannot execute** on this repo — `--reporter=basic` was removed in Vitest 4 (repo runs 4.1.10), exits 1, and a grep over its output is indistinguishable from "clean". |
| 5 | Giant modules (1579 / 1559 / 1049 lines) | **(d)** | The metric is non-blank/non-comment lines, undeclared. Two figures reproduce **exactly**; the third (1,559 for `extension/src/background/index.ts`) matches no file by any metric and no point in that file's 69-commit history — actual is 2,932 total / 2,351 code. Substance: only the extension file is worth acting on, and for a reason the review did not give. |

**Net:** no claim is baseless, but only claims 1 and 4 survive as stated. The review's
own evidence-gathering failed twice in a way that reads as a clean result (claim 4's
command errors out; claim 5's third figure is estimated, not measured) — R50.

## Functionality Findings

### F1 [Minor — downgraded from Major] Stale tracked-file snapshot in shared `/tmp`
`/tmp/passwd-sso-tracked.JOoAuC` (dated 2026-07-23)

The artifact is real and its content signature matches a failing run exactly on three
independent points: it contains a test named `handles multi-segment hostname` that does
not exist at HEAD, its `tailscale-client` / `access-restriction` files hold 15 / 22 tests
against HEAD's 17 / 27, and its `src/__tests__/i18n/` lacks `tenant-admin-tailscale-copy.test.ts`.

**Causality unproven — downgraded on orchestrator verification.** An independent full
`vitest run --coverage` at HEAD did **not** reproduce the failure (those three files
passed; 46/46 on an isolated run). No producer for `passwd-sso-tracked.*` exists in
`scripts/`, `.github/`, or `~/.claude/hooks/`. The most parsimonious remaining
explanation is the reviewing agent's own shell working directory during its
investigation, not a defect in the repo's test gate. Action: delete the stale snapshot;
do not treat the mandatory `vitest run` gate as compromised on this evidence.

### F2 [Minor] Worker registers SIGTERM/SIGINT handlers with no teardown
`src/workers/audit-outbox-worker.ts:2009-2019` (registered from `:2033`; `stop()` at `:2054`)

`registerShutdown()` attaches `process.once("SIGTERM"/"SIGINT")`; neither `stop()` nor the
post-loop cleanup removes them. `process.once` self-removes only when the signal fires,
which never happens under test, so listeners accumulate to Node's 10 threshold and emit
`MaxListenersExceededWarning`. Production impact is nil (one `start()` per process).
Same shape at `src/lib/prisma.ts:122-123`, already papered over in-test at
`src/__tests__/lib/prisma.test.ts:74-77` (`setMaxListeners(30)`) — the workaround is at
the wrong layer and masks the signal.

**Fix:** hold the handler references and `process.off(...)` them in `stop()`; then remove
the `setMaxListeners(30)` workaround so the warning stays a real signal.

### F3 [Minor] Three byte-identical `AUTOFILL*` switch cases beside an already-commonised trio
`extension/src/background/index.ts:2401-2468`

`EXT_MSG.AUTOFILL` (:2401), `AUTOFILL_CREDIT_CARD` (:2424), `AUTOFILL_IDENTITY` (:2447)
are identical except the echoed `type`; `performAutofillForEntry` (:1418) already
dispatches on entry kind. The neighbouring `GET_*_MATCHES_FOR_URL` trio was already
collapsed behind `resolveInlineMatches` (:1928) — the helper to reuse is one screen
above (R1). This is the **only** defect traceable to module size across all three files.

### F4 [Minor] `handleMessage` is a single ~880-line function with 27 switch cases
`extension/src/background/index.ts:1970-2851` (plus `performAutofillForEntry` :1418-1899, ~481 lines)

This is what claim 5 is actually pointing at. `extension/src/background/` already has 7
extracted sibling modules and the `PASSKEY_*` cases already delegate to
`passkey-provider.ts` — the target shape exists inside the same file.

**Explicitly do NOT split** `src/lib/vault/vault-context.tsx` or
`src/workers/audit-outbox-worker.ts` on the reviewer's recommendation. The first is a
linear, self-numbered 12-step transaction (`rotateKey`, :875-1269) sharing ~10 locals —
splitting threads that state through helper signatures without reducing the reasoning
surface. The second is three already-banded parallel pipelines. Neither has a defect to
show for its size.

## Security Findings

### SEC-1 [Critical] `audit-chain-verify` reports `ok: true` when the chain it was asked to verify is missing
`src/app/api/maintenance/audit-chain-verify/route.ts:151-153` and `:305-310`

Two paths let the tamper-evidence verifier return VALID having verified nothing:

1. `:151` — `if (!anchors.length) return NextResponse.json({ ok: true, totalVerified: 0 })`.
   The endpoint never consults `audit_logs`. "No chain yet" and "the anchor row was
   removed while 10k chained rows exist" produce the same answer.
2. `:305` — `truncated = rows.length >= MAX_ROWS_PER_REQUEST && (prevSeq === null || prevSeq < toSeq)`.
   The shortfall test `prevSeq < toSeq` is already computed but gated behind the row cap.
   When the walk ends below `toSeq` for any reason other than hitting the cap — rows
   deleted at the head, or every chained row purged — `truncated` is false, `integrityOk`
   is true (a deleted tail leaves no gap *between* returned rows), and `:310` yields `ok: true`.

Path 2 is reachable through a documented, legitimate operation: `purge-audit-logs`
deletes `created_at < cutoff` via a `SECURITY DEFINER` function. Purge everything and the
anchor still reads `chain_seq = N` while zero rows remain → `{ ok: true, totalVerified: 0 }`
with no `reason`, and the response does not echo `anchorSeq`/`toSeq` for an operator to
notice. DB grants bound path 1 to a superuser/migration-role adversary
(`scripts/checks/db-grants-manifest.json:108-109` — `passwd_app` has no DELETE on
`audit_chain_anchors`); **path 2 needs no such privilege.**

`docs/security/audit-chain-threat-model.md` documents the *partial*-purge case as producing
a false **tamper** and calls that the anti-forensics residual risk. The full-purge /
head-deletion case producing a false **pass** is documented nowhere — and it is the
direction that matters. R49: `:309`'s comment claims "Fail-closed: truncated verification
is never reported as ok" while the shortfall test is gated behind the row cap.

**Fix:**
```ts
const covered = prevSeq !== null ? prevSeq : fromSeq - 1;
const incomplete = covered < toSeq;                  // replaces the row-cap-gated check
const ok = integrityOk && !truncated && !incomplete; // reason: "RANGE_INCOMPLETE"
```
and on the no-anchor path, assert `COUNT(*) FROM audit_logs WHERE tenant_id = $1 AND chain_seq IS NOT NULL`
is 0 before returning `ok: true`; otherwise return a fail-closed `ANCHOR_MISSING`. Echo
`anchorSeq`/`toSeq` either way.

**escalate: true** — the corrected semantics collide with the deferred `purged_up_to_seq`
watermark design (threat-model A1). The owner must decide the `ok`/`reason` taxonomy for
"purged" vs "truncated" vs "anchor missing" before this is coded, and
`route.test.ts:190` currently **pins the fail-open as intended behavior**.

### SEC-2 / T1 [Critical] `convergent: security+testing` — the chain walk is verified only by a drifted hand-copy that never imports the endpoint
`src/__tests__/db-integration/audit-chain-verify-endpoint.integration.test.ts:32-102` (used at :231,253,278,363,448,480); production `src/app/api/maintenance/audit-chain-verify/route.ts:250-310`

A 484-line file named `audit-chain-verify-endpoint.integration.test.ts` never imports the
endpoint. Its imports pull `deliverRowWithChain`, `buildChainInput`, `computeEventHash` —
not `./route` — and it re-implements the walk in a local `walkChain()` commented
`// Mirrors the verify endpoint's walk logic`. The copy has drifted:

| | production `route.ts:291-301` | test copy `:69-93` |
|---|---|---|
| on hash mismatch | `firstTamperedSeq = seq; break;` | sets flag, **no break** |
| `totalVerified` for tampered/later rows | not incremented | `totalVerified++` unconditionally |
| `truncated` / `reason` / `walkedThrough` / `anchorSeq` | present | **absent entirely** |

```
:255-258
    expect(result.ok).toBe(false);
    expect(result.firstTamperedSeq).toBe(3);
    // totalVerified still counts all rows walked
    expect(result.totalVerified).toBe(5);
```
For that fixture the production route returns `totalVerified: 2` — it verifies seq 1-2,
then bails at 3. `route.ts:255-259` documents that bail as the **C15 / OWASP A08-2**
control. The test asserts 5, labels it the endpoint's behavior, and can never fail for the
production behavior it names (RT5, RT9 — the drifting logic is a security control).

Compounding it, `route.ts:12-16` cites this suite as proof the endpoint's behavior is
"verified real behavior (T5 characterization test), not a hypothetical edge case". The T5
test verifies the copy, not the endpoint — **the production source carries a claim its own
evidence does not support** (R49). This twin is why SEC-1 survived review.

**Fix:** import `GET` from the route and drive it through the handler (the file already has
real DB rows, a real anchor, and `setBypassRlsGucs`; only `verifyAdminToken` /
`requireMaintenanceOperator` need stubbing). Delete `walkChain()`. Re-baseline `:258` to
the production values (`totalVerified: 2`, `walkedThrough: 2`, `reason: "TAMPER_DETECTED"`).
Red-prove per RT7: remove the `break` at `route.ts:294` and confirm the test goes red.

### SEC-3 [Major] `/api/vault/delegation/check` filters on a non-existent Prisma field
`src/app/api/vault/delegation/check/route.ts:128`

```ts
...(authResult.type === "mcp_token" ? { tokenId: authResult.tokenId } : {}),
```

`McpAccessToken` has no `tokenId` field. Verified against the generated client —
`McpAccessTokenWhereInput` (`node_modules/.prisma/client/index.d.ts:92314-92333`) exposes
`id, tokenHash, clientId, tenantId, userId, serviceAccountId, scope, expiresAt, revokedAt,
lastUsedAt, createdAt` and no `tokenId`. The conditional-spread form defeats TypeScript's
excess-property check, so it compiles; at runtime Prisma raises
`PrismaClientValidationError: Unknown argument 'tokenId'` before any connection is attempted.

Consequences: (a) the comment at `:125-127` describes a defense-in-depth token binding that
has **never executed** (R49); (b) the agent-authorization hot path 500s for `mcp_token`
callers rather than returning a decision. It fails **closed**, so this is not an auth
bypass. `route.test.ts` mocks `@/lib/prisma` wholesale, so the shape error is invisible (RT1).

**Fix:** `id: authResult.tokenId` (per `src/lib/auth/session/auth-or-token.ts:28`, `tokenId`
is the `McpAccessToken` row id) — **not** deletion of the key, or the binding silently
disappears and the lookup falls back to `clientId` alone.

### SEC-4 / T5 [Major] `convergent: security+testing` — sibling-family revocation not scoped by owner FK
`src/app/api/user/mcp-tokens/[id]/route.ts:60-63`

```ts
await tx.mcpAccessToken.updateMany({
  where: { id: { in: relatedIds }, revokedAt: null },   // ← no userId, no tenantId
```
The collection route's equivalent statement has both (`src/app/api/user/mcp-tokens/route.ts:130`:
`where: { id: { in: relatedIds }, userId, tenantId, revokedAt: null }`), and its
delegation-session block carries the comment `// (with userId for defense-in-depth)` — so
the scoping is deliberate there and absent here. This is the one write in the file not
bounded by the authenticated principal, executed under `withBypassRls` (RLS off).

**Severity adjudication:** the Testing expert rated this Critical as an `[Adjacent]` routing
flag; the Security expert, in scope, adjudicated **Major** with evidence — `familyId` is a
server-generated UUID carried through rotation and never client-supplied, so a family
cannot span principals and it is not exploitable today. Recorded as Major, not silently
downgraded: convergence holds the floor at Major and sets fix priority first within tier.
It remains R3 (incomplete pattern propagation, security-relevant): the defense-in-depth that
would contain a future issuance bug is present in the sibling and absent here.

**Fix:** add `userId, tenantId` to the `where`.

### SEC-5 [Minor] Revocation misses delegation sessions bound to rotated-away tokens in the same family
`src/app/api/user/mcp-tokens/[id]/route.ts:67-76`, and the collection DELETE

Sessions are revoked only `where: { mcpTokenId: id }` — but sibling access tokens in the
family were just revoked at `:60-63`, and a `DelegationSession` created before a refresh
rotation carries the *old* token's id. Those sessions stay `revokedAt: null`, keep appearing
in `GET /api/vault/delegation`, and their Redis metadata
(`delegation:<userId>:<sessionId>:entry:<entryId>`, envelope-encrypted title/username/urlHost)
is never evicted, surviving to TTL (≤ 1h). Practically bounded — using such a session needs a
live token for the revoked access-token row, and `validateMcpToken`
(`src/lib/mcp/oauth-server.ts:798`) rejects it. **Escalates to Major if SEC-3 is "fixed" by
dropping the token binding instead of renaming it** (R42: the member set is "delegation
sessions of every access token in the revoked family", not "of `id`").

**Fix:** revoke `where: { mcpTokenId: { in: [id, ...relatedIds] }, userId, revokedAt: null }`
and evict Redis for that full set.

### SEC-6 [Minor] Fire-and-forget Redis eviction runs inside the open transaction, contradicting its own comment (R9)
`src/app/api/user/mcp-tokens/[id]/route.ts:107-110`

The loop is lexically inside the `withBypassRls` callback (which closes at `:113`), so it
launches *before* commit despite the comment `// (after transaction commit)`. The sibling
collection route places the identical loop after `withBypassRls` returns. Failure direction
is safe (eviction without commit over-evicts), so Minor — but the comment asserts a property
the code does not have.

**Fix:** move the loop below `:113`, returning the ids from the callback as the collection route does.

### SEC-7 [Minor] No rate limiter on `DELETE /api/user/mcp-tokens/[id]` while the sibling has one (RS2)
`src/app/api/user/mcp-tokens/[id]/route.ts` vs `src/app/api/user/mcp-tokens/route.ts:14` (`max: 5`) and `src/app/api/sessions/[id]/route.ts:15` (`max: 10`)

Self-scoped (the lookup is bound to `userId`), so no cross-user oracle and no enumeration
value; the cost is an unbounded per-user write/audit-insert loop.

**Not findings (checked and clean):** IDOR on the primary token lookup (`:28-31` and `:37-40`
both scope `{ id, userId, tenantId }`); refresh-family revocation completeness;
audit-in-transaction (`:79-102` uses `tx.auditLog.create` — and the nested
`prisma.$transaction` at `:36` is **not** a second transaction: `src/lib/prisma.ts:151-160`
proxies `$transaction` to the active `AsyncLocalStorage` tx, so mutations and audit rows
commit atomically and inherit the bypass GUCs); RS1 on the maintenance bearer path (operator
tokens resolved by `hashToken` lookup, no plaintext compare); tenant binding on chain-verify
(enforced twice); SQL injection in chain-verify (`$queryRawUnsafe` with positional `$1..$4`
only); Zod validation of chain-verify query params.

## Testing Findings

### T2 [Major] `mcp-tokens/[id]` DELETE: 90 lines of duplicated revocation cascade at 0% coverage
`src/app/api/user/mcp-tokens/[id]/route.ts:27-113`

Class derived independently (R42): of 212 `route.ts` files, 6 lack a sibling `*.test.ts`;
5 of those are tested from non-sibling paths. **This is the only genuinely untested API
route in the repo** — the reviewer's single member is the complete member set. It is inside
`coverage.include` (`src/app/api/**/*.ts`), so it counts against the global floor at 0%.

Not a wrapper: it hand-duplicates the collection route's cascade, and the duplicate has
already lost its ownership scoping (SEC-4). The refresh-family cascade, delegation
revocation, both audit-emission paths, and the `!result → notFound()` leg are all unexercised.

**Fix (RT2 verified testable):** add `src/app/api/user/mcp-tokens/[id]/route.test.ts` copying
the mock harness from `../route.test.ts:4-51` (add an `mcpAccessToken.findFirst` mock; make
`mockTransaction` invoke its callback). Cover: 401 no session; `NO_TENANT`; 404 when
`findFirst` returns null **asserting no `update`/`updateMany`/`auditLog.create` fired** (RT8);
204 happy path asserting the exact `where` clause of every cascade step; the
`familyIds.length === 0` and `sessions.length === 0` legs; one-audit-per-delegation-session.
The `where`-clause assertion is what pins the ownership scoping and would have caught SEC-4.

### T3 [Major] `audit-chain-verify` unit tests stop at the perimeter
`src/app/api/maintenance/audit-chain-verify/route.test.ts`

`mockQueryRawUnsafe.mockResolvedValue([])` is the default and every success test rides the
empty-anchor early exit — the suite never returns a single chain row. Concretely uncovered
(from v8 `coverage-final.json`):

- `:65` the `from < to` refine; `:91-96` `toChainRow` never invoked
- `:182-201` the entire `to` query-param branch
- `:222` the **success** leg of the seed lookup (only the `:219` failure leg is tested → RT10)
- `:260-302` **the whole chain walk** — gap detection, timestamp monotonicity, payload
  coercion, `buildChainInput`/`computeCanonicalBytes`/`computeEventHash`, tamper compare, C15 bail
- `:305-310` truncation detection and the fail-closed `ok = integrityOk && !truncated` (SEC-1)
- `:314-322` the entire `reason` ladder (`TRUNCATED`/`TAMPER_DETECTED`/`GAP_DETECTED`/`TIMESTAMP_VIOLATION`)
- `:326` `logAuditAsync` on the non-early-exit path; `:344,348-349` the main response

Everything the endpoint exists to do is at 0%. What is covered is the perimeter
(401/429/503/400/403) plus the empty-anchor short-circuit.

**The existing tests are not vacuous** — `:147-157` uses `assertRedisFailClosed` with
`assertNoMutation: [mockQueryRawUnsafe]`, `:213-222` asserts `mockLogAudit` not called, `:144`
pins the exact rate-limit key. RT8 passes; RT10 fails on the seed guard.

**RT2 check — testable as-is:** yes. The suite mocks `$queryRawUnsafe` but does **not** mock
`@/lib/audit/audit-chain`, so a fixture can build genuine `event_hash` values with the real
primitives and feed them as a sequential resolve. No design change needed.

**Fix:** add (1) valid 3-row chain → `ok:true`, `totalVerified:3`, no `reason`; (2) tamper at
row 2 → `reason:"TAMPER_DETECTED"` and **`totalVerified === 1`** (pins the C15 bail);
(3) `chain_seq` gap → `GAP_DETECTED`; (4) `created_at` regression → `TIMESTAMP_VIOLATION`;
(5) `MAX_ROWS_PER_REQUEST` rows with `prevSeq < toSeq` → `truncated:true`, `ok:false`;
(6) seed lookup **success** with `fromSeq > 1` (RT10's allow half); (7) the `to`-param branch;
(8) `logAuditAsync` called once with `ok`/`totalVerified`/`firstTamperedSeq`.

### T4 [Minor] No `statements` threshold configured; the proposed 80/70 is not safe to apply as written
`vitest.config.ts:60-70`

The coverage gate is **real and CI-enforced** — `ci.yml:293` runs `npm run test:coverage`
(= `vitest run --coverage`), red-proved to exit 1 with a named ERROR line. RT7 shape b does
not apply; the "claim is moot" branch does not fire.

Two corrections to the claim: `thresholds` sets `lines` and `branches` only — there is no
`statements` key, so the reviewer's "60%相当" is an inference presented as configuration, and
statement-level erosion is genuinely ungated (v8 statement and line counts diverge — 50.50%
vs 49.47% on one file here). And per-file floors already exist at exactly the proposed 80/70
on exactly the proposed categories (`vitest.config.ts:67-69`).

**Margin analysis:** actual 82/73 against a proposed 80/70 leaves ~2pt/~3pt of headroom. A
ratchet set 2pt under current is a tripwire that reds whichever unrelated PR happens to cross
the line, not the PR that created the gap. And the specific per-file floor the reviewer wants
(audit) **cannot be added today** — `audit-chain-verify/route.ts` at 49.47/32.39 would red
immediately.

**Recommendation:** `lines: 75, branches: 65, statements: 75` (a meaningful ratchet with
~7-8pt of slack for normal churn). Enrol files into the existing per-file map **after** their
tests land — `audit-chain-verify/route.ts` and `mcp-tokens/[id]/route.ts` first. Do not adopt
80/70 globally.

### T6 [Minor] Flaky test under coverage instrumentation — CI-relevant
`scripts/__tests__/check-dockerignore-secrets.test.mjs:321`

Found by the orchestrator's own full run, not by any claim. `npx vitest run --coverage` at
HEAD:

```
FAIL  check-dockerignore-secrets > bundle scan flags every MUST_EXCLUDE representative path
Error: Test timed out in 10000ms
Test Files  1 failed | 1003 passed        Tests  1 failed | 13911 passed | 1 skipped
```

The external review reports "13,912 passed / 1 skipped" — i.e. it did not hit this. The test
passes without instrumentation and exceeds the global `testTimeout: 10000` with it. **CI runs
exactly the coverage variant** (`ci.yml:293`), so this can red the build on an unrelated PR.

**Fix:** pass an explicit longer timeout as this test's third argument, or reduce the work in
the bundle-scan derivation. Do not raise the global `testTimeout`.

### T7 [Minor] `[Adjacent]` 15 nested `vi.mock()` calls will become hard errors on a future Vitest
`src/components/__tests__/webhook-card-test-factory.tsx:131` (13 calls), `src/__tests__/helpers/passkey-reauth-mocks.tsx:16,37`

Both call `vi.mock()` inside exported setup functions. Vitest 4.1.10 warns per call: *"is not
at the top level of the module … This will become an error in a future version."* The pattern
is deliberate and documented (`passkey-reauth-mocks.tsx:1-11`), but the hoisting it relies on
is being withdrawn — a scheduled break of the mandatory test gate on the next major upgrade.

## Adjacent Findings

- `[Adjacent] Critical → adjudicated Major` — SEC-4/T5, routed from Testing to Security, resolved above.
- `[Adjacent] Major` — SEC-2/T1, raised by both Security and Testing; merged above as convergent Critical.
- `[Adjacent] Major → refuted` — "nested `prisma.$transaction` opened on the outer client inside
  `withBypassRls`, shadowing `tx`" (Testing). **Refuted** by the Security expert and confirmed
  directly by the orchestrator: `src/lib/prisma.ts:151-160` proxies `$transaction` to the
  active tx when an RLS context exists. Not a finding.
- `[Adjacent] Minor` — a **third** chain-walk implementation at `scripts/audit-chain-verify-worker.ts:68`
  (`verifyTenantChain`, whole-tenant, no `fromSeq`/`toSeq`/`truncated`), giving three divergent
  adjudicators of one predicate (route, worker, test copy). Consolidating the walk into
  `src/lib/audit/audit-chain.ts` would collapse SEC-2 and this at once (R48).

## Quality Warnings

No expert finding was flagged VAGUE / NO-EVIDENCE / UNTESTED-CLAIM. One finding was
**downgraded on orchestrator verification** (F1, Major → Minor: the artifact is real but the
causal claim did not reproduce) and one was **refuted outright** (the nested-`$transaction`
adjacent finding). Both are recorded above rather than dropped.

## Recurring Issue Check

### Functionality expert
- R1: **Triggered** → F3 (three identical AUTOFILL cases beside `resolveInlineMatches`)
- R2: Evaluated, not triggered (time constants pulled from `../lib/time`)
- R10: Evaluated, not triggered (the three files are leaves/entrypoints; splitting adds no cycles)
- R21: Evaluated — its premise (re-run the full test command yourself) is what surfaced F1
- R42: Evaluated, not triggered (the 27-case switch is keyed on `EXT_MSG` const-object members)
- R49: **Triggered** → claim 5's third figure matches no file by any metric and no point in 69 commits
- R50: **Triggered twice** → F1 (clauses ii/iii/v) and claim 4 (clause iv — the cited command exits 1)
- RT11: **Triggered** → F1 shape (1), stale fixture in shared `/tmp`

### Security expert
- R3: **Violated** → SEC-4 (owner scoping present in the sibling, absent here), SEC-6 (eviction placement)
- R5: Pass — the `[id]` route's `findFirst`→`update` pair is atomic
- R9: **Violated** → SEC-6 (failure direction safe, so Minor rather than the table's default Critical)
- R42: **Violated (narrow)** → SEC-5 (member set is the whole family, not `id`)
- R49: **Violated twice** → SEC-3 (`:125-127` describes a binding that throws) and SEC-1 (`:309`'s
  fail-closed comment vs the row-cap-gated shortfall test)
- R50: **Violated** → SEC-2 (subject identity: the integration test's green is evidence about
  `walkChain`, not the shipped handler)
- RS1: Pass — operator tokens resolved by `hashToken` lookup; no plaintext credential comparison
- RS2: **Violated** → SEC-7
- RS3: Pass — Zod + `parseQuery` on chain-verify; the `[id]` route's only input is a path param
  consumed as an equality predicate on a `@db.Uuid` column
- RT1: **Violated** → `delegation/check/route.test.ts` mocks Prisma wholesale and cannot see SEC-3's shape error
- RT8: Pass on the deny paths inspected
- RT9: **Violated** → SEC-2
- RT10: **Violated in the inverse direction** → chain-verify's only "allow" assertion is the fail-open path

### Testing expert
- R36: N/A — no suppression added; claim 4's warnings do not exist to suppress
- R42: **Pass with correction** — class derived independently (6/212 route files lack a sibling
  test, 5 tested from non-sibling paths); the reviewer's list happened to be complete but was not derived
- R49: **Finding twice** → per-file thresholds claimed absent but present at the exact proposed
  numbers; `route.ts:12-16` claims T5-characterized "verified real behavior"
- R50: **Finding (methodological)** → the reviewer's repro command errors on Vitest 4; every grep
  over it returns empty, indistinguishable from clean
- RT2: **Pass** — every recommended test is writable against the current design; no finding rejected as untestable
- RT5: **Finding** → SEC-2/T1
- RT6: N/A — repo-wide review, not a diff
- RT7: **Pass** — coverage gate red-proved (exit 1, named ERROR) and confirmed wired at `ci.yml:293`
- RT8: **Pass** on existing tests; applied as an obligation to the T2 fix
- RT9: **Finding** → SEC-2/T1 (Critical: audit tamper detection) and T2 (the `[id]` cascade vs the collection cascade)
- RT10: **Finding** → T3 (the `fromSeq > 1` seed guard has only its deny leg)
- RT11: **Finding** → F1

## Environment Verification Report

N/A — no environment constraints were declared in Phase 1 (this review has no Phase 1; it is a
standalone Phase 3 adjudication of external claims).

Not executed this round, and therefore not evidence for anything above: real-DB integration
tests, Playwright E2E, iOS tests, load tests. The external review states the same limitation.

## Resolution Status

**No fixes applied this round — verification only, per the user's instruction.**

Every finding above is repo-wide and unrelated to the current branch
(`fix/harden-cli-tailnet-ssrf`, whose diff is CLI tailnet SSRF hardening). Per the project's
established practice, they must not be folded into this branch. Recommended routing:

| Finding | Severity | Branch |
|---|---|---|
| SEC-1 | Critical | own branch — needs an owner decision on the `ok`/`reason` taxonomy first (escalate: true) |
| SEC-2 / T1 | Critical | same branch as SEC-1 — the test must land with the fix that it red-proves |
| SEC-3 | Major | own branch — one-line fix (`tokenId` → `id`) plus a test that does not mock Prisma wholesale |
| SEC-4 / T5 + T2 | Major | one branch — the test (T2) is what pins the fix (SEC-4) |
| T3 | Major | with SEC-1/SEC-2 |
| SEC-5, SEC-6, SEC-7 | Minor | with SEC-4/T2 |
| T4 | Minor | after T2 and T3 land — enrolling the files before their tests exist reds CI immediately |
| T6 | Minor | own small branch — it can red CI on any unrelated PR |
| F2, F3, F4, T7 | Minor | opportunistic |
| F1 | Minor | delete `/tmp/passwd-sso-tracked.JOoAuC`; no repo change |
