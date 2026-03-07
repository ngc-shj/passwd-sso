# プランレビュー: refactor-scim-tenant-scope

日時: 2026-03-05
レビュー回数: 3回（ループ1 → ループ2 → ループ3で指摘ゼロ確認）

## 前回からの変更

初回レビュー

## 機能観点の指摘 (4件)

### F-1: Groups POST の全 `scopedTeamId` 参照の変更漏れ (高重要度)
- **問題**: Step 4C で `displayName` からの slug 解決は記載されているが、POST ハンドラ内の全 `scopedTeamId` 参照（`existing.teamId !== scopedTeamId`, `teamId: scopedTeamId`, `loadGroupMembers(scopedTeamId, matchedRole)`）の変更が網羅的にリストアップされていない
- **影響**: コンパイルエラーに直結
- **推奨対応**: Step 4C に全参照箇所を列挙

### F-2: Groups PUT/PATCH の destructuring 変更の明記 (中重要度)
- **問題**: PUT/PATCH の `const { teamId: scopedTeamId, tenantId, auditUserId } = result.data` も変更が必要
- **影響**: コンパイルエラー
- **推奨対応**: Step 4D で destructuring の変更を明記

### F-3: `SCIM_GROUP_UPDATE` のチーム/テナント両方への配置検討 (中重要度)
- **問題**: `AUDIT_ACTION_GROUPS_TEAM` から SCIM を完全削除すると、既存の監査ログレコードがチーム監査 UI のフィルタに表示されなくなる。Webhook 配信にも影響。
- **影響**: 過去の SCIM 監査ログの可視性が失われ、チーム Webhook が SCIM イベントを受信不能に
- **推奨対応**: SCIM アクションを TEAM グループにも残す（新規ログは TENANT スコープで記録される）

### F-4: `ScimExternalMapping` の Cascade 削除消失の注意書き (低重要度)
- **問題**: Step 1D で ScimToken の Cascade 注意は記載されているが、ScimExternalMapping の Cascade 消失への言及がない
- **影響**: テナント削除フロー（存在すれば）でブロックされる可能性
- **推奨対応**: プランの注意書きに追記

## セキュリティ観点の指摘 (3件)

### S-1: 既存トークンの tenantId NULL チェック (中重要度)
- **問題**: 既存トークンに `tenantId` が NULL のレコードがあった場合、Step 1 でカラム削除後にフォールバック（`token.team?.tenantId`）が効かなくなる
- **影響**: 正当な SCIM プロビジョニングが停止
- **推奨対応**: マイグレーションに事前の整合性チェック/バックフィル SQL を追加

### S-2: DELETE エンドポイントの revokedAt 重複操作防止 (中重要度)
- **問題**: Step 2D で `token.revokedAt` チェックの記載がない。既に失効済みのトークンへの重複 revoke を防止する仕様が必要
- **影響**: 監査ログに不正確な記録
- **推奨対応**: `token.revokedAt !== null` → 409 を Step 2D に追記

### S-3: Groups POST の slug ベースチーム解決による攻撃面拡大 (情報)
- **問題**: 1 トークンでテナント内の全チームにグループマッピング操作が可能になる
- **影響**: トークン漏洩時の被害範囲がテナント全体に拡大。ただし SCIM 管理は OWNER/ADMIN のみ
- **推奨対応**: 意図的な設計変更として文書化。本 PR のスコープで `allowedTeamIds` は不要（スキップ候補）

## テスト観点の指摘 (6件)

### T-1: Groups POST テストでのチーム slug 解決エッジケース不足 (高重要度)
- **問題**: Step 4E の「チーム slug 解決テスト追加」が抽象的。`:` なし、slug が空、`:` 複数含む、存在しない slug、ロール不正等のケースが未記載
- **影響**: 新しいチーム解決ロジックの境界条件でリグレッション
- **推奨対応**: 具体的なテストケースをプランに列挙

### T-2: 全 SCIM v2 テストの `SCIM_TOKEN_DATA` から `teamId` 削除 (中重要度)
- **問題**: 4つのテストファイルに存在する `SCIM_TOKEN_DATA` モックから `teamId` を削除する必要がある
- **影響**: モックと実際の型が乖離し、テストの信頼性が低下
- **推奨対応**: 全テストファイルの SCIM_TOKEN_DATA 更新をプランに明記

### T-3: 新規テナント API テストの具体的ケースリスト不足 (高重要度)
- **問題**: Step 2F のテストケースが列挙されていない。旧テストにある 401/403/409/Cache-Control 等のカバレッジが移植されない
- **影響**: 新 API のテストカバレッジが旧 API より低下
- **推奨対応**: GET/POST/DELETE の具体的なテストケースリストをプランに追加

### T-4: 監査ログスコープ変更のアサーション追加 (中重要度)
- **問題**: 既存テストで `logAudit` の `scope` フィールドを検証していない。移行後に `TENANT` になることを保証するテストが必要
- **影響**: 監査ログの分類誤りが検出されない
- **推奨対応**: 全 SCIM v2 テストで `scope: AUDIT_SCOPE.TENANT` を検証するアサーション追加

### T-5: `validateScimToken` テストの型安全性確保 (中重要度)
- **問題**: `teamId` 削除後に `makeToken` ヘルパーと期待値の更新が必要。`teamId` が含まれないことの明示的アサーションも必要
- **影響**: テストの期待値が実際の型と乖離
- **推奨対応**: makeToken から teamId/team 削除、not.toHaveProperty("teamId") アサーション追加

### T-6: `ScimExternalMapping.create` 引数の teamId 非含有アサーション (中重要度)
- **問題**: Users POST/PUT テストで create 引数に teamId が含まれないことを検証すべき（Prisma モックでは DB カラム削除が検出不能）
- **影響**: teamId 削除忘れがテストで検出不能
- **推奨対応**: expect.not.objectContaining({ teamId: expect.anything() }) パターン使用

---

## ループ 2

### ループ 2 での変更

ループ 1 の全指摘をプランに反映:

- F-1/F-2: Groups POST/PUT/PATCH の全 scopedTeamId 参照を明記
- F-3: AUDIT_ACTION_GROUPS_TEAM に SCIM を残す方針に変更
- F-4: Cascade 削除消失の注意書き拡充
- S-1: マイグレーションに tenantId バックフィル SQL 追加
- S-2: DELETE の revokedAt 重複操作防止 (409) 追加
- T-1〜T-6: テストケースの具体化、SCIM_TOKEN_DATA 更新、監査ログアサーション等

### 機能観点の指摘 (1件、低重要度)

#### N-4: AUDIT_ACTION_GROUPS_TENANT に追加する具体アクション列挙

- **問題**: 「SCIM グループを追加」とだけあり具体アクションが未記載
- **対応済み**: 全 SCIM アクション（TOKEN_CREATE/REVOKE, USER_*, GROUP_UPDATE）を列挙

その他3件（N-1〜N-3）はプランに既に記載済みの内容と重複のためスキップ。

### セキュリティ観点: 指摘なし

3件（S-4〜S-6）はいずれもプランに記載済みまたはスコープ外のためスキップ。

### テスト観点: 指摘なし

3件（N-1〜N-3）はいずれもプランの他ステップで記載済みのためスキップ。

---

## ループ 3

### 全観点で指摘なし — レビュー完了
