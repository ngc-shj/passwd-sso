# passwd-sso セットアップガイド

## 概要

社内向けパスワード管理Webアプリケーション。
SAML 2.0 IdP (HENNGE, Okta, Azure AD 等) および Google (OIDC) による SSO 認証で利用者を制限し、パスワード情報は **クライアント側** で AES-256-GCM により暗号化され、暗号文のみ PostgreSQL に保存される（E2E）。
Google は Workspace アカウントに加え、個人アカウントにも対応 (`GOOGLE_WORKSPACE_DOMAIN` を空にするとドメイン制限なし)。
SAML 2.0 IdP は SAML Jackson (SAML → OIDC ブリッジ) を経由するため、SAML 2.0 に対応した任意の IdP を利用可能。

## 技術スタック

| 項目 | 技術 |
|------|------|
| フレームワーク | Next.js 16 (App Router) + TypeScript |
| 認証 | Auth.js v5 — Google OIDC / SAML 2.0 (SAML Jackson 経由) |
| DB | PostgreSQL 16 + Prisma 7 |
| 暗号化 | AES-256-GCM (Web Crypto API / クライアント側) |
| UI | Tailwind CSS v4 + shadcn/ui + Lucide Icons |
| デプロイ | Docker Compose (app / db / jackson の 3 コンテナ) |

## アーキテクチャ

```
┌──────────┐    ┌──────────────┐    ┌───────────────┐    ┌────────────┐
│ ブラウザ  │───▶│  Next.js App │───▶│  Auth.js v5   │───▶│ PostgreSQL │
│          │◀──│  (port 3000) │◀──│               │    │ (port 5432)│
└──────────┘    └──────┬───────┘    └───┬───────┬──┘    └────────────┘
                       │                │       │
                       │          ┌─────┘       └─────┐
                       │          ▼                   ▼
                       │   ┌────────────┐    ┌──────────────┐
                       │   │  Google    │    │ SAML Jackson │
                       │   │  OIDC     │    │ (port 5225)  │
                       │   └────────────┘    └──────┬───────┘
                       │                            │
                       │                     ┌──────┴───────┐
                       │                     │  SAML 2.0    │
                       │                     │  IdP         │
                       │                     └──────────────┘
                       │
                       ▼
              ┌──────────────────────────┐
              │  AES-256-GCM (client)    │
              │  暗号化/復号 (E2E)       │
              └──────────────────────────┘
```

### SAML Jackson について

Auth.js は SAML を直接サポートしないため、[BoxyHQ SAML Jackson](https://github.com/boxyhq/jackson) を Docker コンテナとして起動し、SAML → OIDC ブリッジとして利用する。
Auth.js からは通常の OIDC プロバイダとして接続するため、アプリ側に SAML の実装は不要。

SAML 2.0 に対応した任意の IdP (HENNGE, Okta, Azure AD, OneLogin, Google Workspace SAML 等) を利用可能。

npm パッケージ版 (`@boxyhq/saml-jackson`) は依存が重く脆弱性があるため、Docker イメージ (`boxyhq/jackson:latest`) を採用した。

## 前提条件

- Node.js 20 以上
- Docker / Docker Compose
- Google Cloud Console へのアクセス (OIDC 設定用)
- SAML 2.0 IdP の管理画面へのアクセス (SAML 設定用)

## 環境構築手順

### 1. リポジトリクローンと依存インストール

```bash
git clone <repository-url>
cd passwd-sso
npm install
```

### 2. 環境変数の設定

```bash
cp .env.example .env.local
```

`.env.local` を編集し、以下の値を設定する。

| 変数 | 説明 | 生成方法 |
|------|------|----------|
| `DATABASE_URL` | PostgreSQL 接続文字列 | デフォルトのままでOK (開発時) |
| `AUTH_URL` | アプリの公開URL | 開発時は `http://localhost:3000` |
| `AUTH_SECRET` | NextAuth セッション署名キー | `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` | Google OAuth Client ID | Google Cloud Console で取得 |
| `AUTH_GOOGLE_SECRET` | Google OAuth Client Secret | Google Cloud Console で取得 |
| `GOOGLE_WORKSPACE_DOMAIN` | 許可するドメイン | 例: `example.com` |
| `JACKSON_URL` | SAML Jackson の URL | 開発時は `http://localhost:5225` |
| `AUTH_JACKSON_ID` | Jackson OIDC Client ID | Jackson 管理画面で取得 |
| `AUTH_JACKSON_SECRET` | Jackson OIDC Client Secret | Jackson 管理画面で取得 |
| `SAML_PROVIDER_NAME` | SAML IdP のログイン画面表示名 | 例: `HENNGE`, `Okta`, `Azure AD` |
| `ORG_MASTER_KEY` | 組織用暗号化のマスターキー (256bit, hex) | `openssl rand -hex 32` |

### 3. PostgreSQL の起動

```bash
docker compose up db -d
```

開発時は `docker-compose.override.yml` によりポート 5432 がホストに公開される。

ヘルスチェック確認:

```bash
docker compose ps
# STATUS が "healthy" であること
```

### 4. データベースマイグレーション

```bash
npx prisma migrate dev --name init
```

### 5. シードデータ投入

```bash
npx tsx prisma/seed.ts
```

以下のデフォルトカテゴリが作成される: Web, Email, Server, Database, API, Other

### 6. 開発サーバー起動

```bash
npm run dev
```

`http://localhost:3000` でアクセス可能。
未認証の場合は `/auth/signin` にリダイレクトされる。

## IdP の設定

### Google OIDC

#### 1. Google Cloud プロジェクト作成

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. 上部のプロジェクト選択メニューから「新しいプロジェクト」を作成
   - プロジェクト名: `passwd-sso` (任意)
3. 作成したプロジェクトが選択されていることを確認

#### 2. OAuth 同意画面の設定

1. 左メニュー **Google Auth Platform** > **ブランディング** > 「ブランディングの作成」
2. **Step 1 - アプリ情報**:
   - アプリ名: `passwd-sso`
   - ユーザー サポートメール: 自分のメールアドレス
3. **Step 2 - 対象**:
   - 個人アカウントでテストする場合: **外部 (External)** を選択
   - Google Workspace 組織内のみ: **内部 (Internal)** を選択
4. **Step 3 - 連絡先情報**: メールアドレスを入力
5. **Step 4 - 終了**: Google API サービスのポリシーに同意して「作成」

> **注意**: 「外部」を選択した場合、テストモードではテストユーザーに追加したアカウントのみがログイン可能。左メニュー「対象」からテストユーザーを追加すること。

#### 3. OAuth クライアント ID の作成

1. 左メニュー **クライアント** > 「+ クライアントを作成」
2. アプリケーションの種類: **ウェブ アプリケーション**
3. 名前: `passwd-sso-dev` (任意)
4. **承認済みのリダイレクト URI** に追加:
   - 開発: `http://localhost:3000/api/auth/callback/google`
   - 本番: `https://<your-domain>/api/auth/callback/google`
5. 「作成」をクリック
6. 表示される **クライアント ID** と **クライアント シークレット** を `.env.local` に設定:

   ```bash
   AUTH_GOOGLE_ID=<クライアント ID>
   AUTH_GOOGLE_SECRET=<クライアント シークレット>
   ```

### SAML 2.0 IdP (SAML Jackson 経由)

SAML 2.0 に対応した任意の IdP (HENNGE, Okta, Azure AD, OneLogin 等) を利用可能。

1. SAML Jackson を起動:
   ```bash
   docker compose up jackson -d
   ```

2. Jackson の管理画面 (`http://localhost:5225`) で SAML 接続を設定:
   - IdP の SAML メタデータ XML を登録
   - テナント / プロダクト を設定

3. IdP の管理画面で:
   - ACS URL: `http://localhost:5225/api/oauth/saml`
   - Entity ID: Jackson が提供する値を設定

4. Jackson から発行される OIDC Client ID / Secret を `.env.local` に設定

5. `.env.local` の `SAML_PROVIDER_NAME` にログイン画面に表示する IdP 名を設定 (例: `HENNGE`, `Okta`)

## 本番デプロイ

### Docker Compose で全サービス起動

```bash
docker compose up -d
```

3 コンテナが起動する:
- `app` — Next.js アプリ (port 3000)
- `db` — PostgreSQL (内部ネットワークのみ)
- `jackson` — SAML Jackson (内部ネットワークのみ)

本番では `docker-compose.override.yml` を配置しないこと (DB/Jackson のポートを外部に公開しない)。

### 手動ビルド

```bash
npm run build
npm start
```

## セキュリティ設計

### 暗号化

- **方式**: AES-256-GCM (クライアント側)
- **鍵管理**: ブラウザで生成した vault secret key をパスフレーズ由来キーでラップして保存（サーバ側マスターキーは不要）
- **IV**: レコードごとにランダム生成 (96bit)。同一パスワードでも暗号文は毎回異なる
- **AuthTag**: GCM 認証タグ (128bit)。改ざん検知に使用
- **対象フィールド**: `encryptedBlob`, `encryptedOverview`（それぞれ個別の IV/AuthTag を持つ）
- **組織用暗号化**: サーバ側で `ORG_MASTER_KEY` を使って組織ごとの鍵をラップする。運用時はシークレットマネージャで管理する。

### API セキュリティ

- 全パスワード API は認証必須 (middleware で保護)
- 一覧 API は暗号化された概要のみ返却（クライアントで復号）
- 詳細表示はクライアント側で復号（メモリ上の vault key を使用）
- 所有者チェック: 他ユーザーのパスワードへのアクセスは 403 Forbidden
- `/api/vault/unlock` はレート制限（ユーザー+IPで5回/5分）

### クライアント側

- クリップボードコピー後 30 秒で自動クリア
- パスワード表示後 30 秒で自動非表示
- 削除前に確認ダイアログ表示

### HTTP ヘッダー

`next.config.ts` で以下を設定:
- `Strict-Transport-Security` (HTTPS 強制)
- `X-Frame-Options: DENY` (クリックジャッキング防止)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`

middleware で以下を設定:
- `Content-Security-Policy` (リクエスト毎の nonce)
- `/api/csp-report` への CSP レポート送信
- `CSP_MODE` で `dev` (style-src に `unsafe-inline`) / `strict` (nonceのみ) を切り替え

### セッション

- DB ベースのセッション管理 (JWT ではない)
- セッション有効期限: 8 時間
- アクティビティによる延長: 最終アクセスから 1 時間以内

## npm scripts

| コマンド | 説明 |
|---------|------|
| `npm run dev` | 開発サーバー起動 (Turbopack) |
| `npm run build` | プロダクションビルド |
| `npm start` | プロダクションサーバー起動 |
| `npm run lint` | ESLint 実行 |
| `npm run db:migrate` | Prisma マイグレーション |
| `npm run db:seed` | シードデータ投入 |
| `npm run db:studio` | Prisma Studio (DB GUI) |
| `npm run generate:key` | ランダム 256bit キー生成 |

## Prisma 7 に関する注意

Prisma 7 では以下の変更がある:

- `schema.prisma` の datasource から `url` が削除された。DB URL は `prisma.config.ts` で管理
- デフォルトエンジンが `client` に変更。`@prisma/adapter-pg` + `pg` パッケージが必須
- `dotenv` は `.env.local` を自動読み込みしないため、`prisma.config.ts` で明示的に `config({ path: ".env.local" })` を指定

## ディレクトリ構成

```
passwd-sso/
├── docker-compose.yml          # 本番用 (ポート非公開)
├── docker-compose.override.yml # 開発用 (ポート公開)
├── Dockerfile                  # マルチステージビルド
├── .env.example                # 環境変数テンプレート
├── prisma.config.ts            # Prisma 7 設定
├── prisma/
│   ├── schema.prisma           # DB スキーマ
│   ├── migrations/             # マイグレーション
│   └── seed.ts                 # シードデータ
├── src/
│   ├── auth.ts                 # Auth.js 設定 (Prisma Adapter)
│   ├── auth.config.ts          # Auth.js 設定 (Edge 用)
│   ├── middleware.ts           # ルート保護
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/  # 認証エンドポイント
│   │   │   ├── categories/          # カテゴリ一覧 API
│   │   │   └── passwords/           # パスワード CRUD API
│   │   ├── auth/{signin,error}/     # 認証 UI
│   │   └── dashboard/              # メイン UI
│   ├── components/
│   │   ├── auth/               # 認証コンポーネント
│   │   ├── layout/             # ヘッダー・サイドバー
│   │   ├── passwords/          # パスワード管理 UI
│   │   └── ui/                 # shadcn/ui
│   └── lib/
│       ├── crypto.ts           # AES-256-GCM 暗号化
│       ├── password-generator.ts
│       ├── prisma.ts           # Prisma クライアント
│       └── validations.ts      # Zod スキーマ
└── docs/
    ├── setup.ja.md             # 本ドキュメント (日本語)
    └── setup.en.md             # 本ドキュメント (English)
```
