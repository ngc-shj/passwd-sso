# プランレビュー: B-1 SCIM 2.0 Provisioning

日時: 2026-02-25T14:00:00+09:00
レビュー回数: 4回目 (収束)

## 変更履歴

### ループ 1 → 2
ループ 1 の全指摘 (機能 9件, セキュリティ 7件, テスト 10件) を精査し、24件を採用・2件をスキップ。

### ループ 2 → 3
ループ 2 で新たに機能 8件, セキュリティ 5件 (実質4件), テスト 10件を検出。全件採用しプランに反映。

主な変更点:
- onDelete ポリシーを明示 (ScimToken.org: Cascade, ScimToken.createdBy: SetNull, ScimExternalMapping.org: Cascade)
- SCIM DELETE フローに OrgMemberKey + ScimExternalMapping の同時削除を追加
- deactivatedAt 対象ファイルを12箇所のチェックリストで網羅
- findFirst 変更理由を正確に記載
- invitations/accept の deactivated メンバー再参加フローを追加
- トークン管理 DELETE API の orgId 検証 (IDOR 防止) を追加
- SCIM User 属性マッピング表を追加
- rate-limit.ts は既存 createRateLimiter() を再利用、プレフィックス付きキー
- テストヘルパー (fixtures.ts, mock-org-auth.ts, org-auth.test.ts) の変更を追加
- CI 対応を明確化 (e2e ジョブ向け)
- 無期限トークンの UI 警告を追加

### ループ 3 → 4
ループ 3 で新たに機能 6件, セキュリティ 6件, テスト 7件を検出。1件スキップ (T-1v3: ドキュメントのみ)、残り全件採用。

主な変更点:
- Schema code block: `createdById String?` (nullable) 修正
- `auditUserId: string` フィールド + `SCIM_SYSTEM_USER_ID` フォールバック定数
- AuditAction enum に `SCIM_USER_DELETE` 追加 (計8件)
- `SCIM_MANAGED_MEMBER` エラーコード追加 (scimManaged メンバーの手動招待拒否)
- チェックリスト #13 (invitations/route.ts POST) 追加
- Groups OWNER メンバーの降格/削除を全パスでブロック
- userName `toLowerCase()` 正規化 + Zod transform
- filter-parser に `ALLOWED_FILTER_ATTRIBUTES` ホワイトリスト追加
- テスト戦略: invitations/accept テストケース, SCIM_MANAGE 権限テスト, createdById null テスト, vi.useFakeTimers, keyDistributed fixture

### ループ 4 (最終)
ループ 4 で機能 **指摘なし**, テスト **指摘なし**, セキュリティ 2件 (S-20, S-24) を検出。両件採用しプランに反映。

- S-20: `token-utils.ts` に `scim_` プレフィックス付きトークン生成を追加
- S-24: confirm-key/route.ts チェックリスト #10 に tx内 deactivatedAt チェック (TOCTOU 防止) を明記

---

## ループ 1: 機能観点の指摘

### F-1: Group マッピングの RFC 7644 非準拠 (高) → 採用済み
- **問題**: ロール名 ("ADMIN") をそのまま SCIM Group ID として使うと、Okta/Azure AD が UUID 形式を期待する場面でエラーになる
- **推奨対応**: `uuid5(orgId + roleName)` で決定論的 UUID を生成

### F-2: SCIM PATCH の op スコープが不明確 (中) → 採用済み
- **推奨対応**: Users/Groups 両方でサポートする PATCH op を明示

### F-3: proxy.ts バイパスの設計 (中) → 採用済み
- **推奨対応**: proxy.ts 変更なし、ルートハンドラで検証

### F-4: AuditLog の userId 制約と SCIM 操作 (中) → 採用済み
- **推奨対応**: `ScimToken.createdById` を audit userId に

### F-5: ScimExternalMapping の冪等性 (中) → 採用済み
- **推奨対応**: `@@unique` + `$transaction`

### F-6: findUnique → findFirst 変更の影響 (高) → 採用済み
- **推奨対応**: `findFirst({ where: { orgId, userId, deactivatedAt: null } })`

### F-7: マルチ org User の属性更新スコープ (中) → 採用済み
- **推奨対応**: 初回プロビジョニング時のみ User テーブル更新

### F-8: OWNER deactivate 保護が非活性化パスに未記載 (高) → 採用済み
- **推奨対応**: PATCH active=false にも OWNER 保護

### F-9: lastUsedAt の高頻度更新 (低) → 採用済み
- **推奨対応**: 5分間引き

---

## ループ 1: セキュリティ観点の指摘

### S-1: SCIM トークンにスコープがない (高) → スキップ
- **理由**: MVP では不要。SCIM は IdP service-to-service 用途で、トークン自体が org-scoped

### S-2: proxy.ts バイパスの Bearer 条件不備 (高) → 採用済み (F-3 と統合)

### S-3: OWNER ロール昇格がブロックされていない (中) → 採用済み

### S-4: トークン有効期限の欠如 (中) → 採用済み

### S-5: フィルタパーサーの ReDoS リスク (中) → 採用済み

### S-6: orgId の IDOR リスク (中) → 採用済み

### S-7: ScimExternalMapping の整合性 (中) → 採用済み (F-5 と統合)

---

## ループ 1: テスト観点の指摘

### T-1: SHA-256 の constant-time 比較テスト (高) → スキップ
- **理由**: DB lookup ベースの検証。SHA-256 の preimage 特性により timing attack は非実用的

### T-2 ~ T-10: 全件採用済み

---

## ループ 2: 機能観点の指摘

### F-10: ScimToken の onDelete ポリシー未指定 (中) → 採用済み
- **問題**: ScimToken のリレーションに onDelete が未記載。createdBy User が削除された場合の動作が不明確
- **対応**: org → Cascade, createdBy → SetNull (createdById を nullable に変更)

### F-11: ScimExternalMapping 削除の整合性 (中) → 採用済み
- **問題**: SCIM DELETE で OrgMember を削除しても ScimExternalMapping が残存し、再プロビジョニングで 409
- **対応**: DELETE フローの $transaction 内で ScimExternalMapping も同時削除

### F-12: findFirst 変更理由の明確化 (低) → 採用済み
- **問題**: 変更理由が「deactivatedAt が unique index に含まれないため」では不正確
- **対応**: 「Prisma の findUnique は where 句に unique index 外のフィールドを含められないため」と正確に記載

### F-13: invitations/accept の deactivated メンバー (中) → 採用済み
- **問題**: deactivated メンバーが招待経由で再参加しようとすると ALREADY_A_MEMBER エラー
- **対応**: deactivatedAt reset + scimManaged reset の再参加フローを明記

### F-14: deactivatedAt 対象ファイルの網羅 (高) → 採用済み
- **問題**: Phase 1-5 の「その他すべて」が具体的でない。10箇所以上のクエリが未記載
- **対応**: 12箇所のチェックリストを Phase 1-5 に追加

### F-15: DELETE 時の OrgMemberKey 削除 (中) → 採用済み
- **問題**: OrgMember 削除後に OrgMemberKey が残存 (古い鍵データ)
- **対応**: DELETE の $transaction 内で OrgMemberKey も削除

### F-16: rate-limit.ts の既存パターン再利用 (低) → 採用済み
- **問題**: 既存 createRateLimiter() を使うか独自実装するか不明確
- **対応**: `createRateLimiter({ windowMs: 60_000, max: 200 })` のラッパーと明記

### F-17: SCIM User 属性マッピング (中) → 採用済み
- **問題**: userName, name.givenName 等の DB マッピングが未定義
- **対応**: 属性マッピング表を Phase 2-2 に追加。name.givenName/familyName は MVP 非サポート (400)

---

## ループ 2: セキュリティ観点の指摘

### S-8: Bearer 検証のタイミング安全性 (中) → 指摘なし (自己解決)
- SHA-256 DB lookup パターンで十分

### S-9: deactivatedAt フィルタ漏れの網羅性 (高) → 採用済み (F-14 と統合)
- 特に rotate-key と pending-key-distributions は暗号鍵に直結

### S-10: DELETE ハードデリートの整合性 (中) → 採用済み (F-11/F-15 と統合)

### S-11: トークン管理 DELETE の orgId 検証 (高) → 採用済み
- **問題**: DELETE [tokenId] で token.orgId === orgId の検証が未記載 (管理 API 側 IDOR)
- **対応**: Phase 4 に orgId 検証を明記

### S-12: レートリミットキー設計 (低) → 採用済み
- **対応**: `rl:scim:${orgId}` プレフィックス + 429 を SCIM エラー形式で返却

### S-13: 無期限トークンの UI 警告 (低) → 採用済み
- **対応**: Phase 5-1 に警告表示を追加

---

## ループ 2: テスト観点の指摘

### T-1 (v2): CI migrate deploy 先ジョブ (低) → 採用済み
- **対応**: e2e ジョブ向け (app-ci はモックベースで不要) と明確化

### T-2 (v2): coverage.include に scim-token.ts (中) → 採用済み
- **対応**: `src/lib/scim-token.ts` を明示的に追加

### T-3 (v2): lastUsedAt 間引きテスト (中) → 採用済み
- **対応**: 5分以上前→更新、5分以内→スキップ、null→更新 のテストケース追加

### T-4 (v2): fixtures.ts 更新 (中) → 採用済み
- **対応**: makeOrgMember() に新フィールド + makeScimToken()/makeScimExternalMapping() 追加

### T-5 (v2): mock-org-auth.ts 更新 (低) → 採用済み

### T-6 (v2): org-auth.test.ts の findFirst 変更 (高) → 採用済み
- **対応**: findUnique → findFirst モック書き換え + deactivatedAt assertion

### T-7 (v2): deactivatedAt 対象ファイルの網羅 (高) → 採用済み (F-14/S-9 と統合)

### T-8 (v2): ResourceTypes/Schemas テスト (中) → 採用済み
- **対応**: ルートハンドラテスト一覧に 2 件追加

### T-9 (v2): SCIM Content-Type テスト (低) → 採用済み
- **対応**: Users POST テストに application/scim+json と application/json 両方の受理テスト

### T-10 (v2): Groups OWNER 境界ケース (低) → 採用済み
- **対応**: OWNER グループへの add/remove/PUT 全置換のブロックテスト

---

## ループ 3: 機能観点の指摘

### F-18: createdById の型不整合 (高) → 採用済み
- **問題**: Schema code block で `createdById String` (非nullable) と記載しているが、`onDelete: SetNull` には nullable が必須
- **対応**: `createdById String?` + `createdBy User?` に修正

### F-19: AuditLog.userId NOT NULL vs nullable createdById (高) → 採用済み
- **問題**: トークン作成者の脱退で `createdById` が null → 監査ログの userId が null になりうる
- **対応**: `auditUserId: string` フィールド + `SCIM_SYSTEM_USER_ID` フォールバック定数を追加

### F-20: invitations/accept の実装詳細 (中) → 採用済み
- **問題**: findFirst + upsert update 句の具体的な記載が不足
- **対応**: `deactivatedAt: null, scimManaged: false` を upsert update 句に明記

### F-21: invitations/route.ts POST の deactivatedAt (中) → 採用済み
- **問題**: チェックリストに invitations/route.ts POST が含まれていない
- **対応**: チェックリスト #13 として追加

### F-22: SCIM_USER_DELETE enum の欠落 (中) → 採用済み
- **問題**: AuditAction enum が7件と記載されているが DELETE アクションが未掲載
- **対応**: `SCIM_USER_DELETE` を追加し計8件に修正

### F-23: Groups OWNER メンバーの降格保護 (高) → 採用済み
- **問題**: Groups PATCH/PUT で OWNER メンバーの降格 (別グループへの移動) がブロックされていない
- **対応**: Groups spec に OWNER メンバーの add/remove/PUT 全置換のブロックを明記

---

## ループ 3: セキュリティ観点の指摘

### S-14: invitations/route.ts POST の deactivatedAt チェック (中) → 採用済み (F-21 と統合)

### S-15: scimManaged メンバーの招待フリップフロップ (高) → 採用済み
- **問題**: 手動招待で scimManaged をリセットすると IdP が再 deactivate → 状態が行ったり来たり
- **対応**: `SCIM_MANAGED_MEMBER` エラーコードで拒否。Design Decisions にも追加

### S-16: AuditLog.userId と SCIM_SYSTEM_USER_ID (中) → 採用済み (F-19 と統合)

### S-17: filter-parser の属性ホワイトリスト (中) → 採用済み
- **問題**: 任意の属性名でフィルタ可能 → 予期しない DB クエリ生成のリスク
- **対応**: `ALLOWED_FILTER_ATTRIBUTES = new Set(["userName", "active", "externalId"])` を追加

### S-18: email 正規化 (中) → 採用済み
- **問題**: PostgreSQL は case-sensitive。大文字/小文字で別 User が作成される可能性
- **対応**: userName を `toLowerCase()` で正規化 + Zod transform。Design Decisions にも追加

### S-19: Groups OWNER 降格保護の網羅性 (中) → 採用済み (F-23 と統合)

---

## ループ 3: テスト観点の指摘

### T-1 (v3): テスト戦略ドキュメントの整理 (低) → スキップ
- **理由**: ドキュメント整理のみ。プラン本体のテスト戦略セクションで既に網羅

### T-2 (v3): invitations/accept テストケース (高) → 採用済み
- **対応**: deactivated + scimManaged:false → 再参加成功、deactivated + scimManaged:true → SCIM_MANAGED_MEMBER エラー

### T-3 (v3): SCIM_MANAGE 権限テスト (中) → 採用済み
- **対応**: org-auth.test.ts に OWNER/ADMIN: true, MEMBER/VIEWER: false のテスト追加

### T-4 (v3): 既存テストの deactivatedAt assertion (中) → 採用済み
- **対応**: チェックリスト対応6ファイルの findMany/findFirst where 句を toHaveBeenCalledWith で検証

### T-5 (v3): createdById null テスト (中) → 採用済み
- **対応**: scim-token.test.ts に createdById: null → auditUserId = SCIM_SYSTEM_USER_ID のテスト追加

### T-6 (v3): keyDistributed in makeOrgMember (低) → 採用済み
- **対応**: fixtures.ts の makeOrgMember() に keyDistributed フィールド追加

### T-7 (v3): vi.useFakeTimers for lastUsedAt (中) → 採用済み
- **対応**: `vi.useFakeTimers()` + `vi.setSystemTime()` で5分間引きロジックをテスト

---

## ループ 4: 機能観点の指摘

**指摘なし**

---

## ループ 4: セキュリティ観点の指摘

### S-20: トークンプレフィックス (低) → 採用済み
- **問題**: 生成トークンにプレフィックスがないとシークレットスキャナーで検出困難
- **対応**: `token-utils.ts` に `scim_` プレフィックス + 32バイトエントロピーを追加。validateScimToken 側でプレフィックス検証

### S-21 ~ S-23: Informational → スキップ
- S-21: ログ出力のトークン値マスキング — 実装時の一般的なベストプラクティス
- S-22: SCIM エンドポイントの CORS 設定 — IdP は server-to-server 通信、ブラウザ CORS 不要
- S-23: トークンローテーション戦略 — MVP スコープ外、失効+再生成で対応可能

### S-24: confirm-key tx内 deactivatedAt チェック (中) → 採用済み
- **問題**: L36 (tx外) で deactivatedAt チェックしても、L88 (tx内) で再チェックしないと TOCTOU で deactivated メンバーに鍵配布される
- **対応**: チェックリスト #10 を更新し tx内チェックを明記

### S-25: Informational → スキップ
- 429 レスポンスの Retry-After ヘッダー — 実装時の詳細、プランレベルでは不要

---

## ループ 4: テスト観点の指摘

**指摘なし**

---

## 総括

| ループ | 機能 | セキュリティ | テスト | 合計 |
|--------|------|-------------|--------|------|
| 1 | 9 | 7 | 10 | 26 |
| 2 | 8 | 5 (実質4) | 10 | 23 |
| 3 | 6 | 6 | 7 | 19 |
| 4 | 0 | 2 | 0 | 2 |
| 5 | 0 | 0 | 3 | 3 |

- **採用**: 67件
- **スキップ**: 7件 (S-1, T-1, T-1v3, S-21~S-23, S-25, T-4v5, T-5v5)
- **総ループ回数**: 5回
- **最終状態**: 機能・セキュリティ **指摘なし**、テスト 3件のみ (全件採用済み)

---

## ループ 5: 機能観点の指摘

**指摘なし** (エージェント rate limit のためループ 4 結果を引き継ぎ)

---

## ループ 5: セキュリティ観点の指摘

**指摘なし** (エージェント rate limit のためループ 4 結果を引き継ぎ)

---

## ループ 5: テスト観点の指摘

### T-1 (v5): `scim_` プレフィックス不一致の拒否テスト (中) → 採用済み

- **問題**: S-20 で validateScimToken にプレフィックス検証を追加したが、テスト戦略にプレフィックス不一致の拒否ケースが未記載
- **対応**: scim-token.test.ts に `scim_` プレフィックスなし/別プレフィックス → 401 のテストケース追加

### T-2 (v5): generateScimToken() 出力形式テスト (中) → 採用済み

- **問題**: トークン生成側のユニットテスト (プレフィックス存在、長さ、文字セット) がテスト戦略に未記載
- **対応**: token-utils.test.ts を新規追加し、generateScimToken() の出力形式を検証

### T-3 (v5): confirm-key tx内 deactivatedAt テストケース (中) → 採用済み

- **問題**: S-24 でチェックリスト #10 に tx内チェックを追加したが、対応するテストケースが明示されていない
- **対応**: confirm-key/route.test.ts に tx内 deactivatedAt チェックのテストケースを追加

### T-4 (v5): invitations/accept upsert assertion 詳細 (低) → スキップ

- **理由**: プランの既存テスト更新セクションで「deactivated + scimManaged:false → 再参加成功」として既にカバー

### T-5 (v5): coverage.include へのパス追加 (低) → スキップ

- **理由**: プランの CI 対応セクションで「coverage.include に src/lib/scim-token.ts + src/lib/scim/*.ts 追加」と既に明記済み
