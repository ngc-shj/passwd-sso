# main ブランチ評価（load-test 修正）

作成日: 2026-02-17
対象: `main`（PR #63 取り込み済み）

## 1. 機能面

### 評価
- 妥当（重大な機能不整合なし）

### 確認ポイント
- `load-test/scenarios/passwords-generate.js`
  - `constant-arrival-rate` 50 rps の設定で、SLO 計測目的と整合。
  - 期待レスポンスチェック（`status 200`, `password length >= 32`）が実装済み。
- `load-test/scenarios/health.js`
  - ヘルスレスポンス判定が現仕様（`checks.database.status === "pass"`）に一致。
- `src/app/api/passwords/generate/route.ts`
  - レート制限が `120/60s` となっており、負荷シナリオの前提と整合。
- `load-test/helpers/auth.js`
  - auth ファイル未生成/空時の fail-fast があり、誤実行時の切り分けが容易。

## 2. セキュリティ面

### 評価
- 妥当（既知の懸念に対する対策が入っている）

### 確認ポイント
- `load-test/setup/seed-load-test-users.mjs`
  - 三重ガード（hostname allowlist / `NODE_ENV !== production` / `ALLOW_LOAD_TEST_SEED=true`）を維持。
  - dbname パターン不一致時はデフォルト拒否、`ALLOW_NON_TEST_DBNAME=true` の明示 opt-in のみ許可。
  - `.load-test-auth.json` の `chmod 600` と `.gitignore` 管理で認証情報露出リスクを低減。
- CodeQL 対応
  - `computeAuthHash()` で `Uint8Array.from(authKey)` を介して false positive を解消。
  - 実装コメントがあり、意図が明確。

## 3. テスト面

### 評価
- 妥当（ユニット/静的チェックは十分、負荷実測は別途必要）

### 実行確認
- `npm run lint` : pass
- `npx vitest run src/app/api/passwords/generate/route.test.ts src/app/api/health/ready/route.test.ts` : pass（13 tests）
- `node --check`（seed/auth/health/generate シナリオ）: pass

### 残ギャップ
- k6 実測（`k6 run ...`）の再現確認は環境依存のため未実施。
  - 性能値（p95/p99/error rate）は実環境での定期再測定を推奨。

## 4. 前回評価との差分

- **結論: 前回評価と同じ**
- 前回同様、重大な機能/セキュリティ/テスト欠落は見当たらない。
- 変更は主に整合性向上（シナリオ設定・ガード・解析対応）で、悪化は確認されない。
