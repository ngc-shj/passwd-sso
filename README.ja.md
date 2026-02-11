# passwd-sso

[English](README.md)

SSO 認証とエンドツーエンド暗号化を備えたセルフホスト型パスワードマネージャーです。

## 機能

- **SSO 認証** - Google OIDC + SAML 2.0（[BoxyHQ SAML Jackson](https://github.com/boxyhq/jackson) 経由）
- **エンドツーエンド暗号化** - AES-256-GCM; サーバーは平文パスワードを一切見ません
- **マスターパスフレーズ** - PBKDF2（600k iterations）+ HKDF 鍵導出、Secret Key 付き
- **複数エントリタイプ** - パスワード、セキュアノート、クレジットカード、ID/個人情報、パスキー記録
- **パスワード生成** - ランダムパスワード（8-128 文字）、diceware パスフレーズ（3-10 単語）
- **TOTP 認証** - 2FA コードの保存と生成（otpauth:// URI 対応）
- **セキュリティ監査（Watchtower）** - 漏洩（HIBP）、弱い、再利用、古い、HTTP URL の検出とスコア表示
- **インポート / エクスポート** - Bitwarden、1Password、Chrome CSV インポート; CSV・JSON エクスポート
- **パスワード保護エクスポート** - AES-256-GCM + PBKDF2（600k）で暗号化
- **ファイル添付** - 暗号化ファイル添付（個人: E2E、組織: サーバーサイド）
- **共有リンク** - 期限付きの読み取り専用共有 + アクセスログ
- **監査ログ** - 個人/組織の監査ログ（フィルタ、エクスポートイベント記録）
- **緊急アクセス** - 鍵交換による一時的な Vault アクセスの申請/承認
- **鍵ローテーション** - パスフレーズ検証による暗号化鍵の更新
- **タグ & 整理** - 色付きタグ、お気に入り、アーカイブ、ゴミ箱（30 日自動削除）
- **キーボードショートカット** - `/ or Cmd+K` 検索、`n` 新規、`?` ヘルプ、`Esc` クリア
- **多言語対応** - 日本語・英語（next-intl）
- **ダークモード** - ライト / ダーク / システム（next-themes）
- **組織 Vault** - チームでのパスワード共有（サーバーサイド AES-256-GCM 暗号化、RBAC: Owner/Admin/Member/Viewer）
- **レート制限** - Redis による Vault アンロック試行制限
- **CSP & セキュリティヘッダー** - nonce ベースの Content Security Policy、CSP 違反レポート
- **セルフホスト** - Docker Compose（PostgreSQL + SAML Jackson + Redis）

## 技術スタック

| レイヤー | 技術 |
|---|---|
| フレームワーク | Next.js 16（App Router, Turbopack） |
| 言語 | TypeScript 5.9 |
| データベース | PostgreSQL 16 |
| ORM | Prisma 7（driver adapter + pg） |
| 認証 | Auth.js v5（データベースセッション） |
| SAML ブリッジ | BoxyHQ SAML Jackson（Docker） |
| UI | Tailwind CSS 4 + shadcn/ui + Radix UI |
| 暗号化 | Web Crypto API（クライアントサイド）+ AES-256-GCM（サーバーサイド: 組織 Vault） |
| キャッシュ / レート制限 | Redis 7 |

## アーキテクチャ

```
ブラウザ (Web Crypto API)
  │  ← 個人 Vault: AES-256-GCM E2E 暗号化/復号
  ▼
Next.js アプリ (SSR / API Routes)
  │  ← Auth.js セッション、ルート保護、RBAC
  │  ← 組織 Vault: サーバーサイド AES-256-GCM 暗号化/復号
  ▼
PostgreSQL ← Prisma 7          Redis ← レート制限
  │
  ▼
SAML Jackson (Docker) ← SAML 2.0 IdP (HENNGE, Okta, Azure AD 等)
```

**個人 Vault** — すべてのパスワードデータは**クライアントサイドで暗号化**されてからサーバーに送信されます。サーバーは暗号文のみを保存し、復号はユーザーのマスターパスフレーズから導出された鍵を使ってブラウザ内でのみ行われます。

**組織 Vault** — 共有パスワードは**サーバーサイドで暗号化**されます（組織ごとの鍵を `ORG_MASTER_KEY` でラップ）。個別の鍵交換なしにチームメンバー間で即座にパスワードを共有できます。

## セットアップ

### 前提条件

- Node.js 20 以上
- Docker & Docker Compose
- Google Cloud プロジェクト（OIDC 用）および/または SAML IdP

### 1. クローンとインストール

```bash
git clone https://github.com/ngc-shj/passwd-sso.git
cd passwd-sso
npm install
```

### 2. 環境変数の設定

```bash
cp .env.example .env.local
```

`.env.local` を編集して以下を設定:

| 変数 | 説明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 接続文字列 |
| `AUTH_SECRET` | `openssl rand -base64 32` で生成 |
| `AUTH_GOOGLE_ID` | Google OAuth クライアント ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth クライアントシークレット |
| `GOOGLE_WORKSPACE_DOMAIN` | （任意）Google Workspace ドメインに制限 |
| `JACKSON_URL` | SAML Jackson URL（デフォルト: `http://localhost:5225`） |
| `AUTH_JACKSON_ID` | Jackson OIDC クライアント ID |
| `AUTH_JACKSON_SECRET` | Jackson OIDC クライアントシークレット |
| `SAML_PROVIDER_NAME` | サインインページの表示名（例: "HENNGE"） |
| `ORG_MASTER_KEY` | 組織 Vault マスターキー — `openssl rand -hex 32` |
| `REDIS_URL` | レート制限用 Redis URL（本番必須） |

> **Redis は本番必須です。** 開発/テスト環境では `REDIS_URL` 未設定時に in-memory フォールバックを利用できます。

### 3. サービスの起動

**開発環境**（PostgreSQL + SAML Jackson + Next.js 開発サーバー）:

```bash
# 全サービスを起動（Redis でレート制限あり）
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d db jackson redis

# Redis なしで起動（単一インスタンス / 最小構成）
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d db jackson

# データベースマイグレーション
npm run db:migrate

# 開発サーバーを起動
npm run dev
```

[http://localhost:3000](http://localhost:3000) を開きます。

**本番環境**（Docker Compose 一括起動）:

```bash
docker compose up -d
```

### 4. 初回セットアップ

1. Google または SAML SSO でサインイン
2. マスターパスフレーズを設定（暗号化鍵の導出に使用）
3. パスワードの登録を開始

## スクリプト

| コマンド | 説明 |
|---|---|
| `npm run dev` | 開発サーバー（Turbopack） |
| `npm run build` | プロダクションビルド |
| `npm run start` | プロダクションサーバー起動 |
| `npm run lint` | ESLint |
| `npm test` | テスト実行（Vitest） |
| `npm run test:watch` | テスト（ウォッチモード） |
| `npm run test:coverage` | テスト（カバレッジ付き） |
| `npm run db:migrate` | Prisma マイグレーション（dev） |
| `npm run db:push` | マイグレーションなしでスキーマ反映 |
| `npm run db:seed` | シードデータ投入 |
| `npm run db:studio` | Prisma Studio GUI |
| `npm run generate:key` | 256 ビット hex キー生成 |

## プロジェクト構成

```
src/
├── app/[locale]/
│   ├── page.tsx              # ランディング / サインイン
│   ├── dashboard/            # 個人 Vault、組織 Vault、Watchtower 等
│   └── auth/                 # 認証ページ
├── app/api/
│   ├── auth/                 # Auth.js ハンドラー
│   ├── passwords/            # パスワード CRUD + 生成
│   ├── tags/                 # タグ CRUD
│   ├── vault/                # セットアップ、アンロック、ステータス、鍵ローテーション
│   ├── orgs/                 # 組織管理
│   ├── share-links/          # 共有リンク CRUD + アクセス
│   ├── audit-logs/           # 監査ログクエリ
│   ├── emergency-access/     # 緊急アクセスワークフロー
│   ├── watchtower/           # セキュリティ監査（HIBP、分析）
│   └── csp-report/           # CSP 違反レポート
├── components/
│   ├── layout/               # Header, Sidebar, SearchBar
│   ├── passwords/            # PasswordList, PasswordForm, Generator、エントリタイプフォーム
│   ├── org/                  # 組織 Vault UI（一覧、フォーム、設定、招待）
│   ├── emergency-access/     # 緊急アクセス UI
│   ├── share/                # 共有リンク UI
│   ├── watchtower/           # セキュリティ監査ダッシュボード
│   ├── vault/                # Vault ロック/アンロック UI
│   ├── tags/                 # TagInput, TagBadge
│   ├── providers/            # クライアントプロバイダー（テーマ、セッション等）
│   ├── auth/                 # SignOutButton
│   └── ui/                   # shadcn/ui コンポーネント
├── lib/
│   ├── crypto-client.ts      # クライアントサイド E2E 暗号化（個人 Vault）
│   ├── crypto-server.ts      # サーバーサイド暗号化（組織 Vault）
│   ├── crypto-aad.ts         # 暗号化の追加認証データ（AAD）
│   ├── crypto-emergency.ts   # 緊急アクセス鍵交換
│   ├── export-crypto.ts      # パスワード保護エクスポート暗号化
│   ├── org-auth.ts           # 組織 RBAC 認可ヘルパー
│   ├── audit.ts              # 監査ログヘルパー
│   ├── vault-context.tsx     # Vault ロック/アンロック状態
│   ├── password-generator.ts # サーバーサイド安全生成
│   ├── password-analyzer.ts  # パスワード強度分析
│   ├── credit-card.ts        # クレジットカード検証 & フォーマット
│   ├── rate-limit.ts         # レート制限ロジック
│   ├── api-error-codes.ts    # API エラーコード一元管理 & i18n マッピング
│   ├── prisma.ts             # Prisma シングルトン
│   ├── redis.ts              # Redis クライアント（レート制限）
│   └── validations.ts        # Zod スキーマ
└── i18n/                     # next-intl ルーティング
```

## セキュリティモデル

- **ゼロナレッジ** - サーバーは AES-256-GCM の暗号文のみを保存; ユーザーデータを復号できません
- **鍵導出** - パスフレーズ → PBKDF2（600k）→ ラッピング鍵 → ランダム 256 ビット秘密鍵をラップ
- **ドメイン分離** - 秘密鍵 → HKDF → 暗号化鍵 + 認証鍵に分離
- **Secret Key** - アカウント固有の追加ソルトでサーバー侵害に対する防御を強化
- **AAD バインディング** - 追加認証データで暗号文をユーザー・エントリ ID に紐付け
- **鍵ローテーション** - 全パスワード再入力なしで暗号化鍵を更新可能
- **セッションセキュリティ** - データベースセッション（JWT ではない）、8 時間タイムアウト + 1 時間延長
- **自動ロック** - 15 分無操作または 5 分タブ非表示で Vault をロック
- **クリップボードクリア** - コピーしたパスワードは 30 秒後に自動消去
- **組織 Vault** - サーバーサイド AES-256-GCM（組織ごとの鍵を `ORG_MASTER_KEY` でラップ）
- **RBAC** - Owner / Admin / Member / Viewer のロールベースアクセス制御
- **レート制限** - Redis による Vault アンロック試行制限（15 分間に 5 回まで）
- **CSP** - nonce ベースの Content Security Policy と違反レポート

## デプロイガイド

- [Docker Compose セットアップ（日本語）](docs/setup.docker.ja.md) / [English](docs/setup.docker.en.md)
- [AWS デプロイ（日本語）](docs/setup.aws.ja.md) / [English](docs/setup.aws.en.md)
- [Terraform (AWS)（日本語）](infra/terraform/README.ja.md) / [English](infra/terraform/README.md)

## ライセンス

MIT
