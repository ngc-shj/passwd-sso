# 引き継ぎ: webhook 永続冪等化の実装 (feature/worker-runtime-invariants)

## このセッションでやったこと（完了・コミット済み）

ブランチ `feature/worker-runtime-invariants`(PR #668、未 push コミットあり）で、
worker runtime invariants (audit-outbox の破壊的スイープ bound 化) を triangulate で
実装・レビュー・PR 化した後、**2回の外部セキュリティレビュー**で計5件の指摘を受け、
うち EXT-1 / EXT-3 と gate 撤回・sweep ガード厳密化まで対応済み。EXT-2(webhook 永続
冪等化)の実装が残タスク。

### 未 push コミット（origin/feature/worker-runtime-invariants..HEAD）
- `25e76a41` fix: didInsert-gate 撤回の processBatch 分を完成 + 未使用 regex 削除
- `cdd0017b` docs: webhook durable-delivery 設計プラン
- `2eda49d1` fix: 欠陥ある webhook inserted-gate 撤回 + sweep ガードをトップレベル厳密化
- `229b7054` review: 外部レビュー round 2 の3件を修正・文書化
- `6ea11fb8` fix: purge 監査原子化 + (撤回された)webhook 抑止 + sweep ガード
- (以前に push 済み: plan/review/deviation/実装/コードレビューの各コミット)

### 完了済みの外部レビュー対応
- **EXT-1 (High) 完了**: `purgeRetention` の SENT/FAILED 各ブランチの DELETE と
  `AUDIT_OUTBOX_RETENTION_PURGED` emission を同一 tx で原子化。private
  `writeDirectAuditLogInTx(tx,...)` を追加。回帰テスト
  `audit-outbox-retention-purge-audit-atomicity.integration.test.ts`(3件、Proxy で
  FAILED tx を注入失敗させ SENT の delete+audit が残ることを検証)。
- **EXT-3 (Low) 完了**: sweep-boundedness classifier
  (`src/__tests__/workers/worker-policy-manifest.test.ts` の `classifySweeps`)を
  トップレベル解析で厳密化。`topLevelSql`(括弧内 subselect を除去)+ `isKeySetLimited`
  (`WHERE <keys> IN (SELECT <keys> ... LIMIT n)` で IN-list キーと投影が一致する形のみ
  bounded)+ `PK_BY_TABLE` レジストリ(tenant_id は audit_chain_anchors の PK のみ)。
  self-test fixture (a)-(j)。`DELETE FROM x WHERE EXISTS (SELECT 1 FROM y LIMIT 1)` や
  非 PK tenant_id exemption を正しく unbounded/loose-exemption と判定。
- **欠陥 gate 撤回 完了**: EXT-2 の最初の修正(processBatch の `didInsert` gate)は
  欠陥(勝者クラッシュで通知消失を新規発生、非チェーン deliverRow も ON CONFLICT だが
  didInsert=true 固定で重複残存)だったので撤回。欠陥テスト
  `audit-outbox-webhook-dedup.integration.test.ts` 削除。`deliverRowWithChain` の返り値
  `{delivered, inserted}` は C7 race test で使うので残す。撤回により processBatch は
  main の webhook 挙動(既知の重複/消失)に一時的に戻っている。

## 残タスク: EXT-2 webhook 永続冪等化（ユーザー指示: 本 PR で実装）

### 設計は確定済み
`docs/archive/review/webhook-durable-delivery-plan.md` に contract-locked 設計あり
(C1-C5, INV-W1..W5, SC-W1..W4)。要点:
- **新テーブル `webhook_deliveries`** + enum `WebhookDeliveryScope`(TENANT/TEAM)。
  `@@unique([outboxId, scope, teamId])` で work-item を dedup。outbox_id に FK なし
  (audit_deliveries 同様、purge を生き延びる)。RLS + worker role grant。
- **enqueue を勝者 audit tx 内で**: `deliverRowWithChain` の `if (inserted.length>0)`
  ブランチと `deliverRow`(ON CONFLICT に **`RETURNING id` を追加**して inserted を返す
  よう変更)で、`enqueueWebhookDeliveryInTx(tx,row,payload)` を呼ぶ。ON CONFLICT 勝者
  のみが enqueue。→ クラッシュ耐性 + 冪等。
- **delivery worker** `processWebhookDeliveryBatch` + `reapStuckWebhookDeliveries` +
  purge 拡張。events フィルタは delivery-time 解決(worker が live な
  tenant_webhooks/team_webhooks を `events:{has:action}` で引く)。webhook-dispatcher.ts
  の delivery core(HMAC/AAD/SSRF/deliverWithRetry)を抽出して再利用。
  `dispatchTenantWebhook` は directory-sync が使うので export 維持(SC-W1)。
- **`dispatchWebhookForRow` を廃止**(enqueue + delivery loop に置換)。
- 新 dead-letter action `AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER` を AUDIT_ACTION 等に登録
  (R12: action group / i18n / OUTBOX_BYPASS / WEBHOOK_DISPATCH_SUPPRESS / tests)。

### 進め方（triangulate 継続）
1. **Phase 1 プランレビュー**: `webhook-durable-delivery-plan.md` を3エキスパート
   (functionality/security/testing、Opus)で並列レビュー → 収束まで(schema migration・
   RLS・grant・crypto AAD・events フィルタ・dead-letter unchained 不変条件を重点確認)。
   ※ Fable 5 はレート制限で失敗するので `/model opus` 済み、サブエージェントも Opus 指定。
2. **Phase 2 実装**: schema.prisma + migration(dev DB に `npm run db:migrate` で適用、
   メモリ `feedback_run_migration_on_dev_db` 参照)+ enqueue + worker + revert 済み gate
   の穴埋め + テスト。R12(新 action の全登録先)と R14(grant 網羅)に注意。
3. **Phase 3 コードレビュー** → pre-pr.sh → push → PR #668 更新。

### 重要な制約・教訓（メモリ済み）
- **R21**: 実装サブエージェントは禁止しても production ファイルに break→observe→restore
  を実行することがある。バッチ後に必ず residue grep で検証(`feedback_r21_subagent_...`)。
- **pre-existing は skip 理由にならない**(`feedback_no_skip_existing_code` corollary):
  SC3 の「webhook 重複を at-least-once として受容」という方針自体が誤りだった。
- **git commit のバッククォート**: メッセージ内の `` `x` `` はシェルに評価されるので
  必ず heredoc(`git commit -F file`)を使う。
- **`.claude/settings.json`**(rtk 権限追加)はスコープ外、コミットから除外。
- **dev DB は共有**で docker worker が稼働中。統合テストは自テナントの row-id スコープで
  アサート(グローバルスイープ SC6 の背景ノイズに耐性を持たせる)。CI は分離 DB。
- **integration**: `npm run test:integration` / 個別は
  `npx vitest run --config vitest.integration.config.ts <files>`。dev Postgres 稼働必須。
- **RTK が vitest/build 出力を切り詰める**: サマリは `rtk proxy npx vitest run ... 2>&1
  | grep -E 'Test Files|Tests |FAIL'` で取る。

### 検証コマンド
```
npm run lint
rtk proxy npx vitest run 2>&1 | grep -E 'Test Files|Tests |FAIL'
rtk proxy npx vitest run --config vitest.integration.config.ts <files> 2>&1 | grep -E 'Test Files|Tests '
rtk proxy npx next build 2>&1 | grep -iE 'Compiled|error'
bash scripts/pre-pr.sh
```
