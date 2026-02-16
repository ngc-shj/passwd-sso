# Load Testing (k6)

k6 を使用した負荷テストスイート。6 シナリオで API のスループット、レイテンシ、エラー率を計測する。

## 前提

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) がインストール済み
- PostgreSQL + Redis が起動中
- アプリが `http://localhost:3000` で起動中
- `ORG_MASTER_KEY` (または `VERIFIER_PEPPER_KEY`) が設定済み

## クイックスタート

```bash
# 1. DB にテストユーザーをシード (50ユーザー、PBKDF2のため数分かかる)
ALLOW_LOAD_TEST_SEED=true \
DATABASE_URL=postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso \
npm run test:load:seed

# 2. 負荷テスト実行
k6 run load-test/scenarios/mixed-workload.js

# 3. テストデータ削除
ALLOW_LOAD_TEST_SEED=true \
DATABASE_URL=postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso \
npm run test:load:cleanup
```

## npm スクリプト

| コマンド | 説明 |
|---------|------|
| `npm run test:load:seed` | テストユーザーをシード |
| `npm run test:load:cleanup` | テストデータを削除 |
| `npm run test:load:smoke` | スモークテスト (ガード検証 + 1ユーザーシード + API確認 + クリーンアップ) |
| `npm run test:load` | mixed workload シナリオ実行 |
| `npm run test:load:health` | health シナリオ実行 |

## シナリオ一覧

| シナリオ | エンドポイント | executor | 負荷 |
|---------|-------------|----------|-----|
| `health.js` | GET /api/health/ready | constant-arrival-rate | 50 rps, 30s |
| `vault-unlock.js` | POST /api/vault/unlock | ramping-vus | 1→20→0, 50s |
| `passwords-list.js` | GET /api/passwords | constant-arrival-rate | 30 rps, 30s |
| `passwords-create.js` | POST /api/passwords | ramping-vus | 1→10→0, 40s |
| `passwords-generate.js` | POST /api/passwords/generate | constant-arrival-rate | 50 rps, 30s |
| `mixed-workload.js` | 上記複合 | ramping-vus | 1→20→0, 90s |

## SLO 初期目標

| エンドポイント | p95 | p99 | エラー率 |
|-------------|-----|-----|---------|
| GET /api/health/ready | < 200ms | < 500ms | < 0.1% |
| POST /api/vault/unlock | < 500ms | < 1000ms | < 1% |
| GET /api/passwords | < 300ms | < 800ms | < 0.1% |
| POST /api/passwords | < 500ms | < 1000ms | < 0.5% |
| POST /api/passwords/generate | < 100ms | < 300ms | < 0.1% |
| Mixed workload | < 500ms | < 1500ms | < 0.5% |

k6 の `thresholds` が breach されると **exit code 99** で終了する。スクリプトやCIでの合否判定に使用可能。

## 安全ガード

シードスクリプトは三重ガードで本番 DB への誤接続を防止:

1. **URL パース**: hostname が `localhost`, `127.0.0.1`, `::1`, `db` のいずれか + dbname に `test`/`loadtest`/`ci` を含む
2. **NODE_ENV**: `production` の場合は拒否
3. **明示フラグ**: `ALLOW_LOAD_TEST_SEED=true` が必須

> **注**: hostname `db` は docker-compose 内部ネットワーク専用。外部環境では使用しないこと。

## 認証方式

- Auth.js v5 の database session 戦略 (raw token)
- セッショントークンを DB に直接 INSERT (E2E テストと同一パターン)
- k6 は `authjs.session-token` cookie でリクエスト
- HTTPS 環境では `COOKIE_NAME=__Secure-authjs.session-token` を指定

## ベースライン管理

```bash
# ベースライン保存 (環境別プレフィックス)
k6 run load-test/scenarios/mixed-workload.js \
  --out json=load-test/baselines/local-$(date +%F).json

# staging 環境
BASE_URL=https://staging.example.com k6 run load-test/scenarios/mixed-workload.js \
  --out json=load-test/baselines/staging-$(date +%F).json
```

**重要**: ローカル計測値は本番 SLO の参考値であり、直接比較しないこと。比較は同一環境内の経時変化 (リグレッション検出) に使用する。

## 認証アーティファクトの取り扱い

- `.load-test-auth.json` はローカル専用、共有禁止
- `chmod 600` が自動適用される
- 使用後は `npm run test:load:cleanup` で削除
- `.gitignore` に登録済み

## トラブルシューティング

### セッション認証エラー (401)

```bash
# cookie名を確認
COOKIE_NAME=__Secure-authjs.session-token npm run test:load:seed
```

### レートリミット (429)

vault-unlock は 5回/5分のレートリミットあり。50ユーザーに分散 + `sleep(1)` で回避。ユーザー数を増やす:

```bash
ALLOW_LOAD_TEST_SEED=true DATABASE_URL=... \
  node load-test/setup/seed-load-test-users.mjs --users 100
```

### 手動クリーンアップ

cleanup コマンドが失敗した場合:

```sql
DELETE FROM password_entries WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'lt-user-%@loadtest.local');
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'lt-user-%@loadtest.local');
DELETE FROM vault_keys WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'lt-user-%@loadtest.local');
DELETE FROM users WHERE email LIKE 'lt-user-%@loadtest.local';
```

### k6 がインストールされていない

```bash
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D68
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
  sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```
