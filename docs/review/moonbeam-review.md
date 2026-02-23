# プランレビュー: mellow-dreaming-moonbeam.md
日時: 2026-02-22T00:00:00Z
レビュー回数: 2回目

## 前回からの変更
Round 2 で反映した Medium 指摘:
- F-11: `encryptShareData`/`encryptShareBinary` の戻り値に `masterKeyVersion` を含める
- F-12/F-13: proxy.ts 保護方針の明確化、ダウングレード検証条件の修正
- F-14: 楽観的ロック（WHERE masterKeyVersion = fromVersion）を明記
- F-15: V1 キー優先順位を明記（ORG_MASTER_KEY_V1 > ORG_MASTER_KEY）
- S-10: encryptShareData の戻り値にバージョン含める（F-11 と同一）
- S-11: レート制限をグローバル固定キーに変更
- S-12: CURRENT_VERSION の上限 .max(100) 追加
- S-14: 監査ログ metadata にリクエスト元 IP を含める
- T-R2-1: proxy.ts の保護方針を明確化（セッション認証対象外、catch-all スルー）
- T-R2-2: 監査定数 + i18n 翻訳キーの追加を Step 1 に追記
- T-R2-3: encryptShareData の戻り値からバージョンを取得する設計（F-11 で解決）

## 機能観点の指摘

### F-1 (Critical): `unwrapOrgKey` デフォルト引数が current version だと未更新サイトで復号失敗
- **問題:** デフォルトが `getCurrentMasterKeyVersion()` だと、呼び出しサイトの更新漏れで V2 で V1 データを復号しようとして全面エラー
- **影響:** ローテーション後、未更新の API エンドポイントで全組織データの復号が失敗しサービス障害
- **推奨対応:** デフォルトを `1` に固定。明示的に渡さない限り V1 で復号を試みる設計に

### F-2 (Critical): `AuditLog.userId` が必須だがローテーション API にユーザーセッションがない
- **問題:** `ADMIN_API_TOKEN` 認証ではセッションユーザーが存在せず、`userId` (FK必須) に値を設定できない
- **影響:** 監査ログ記録失敗 or FK制約違反
- **推奨対応:** セッション認証 + ADMIN ロールに変更、または API にoperatorId必須パラメータ追加

### F-3 (Critical): Organization 作成時に `masterKeyVersion` を DB に保存する変更が漏れている
- **問題:** `src/app/api/orgs/route.ts` で `wrapOrgKey()` の戻り値の `masterKeyVersion` を `prisma.organization.create` に含めていない
- **影響:** ローテーション後の新規 org は V2 で wrap されるが DB には `masterKeyVersion=1` (デフォルト) が記録され、復号時に V1 で試みて失敗
- **推奨対応:** Step 4 に org 作成側の変更を明記

### F-4 (High): Share 作成側3ファイルの変更が Step 5 テーブルに記載漏れ
- **問題:** `share-links/route.ts`, `sends/route.ts`, `sends/file/route.ts` で `masterKeyVersion` を DB に保存する変更がテーブル未記載
- **影響:** Share 作成時に masterKeyVersion が保存されず、復号時にバージョン不明
- **推奨対応:** Step 5 のテーブルにこの3ファイルの変更を追加

### F-5 (High): `getVerifierPepper()` の dev/test フォールバックが壊れる
- **問題:** `ORG_MASTER_KEY` なし運用時、`getMasterKey()` が失敗し pepper 導出ができなくなる
- **影響:** dev/test でボールトアンロック不可
- **推奨対応:** フォールバック内で `getMasterKeyByVersion(1)` を使用

### F-6 (Medium): `masterKeyCache` にキーマテリアルがプロセス寿命分残る
- **問題:** キャッシュ導入で GC によるキー回収が不可能に
- **影響:** ヒープダンプでマスターキー漏洩リスク増大
- **推奨対応:** キャッシュ廃止（hex parse コストは無視可能）

### F-7 (Medium): ローテーション API にトランザクション制御と並行性保護がない
- **問題:** re-wrap 中のレースコンディション、同時実行の冪等性
- **影響:** データ不整合（低確率だが大規模運用時にリスク）
- **推奨対応:** 各 org の更新を個別トランザクションで実行、WHERE条件付き楽観的ロック

### F-8 (Low): テストファイル12箇所の `mockUnwrapOrgKey` 更新がプランに未記載
- **問題:** `unwrapOrgKey` のモックを使う全テストファイルの更新が必要
- **推奨対応:** Step 4 にテストファイル更新を追記

### F-9 (Low): `env.ts` で動的キー名のバリデーションが Zod 型安全にならない
- **問題:** `ORG_MASTER_KEY_V{N}` は Zod スキーマに静的定義できない
- **推奨対応:** `superRefine` 内で `process.env` を直接参照し、hex64 バリデーションも手動で行う

### F-10 (Low): テストセットアップファイルの更新が必要
- **問題:** `setup.ts` が常に `ORG_MASTER_KEY` を設定するため、レガシー以外のパスがテストしにくい
- **推奨対応:** バージョン関連テストでは環境変数を完全分離するパターンを採用

## セキュリティ観点の指摘

### S-1 (Critical): ADMIN_API_TOKEN の比較がタイミング攻撃に対して脆弱
- **問題:** トークン比較方法が未定義。`===` を使うとタイミングサイドチャネルでトークン推測可能
- **影響:** 攻撃者がマスターキーを自分の制御する鍵に差し替え可能
- **推奨対応:** `timingSafeEqual` + SHA-256 ハッシュ比較を明記

### S-2 (Critical): ADMIN_API_TOKEN のエントロピーと検証が未定義
- **問題:** 最小長、フォーマット検証なし
- **影響:** 弱いトークンでブルートフォース突破
- **推奨対応:** `env.ts` に hex64 バリデーション追加、本番環境で必須化

### S-3 (High): ローテーション API が proxy.ts のルート保護の対象外
- **問題:** `/api/admin/*` は proxy の認証チェックリストに含まれない
- **影響:** トークン漏洩時、認証セッションなしで誰でもローテーション実行可能
- **推奨対応:** proxy.ts に `/api/admin/*` の保護を追加、ネットワークレベル制限を推奨

### S-4 (High): PasswordShare の「自然失効」依存は鍵漏洩時に30日間データ露出
- **問題:** 旧マスターキー漏洩時、有効中の PasswordShare が最大30日間復号可能
- **影響:** 共有パスワード・ファイルが30日間平文取得可能
- **推奨対応:** ローテーション API に有効な PasswordShare の再暗号化を含める、または緊急時の一括取消機能

### S-5 (High): masterKeyVersion のダウングレード攻撃への対策がない
- **問題:** `targetVersion` が current より低い場合の検証がない
- **影響:** 攻撃者が既に入手した旧鍵でデータ復号可能にする
- **推奨対応:** `targetVersion > currentVersion` の検証、ダウングレード試行の監査ログ記録

### S-6 (Medium): rewrapOrgKey での平文鍵の Buffer をゼロフィルしていない
- **問題:** unwrap した平文 org key が使用後もメモリに残る
- **推奨対応:** `try/finally` で `buffer.fill(0)` を実施

### S-7 (Medium): マスターキーキャッシュがセキュリティリスク
- **問題:** `Map<number, Buffer>` で全バージョンのマスターキーがプロセス寿命分メモリに残る
- **推奨対応:** キャッシュ廃止（F-6 と同一指摘）

### S-8 (Medium): getVerifierPepper の ORG_MASTER_KEY 依存（F-5 と同一）
- **推奨対応:** ローテーション手順に dev/test 環境での注意事項を明記

### S-9 (Medium): ローテーション API にレート制限がない
- **問題:** ブルートフォース + タイミング攻撃の組み合わせが容易に
- **推奨対応:** `windowMs: 60_000, max: 1` 程度のレート制限追加

## テスト観点の指摘

### T-1 (High): テストセットアップのグローバル環境変数がバージョン付き鍵テストと競合
- **問題:** `setup.ts` が `ORG_MASTER_KEY` を常にセット、テスト間分離が不完全
- **推奨対応:** `vi.stubEnv` / `vi.unstubAllEnvs` またはプロセス全体の env 保存・復元パターン

### T-2 (High): Share 暗号化関数4つのバージョン対応テストが欠落
- **問題:** `encryptShareData`, `encryptShareBinary`, `decryptShareBinary` のテストが未記載
- **推奨対応:** ラウンドトリップ・クロスバージョンテスト追加

### T-3 (High): 11箇所の `unwrapOrgKey` 呼び出しサイトの更新漏れ検出の仕組みがない
- **問題:** モックが更新漏れをマスクする
- **推奨対応:** TypeScript コンパイラでの検出（第2引数を必須にする）または grep ベースの CI チェック

### T-4 (Medium): ローテーション API テストの AuditLog userId 必須 FK の扱い未定義
- **推奨対応:** `logAudit` をモックし、呼び出しアサーション追加

### T-5 (Medium): `env.test.ts` の境界条件テストが不十分
- **問題:** レガシー + V1 同時設定、CURRENT_VERSION 未設定、V不正 hex 等のケースが欠落
- **推奨対応:** 境界条件テスト5件追加

### T-6 (Medium): CI ワークフローにバージョン付き鍵の環境変数が未反映
- **推奨対応:** CI の env ブロックに V1 + CURRENT_VERSION 追加、またはマトリクスで2パターン

### T-7 (Low): `wrapOrgKey` の返却値テストだけでは暗号鍵の一致を検証できない
- **推奨対応:** クロスバージョン検証テスト追加（V2 で wrap → V1 で unwrap → 失敗を確認）

### T-8 (Low): `rewrapOrgKey` のラウンドトリップテストが DB レイヤーを経由しない
- **推奨対応:** API テストで Prisma update のアサーション追加
