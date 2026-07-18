# Plan: Control Consolidation Roadmap (fail-closed debt / update contracts / gate hygiene)

Source: external investigation report pasted into /triangulate on 2026-07-18.
Reviewed as a plan (roadmap) — Phase 1 plan review. Not yet an implementation plan;
contains no Contracts/Go-No-Go sections by design (roadmap-level document).

## Project context

- Type: `mixed` — Next.js 16 web app + CLI (npm) + browser extension + iOS (Swift) + CI/CD guard suite
- Test infrastructure: `unit + integration + E2E + CI/CD` (vitest, real-DB integration, Playwright, XCTest, a large `scripts/checks/*` static-guard suite)
- Verification environment constraints:
  - VC1: iOS XCTest real-TLS fixtures require macOS + Xcode; developer primary env is Linux → `verifiable-CI` only.
  - VC2: GitHub branch-protection settings live outside the repo; verification requires GitHub API access (`gh api`) → `verifiable-local` with network, not enforceable by repo code alone.
  - VC3: Redis-failure fail-closed behavior is testable via mocked limiter in unit tests and via real Redis outage simulation only in integration CI.

## Ground-truth reconciliation (verified 2026-07-18 by orchestrator before expert review)

- `scripts/checks/fail-closed-test-debt.txt`: 42 non-comment entries — matches report.
- `scripts/checks/gate-selftest-debt.txt`: 24 non-comment entries; 13 `pre-pr:Static:` inline-gate entries — matches report.
- `.nvmrc` = `20` (major-only); root `package.json` has no `engines`/`packageManager` — matches report.
- `.github/workflows/ci.yml` `env-drift-check` uses `node-version: '22'` — matches report.
- `src/components/passwords/entry/entry-history-section.tsx:190` — TODO old-team-key fetch — matches report.
- `src/lib/access-request/access-request-state.ts:33` — TODO no caller transitions to EXPIRED — matches report.
- `src/workers/retention-gc-worker/index.ts` — `RLS_FREE_EXPIRY_TABLES` manual set — matches report.

---

# 調査結果(レポート本文・原文のまま)

このリポジトリは、一般的なWebアプリケーションとしては既にかなり高い成熟度です。
改善の中心は「基本的なセキュリティ対策の追加」ではなく、**既存の多数の制御を、より直接的・検証可能・運用可能な形へ整理すること**です。

優先順位:

| 優先度 | 改善テーマ | 性質 |
| --- | --- | --- |
| P1 | Redis障害時のfail-closedテスト負債42件の解消 | 実効性検証 |
| P1 | `encryptedBlob`/`encryptedOverview`更新契約の分離 | データ整合性 |
| P1 | Node/npm実行環境の役割別固定と明文化 | 再現性・供給網 |
| P2 | inlineセキュリティゲート13件の独立・自己テスト化 | 制御保守性 |
| P2 | retention workerのRLS判定をDB実態から導出 | 権限境界 |
| P2 | team historyの旧鍵復号対応 | 機能・鍵rotation整合 |
| P2 | Access RequestのEXPIRED遷移実装 | 状態機械完成度 |
| P2 | integration CIの必須性をリポジトリ内でも検証 | CI保証 |
| P3 | coverage対象と閾値の再設計 | テスト品質 |
| P3 | workerの運用メトリクス統一 | 可観測性 |
| P3 | control inventoryの機械可読化 | 長期保守性 |

## 1. Redis障害時のfail-closedテスト負債を解消する

`scripts/checks/fail-closed-test-debt.txt` に42ルートが登録されている。
`failClosedOnRedisError: true` を設定しているが、Redis障害時に本当に503になることを
route単位で直接確認するテストがない。対象には API key発行、passkey verify/reauth、
extension token発行・refresh・exchange、mobile token、MCP token、share link access、
emergency access、access request approve/deny、Vault setup/unlock/reset/rotation/recovery
など高感度経路が多数含まれる。

回帰リスク: `redisErrored` を429へ誤変換、route内で結果無視、特定認証分岐だけfail-open、
response envelope不一致。現在のgateは「未テストであること」を管理するが動作は保証しない。

推奨: 42件を個別重複テストせず、共通contract test helperを作る:

```typescript
export function assertRedisFailureIsFailClosed(options: {
  invoke: () => Promise<Response>;
  mockLimiterFailure: () => void;
  expectedErrorCode: string;
}) { /* 共通検証 */ }
```

テスト例: mockRateLimiter が `{success:false, redisErrored:true}` を返すとき
status 503 / `API_ERROR.SERVICE_UNAVAILABLE` を検証。

進め方: 危険度順。第1群: token mint/refresh、passkey verify、extension exchange、
Vault recovery/reset、access request approve/deny。第2群: share access、delegation、
registration options、invitation accept。

完了条件: fail-closed-test-debt.txt = 0件、または直接テスト不能ルートのみ理由付きで最小限残す。

## 2. `encryptedBlob` と `encryptedOverview` の更新契約を分離する

現状validation: overviewあり・blobなし→拒否 / blobあり・overviewなし→許可。
blob単独更新はブラウザ拡張のpasskey counter更新互換のため許可されている。

残る問題: 一般password PUTでもblob単独更新ができる。サーバーはE2E暗号化blobの中身を
判定できないため、passkey counterだけの変更と通常編集のoverview送信忘れを区別できない。
現在保証されるのは「overview-only更新を防ぐ」ことだけで、
「encryptedBlobとencryptedOverviewが常に同一平文状態を表す」ことは保証されない。

推奨(最善案): 専用endpoint分離 — `PUT /api/passwords/[id]/passkey-counter`。
このendpointだけblob単独更新を許可し、通常PUTでは
`encryptedBlob !== undefined ⇔ encryptedOverview !== undefined` を必須化。

代替案: 操作種別を明示するdiscriminated union
(CONTENT_UPDATE / PASSKEY_COUNTER_UPDATE / METADATA_UPDATE)。

追加確認: v1 APIにもblob-only許可が必要かは再検証。v1が同操作を担っていないなら
v1だけ先に完全pairingへ移行できる。

## 3. Node/npm実行環境を役割別に固定し、契約として明文化する

現状: `.nvmrc`/通常CI/開発 = Node 20 (major-only)、`env-drift-check` = Node 22、
CLI release = 24.18.0、Docker runtime = Node 20 Alpine digest固定。
root package.json に engines/packageManager なし。

評価: releaseのNode 24.18.0はTrusted Publishing用toolchainとして合理的。問題は
通常開発・CI・Docker間で粒度が揃っていないこと(ローカル成功・Docker失敗が起こり得る)。

推奨: appRuntime/ciRuntime/publishRuntime を役割別に明示管理。
`.nvmrc` 完全パッチ固定、root package.json に engines + packageManager、
Docker/CI/.nvmrc整合gate追加(publish用Node 24は別trust domainとして例外)。
env-drift-checkのNode 22は特別な理由がなければ .nvmrc へ統一、意図的ならコメント+gateで固定。

## 4. inlineセキュリティゲート13件を独立スクリプト化する

`gate-selftest-debt.txt` 24件中13件が `pre-pr.sh` 内のinline gate
(RLS cross-tenant SQL parse、no-deprecated-logAudit、PRF salt immutable、
no-argon2-browser-reintroduce、DCR public-only literal、client-secret-hash-non-null、
no Auth.js builtin WebAuthn provider、master-key rotation CAS、fetch basePath compliance等)。

問題: inline shell gateは単体テストしづらく、fixture渡し・false-positive/negative検証が
困難、pre-pr.sh肥大化、exit code/pipefail差異の見落とし。gateもプロダクションコードと
同等にテストされるべき。

推奨: `scripts/checks/check-*.mjs` + 対応する `scripts/__tests__/*.test.mjs` へ分離し、
pre-pr.shはオーケストレーションのみに。
目標: inline security gate 13→0、executable gateの直接self-test率100%、
gate-selftest-debt.txtは非セキュリティ補助チェックのみに限定。

## 5. retention workerのRLS判定をDB実態から導出する

現状: `RLS_FREE_EXPIRY_TABLES` 手動管理set。コメントに
「pg_policiesからRLS-enabled statusを導出しDB ground truthと照合する」課題が明記済み。

ドリフト: migrationでRLS policy追加→registry更新忘れ→globalDelete要件とDB実態の食い違い。
逆方向(policy削除→registryはRLSありと認識)もあり得る。

推奨: CIの実DB integrationで `pg_class.relrowsecurity` + `pg_policies` とretention registry
を照合。RLS有効なのにglobalDeleteなし→fail、RLSなしなのにRLS_FREE未登録→fail、
registryに存在しないテーブル→fail、DBに存在しないregistry entry→fail。

## 6. team password historyの旧鍵復号を完成させる

`entry-history-section.tsx` に TODO: `h.teamKeyVersion !== current` の場合の旧鍵取得が未実装。
鍵rotation後に履歴閲覧が壊れる可能性。history recordの teamKeyVersion/itemKeyVersion を
使い `GET /member-key?keyVersion=N` で旧team keyを取得。

制約: 現メンバーであること、旧鍵version取得権限、revoked memberに旧鍵を返さない、
API responseをキャッシュしない、key version不一致fail-closed、audit event。

テスト: current/old key history、存在しないkey version、revoked membership、rotation途中、
re-encrypted item key、history record改ざん。

## 7. Access RequestのEXPIRED遷移を実装する

状態機械上 `PENDING → EXPIRED by SYSTEM` が定義済みだが、遷移させるcallerがない。
期限切れrequestがPENDINGとして残り続ける。

推奨: retention workerへの単純DELETEではなく状態遷移workerとして
`UPDATE ... SET status='EXPIRED' WHERE status='PENDING' AND expires_at < now()` (bounded batch)。
性質: batch-bounded、idempotent、tenantごとaudit、concurrent approveとのCAS、
EXPIRED後approve不能。

## 8. integration CIが本当にrequiredかを機械検証する

`ci-integration.yml` に「branch protectionはリポジトリ外設定、post-merge確認」と記載。
workflowが存在してもrequiredでなければ失敗してもmergeできる。
RLS/DB role/Redis session tombstone/Vault rotation race/advisory lock/retention worker/
audit chain/cross-tenantがintegration CIに依存。

推奨: `gh api repos/$REPO/branches/main/protection/required_status_checks` を定期/手動検証する
script追加。期待contextをJSONとしてコミット。

## 9. coverage設計を見直す

現状: lines 60% / branches 50%(一部重要ファイルのみ80/70)。
global coverageはUI等で希釈される。auth policy、token verification、key rotation、
RLS wrapper、retry/fail-closed、destructive operation、provenance parser、rate limiter、
state transitionはbranch coverageが重要。

推奨: risk-tier方式(critical: branches 85/lines 90、high: 75/85、default: 55/65)。
critical候補: src/lib/auth/**、src/lib/crypto/**、src/lib/vault/**、tenant-rls.ts、
prisma.ts、src/lib/security/**、worker state/claim/delete、provenance verification、
route policy classifier。coverage閾値とは別にnegative-path contractを維持。

## 10. workerの可観測性を統一する

worker policy manifestは詳細だが実行時メトリクスの共通契約が薄い。
全workerに worker_last_success_timestamp / worker_run_duration_seconds /
worker_records_processed_total / worker_dead_letter_total / worker_oldest_pending_age_seconds
等を持たせる。retention/audit outbox個別メトリクスも。
fail-closedでもworkerが長期停止していれば目的を達成しない —
セキュリティ制御は「コード上存在する」だけでなく「運用中に動作している」ことの確認が必要。

## 11. security control inventoryを機械可読化する

route-policy manifest、step-up manifest、worker policy manifest、crypto domain registry、
supply-chain manifest、exemption files、debt files、security matrices、34個の実行可能check
が分散している。control単位のYAML index(id/scope/enforcement/tests/exemptions/owner/severity)
として既存データを束ねる。orphan gate発見、runtime enforcementだけでtestがない制御の発見、
exemption影響範囲追跡、control owner明示、監査証跡。

## その他

- audit log downloadと一覧の条件差(emergency access条件がdownload側にないTODO)→共有query builderへ。
- session cacheとHIBP routeのRedis実装統一。
- `actorId`命名移行は単なるrenameではなく actor_type/actor_id/subject_type/subject_id の組へ。

## 定量目標

| 指標 | 現状 | 目標 |
| --- | ---: | ---: |
| Redis fail-closed test debt | 42 | 0〜5 |
| gate self-test debt | 24 | 10以下 |
| inline security gate | 13 | 0 |
| Node通常runtime指定 | major-only | exact patch |
| Access Request EXPIRED caller | 0 | 1 worker |
| blob-only一般更新 | 許可 | 専用operationへ限定 |
| retention RLS判定 | 手動set | DB ground truth |

## 推奨ロードマップ

- 第1段階: fail-closedテスト(高感度routeから)、inline gate 3〜5件ずつ独立化、
  Node契約固定、Access Request EXPIRED実装、branch protection検証script。
- 第2段階: passkey counter専用更新経路、team history旧鍵復号、retention registryと
  pg_policiesの実DB照合、audit list/download query統一、worker metrics contract。
- 第3段階: control inventory、risk-tier coverage、gate mutation testing、
  client間暗号property test、runtime control health dashboard。

## 最終所見

最も避けるべきは、さらに大量の個別grepゲートを無秩序に追加すること。
次に必要なのは既存制御の未検証部分を埋め、例外を減らし、制御同士の関係を単純化すること。
直近では Redis fail-closedテスト42件、blob/overview更新契約、inline gate 13件 の3点が
費用対効果の高い改善対象。

---

# Review Round 1 amendments (2026-07-18)

Full findings: `control-consolidation-roadmap-review.md`. The report's facts and
priorities were confirmed accurate; the following amendments correct its
prescriptions before any implementation planning.

## Sec 1 (fail-closed test debt) — amended

- **Class = 69 limiter callsites across 62 route files + 3 out-of-scan members**, not
  "42 routes". The debt file is the untested subset only. Gate scan root must be extended
  to `src/lib` + `src/auth.config.ts` (magicLinkEmailLimiter is silent-drop — needs a
  non-Response helper variant). Define migration policy for the 20 already-tested routes. (M2)
- **Pin the class in a committed manifest**: removing `failClosedOnRedisError: true` from a
  route must require an explicit exemption diff, because today it simultaneously greens
  the test and removes the route from gate scope (silent fail-open). (M2)
- **Helper contract hardened** (M1, M12, M14):
  - Mock at the *limiter* layer with the exported `RateLimitResult` type:
    `{ allowed: false, redisErrored: true }` (the report's `{success:false}` shape does not
    exist) so the production `checkRateLimitOrFail` mapping stays in the tested path.
    The mcp/authorize stub-the-helper pattern is NOT the template.
  - Mandatory `assertNoMutation` hook (write-primitive spies `.not.toHaveBeenCalled()`)
    plus an internal limiter-was-reached assertion.
  - Envelope-aware expectation (`canonical` | `oauth` | custom per `FailClosedEnvelope`),
    incl. `Retry-After` and absent `error_description` for the OAuth family.
  - Spy on `createRateLimiter` options to assert `failClosedOnRedisError: true`.
- **Co-evolve the gate with the helper**: recognize the helper callsite token instead of
  the bare `redisErrored` literal (which comments can satisfy vacuously), with red
  fixtures in both directions; burn-down recorded per limiter callsite. (M2, M4)
- ≥1 integration-CI test per 第1群 route family against a real broken Redis, red-proven. (M2)

## Sec 2 (blob/overview contract) — amended

- **The pairing invariant cannot be stated globally**: history-restore writes blob-only by
  design (history rows store no overview). Either extend history snapshots to include the
  overview, or scope the invariant to the PUT surface and document restore as sanctioned
  divergence with client-side overview re-derivation. (M3)
- **Dedicated passkey-counter endpoint inherits the full PUT guard set** as acceptance
  criteria: PASSWORDS_WRITE scope + per-user rate limit, 403→404 oracle collapse,
  mandatory keyVersion CAS inside the FOR UPDATE transaction, history snapshot + trim,
  ENTRY_UPDATE audit. Server-side the split is client-honor-only — it narrows nothing. (M3)
- **Staged rollout for deployed extensions**: endpoint first (old path still accepted) →
  extension migration release → version floor/grace period → enforcement behind an
  independent rollback flag. Immediate enforcement risks RP clone-rejection for stale
  extensions. (M8)
- v1 note corrected: v1 shares `updateE2EPasswordSchema`, so schema tightening propagates
  automatically; the v1 question is about consumers, not schema. (M3)

## Sec 3 (Node pinning) — amended

- Add `consumerRuntime` role: `cli/package.json` `engines` (npm consumer contract) and
  extension packaging, included in the consistency gate. (M9)

## Sec 4 (inline gate extraction) — amended

- **Control continuity**: one-to-one migration manifest (inline label → extracted script)
  checked by the meta-gate until 0; each extracted gate ships a red-proof fixture
  (FIXTURE_ROOT seam convention) BEFORE the inline original is removed; inline removal +
  debt-entry removal atomic in the same PR. (M4)
- Target corrected: 24 → 11 via Sec 4 alone (11 justified path entries remain), not "10以下". (M4)

## Sec 5 (retention RLS ground truth) — amended

- Derivation error = CI failure (no skip-on-error), with a nonzero-RLS sanity floor.
  Guarantee restated as "registry consistent with **migrations**"; production drift is
  Sec 10's runtime-health concern. Test file must be `*.integration.test.ts` under
  db-integration (the `src/__tests__/integration/` directory is the mocked unit lane). (M10)

## Sec 6 (team history old-key decryption) — rescoped

- The server endpoint (`GET /member-key?keyVersion=N`) **already exists and is tested**;
  remaining work is client wiring — plus the **restore re-encrypt contract** (decrypt with
  old key → re-encrypt with current → PUT), whose absence leaves restored entries
  undecryptable on every surface after rotation. (M3, M5)
- Harden the existing route: per-user rate limiter, `Cache-Control: no-store` on all
  member-key responses, audit emit on historical-key access; revoked-member denial tests
  assert mutation absence. (M5)

## Sec 7 (Access Request EXPIRED) — amended

- Use `bulkTransition({actor: AR_ACTOR.SYSTEM})` (compile-checked MATRIX +
  `hasScopeUnderBypass` cross-tenant guard), never a raw UPDATE in the bypass-RLS worker;
  explicit per-batch tenantId predicate; column-scoped UPDATE grant for the worker role. (M6)
- Register `ACCESS_REQUEST_EXPIRED` in AUDIT_ACTION + group arrays + i18n + UI label maps
  + tests. (M11)
- Client notification/cache-invalidation strategy for PENDING→EXPIRED required (pre-screen #2).

## Sec 8 (branch protection verification) — amended

- Fine-grained PAT, "Administration: Read-only", single repo (never a classic repo-scoped
  PAT — the monitor must not be able to rewrite what it monitors). API error or missing
  protection object = check FAILURE. Gate the release workflow on a fresh protection check
  so the control is preventive at the publish boundary. (M7)

## Sec 9 (coverage) — amended

- Risk-tier thresholds require a paired `coverage.include` expansion — vault/**,
  tenant-rls.ts, prisma.ts, most of security/**, workers/** are currently not collected at
  all. Add a "every thresholds key matched by an include glob" rule to
  check-vitest-coverage-include.mjs with a red self-test. (M13)

---

# Review Round 2 amendments (2026-07-18)

Round 2 re-verified all Round 1 amendments against the repo: all correct and
complete, no regressions, no boundary widening. Seven refinements
(full findings: review file, R2-1 … R2-7):

## Sec 5 / test-lane hygiene (R2-1 — Major)

- **Pre-existing lane-drift instance to remediate**:
  `src/__tests__/integration/mobile-dpop-flow.integration.test.ts` is fully mocked
  (12 `vi.mock` incl. prisma/redis/crypto-server) yet its `.integration.test.ts`
  suffix routes it to the real-DB lane config (`vitest.config.ts:14` excludes,
  `vitest.integration.config.ts:8` includes — both repo-wide globs). It never runs
  under `npx vitest run`. Rename (drop the `.integration.` infix, matching its 4
  siblings) or relocate; add a gate check enumerating `*.integration.test.ts`
  files outside `src/__tests__/db-integration/` so the M10 naming rule is enforced,
  not just documented.

## Sec 6 (R2-2)

- **Scope the restore re-encrypt contract to the TEAM surface only**: the personal
  restore route already fails closed via `assertCurrentKeyVersion`
  (passwords/[id]/history/[historyId]/restore/route.ts:80 → KEY_VERSION_MISMATCH).
  The unguarded gap is `teams/[teamId]/passwords/[id]/history/[historyId]/restore/
  route.ts:95-109`, which writes back the stale `teamKeyVersion` unconditionally.
  Personal route: no action needed.

## Sec 7 (R2-3)

- **Grant migration is a named deliverable**: `passwd_retention_gc_worker` holds only
  SELECT, DELETE on `access_requests` (migration 20260619001000:9); the column-scoped
  UPDATE grant must ship as its own tracked migration. Worker must log/metric when
  `bulkTransition` updates 0 rows against a nonzero expired-PENDING candidate scan
  (repo precedent: under-granted NOBYPASSRLS workers silently no-op,
  retention-gc-worker/index.ts:51-55).

## Sec 8 (R2-4)

- **PAT lifecycle**: the fine-grained read-only PAT becomes a release-availability
  dependency (fail-closed gate). Implementation plan must include PAT-expiry
  monitoring/rotation so an expired PAT is a diagnosed failure, not a mystery outage.

## Sec 1 (R2-5, R2-6, R2-7)

- **createRateLimiter options assertion**: `createRateLimiter` is invoked at module
  top level on first import; a post-import `vi.spyOn` silently records zero calls.
  Use the repo convention — `vi.hoisted()` + `vi.mock("@/lib/security/rate-limit",
  factory)` with the factory itself a recording `vi.fn()` (see
  vault/unlock/route.test.ts:14-30) — or replace the spy with the behavioral proof in
  rate-limiters.test.ts:44-49 (mock getRedis→null, assert `redisErrored: true`).
- **Gate co-evolution scope corrected**: the callsite-count axis is already
  co-evolved (`checkRateLimitOrFail(` count, check-fail-closed-routes-have-test.sh:
  159-164), and the amended mock fixture keeps the literal `redisErrored` token, so
  the test-existence grep (:98,:101) remains valid. Remaining ask: prohibit the
  return-value-stub anti-pattern (stubbing `checkRateLimitOrFail` directly) only.
- **assertNoMutation per-route primitive table**: the Sec 1 implementation plan must
  enumerate, per route family, which write primitive constitutes "the mutation"
  (e.g. `vaultKey.updateMany` for unlock lockout-reset vs token-mint inserts for MCP
  token routes). The spy mechanic itself is the established
  `vi.hoisted()`/`vi.mock("@/lib/prisma")` convention.

---

# Review Round 3 amendment (2026-07-18)

Round 3 verification: Functionality and Security experts returned No findings
(all Round 2 citations re-verified exact; no boundary widening). One Minor
residual from the Testing expert (R3-1), addressed here:

## Sec 1 (R3-1)

- **The return-value-stub prohibition currently has no CI-enforceable backstop**:
  the existing anti-pattern instance (mcp/authorize.test.ts:45-47 mocks
  `checkRateLimitOrFail` directly) satisfies the gate's `redisErrored` presence
  grep via a describe-label string alone (:345). Until the Sec 1 implementation
  adds structural detection (e.g. fail when `vi.mock(".../rate-limit-audit")`
  coexists with a fail-closed test claim), the prohibition is enforced by
  convention/code-review only — the plan records this explicitly so readers do
  not assume the current grep gate covers it.
