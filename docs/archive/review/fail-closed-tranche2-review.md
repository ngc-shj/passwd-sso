# Plan Review: fail-closed-tranche2
Date: 2026-07-19
Review round: 1

## Changes from Previous Round
Initial review. Three expert agents (Functionality / Security / Testing) reviewed
`fail-closed-tranche2-plan.md` with repo cross-verification (member-set
recomputation, gate/classifier source reading, per-route line-number checks).
Local-LLM pre-screen ran first (3 findings, pre-addressed in the plan).

## Merged Findings (deduplicated across experts)

Merge join: Func-F1 ≡ Test-F1 (M1); Func-F2 + Sec-F8 + Func-A2 (M2);
Func-F3 ≡ Sec-F6 (M3); Sec-F1 ⊃ Func-F5 (M4); Func-F4 + Test-F8 (m12).
Perspective convergence (≥2 experts): M1, M3, M4 — severity floor Major
confirmed.

### Major

- **M1 (Func F1 = Test F1; R42/R19)** Stub-instance enumeration incomplete — 3
  files missing from the plan's "complete enumeration":
  `src/__tests__/api/extension/bridge-code-cnfJkt.test.ts:45,59`,
  `src/__tests__/db-integration/extension-token-dpop-flow.integration.test.ts:86`,
  `src/lib/scim/with-scim-auth.test.ts:28`. C6 "exactly 4 exempt hits" and C7
  acceptance unachievable as written. → C7 extended (+2 files); with-scim-auth
  stub removal folded into C8b.
- **M2 (Func F2 + Sec F8)** C8b ground truth wrong: `with-scim-auth.test.ts`
  already has a redisErrored→503 test (:111-127) AND already vi.mocks
  rate-limit-audit (:28) — "the module is never vi.mocked" contradicted.
  Emission assertion must settle the fire-and-forget void (RT4). → C8b
  rewritten (stub removal + test rework + settle).
- **M3 (Func F3 = Sec F6)** C5 scan-root grep matches 3 comment-only src/lib
  files (`audit.ts:225`, `ip-rate-limit.ts:20`, `rate-limit-audit.ts:2`);
  "exactly 3 (verified)" false for the stated command (6 files);
  MANIFEST_MISSING_ROUTE would misfire. D4/D9 class. → comment rewording task
  added to C5; ground truth corrected.
- **M4 (Sec F1 ⊃ Func F5; R42)** C6 scan universe misses top-level
  `src/*.test.ts` (incl. `src/auth.config.test.ts` — the very file C8a
  extends), all `.test.tsx` (238), and vitest `setupFiles`. → enumeration
  pattern fixed (`\.test\.tsx?$` over all of src + setupFiles), classifier
  virtual-path .tsx fix, red fixtures added.
- **M5 (Sec F2; R18)** C6 exemption derived from a growable legacy manifest —
  legacy growth is policy-only (same shape as the R3-1 gap this plan closes)
  and all 13 legacy siblings would be exempt, not just the 4 stub files. →
  frozen explicit 4-file exemption list in the gate + EXPECTED_LEGACY_COUNT
  ratchet.
- **M6 (Sec F3)** Classifier stub detection evadable via relative-path
  specifier, `vi.doMock`, `vi.mock(import(...))`, template-literal specifier,
  aliased `vi`. → specifier suffix-match normalization + vi symbol resolution
  (D11 method) + per-variant red fixtures.
- **M7 (Sec F4)** Per-limiter granularity unpinned: count-neutral add-remove
  swap defeats path-granular manifest + AC4.4 aggregate. → manifest format
  `path<TAB>count`, set-equality on (path, count) pairs.
- **M8 (Sec F5)** Scan root hardcoded to 3 locations; a future member in
  `src/app/**/actions.ts`, `src/proxy.ts`, `src/workers` escapes pinning. →
  enumeration over all of `src` (excluding test files and `src/__tests__`).
- **M9 (Test F2; RT1/RT8)** `logAuditAsync` as assertNoMutation spy on
  authenticated routes #22/#29 races the production fail-closed audit emission
  (`emitRateLimitFailClosed` → `logAuditAsync` on the 503 path itself). →
  removed from those rows; pre-auth rationale noted for row 17.
- **M10 (Test F3; D6 class)** snapshotFactory mandate bound to the F column
  only; rows 10/17/20/26 (no F, but `vi.clearAllMocks()`) missed. → mandate
  re-keyed on clearAllMocks/resetAllMocks presence.
- **M11 (Test F4; RT7/RT2)** C6 `git ls-files` enumeration cannot see
  FIXTURE_ROOT temp trees — planned red fixtures structurally unable to turn
  the gate red. → two-phase enumeration (find under FIXTURE_ROOT; git
  ls-files otherwise).

### Minor

- **m12 (Func F4 + Test F8)** C8c call form omits required `req` arg; helper
  mock topology unspecified (mock `createRateLimiter` layer, keep real
  `rate-limiters.ts`, snapshotFactory). → both added to C8c.
- **m13 (Sec F7)** No debt-file re-entry ratchet after burn-down. →
  EXPECTED_DEBT_COUNT=0 added.
- **m14 (Test F5)** Row 9 lacks limiter creation order (ipLimiter :77 →
  bridgeCodeLimiter :85) and non-null-IP arrange precondition. → added.
- **m15 (Test F6)** C10 verify-access overclaims "dual-limiter" (ip 503
  short-circuits token limiter under whole outage); redisAvailable skip guard
  unspecified. → claim corrected, residual to SC-T3-4, skip guard added.
- **m16 (Test F7; D4 class)** No C4 diff guard against the
  `failClosedOnRedisError` literal in src/app/api test files. → added.
- **m17 (Test F9)** C9.4 legacy-empty end-state unreachable for the
  silent-drop member (classifier never counts the variant as helper calls). →
  C9.4 scoped to route members; variant classifier support registered as
  SC-T3-6.

### Adjudicated without plan change

- **Func A1** (C10 switchable `getRedis` mock vs "no mocks" claim): Testing
  expert verified soundness — `createRateLimiter` calls `getRedis()` per
  check (`rate-limit.ts:54`), the mock swaps only the connection target, and
  the chain-test precedent uses the same seam. The "NO mocks" claim refers to
  rate-limit / rate-limit-audit modules, which stay real. No change beyond
  C10's existing wording.

## Quality Warnings
None (merge-findings quality gate: no VAGUE / NO-EVIDENCE / UNTESTED-CLAIM).

## Verification highlights (no-finding evidence)

- Member-set: 62 opt-in route files = helper 18 ∪ legacy 13 ∪ debt 31, no
  overlap; per-route table matches debt manifest exactly; 27×1 + 4×2 = 35
  cases (branch-counting rule consistent with tranche 1).
- All cited line numbers verified accurate (v1 routes, auth.config,
  with-scim-auth, reset-vault approve limiter order, mobile tests, key-reset,
  tenant/* legacy stubs).
- C8c security assessment: 429→503 leaks only "infra outage" to authenticated
  API-key clients; blocking property unchanged (same early-return site).
- C8a: silent-drop anti-enumeration preserved; warn log is a constant string
  (no PII).
- Evasion stress-test: (a) flag-removal+test-deletion and (e) rename are
  caught by manifest set-equality; (b)(c)(d)(f) leaks → M5-M8 close them.
- RT5: all 35 cases keep production `checkRateLimitOrFail` in path; RT4: C10
  switchable-mock red-proof sound; RT7: red fixtures planned for every new
  failure token (M11 fixes the fixture seam).

## Recurring Issue Check

### Functionality expert
- R1: pass / R2: n/a / R3: triggered(適用済み: v1 消費者列挙完全、stub 列挙で 3 件欠落検出=M1)/ R4-R11: n/a / R12: pass / R13-R15: n/a / R16: pass(文書化済み)/ R17: triggered(C1 walkthrough 充足確認, pass)/ R18: pass / R19: pass / R20-R21: n/a / R22: pass / R23-R28: n/a / R29: pass / R30-R32: n/a / R33: pass / R34: pass / R35-R39: n/a / R40: pass / R41: pass / R42: triggered(62/31/35 再計算 ✓; stub 集合と out-of-scan grep でデルタ検出=M1/M3)/ R43: n/a / R44: pass

### Security expert
- R1: pass / R2: pass / R3: pass / R4-R8: n/a / R9: pass / R10: pass / R11: n/a / R12: pass / R13-R15: n/a / R16: 注意(文書化済み)/ R17: pass / R18: triggered→M5 / R19: pass / R20: 注意(バッチ緩和記載)/ R21: pass / R22: pass / R23-R28: n/a / R29: pass / R30-R32: n/a / R33: pass / R34: pass / R35: n/a / R36: pass / R37-R39: n/a / R40: pass / R41: pass(M1/M6 修正が前提)/ R42: triggered→M4/M8/M3 / R43: pass / R44: pass(新設セクションも herestring 慣行に従うこと)
- RS1: n/a / RS2: n/a / RS3: n/a / RS4: pass / RS5: n/a / RS6: n/a

### Testing expert
- R1-R2: 適用外 / R3: 該当なし / R4-R16: 適用外 / R17-R18: 該当なし(gate 強制)/ R19: 発火→M1 / R20-R41: 適用外・該当なし / R42: 発火→M1 / R43: 適用外 / R44: 該当なし
- RT1: 発火→M9(fixture 形状は ✓)/ RT2: 検証済み(M11 のみ阻害)/ RT3: 該当なし / RT4: 検証済み・健全(m15 の可用性ガードのみ)/ RT5: 合格 / RT6: 該当なし(C1 variant self-test 計画あり)/ RT7: 発火→M11 / RT8: 発火→M9(read-only 行の最近傍 primitive 拡張は文書化済み)/ RT9: 適用外

## Disposition
All 17 merged findings accepted and reflected in the plan (Round 1 edits).
No findings skipped. Contracts C5/C6/C7/C8 flipped to pending until Round 2
re-review confirms the amendments; C1/C2/C3/C4/C9/C10 amendments are
scope-preserving (spy tables, guards, wording) and re-verified in Round 2.

---

# Review Round 2
Date: 2026-07-19

## Changes from Previous Round
Round 1's 17 findings were amended into the plan. Round 2 (incremental)
verified each fix against the repo and re-ran evasion stress-tests over the
NEW gate/classifier/manifest design. Functionality confirmed all arithmetic
(62 routes = 18∪13∪31; 65 manifest entries = 62+3; 19 stub files fully
dispositioned; 35 cases; sum(src/app/api manifest counts)=69) and all cited
line numbers by direct code read. New findings below.

## Merged Findings (Round 2)

Convergence: Func-F-R2-3 ≡ Test-F-R2-2 (C8b 5-min throttle) — Major floor.
Func-F-R2-1 ≡ Sec-S2-5 ≡ Test-F-R2-6 (C5 `<=` drafting residue) — Minor.
Test-F-R2-1 ≡ Sec-S2-6 (ratchet fixture executability) — Major.

### Major
- **R2-M1 (Sec S2-1)** C6 classifier `vi`-resolution would REGRESS mock
  detection under vitest `globals: true` (both configs) — an import-less
  global-`vi` stub yields mock=0. → recall-first resolution for the mock
  fail-criterion (named-import binding + bare global `vi` + namespace
  `.vi`; shadowed `vi` fail-loud); precision-first kept only for `calls`.
- **R2-M2 (Sec S2-2)** Non-literal mock specifier silently ignored
  (dynamic `vi.doMock` + computed-property factory fully evades). →
  `STUB_DYNAMIC_SPECIFIER` fail-loud for any unrecognized first-arg form.
- **R2-M3 (Sec S2-3)** Manifest per-file `grep -c` count spoofable via a
  comment literal — legacy member goes fail-open with a green gate. →
  AST-authoritative per-file count; grep>AST ⇒ `MANIFEST_COMMENT_LITERAL`
  fail-loud (enforces the documented D4 rule).
- **R2-M4 (Sec S2-4 = Test F-R2-3)** vitest `resolve.alias` (and hardcoded
  setupFiles) is a stub seam outside the gate universe. → gate greps
  vitest configs for `rate-limit-audit` (`STUB_CONFIG_SEAM` fail-loud) and
  derives the setupFiles scan list from the configs; red fixtures added.
- **R2-M5 (Test F-R2-1 = Sec S2-6)** EXPECTED_DEBT/LEGACY_COUNT red
  fixtures structurally unexecutable — the gate `exit 0`s at :244 under any
  override. → new C5/C6 per-file sections placed BEFORE the early-exit;
  ratchet constants become fixture-overridable env vars added to BOTH the
  ENV_POLLUTION_GUARD list and the aggregate-skip condition; only repo-wide
  aggregates skip in fixture mode.
- **R2-M6 (Func F-R2-3 = Test F-R2-2)** C8b real-module emission assertion
  collides with `emitRateLimitFailClosed`'s 5-min module-level throttle
  (all with-scim-auth tests share `rlfc:scim:ip:unknown`) → order-dependent
  vi.waitFor timeout. → mandate `__resetThrottleForTests()` in `beforeEach`
  for any real-emission assertion (C8b + C10 defensively).

### Minor
- **R2-m7 (Func/Sec/Test convergence)** C5 legacy-ratchet drafting residue
  (`count <= … — no, keep it EXACT`). → rewritten to EXACT-only.
- **R2-m8 (Test F-R2-4)** `MANIFEST_PARSE_ERROR` missing from the
  order-of-work red-fixture list. → malformed-line fixtures added.
- **R2-m9 (Test F-R2-5)** C8b "audit-outbox enqueue mock or structured-log
  spy" ambiguous; log branch unreachable (non-null tenantId). → pinned to
  `vi.mock("@/lib/audit/audit")` spying `logAuditAsync`+`tenantAuditBase`,
  asserting `objectContaining({ action: RATE_LIMIT_FAIL_CLOSED, targetId:
  "scim" })` (verified against the real payload, rate-limit-audit.ts:159-160).
- **R2-m10 (Func F-R2-2)** key-reset.test.ts attributed to C7 in Ground
  truth but owned by C2 row 10. → attribution corrected; C7 = 5 files.
- **R2-m11 (Sec S2-7)** `src/__tests__` exclusion residual (production
  importing a flag-bearing support file there escapes pinning). → accepted
  residual documented in Risks.

## Adjudicated / verified without further change
- C7 dpop-flow un-stub viable (Test expert read :80-88): the file already
  limiter-layer mocks `@/lib/security/rate-limit`; the rate-limit-audit stub
  is a redundant overlay — removal is safe and preserves integration
  character (Redis is `getRedis: () => null` by design there).
- Helper attribution asserts the flag per case (fail-closed.ts:156-157), so
  helper-mode members are protected against flag removal even without the
  manifest; the manifest closes the legacy/no-helper-case gap.
- No class members outside `src/`; `.spec.ts` rename evasion N/A (vitest
  include is `*.test.{ts,tsx}` — a renamed spec would not run, fail-loud).

## Disposition
All 11 merged Round-2 findings accepted and reflected. C5/C6/C7/C8 flipped
to locked. Proceeding to Round 3 verification.

---

# Review Round 3
Date: 2026-07-19

## Changes from Previous Round
Round 2's 11 findings amended in. Round 3 ran ONE consolidated verification
pass (functionality + security + testing lenses) restricted to internal
consistency of the Round-2 amendments and code cross-checks — not a re-raise
of resolved findings.

## Result: No findings — plan converged

Verified against amended plan + code:
1. C6 recall-first `vi` resolution (mock criterion) vs precision-first D11
   (calls criterion) — cleanly separated, no contradiction; current
   classifier mock detection is text-match (classify-fail-closed-test.mjs:191-204),
   so recall-first is forward-consistent, not a regression.
2. All 8 failure tokens (MANIFEST_MISSING_ROUTE, MANIFEST_STALE_ROUTE,
   MANIFEST_COUNT_MISMATCH, MANIFEST_COMMENT_LITERAL, MANIFEST_PARSE_ERROR,
   STUB_DYNAMIC_SPECIFIER, STUB_CONFIG_SEAM, STUB_MOCKED_RATE_LIMIT_AUDIT)
   have planned red fixtures and non-overlapping meanings.
3. Fixture-executability ordering (new per-file sections before the :244
   early-exit; ratchet constants env-overridable at both guard sites; only
   repo-wide aggregates skip) — implementable, no ordering conflict.
4. C8b verified against code: `__resetThrottleForTests` exists (:264);
   emitted `targetId===args.scope` and SCIM scope is literally "scim"
   (with-scim-auth.ts:33); `emitRateLimitFailClosed` imports `logAuditAsync`
   from `@/lib/audit/audit` (:25) so mocking that module intercepts the emit
   while rate-limit-audit stays real; warn-log branch unreachable (non-null
   tenantId) — log-spy would be dead, `logAuditAsync` spy is correct.
5. 19 stub files re-tallied via `git grep`: C7(5) + C2 colocated(8, incl.
   execute-partial-failure once) + C2 row 10 key-reset(1) + C8b(1) +
   frozen exemptions(4) = 19, no double-count.
6. No stale numbers (C7 "5 files" everywhere; 65 manifest; EXPECTED_LEGACY=16;
   EXPECTED_DEBT=0 all consistent).

Recurring Issue Check (Round-2-triggered only): R42 pass (19-file set
reproduced via git grep, no delta); R44 pass (new sections run before :244
under pipefail, fail-loud tokens exit 1); RT7 pass (every new token has a
red fixture authored first).

## Go/No-Go: all 10 contracts locked. Phase 1 complete.
