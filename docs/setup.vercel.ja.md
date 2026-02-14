# passwd-sso Vercel セットアップ

このガイドは `passwd-sso` を [Vercel](https://vercel.com/) へデプロイするための最小構成です。  
前提として、DB/Redis は外部マネージドサービスを使います（Vercel 上に状態を持たせない）。

## 1. 前提

- Vercel アカウント
- GitHub リポジトリ連携済み
- PostgreSQL（必須）
- Redis（本番推奨）

例:
- PostgreSQL: Neon / Supabase / RDS / Cloud SQL
- Redis: Upstash Redis / ElastiCache / Memorystore

## 2. Vercel プロジェクト作成

1. Vercel ダッシュボードで **Add New... → Project**
2. `passwd-sso` リポジトリを選択
3. Framework Preset は **Next.js**
4. Root Directory はリポジトリルート（通常そのまま）

## 3. Environment Variables

Vercel Project Settings → Environment Variables で設定:

- `DATABASE_URL`（PostgreSQL 接続文字列）
- `AUTH_URL`（本番URL。例: `https://your-app.vercel.app`）
- `AUTH_SECRET`（`openssl rand -base64 32` で生成）
- `ORG_MASTER_KEY`（`openssl rand -hex 32` で生成）
- `REDIS_URL`（本番推奨）
- `BLOB_BACKEND`（`db` / `s3` / `azure` / `gcs`）
- SSO 用:
  - `AUTH_GOOGLE_ID`
  - `AUTH_GOOGLE_SECRET`
  - `GOOGLE_WORKSPACE_DOMAIN`（任意）
  - `JACKSON_URL`
  - `AUTH_JACKSON_ID`
  - `AUTH_JACKSON_SECRET`
  - `SAML_PROVIDER_NAME`

添付をクラウドへ出す場合は `.env.example` にある対応変数も追加してください。

## 4. DB マイグレーション（重要）

Vercel のデプロイ時に自動で `prisma migrate deploy` は実行されません。  
本番反映前に別途実行してください。

例（ローカルから本番 DB へ）:

```bash
DATABASE_URL='postgresql://...' npx prisma migrate deploy
```

推奨: GitHub Actions などで「デプロイ前に migrate deploy」を固定化する。

## 5. デプロイ後の確認

1. `/auth/signin` が表示される
2. サインインできる
3. Vault 作成・アンロックできる
4. エントリ作成/閲覧できる
5. 添付を有効化している場合は upload/download/delete が通る

## 6. セキュリティ運用メモ

- `AUTH_SECRET` / `ORG_MASTER_KEY` は定期ローテーション方針を定義
- DB/Redis/Blob は TLS 接続を強制
- Preview/Production で環境変数を分離
- 本番は `REDIS_URL` を必須運用（レート制限を有効化）
