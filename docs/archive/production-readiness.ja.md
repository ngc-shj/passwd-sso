# passwd-sso 商用運用 ToDo

最終更新: 2026-02-17
ベースライン: main ブランチ

---

## 凡例

- **必須** — 商用リリースのブロッカー
- **強く推奨** — リリース後早期に対応
- **推奨** — 段階的に対応

---

## 1. 運用基盤

| # | 優先度 | 項目 | 状態 | 備考 |
|---|--------|------|------|------|
| 1.1 | 必須 | CI/CD パイプライン構築 | 対応済み | GitHub Actions 4 並列ジョブ (app-ci / extension-ci / audit-app / audit-ext)。ESLint native flat config 移行済み。PR #18 |
| 1.2 | 必須 | 監査ログ外部転送 (pino + Fluent Bit) | 対応済み | 監査イベントを構造化 JSON で stdout → Fluent Bit → 任意の転送先。多層防御 (sanitizeMetadata + pino redact)。PR #14 |
| 1.3 | 必須 | アプリケーション構造化ログ | 対応済み | pino 汎用ロガー (`_logType: "app"`) + `withRequestLog()` ラッパーで requestId・レイテンシ自動記録。Phase 1: vault/passwords/auth/csp-report。CSP report body サニタイズ済み。PR #20 |
| 1.4 | 必須 | ヘルスチェックエンドポイント | 対応済み | `/api/health/live` (liveness, 200 固定) + `/api/health/ready` (readiness, DB + Redis チェック, unhealthy → 503)。`HEALTH_REDIS_REQUIRED=true` で Redis 障害時 fail 切替。PR #22 |
| 1.5 | 必須 | 監視・アラート基盤 | 対応済み | Terraform: CloudWatch メトリクスフィルタ (5xx, ヘルスチェック失敗, 高レイテンシ) + アラーム 4 種 + EventBridge ECS 停止検知 + SNS 通知。アプリコードは vendor-neutral。PR #22 |
| 1.6 | 強く推奨 | エラートラッキング (Sentry 等) | 未着手 | クライアントサイド + サーバーサイドのエラー収集・通知 |

---

## 2. セキュリティ強化

| # | 優先度 | 項目 | 状態 | 備考 |
|---|--------|------|------|------|
| 2.1 | 必須 | 環境変数バリデーション | 対応済み | Zod スキーマで起動時に 26 変数を一括検証 (`src/lib/env.ts` + `instrumentation.ts`)。PR #17 |
| 2.2 | 必須 | アカウントロックアウト | 対応済み | DB 永続の段階的ロックアウト (5回→15分, 10回→1h, 15回→24h) + 24h 観測ウィンドウ + 監査ログ (`VAULT_UNLOCK_FAILED` / `VAULT_LOCKOUT_TRIGGERED`)。既存 rate limiter と併用。管理者通知は監査ログ/運用ログ出力まで (CloudWatch Alarm 自動化は次フェーズ)。PR #24 |
| 2.3 | 必須 | パスフレーズリカバリフロー | 対応済み | 回復キー (256-bit, HKDF+AES-256-GCM) による secretKey 復元 + 新パスフレーズ設定。Vault Reset (全データ削除) を最終手段として提供。未生成時はバナーで促進 (24h 後に再表示)。監査ログ 4 種。CSRF 防御 (Origin 検証) + Rate limit 付き。PR #25 |
| 2.4 | 強く推奨 | CORS 設定の明示 | 対応済み | Same-origin only ポリシーを明示実装。OPTIONS preflight 204 応答 + `applyCorsHeaders()` で全 API return 経路にヘッダー付与。`Vary: Origin` + case-insensitive 重複排除。Extension は Service Worker + Bearer Token で CORS 迂回。`../security/cors-policy.md` に運用方針を文書化。#46, PR #57 |
| 2.5 | 強く推奨 | 並行セッション管理 | 未着手 | セッション一覧表示、リモートログアウト、新規ログイン通知 |
| 2.6 | 強く推奨 | 鍵素材メモリ管理の文書化 | 一部対応 | `../security/security-review.md` に記載あり。Web Crypto API 制約下でのリスク受容判断をユーザー向けにも公開 |
| 2.7 | 推奨 | セキュリティ第三者監査 | 未着手 | 暗号実装の外部レビュー (NCC Group, Cure53 等) |

---

## 3. データ保全・可用性

| # | 優先度 | 項目 | 状態 | 備考 |
|---|--------|------|------|------|
| 3.1 | 必須 | バックアップ・リカバリ戦略 | 対応済み | AWS Backup Vault Lock (WORM/Compliance) + S3 Object Lock + クロスリージョンコピー + EventBridge 失敗通知。RPO 1h / RTO 2h。PR #23 |
| 3.2 | 強く推奨 | DB コネクションプール設定 | 対応済み | pg.Pool を環境変数で設定可能化 (max / connectionTimeoutMillis / idleTimeoutMillis / maxLifetimeSeconds / statement_timeout)。envInt() で厳密パース + 範囲ガード (production fail-fast)。pool.on("error") + SIGTERM graceful shutdown。CloudWatch RDS DatabaseConnections アラーム追加。#48 |
| 3.3 | 強く推奨 | マイグレーション戦略の分離 | 対応済み | ECS one-off タスク定義 (Fargate RunTask) でマイグレーションをアプリ起動から完全分離。deploy.sh で migrate → 成功確認 → app 更新の順序を保証。docker-compose は profiles 分離。`../operations/deployment.md`。#47 |
| 3.4 | 推奨 | Redis 高可用性 | 未着手 | 現行は単一 Redis。Redis Sentinel / ElastiCache 等によるフェイルオーバー |

---

## 4. テスト・品質保証

| # | 優先度 | 項目 | 状態 | 備考 |
|---|--------|------|------|------|
| 4.1 | 必須 | E2E テスト導入 | 対応済み | Playwright (Chromium)。7 spec / 22 ケース: セットアップ → アンロック → CRUD → ロック/再アンロック → Recovery Key → Vault Reset → ロケール切替。Node.js 版暗号ヘルパー (CRYPTO_CONSTANTS 共有)、DB 二重ガード (URL パターン + E2E_ALLOW_DB_MUTATION)、暗号互換性テスト 16 件。CI ジョブ追加 (PostgreSQL + Redis サービス) |
| 4.2 | 強く推奨 | カバレッジ対象の拡大 | 一部対応 | コンポーネントテスト基盤導入済み (`@testing-library/react` + `jsdom`, `.test.tsx` 対応)。coverage 対象は 4 パスに限定 → crypto-client.ts や components 層を追加 |
| 4.3 | 強く推奨 | 負荷テスト | 対応済み | k6 6 シナリオ (health / vault-unlock / passwords-list / passwords-create / passwords-generate / mixed-workload)。DB シードスクリプト (三重安全ガード + スモークテスト)。SLO 初期目標 + thresholds による自動合否判定。#49 |
| 4.4 | 推奨 | セキュリティスキャン自動化 | 未着手 | Dependabot / Snyk / Trivy (コンテナ) を CI に統合 |

---

## 5. コンプライアンス・ドキュメント

| # | 優先度 | 項目 | 状態 | 備考 |
|---|--------|------|------|------|
| 5.1 | 必須 | プライバシーポリシー・利用規約 | 未着手 | 個人情報保護法 (日本)、GDPR 対応。データ処理契約 (DPA) |
| 5.2 | 強く推奨 | 依存パッケージのライセンス監査 | 対応済み | CI strict モード (`--strict`) で未レビュー・期限切れを fail。allowlist JSON (11 必須フィールド) で例外管理。ポリシー文書: `../security/license-policy.md` |
| 5.3 | 強く推奨 | インシデント対応手順書 | 未着手 | 脆弱性発見時のエスカレーション、パッチ適用、ユーザー通知フロー |
| 5.4 | 推奨 | SOC 2 / ISMAP 等の認証取得 | 未着手 | 長期目標。日本市場向けには ISMAP が有効 |

---

## 6. 対応済み

既に商用水準に達している領域。

- 暗号設計: PBKDF2 600k + HKDF ドメイン分離 + AAD バインディング
- 型安全性: `any` 型 0 件、`as any` 1 件、`@ts-ignore` 0 件、`strict: true`
- テスト比率: アプリ 38,646 行に対しテスト 20,280 行 (約 52%、119 ファイル / 1,152 テスト)
- セキュリティレビュー: `../security/security-review.md` 全 6 セクション PASS
- CSP + nonce 制御 + violation reporting
- レートリミット (Redis + インメモリフォールバック)
- i18n (en/ja 884 キー完全一致、APP_NAME 環境変数対応)
- Terraform インフラコード化 (1,315 行)
- Docker マルチステージビルド + 非 root 実行
- ブラウザ拡張のトークンライフサイクル管理
- 入力バリデーション (Zod 486 行、API 40 箇所)
- 監査ログ (Personal + Org、フィルタ・エクスポート対応)
- 監査ログ外部転送 (pino + Fluent Bit サイドカー)
- 環境変数バリデーション (Zod スキーマ 26 変数、起動時一括検証)
- CI/CD パイプライン (GitHub Actions 4 並列ジョブ、ESLint + Vitest + Next.js build)
- アプリケーション構造化ログ (pino + withRequestLog + CSP report サニタイズ)
- ヘルスチェック (`/api/health/live` liveness + `/api/health/ready` readiness, DB/Redis チェック, タイムアウト保護)
- 監視・アラート基盤 (CloudWatch メトリクスフィルタ + アラーム + EventBridge ECS 停止検知 + SNS 通知)
- バックアップ・リカバリ (AWS Backup Vault Lock WORM + S3 Object Lock Compliance + クロスリージョンコピー + EventBridge 失敗通知)
- パスフレーズリカバリフロー (回復キー: Base32 + HKDF + AES-256-GCM ラップ + Vault Reset: 全データ削除)
- コンポーネントテスト基盤 (`@testing-library/react` + `jsdom`、signin / header / auto-extension-connect)
- E2E テスト (Playwright 7 spec / 22 ケース、暗号互換性テスト 16 件、DB 二重ガード + スコープ限定クリーンアップ)
- マイグレーション戦略の分離 (ECS one-off RunTask + deploy.sh 順序保証 + docker-compose profiles 分離)
- DB コネクションプール設定 (環境変数チューニング + maxLifetimeSeconds + graceful shutdown + RDS 接続数アラーム)
- 負荷テスト (k6 6 シナリオ、DB シード三重ガード、SLO 初期目標、thresholds 自動合否判定)
- 依存パッケージライセンス監査 (allowlist JSON 17 件、strict モード CI 強制、期限切れ検出、ポリシー文書)
- 本番コード `console.log` 0 件、`TODO/FIXME` 0 件

---

## 推奨実行順序 (残りの必須項目)

必須項目 8/9 対応済み。残り:

1. **5.1** プライバシーポリシー・利用規約 — リリース前の法務要件

---

## OSS 前提の優先順位 (当面)

OSS としての公開・運用を前提に、以下は当面スコープ外とする:

- `5.1` プライバシーポリシー・利用規約
- `2.7` セキュリティ第三者監査
- `5.4` SOC 2 / ISMAP 等の認証取得

### P1 (直近対応)

1. `5.3` インシデント対応手順書
2. `2.4` CORS 設定の明示
3. `3.3` マイグレーション戦略の分離
4. `3.2` DB コネクションプール設定
5. `4.3` 負荷テスト

### P2 (次フェーズ)

1. ~~`5.2` 依存パッケージのライセンス監査~~ ✅
2. `4.4` セキュリティスキャン自動化
3. `2.5` 並行セッション管理
4. `1.6` エラートラッキング
5. `4.2` カバレッジ対象の拡大

### P3 (中長期)

1. `3.4` Redis 高可用性
2. `2.6` 鍵素材メモリ管理の文書化 (残タスク)
