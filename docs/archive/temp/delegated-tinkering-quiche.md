# 評価結果: delegated-tinkering-quiche.md

対象: `~/.claude/plans/delegated-tinkering-quiche.md`（Batch A: V-1 フォルダ + V-2 変更履歴）
作成日: 2026-02-18

## 指摘事項（優先度順）

1. **Low**: `purge-history` のレート制限実装をテスト観点まで固定すること
- 計画本文に「1リクエスト/分」とあるが、テスト項目には明示されていない。
- 実装時に limiter 設定だけ入ってテスト抜けになりやすい。
- 対応推奨: `429` を含む単体テストを Step 9 に明記。

2. **Low**: `purgedCount=0` 時の監査ログ期待値を明文化するとよい
- `HISTORY_PURGE` 監査は良い設計。
- ただし削除件数0でもログを残すか、残すならどのメタデータを必須にするかは明記すると運用でブレない。

## 機能
- 評価: **妥当**
- フォルダと履歴を同バッチで扱う構成は合理的。
- 以前の懸念だった `GET /api/passwords` 副作用は、専用 `POST /api/maintenance/purge-history` に分離されている。
- Personal/Org 共通ヘルパー化で深度/循環参照の実装ブレを抑えられる。

## セキュリティ
- 評価: **妥当**
- 履歴は暗号化 blob のまま保持/返却、restore 時の所有権確認・entryId一致確認・監査ログ付与が揃っている。
- `AUDIT_METADATA_KEY` に `HISTORY_ID` / `RESTORED_FROM_CHANGED_AT` / `PURGED_COUNT` を追加する方針は監査一貫性に有効。

## テスト
- 評価: **概ね妥当**
- 追加予定テスト（root重複、restore連打、purge API、部分インデックス存在確認）は有効。
- 追加推奨:
  1. purge API の rate limit 到達時 `429`
  2. purge API で `purged=0` の監査ログ確認

## 総評
- 現計画は、機能・セキュリティ・テストの3観点で実装着手可能です。
- 残件は高リスクではなく、テスト要件の明文化で十分に管理できます。

## 前回評価結果からの変更
- 判定: **変更あり（軽微）**
- 理由:
  - 計画本文に `HISTORY_PURGE` 監査アクション、`AUDIT_METADATA_KEY` の追加、履歴トリムの安定ソート等が追記され、監査・整合性の具体性が増したため。
  - 主要結論（実装可能）は前回と同じ。

---

## 指摘事項への対応（実装後レビュー回答）

対応日: 2026-02-18
対応コミット: `d5c53da fix: add rate limiting to purge-history and add tests`

### 指摘1: `purge-history` のレート制限テスト

**判定: 妥当 → 修正済み**

実装時にレート制限自体が未実装だった（計画には記載があったが実装が漏れていた）。

**対応内容:**
- `src/app/api/maintenance/purge-history/route.ts` に `createRateLimiter({ windowMs: 60_000, max: 1 })` を追加
- レートキー: `rl:purge_history:${session.user.id}`（ユーザー単位）
- 超過時は `429 RATE_LIMIT_EXCEEDED` を返却
- `src/app/api/maintenance/purge-history/route.test.ts` を新規作成（6テスト）:
  - `returns 401 when unauthenticated`
  - `returns 429 when rate limited`
  - `purges old history entries and returns count`
  - `logs audit with purgedCount when entries deleted`
  - `logs audit with purgedCount=0 when no entries to delete`
  - `only deletes entries older than 90 days`

### 指摘2: `purgedCount=0` 時の監査ログ

**判定: 妥当 → テスト追加で明文化済み**

実装コード上は `logAudit()` が `deleteMany` の結果に関わらず常に呼ばれるため、`purgedCount=0` でも監査ログは出力される。ただしこの動作保証がテストに含まれていなかった。

**対応内容:**
- テストケース `logs audit with purgedCount=0 when no entries to delete` を追加
- `mockPrismaHistory.deleteMany.mockResolvedValue({ count: 0 })` のケースで `mockLogAudit` が `purgedCount: 0` 付きで呼ばれることを検証
- 仕様: **削除件数0でも必ず監査ログを出力する**（`AUDIT_METADATA_KEY.PURGED_COUNT` は常に必須メタデータ）

### 検証結果

| 項目 | 結果 |
|------|------|
| `npm run lint` | エラーなし |
| `npm test` | 131 files, 1315 tests 全パス |
| `npm run build` | ビルド成功 |
