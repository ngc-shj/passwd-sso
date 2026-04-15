# Plan Review: audit-path-unification
Date: 2026-04-15
Review rounds: 2

## Round 2 Summary
All Round 1 findings (Critical 5 / Major 14 / Minor 10 — 28 total, minus LLM-2 rejected as false positive = 27 addressed) verified as resolved. Three new Minor findings surfaced in Round 2 (F8, F9, T14) and addressed in the same pass:
- **F8**: DO-block comment clarified re: enum safety in same transaction
- **F9**: webhook-dispatcher tenantId explicit-pass requirement added
- **T14**: webhook-dispatcher test coverage (existing vs new) documented

## Round 1 Summary — Findings Resolved
See original Round 1 findings below. All addressed in the updated plan.

## Functionality Findings

### F1 Major: `mcp/register` および `webhook-dispatcher` が MF9 の caller migration リストから欠落
- Evidence: `src/app/api/mcp/register/route.ts:175` (`userId: NIL_UUID`), `src/lib/webhook-dispatcher.ts:235, 306` (`userId: NIL_UUID`)
- Problem: これらは現在 NIL_UUID を使っており、新 sentinel 体系に移行しないと残存する。webhook-dispatcher は `actorType` 未指定で `HUMAN` デフォルトになる不整合あり。
- Fix: Step 6 に `mcp/register` (→ `SYSTEM_ACTOR_ID + SYSTEM + tenantId 明示`) と `webhook-dispatcher` × 2 (→ `SYSTEM_ACTOR_ID + SYSTEM`) を追加。

### F2 Major: `VALID_ACTOR_TYPES` (audit-query.ts) の更新が plan 欠落
- Evidence: `src/lib/audit-query.ts:11` `VALID_ACTOR_TYPES = ["HUMAN", "SERVICE_ACCOUNT", "MCP_AGENT", "SYSTEM"]`
- Problem: ANONYMOUS を追加しないと audit API フィルタで `?actorType=ANONYMOUS` が無効化。
- Fix: MF1 の implementation list に `VALID_ACTOR_TYPES` 更新を追加。

### F3 Major: `audit-actor-type-badge.tsx` の更新が plan 欠落
- Evidence: `src/components/audit/audit-actor-type-badge.tsx:17-19`
- Problem: ANONYMOUS が raw 文字列として表示される。SYSTEM も既に同じ問題あり。
- Fix: Step 8 に `audit-actor-type-badge.tsx` への `ANONYMOUS` ケース追加（+ SYSTEM ラベル不足の fix）を明記。

### F4 Minor: migration backfill の WHERE 節が不完全
- Evidence: 計画 SQL `WHERE user_id IS NULL AND actor_type = 'SYSTEM'`
- Problem: `audit_logs_system_actor_user_id_check` が `NOT VALID` のため既存の `actor_type != 'SYSTEM' AND user_id IS NULL` 行が存在しうる。その場合 `SET NOT NULL` が失敗。
- Fix: backfill を `WHERE user_id IS NULL` に拡張するか、移行前に検証 `SELECT COUNT(*) WHERE user_id IS NULL` ステップを追加。

### F5 Minor: Scenario 1 Step 4 の CHECK 制約記述が誤り
- Evidence: 計画 Scenario 1 Step 4 "CHECK (actor_type='ANONYMOUS' OR user_id IS NOT NULL — satisfied)"
- Problem: 実際の制約は `audit_logs_outbox_id_actor_type_check: (outbox_id IS NOT NULL OR actor_type = 'SYSTEM')`
- Fix: 記述を `outbox_id IS NOT NULL (via outbox path)` に修正。

### F6 Minor: `audit_logs_outbox_id_actor_type_check` 制約が未言及（保持対象）
- Evidence: `prisma/migrations/20260412100000_add_audit_outbox/migration.sql:43`
- Problem: この制約は worker meta-events を SYSTEM に限定する防衛線。ANONYMOUS は outbox 経由で `outbox_id IS NOT NULL` を満たすため、制約は変更不要。計画に明記されていないため誤って drop される可能性。
- Fix: Migration safety 節に「`audit_logs_outbox_id_actor_type_check` は保持」と明記。

### F7 Minor: `resolveTenantId` の UUID_RE guard 除去の記述が曖昧
- Evidence: 計画 MF10
- Problem: `userId: string` になっても UUID 形式でない文字列が渡される可能性あり（将来の bug）。guard 完全削除か部分保持か曖昧。
- Fix: MF10 を「`params.userId` null guard のみ削除、UUID_RE guard は defense-in-depth として維持」と明記。

## Security Findings

### S1 Major: **SHARE_ACCESS_VERIFY_* が PERSONAL scope のため webhook dispatch が no-op — プランの核心的価値が無効化**
- Evidence: `src/app/api/share-links/verify-access/route.ts:75` `scope: AUDIT_SCOPE.PERSONAL` + `audit-outbox-worker.ts:677-691` の分岐に PERSONAL 用 branch なし + `TENANT_WEBHOOK_EVENT_GROUPS` に SHARE_ACCESS_VERIFY_* 未登録
- Problem: 計画の主目的「SIEM/webhook fan-out で brute-force 検知」が達成されない。outbox 経由に変えても webhook が発火しないため、変更の主要な利得がゼロ。
- Fix: 2 択:
  - **(a)** `SHARE_ACCESS_VERIFY_*` の scope を TENANT に変更 + `TENANT_WEBHOOK_EVENT_GROUPS` の SHARE グループに追加
  - **(b)** `dispatchWebhookForRow` に PERSONAL scope + tenantId 分岐を追加
- 推奨: (a)。anonymous events は tenant-level の security signal であり TENANT scope が意味的に正しい。
- escalate: false (設計上の欠陥で重要だが、auth bypass や RCE ではない)

### S2 Minor: ANONYMOUS event の webhook 配信で攻撃者 IP が外部エンドポイントに送信される (設計判断の明文化)
- Evidence: `metadata: { ip }` + `EXTERNAL_DELIVERY_METADATA_BLOCKLIST` に `ip` 含まれず
- Problem: S1 修正後、webhook 発火するとテナント設定の外部エンドポイントに攻撃者 IP が送信される。GDPR 要注意。
- Fix: MF11 に「IP は SIEM/webhook ペイロードに含まれる。テナント管理者は DPA で合意済み前提」と明示。

### S3 Minor: sentinel UUID の "UUIDv4 準拠" 説明が誤り
- Evidence: 計画 §2 "RFC 4122 version-4 UUIDs with a recognizable prefix"
- Problem: `00000000-0000-4000-8000-000000000000` は version field (4) / variant field (10xx) は UUIDv4 構造に合致するが、random フィールドがゼロ固定のため UUIDv4 生成器が出力することはない。説明が誤解を招く。
- Fix: JSDoc / 計画を「UUIDv4 structural format をもつ predictable sentinel (RFC 4122 random UUID ではない)」に修正。

### S4 Minor: sentinel UUID の予測可能性と collision 境界
- Evidence: `uuid(4)` は random 122bit、sentinel との衝突確率 2^-122
- Problem: 理論的には negligible だが、JSDoc に明記して将来の変更で sentinel 数が増えた場合の安全性を担保。
- Fix: `SENTINEL_ACTOR_IDS` を正規 source として定義、sentinel 追加時は必ずこのセットに追加する invariant テストを追加。

### S5 Minor: ANONYMOUS event 高頻度挿入による chain ロック競合
- Evidence: `deliverRowWithChain` `FOR UPDATE` + 既存 rate limit (IP 5/min, token 20/min)
- Problem: 既存 rate limit で実用的 DoS リスクは低いが、CIDR 分散攻撃想定時は要観察。
- Fix: Considerations 節に「share-access 用 rate limit が chain ロック DoS の第一防衛線」と明記。

### S6 Minor: GDPR right-to-be-forgotten — PII redaction job が "別途" で具体性なし
- Evidence: 計画 Scenario 4 "A separate PII redaction job (out of scope here)"
- Problem: FK drop で audit 保持が強化される一方、PII redaction 未実装だと GDPR Art.17 (1) 遵守が弱まる。
- Fix: Considerations に「PII redaction job は follow-up plan で Q3 中に検討、IP 保持の法的根拠 (Art.17(3)(b) 法的義務 or (e) 公共の利益) を明文化」と TODO 追加。

### S7 Minor: `anonymousAccess` flag 削除の影響範囲確認
- Evidence: 計画 MF15
- Problem: 現状は consumer なし (grep で確認) だが、MF15 に grep 確認ステップが明示されていない。
- Fix: MF15 に「`grep -rn anonymousAccess src/` で残存参照がゼロであることを確認後に削除」ステップ追加。

### S8 OK: RLS policy は tenant_id ベースで sentinel UUID 導入後も安全
- Problem なし。ただし文書化のため Considerations に明記推奨。

## Testing Findings

### T1 Critical: `audit-fifo-flusher.test.ts` の 4 件のテストの削除/置換仕様が曖昧
- Evidence: L82-167 の 4 件は `userId: null` を正として検証
- Problem: プランは「delete null-userId direct-write tests」と 1 行のみ。カバレッジギャップ発生。
- Fix: Step 10 に 1:1 置換仕様を明示 (例: L82 → `ANONYMOUS_ACTOR_ID → enqueueAudit` テスト)。

### T2 Critical: DB migration backfill が CI テストで検証されない
- Evidence: 計画 Testing strategy テーブル「Manual — Run migration against seeded DB」
- Problem: backfill 正しさの CI 検証なし。
- Fix: `audit-sentinel.integration.test.ts` に (a) テスト SYSTEM+NULL 行投入 → (b) migration UPDATE 実行 → (c) SYSTEM_ACTOR_ID に書換確認、の 3 ステップを明示。

### T3 Critical: `audit-outbox-userId-system.integration.test.ts` が新スキーマで壊れる
- Evidence: 既存 test の L28 "allows SYSTEM actor with user_id = NULL" + L96 regex includes `audit_logs_system_actor_user_id_check`
- Problem: migration 後 userId NOT NULL になり CHECK 制約が DROP される。テストが失敗 or 偽陽性。
- Fix: Step 10 に同 integration test の更新を明示追加。

### T4 Critical: `audit-bypass-coverage.test.ts` への `ActorType.ANONYMOUS` enumeration assertion の対象が不明
- Evidence: 既存テストは `AUDIT_ACTION_VALUES` 等を列挙するが ActorType 自体の enumeration なし
- Problem: 何を追加するか定義されていない。
- Fix: `Prisma.$Enums.ActorType` をインポートし全 enum 値が i18n key + UI switch case + VALID_ACTOR_TYPES に存在することを assert する exhaustiveness test を新規追加。

### T5 Major: `verify-access/route.test.ts` L230, L254 の assertion 更新詳細が不足
- Evidence: 既存テストは `userId: null, actorType: "SYSTEM"` を期待
- Fix: 更新後の期待値を plan に明示 (`userId: ANONYMOUS_ACTOR_ID, actorType: "ANONYMOUS"`, metadata.anonymousAccess 削除)。

### T6 Major: `audit-sentinel.integration.test.ts` のシナリオが不十分
- Missing scenarios:
  - sentinel UUID が `users` に存在しないことの確認
  - ANONYMOUS row の RLS 通過確認
  - `audit_logs_outbox_id_actor_type_check` が ANONYMOUS に対して期待通り動作
  - sentinel UUID が chain に参加すること
- Fix: Testing strategy テーブルにこれら 4 シナリオを追加。

### T7 Major: manual test script 更新内容が不完全
- Missing: actor_type='ANONYMOUS' 確認 / metadata.anonymousAccess 削除 / outbox.status='SENT' 確認 / outbox_id NOT NULL 確認 / SIEM fan-out 発火の検証手法
- Fix: Step 11 に 5 項目の新 assertion list 追加。

### T8 Major: worker guard 到達不能性の証明手法が未指定
- Evidence: MF7 "verify worker guard is unreachable from logAuditAsync"
- Fix: integration test で `worker.system_actor_null_userid_skipped` log が出力されないことを確認するシナリオを追加。

### T9 Major: `mcp/token` の `result.userId ?? null` が型変更で compile error
- Evidence: `src/app/api/mcp/token/route.ts:138`
- Problem: プラン Step 6 に `mcp/token` はあるが、null fallback をどの sentinel に置換するか未指定。
- Fix: `result.userId ?? SYSTEM_ACTOR_ID` + `actorType: SYSTEM` 明示。加えて `audit.mocked.test.ts` L379 の "mcp_token auth with userId null" test の更新指示も追加。

### T10 Major: i18n exhaustiveness test がなく SYSTEM ラベルの既存欠落も未検出
- Evidence: `messages/en/AuditLog.json` に `actorTypeSystem` キー存在せず（SYSTEM もテストされていない）
- Fix: Step 9 を拡張 — 全 `ActorType` 値に対応する i18n キー (`actorTypeHuman/Sa/Mcp/System/Anonymous`) の存在を assert する exhaustiveness test を追加。

### T11 Major: `SHARE_ACCESS_VERIFY_*` が `TENANT_WEBHOOK_EVENT_GROUPS` 未登録 (S1 と連動)
- Fix: S1 の修正と合わせて `audit-bypass-coverage.test.ts` に「SHARE_ACCESS_VERIFY_* が TENANT_WEBHOOK_EVENT_GROUPS.SHARE に含まれる」assertion 追加。

### T12 Minor: `audit-and-isolation.test.ts` は mocked logAudit のため tenant isolation 検証が不適
- Fix: ANONYMOUS tenant isolation は `audit-sentinel.integration.test.ts` (real DB) で実施、`audit-and-isolation.test.ts` には追加しない。

### T13 Minor: migration rollback dry-run テスト手順の欠如
- Fix: Considerations に「staging 環境で migration dry-run 必須、失敗時の half-migration 対応 (`ALTER TYPE ADD VALUE` 後に `ALTER TABLE NOT NULL` 失敗等)」の運用手順を追加。

## Adjacent Findings
None (all findings fit within the relevant expert's scope).

## Quality Warnings
None (all findings have specific evidence and concrete fixes).

## Additional findings from Local LLM pre-screening

### LLM-1 Critical: FK drop rollback safeguard 未実装
- Overlaps with F6 mentioned above. Plan must document safeguard (pre-migration FK backup query or similar).

### LLM-2 Critical: FK drop によって audit_logs に非存在 UUID を inject できる攻撃面
- Evaluation: Not a real issue. `audit_logs` write は BYPASS_RLS 経由の server-side code のみが実施可能。外部攻撃者が任意 UUID を書き込むルートは既存で存在しない。**却下** (false positive from LLM)。

## Recurring Issue Check

### Functionality expert
- R1: Checked — F2, F3 (downstream consumers) で検出
- R2: Checked — F6 (schema CHECK 制約影響)
- R3: OK (i18n ja/en 両方)
- R4: F1 (callers 網羅性)
- R5: OK (exhaustiveness via `satisfies`)
- R6: OK (FK drop irreversibility 明記)
- R7: OK
- R8: OK
- R9: OK
- R10: OK
- R11: OK
- R12: OK
- R13: F4 (backfill WHERE 節)
- R14: F1 (NIL_UUID との共存問題)
- R15: OK
- R16: F2, F3

### Security expert
- R1-R7: Not applicable (no new SQL / XSS / CSRF / auth paths)
- R8-R9: S5 (rate limit と DoS 考察)
- R10: S1 (audit completeness)
- R11: OK (RLS tenant_id 維持)
- R12: OK
- R13: N/A
- R14: S6 (GDPR)
- R15: OK (audit write-only)
- R16: OK
- RS1: OK (timing-safe N/A)
- RS2: OK (rate limit 既存)
- RS3: N/A (schema-level validation)

### Testing expert
- R1: T12 (mocked isolation test)
- R2: T1, T5, T9 (型変更で compile error)
- R3: T1 (削除仕様不明)
- R4: T4, T10 (exhaustiveness test 欠如)
- R5: T2 (backfill CI 検証)
- R6: T3 (constraint 名 assertion)
- R7: T7 (manual test 不完全)
- R8: T8 (到達不能証明)
- R9: T11 (webhook subscribability)
- R10: T10 (i18n 既存欠落)
- R11: T2 (CI 外)
- R13: N/A
- R14: T9 (mcp_token test 未言及)
- R15: T9 (access-restriction 型エラー関連)
- R16: OK
- RT1: N/A (new enum values)
- RT2: OK
- RT3: Not specified (should be)
