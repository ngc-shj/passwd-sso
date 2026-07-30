# passwd-sso

[English](README.md)

SSO 認証とエンドツーエンド暗号化を備えたセルフホスト型パスワードマネージャーです。

## スクリーンショット

![passwd-sso ダッシュボード](docs/assets/passwd-sso-dashboard.png)

<details>
<summary>その他のスクリーンショット</summary>

### エントリー詳細（カスタムフィールド自動補完例）

![passwd-sso エントリー詳細](docs/assets/passwd-sso-entry-detail.png)

### パスワードジェネレーター

![passwd-sso パスワードジェネレーター](docs/assets/passwd-sso-password-generator.png)

### ブラウザ拡張（カスタムフィールド自動補完）

![passwd-sso 拡張 aws 補完 1](docs/assets/passwd-sso-extension-aws-fill-1.png)
![passwd-sso 拡張 aws 補完 2](docs/assets/passwd-sso-extension-aws-fill-2.png)

</details>

## 機能

### Vault & エントリ

- **エンドツーエンド暗号化** — AES-256-GCM; サーバーは平文パスワードを一切見ません
- **複数エントリタイプ** — パスワード、セキュアノート、クレジットカード、ID/個人情報、パスキー、銀行口座、ソフトウェアライセンス、SSH 鍵
- **カスタムフィールド** — テキスト、非表示、URL、ブール値、日付、年月
- **パスワード生成** — ランダム（8-128 文字）、diceware パスフレーズ（3-10 単語）
- **TOTP 認証** — 2FA コードの保存/生成、カメラ QR キャプチャ対応
- **ファイル添付** — 暗号化ファイル添付（個人/チームとも E2E）
- **フォルダ & タグ** — ネスト対応の色付きタグ、階層フォルダ、お気に入り、アーカイブ、ゴミ箱（30 日自動削除）
- **変更履歴** — エントリのバージョン履歴、比較、復元
- **一括操作** — 複数エントリの一括アーカイブ、ゴミ箱移動、復元
- **インポート / エクスポート** — Bitwarden、1Password、KeePassXC、Chrome CSV インポート; CSV/JSON エクスポート（AES-256-GCM 暗号化オプション付き）

### 認証

- **SSO** — Google OIDC + SAML 2.0（[BoxyHQ SAML Jackson](https://github.com/boxyhq/jackson) 経由）
- **パスキーサインイン** — Discoverable FIDO2（WebAuthn）; PRF 対応キーは Vault を自動アンロック
- **メール + セキュリティキー** — メールアドレス検索による Non-discoverable クレデンシャル（タイミングオラクル対策付き）
- **マジックリンク** — ロケール対応テンプレートによるメールベースのパスワードレス認証
- **マスターパスフレーズ** — PBKDF2（600k）または Argon2id（64 MB）+ HKDF、Secret Key 付き

### セキュリティ & コンプライアンス

- **セキュリティ監査（Watchtower）** — 漏洩（HIBP）、弱い、再利用、古い、HTTP URL の検出; ダークウェブ常時監視とメールアラート
- **アカウントロックアウト** — 段階的ロックアウト（5 回→15 分、10 回→1 時間、15 回→24 時間）、閾値到達時にテナント管理者へメール & アプリ内通知
- **同時セッション制限** — テナント単位のセッション上限、超過時に最古セッションを自動切断
- **レート制限** — Redis による機密エンドポイントの制限; 本番向け Sentinel HA 対応
- **CSP & セキュリティヘッダー** — nonce ベースの CSP、違反レポート、OWASP ヘッダー
- **回復キー** — 256 ビット鍵（HKDF + AES-256-GCM）、Base32 エンコード; パスフレーズなしで Vault を復旧
- **Vault リセット** — 最終手段としての全削除（明示的な確認付き）
- **鍵ローテーション** — パスフレーズ検証による暗号化鍵の更新
- **トラベルモード** — 国境通過時に機密エントリを非表示; リモート無効化でアクセス復元
- **ネットワークアクセス制限** — テナント単位の CIDR 許可リストと Tailscale 連携
- **監査ログ & Webhook** — 個人/チーム/テナントログ、フィルタ、CSV/JSONL ダウンロード、Webhook 配信
- **監査ログ転送** — Fluent Bit サイドカー経由の構造化 JSON 出力（外部収集向け）
- **Break Glass** — テナント管理者による個人監査ログへの緊急アクセス（期限付き許可）
- **エラー追跡** — Sentry 統合（再帰的な機密データ除去付き）
- **CI セキュリティ** — CodeQL SAST、Trivy コンテナスキャン、暗号ドメイン台帳、npm audit
- **再現可能ビルド** — Docker ベースイメージの digest ピンニング、ビルドメタデータ検証

### チーム & 組織

- **チーム Vault** — E2E 暗号化共有（ECDH-P256）、RBAC（Owner/Admin/Member/Viewer）
- **チームセキュリティポリシー** — 共有/エクスポート制御、再認証必須化、パスワードポリシー指針
- **マルチテナント分離** — PostgreSQL FORCE RLS（50+ テーブル）、IdP クレームによるテナント解決
- **SCIM 2.0 プロビジョニング** — テナントスコープのユーザー/グループ同期（RFC 7644）
- **ディレクトリ同期** — Azure AD、Google Workspace、Okta からメンバー同期
- **テナント管理** — メンバー管理、SCIM トークン、管理者 Vault リセット、テナント設定
- **共有リンク** — 期限付き共有、アクセスログ、表示権限制御
- **Send** — テキスト/ファイルの一時共有（自動有効期限付き）
- **緊急アクセス** — 鍵交換による一時的な Vault アクセスの申請/承認
- **セッション管理** — アクティブセッション一覧、個別/全体失効、メンバー削除時の自動無効化
- **通知機能** — 緊急アクセスと新規デバイスログインに対するアプリ内/メール通知

### 開発者ツール

- **CLI** — [`passwd-sso-cli`](https://www.npmjs.com/package/passwd-sso-cli)（`npm install -g passwd-sso-cli`）; OAuth 2.1 PKCE ログイン、XDG 準拠の設定管理
- **SSH Agent** — `passwd-sso agent` で Vault の SSH 鍵を SSH エージェントプロトコル経由で提供
- **CI/CD シークレット** — `env` / `run` コマンドで Vault のシークレットを環境変数/サブプロセスに注入。CI パイプラインでの非対話的な自動ロック解除には `PSSO_PASSPHRASE` を設定。**セキュリティ注記**: `PSSO_PASSPHRASE` は CI/自動化専用です — パスフレーズはプロセス環境から読み取り可能です（例: Linux の /proc 経由）。共有環境や対話環境では使用せず、`passwd-sso unlock`（TTY プロンプト）を使用してください。
- `env` / `run` は `.passwd-sso-env.json` を読み込み、接続先サーバーは `passwd-sso login` で保存済みの CLI `serverUrl` を使います。このファイルの `secrets` は「出力する環境変数名 → vault entry / field」の対応表です。例: `"DATABASE_PASSWORD": { "entry": "<entry-id>", "field": "password" }` は、その vault entry の `password` フィールドを取得して `DATABASE_PASSWORD` として公開する、という意味です。キー名は単なる出力先の環境変数名で、CLI は取得した field 値をそのまま注入します — 接続文字列の組み立てや値の変換は行いません。**`apiKey` を含む `.passwd-sso-env.json` はコミットしないでください** — 長期有効な認証情報です。`.gitignore` に追加し、CI のシークレットストアから実行時に注入してください。
- **ブラウザ拡張** — Chrome/Edge MV3; 自動補完、インライン候補、カスタムフィールド自動補完、マルチ URL マッチング、クレカ/住所、新規ログイン検出 & 保存、ポップアップからの Vault 全体検索、**パスキープロバイダー**（WebAuthn get/create をインターセプトし、プラットフォーム認証器より先に Vault のパスキーを提示）
- **iOS アプリ + AutoFill 拡張** — ネイティブ iPhone アプリ（iOS 17+）と認証情報プロバイダー拡張; Safari および Associated Domains 対応アプリで Password + TOTP の自動補完、QuickType インライン候補、**パスキー（WebAuthn）アサーション**に対応。Face ID による Vault 解錠、アプリ内エントリ作成・編集、拡張同等の設定（自動ロック、クリップボード消去、テーマ）、日英ローカライズ。ソース: [`ios/`](./ios/)。必須の `apple-app-site-association`（AASA）ファイルはサーバーが生成します — `IOS_APP_TEAM_ID` / `IOS_APP_BUNDLE_ID` を設定し、リバースプロキシで `https://<server>/.well-known/apple-app-site-association` を `/api/mobile/.well-known/apple-app-site-association` に転送してください; 詳細は [`ios/README.md`](./ios/README.md) を参照
- **REST API v1** — `/api/v1/*`（OpenAPI 3.1 仕様付き）
- **API キー** — スコープ付きキー（SHA-256 ハッシュ、有効期限設定可能）

### AI & オートメーション（Machine Identity）

- **サービスアカウント** — スコープ付き `sa_` トークンによる非人間 ID 管理、テナント管理者 CRUD
- **MCP Gateway** — [Model Context Protocol](https://modelcontextprotocol.io/) サーバーとして AI エージェント（Claude Desktop、Cursor）にクレデンシャルアクセスを提供
- **OAuth 2.1 + PKCE** — MCP クライアント認証のための Authorization Code フロー
- **Just-in-Time アクセス** — SA 自己申請によるスコープ拡張リクエスト + 管理者承認ワークフロー
- **クロスアクター監査** — 全アクションを `actorType`（ユーザー / サービスアカウント / MCP エージェント）で横断的に追跡
- **委任復号** — ブラウザでアンロックした後、エントリ単位で MCP セッションへ委任（per-entry consent + 短い TTL）
- **ゼロ知識モデル維持** — サーバーは平文を一切見ない; MCP エージェントは委任されたエントリのみをエンベロープ暗号化 Redis キャッシュ経由でアクセス

### UI & ローカライゼーション

- **多言語対応** — 日本語・英語（next-intl）
- **ダークモード** — ライト / ダーク / システム（next-themes）
- **キーボードショートカット** — `/ or Cmd+K` 検索、`n` 新規、`?` ヘルプ、`Esc` クリア
- **ロケール保存** — DB に保存し、メール/通知に反映

## 技術スタック

| レイヤー | 技術 |
| --- | --- |
| フレームワーク | Next.js 16（App Router, Turbopack） |
| 言語 | TypeScript 5.9 |
| データベース | PostgreSQL 16 |
| ORM | Prisma 7（driver adapter + pg） |
| 認証 | Auth.js v5（データベースセッション） |
| SAML ブリッジ | BoxyHQ SAML Jackson（Docker） |
| UI | Tailwind CSS 4 + shadcn/ui + Radix UI |
| 暗号化 | Web Crypto API（Vault E2E）+ AES-256-GCM（サーバーサイド） |
| キャッシュ / レート制限 | Redis 7 |

## アーキテクチャ

```text
ブラウザ (Web Crypto API)
  │  ← 個人/チーム Vault: AES-256-GCM E2E 暗号化/復号
  ▼
Next.js アプリ (SSR / API Routes)
  │  ← Auth.js セッション、ルート保護、RBAC
  │  ← 共有リンク / Send: サーバーサイド AES-256-GCM 暗号化
  │  ← MCP Gateway: /api/mcp (Streamable HTTP, OAuth 2.1 PKCE)
  │  ← サービスアカウントトークン: sa_ プレフィックス、JIT アクセスワークフロー
  ▼
PostgreSQL ← Prisma 7          Redis ← レート制限、セッションキャッシュ
  │  ← audit_outbox（コミット後にエンキュー。同一トランザクションは enqueueAuditInTx 経由）
  ▼
Audit Outbox Worker（別プロセス）← audit_outbox を drain → audit_logs
  │
SAML Jackson (Docker) ← SAML 2.0 IdP (HENNGE, Okta, Azure AD 等)
```

**Docker サービス** — 6 コンテナ: `app`（Next.js）、`db`（PostgreSQL 16）、`jackson`（SAML Jackson）、`redis`（Redis 7）、`migrate`（ワンショット Prisma マイグレーション）、`audit-outbox-worker`（監査ドレインワーカー、dev override のみ — 本番環境では別途デプロイ）。

**個人 Vault** — すべてのデータは**クライアントサイドで暗号化**されてからサーバーに送信されます。サーバーは暗号文のみを保存します。

**チーム Vault** — 共有パスワードは**クライアントサイド E2E** で暗号化されます。チーム鍵配布は ECDH-P256 によるメンバー鍵交換で行います。

## セットアップ

### 前提条件

- Node.js 20 以上
- Docker & Docker Compose
- 少なくとも 1 つの認証プロバイダー: Google Cloud プロジェクト（OIDC）、SAML IdP、またはマジックリンク / パスキーのみ（外部 IdP 不要）

### 1. クローンとインストール

```bash
git clone https://github.com/ngc-shj/passwd-sso.git
cd passwd-sso
npm install
```

### 2. 環境変数の設定

対話式ジェネレータが推奨です — 必須項目を順に質問し、暗号鍵は自動生成、Zod スキーマで検証してから書き出します:

```bash
npm run init:env                          # 対話式、デフォルト profile=dev
npm run init:env -- --profile=production  # 本番プロバイダの実値を入力
```

ジェネレータは `.env` を atomic に mode `0o600` で書き出し、上書き時には必ず確認します。生成された秘密値は端末上では `[generated]` のプレースホルダで表示され、ファイルにのみ書き込まれます (`--print-secrets` を付けると表示)。

手動編集が好みなら、テンプレートをコピー:

```bash
cp .env.example .env
```

`.env.example` は `src/lib/env-schema.ts` (Single Source of Truth) から自動生成されます — スキーマ変更後は `npm run generate:env-example` で再生成してください。`npm run check:env-docs` で `.env.example`、allowlist、`docker-compose*.yml` の整合性を検証できます。

**`.env` と `.env.local` の使い分け** — canonical なファイルは `.env` です。Docker Compose (auto-load) と Next.js アプリ (`src/lib/load-env.ts` 経由) のどちらもこれを native に読みます。`.env.local` は `.env` の **後** に読み込まれて値を上書きする (Next.js 慣習) override 用ファイルです。個人ローカルの調整 (DB ポート違い、別の Tailscale ホスト名など) のみ書き、canonical な設定は `.env` に置いてください。`--env-file` フラグは不要です:

```bash
npm run docker:up     # docker compose -f docker-compose.yml -f docker-compose.override.yml up
npm run docker:down
```

> **古いクローンからの移行**: 過去の運用で `.env.local` のみ作成しているリポジトリは、`mv .env.local .env` を実行して Docker Compose が自動読込できる canonical なファイルに移してください。`npm run init:env` は legacy `.env.local` を検出すると 1 度だけ NOTE で同じことを案内します。

`.env.example` の末尾には **External / Build-time** セクションがあり、Next.js アプリは読まないが docker-compose / 本番ビルド / プロビジョニングスクリプトが必要とする変数 (`JACKSON_API_KEY` (Jackson コンテナ用), `PASSWD_SUPERUSER_PASSWORD` / `PASSWD_APP_PASSWORD` / `PASSWD_OUTBOX_WORKER_PASSWORD` / `PASSWD_RETENTION_GC_WORKER_PASSWORD` (DB ロール用), `SENTRY_AUTH_TOKEN` (ソースマップアップロード用), `NEXT_DEV_ALLOWED_ORIGINS` (dev サーバ用)) が並びます。`npm run init:env` は Zod 宣言済み変数と並んで、これらも同一の `.env` に書き出します。

主要な変数:

| 変数 | 説明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 接続文字列 |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth 資格情報 |
| `JACKSON_URL` | SAML Jackson URL（デフォルト: `http://localhost:5225`） |
| `AUTH_JACKSON_ID` / `AUTH_JACKSON_SECRET` | Jackson OIDC 資格情報 |
| `SHARE_MASTER_KEY` | `openssl rand -hex 32` — 共有リンクのサーバー暗号化用 |
| `VERIFIER_PEPPER_KEY` | `openssl rand -hex 32` — パスフレーズ検証 pepper（**本番必須**） |
| `REDIS_URL` | レート制限用 Redis URL（**本番必須**） |

<details>
<summary>全環境変数</summary>

| 変数 | 説明 |
| --- | --- |
| `NEXT_PUBLIC_APP_NAME` | （任意）UI に表示するアプリ名 |
| `NEXT_PUBLIC_BASE_PATH` | （任意）リバースプロキシ配下のサブパス（例: `/passwd-sso`）。ビルド前に設定 |
| `APP_URL` | （推奨）リバースプロキシ / CDN 配下の外部 URL（オリジンのみ）。Cookie 認証 API の CSRF Origin 判定に使われます |
| `DATABASE_URL` | PostgreSQL 接続文字列（アプリロール、例: `passwd_app`） |
| `MIGRATION_DATABASE_URL` | マイグレーション用 PostgreSQL 接続（スーパーユーザーロール、例: `passwd_user`）。`npm run db:migrate` に必要 |
| `AUTH_URL` | アプリケーションのオリジン（例: `http://localhost:3000`）。`APP_URL` 未設定時の canonical Origin として使われます |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `COOKIE_PARTITIONED` | （任意）セッション Cookie に Partitioned（CHIPS）属性を付与するオプトイン設定。値は `true` / `false` のみ。デフォルト: `false`。サードパーティ iframe コンテキスト外では効果なし。Secure Cookie が必須。[アップグレード時の注意](#アップグレード時の注意-fail-closed-になった環境変数) 参照 |
| `AUTH_GOOGLE_ID` | Google OAuth クライアント ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth クライアントシークレット |
| `GOOGLE_WORKSPACE_DOMAINS` | （任意）Google Workspace ドメインに制限（カンマ区切りで複数可） |
| `AUTH_TENANT_CLAIM_KEYS` | （任意）tenant 解決に使う IdP クレームキーをカンマ区切りで指定し、記載順に評価します。**未設定は「設定なし」ではありません** — `tenant_id, tenantId, organization, org, company, company_id` が選択され、いずれも IdP がアサートする属性であり、Google の検証済み `hd` より**先に**評価されます。`AUTH_TENANT_CLAIM_KEYS=hd` は**Google サインインに限った**検証済みクレームのみの構成です: `hd` は `google` プロバイダーの場合にのみ採用されるため、SAML デプロイでは一切クレームが解決されず、新規ユーザーは個人のブートストラップテナントに OWNER として作成されます。設定する前に [IdP のドメインが変わった / テナントがロックアウトされた](#idp-のドメインが変わった--テナントがロックアウトされた) の項を必ず参照してください |
| `JACKSON_URL` | SAML Jackson URL（デフォルト: `http://localhost:5225`） |
| `AUTH_JACKSON_ID` | Jackson OIDC クライアント ID |
| `AUTH_JACKSON_SECRET` | Jackson OIDC クライアントシークレット |
| `SAML_PROVIDER_NAME` | サインインページの表示名（例: "HENNGE"） |
| `SHARE_MASTER_KEY` | `openssl rand -hex 32` — 共有リンク / Send 用マスターキー |
| `VERIFIER_PEPPER_KEY` | `openssl rand -hex 32` — パスフレーズ検証 pepper（**本番必須**） |
| `DIRECTORY_SYNC_MASTER_KEY` | `openssl rand -hex 32` — ディレクトリ同期資格情報の暗号化（**本番必須**） |
| `WEBAUTHN_RP_ID` | （任意）Relying Party ID（ドメイン名） |
| `WEBAUTHN_RP_NAME` | （任意）Relying Party 表示名 |
| `WEBAUTHN_RP_ORIGIN` | （任意）検証用 RP オリジン（例: `http://localhost:3000`） |
| `WEBAUTHN_PRF_SECRET` | `openssl rand -hex 32` — パスキー Vault アンロック用 PRF ソルト導出 |
| `OPENAPI_PUBLIC` | （任意）`false` で OpenAPI 仕様に認証を要求 |
| `REDIS_URL` | レート制限用 Redis URL（**本番必須**） |
| `BLOB_BACKEND` | 添付ファイルの保存先（`db` / `s3` / `azure` / `gcs`） |
| `AWS_REGION`, `S3_ATTACHMENTS_BUCKET` | `BLOB_BACKEND=s3` の場合に必須 |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_BLOB_CONTAINER` | `BLOB_BACKEND=azure` の場合に必須 |
| `AZURE_STORAGE_CONNECTION_STRING` または `AZURE_STORAGE_SAS_TOKEN` | `BLOB_BACKEND=azure` の場合はいずれか必須 |
| `GCS_ATTACHMENTS_BUCKET` | `BLOB_BACKEND=gcs` の場合に必須 |
| `BLOB_OBJECT_PREFIX` | クラウド保存時のオブジェクトキー接頭辞（任意） |
| `AUDIT_LOG_FORWARD` | （任意）構造化 JSON 監査ログを stdout に出力 |
| `AUDIT_LOG_APP_NAME` | （任意）監査ログ転送時のアプリ名 |
| `AUDIT_IDENTIFIER_PEPPER` | （任意）`AUTH_LOGIN_FAILURE` 監査イベントに記録する識別子のハッシュ化に使う HMAC pepper。設定する場合はちょうど 64 文字の 16 進数（`npm run generate:key`）。未設定時は `AUTH_SECRET`（32 文字以上）から HKDF 導出した鍵にフォールバックし、どちらも使えない場合はハッシュを計算せず `identifierHashScope` を `"unkeyed"` として記録します。詳細は [アップグレード時の注意](#アップグレード時の注意-fail-closed-になった環境変数) と [Audit Log Schema](docs/security/audit-log-schema.md) を参照 |
| `BREAKGLASS_COOLING_OFF_SECONDS` | （任意）24 時間以内に同一の依頼者/対象で最初に発行される Break Glass 許可が実行されるまでの遅延（秒）。0 以上の整数。デフォルト: `3600`。`0` で無効化。[アップグレード時の注意](#アップグレード時の注意-fail-closed-になった環境変数) 参照 |
| `EMAIL_PROVIDER` | （任意）`resend` または `smtp` — 空欄でメール送信無効 |
| `EMAIL_FROM` | メール送信元アドレス |
| `RESEND_API_KEY` | `EMAIL_PROVIDER=resend` の場合に必須 |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | `EMAIL_PROVIDER=smtp` の場合に必須 |
| `DB_POOL_MAX`, `DB_POOL_*` | （任意）PostgreSQL コネクションプール調整 |
| `OUTBOX_WORKER_DATABASE_URL` | （任意）ワーカー DB 接続（`passwd_outbox_worker` ロール）。`npm run worker:audit-outbox` に必要 |
| `PASSWD_SUPERUSER_PASSWORD` | （`docker compose` 必須）`passwd_user` SUPERUSER ロールのパスワード。未設定だと docker-compose が起動失敗。アップグレード手順は [Docker Setup](docs/setup/docker/en.md) 参照 |
| `PASSWD_APP_PASSWORD` | （`docker compose` 必須）`passwd_app` ランタイムロールのパスワード。未設定だと docker-compose が起動失敗 |
| `PASSWD_OUTBOX_WORKER_PASSWORD` | （`docker compose` 必須）`passwd_outbox_worker` DB ロールのパスワード。initdb 初回起動時に使用。既存クラスタでは `scripts/set-outbox-worker-password.sh` を使用 |
| `PASSWD_RETENTION_GC_WORKER_PASSWORD` | （`docker compose` 必須）`passwd_retention_gc_worker` DB ロールのパスワード。initdb 初回起動時に使用。既存クラスタでは `scripts/set-retention-gc-worker-password.sh` を使用 |
| `OUTBOX_BATCH_SIZE`, `OUTBOX_*` | （任意）監査アウトボックスワーカーの調整。詳細は `.env.example` 参照 |
| `NEXT_DEV_ALLOWED_ORIGINS` | （任意）dev サーバー向け許可オリジン（例: Tailscale ホスト名） |
| `NEXT_PUBLIC_CHROME_STORE_URL` | （任意）ブラウザ拡張配布用 Chrome Web Store URL |
| `IOS_APP_TEAM_ID` | Apple Developer Team ID（10 文字の文字列）。AASA ルートが iOS Universal Links を配信するために必須。未設定時は 503 を返す |
| `IOS_APP_BUNDLE_ID` | （任意）iOS アプリのバンドル識別子。デフォルト: `jp.jpng.passwd-sso`（`ios/project.yml` の `PRODUCT_BUNDLE_IDENTIFIER` と一致） |
| `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN` | （任意）Sentry エラートラッキング DSN |
| `SENTRY_AUTH_TOKEN` | （任意）ソースマップアップロード用 Sentry 認証トークン |
| `KEY_PROVIDER` | （任意）鍵プロバイダーバックエンド: `env`（デフォルト）、`azure-kv`、または `gcp-sm`。詳細は [KMS Setup](docs/operations/key-provider-setup.md) 参照 |
| `SM_CACHE_TTL_MS` | （任意）KMS 復号済み鍵キャッシュの TTL（ms）（デフォルト: 300000 = 5 分） |
| `QUOTA_MAX_PASSWORDS_PER_USER` | （任意）ユーザーごとのパスワードエントリ上限数。デフォルト: `10000` |
| `QUOTA_MAX_ATTACHMENT_BYTES_PER_USER` | （任意）ユーザーごとの添付ファイル合計バイト数上限。デフォルト: `1073741824`（1 GiB） |
| `QUOTA_MAX_SHARE_LINKS_PER_USER` | （任意）ユーザーごとのアクティブな共有リンク上限数。デフォルト: `1000` |
| `QUOTA_MAX_WEBHOOKS_PER_TENANT` | （任意）テナントごとの Webhook 上限数（テナント + チーム合算）。デフォルト: `100` |

</details>

> **Redis は本番必須です。** 開発/テスト環境では `REDIS_URL` 未設定時に in-memory フォールバックを利用できます。
>
> **Cookie 認証の破壊的 API では canonical origin の設定が必要です。** `assertOrigin()` は `APP_URL` / `AUTH_URL` のどちらも無い場合、`Host` ヘッダーから same-origin を推測せず fail-closed で 403 を返します。

### アップグレード時の注意: fail-closed になった環境変数

これまで緩く読まれていた 4 つの環境変数が、環境スキーマの検証対象になりました。いずれも **fail-closed** です — 解釈できない値のまま動き続けるのではなく、プロセスが起動を拒否します。方向としては正しい変更ですが、これまで黙って許容されていた値を設定しているデプロイは、アップグレード後に**起動しなくなります**。ロールアウト前に 4 つとも確認してください。

| 環境変数 | 従来 | 現在 | 起こること |
| --- | --- | --- | --- |
| `AUDIT_IDENTIFIER_PEPPER` | 任意の文字列をそのまま HMAC 鍵として使用。未設定時は空鍵 HMAC | 設定する場合はちょうど 64 文字の 16 進数（`npm run generate:key`）、または未設定 | 64 文字の 16 進数**でない**値はすべて**起動失敗**。短い値だけでなく、長すぎる値や、長さは合っていても 16 進数でない値も拒否されます。ハッシュの相関については下記参照 |
| `COOKIE_PARTITIONED` | `=== "true"` による比較のため、`1` / `TRUE` / `yes` はすべて *off* と解釈 | `true` または `false`、あるいは未設定（`false`） | それ以外の表記はすべて**起動失敗**。`COOKIE_PARTITIONED=1` で CHIPS を有効化したつもりだったデプロイは、実際には一度も有効になっていません — `true` を設定してください |
| `BREAKGLASS_COOLING_OFF_SECONDS` | 検証なし | 0 以上の整数（秒）、または未設定（`3600`） | `1h` のような非数値は**起動失敗** |
| `AUTH_TENANT_CLAIM_KEYS` | 任意の文字列。何も指していないエントリは捨てられていたため、`,` は未設定とまったく同じ挙動になっていた | 設定する場合は少なくとも 1 つのクレームキーを指す必要がある（未設定は可） | **どのキーも指していない値**（`,` や `,,`）だけが起動失敗。キーの重複や空エントリ混在（`org,,tenant`）は従来どおり起動します — 見た目どおりのキーを指すためです。旧来のフォールスルーは無害ではありませんでした: SAML デプロイではどのサインインでもクレームが解決されず、初回ユーザーが自分専用の bootstrap テナントの OWNER として作成されていました |

**`AUDIT_IDENTIFIER_PEPPER` は、どう直しても既存ハッシュとの相関が切れます。** `AUTH_LOGIN_FAILURE` の `identifierHash` は pepper を鍵とする HMAC なので、鍵が変われば新しいハッシュは `audit_logs` に既にある値と無関係になります — 同じ識別子でも同じハッシュにはならず、アップグレードをまたいだ相関は失われます。これは起動失敗のケースに限りません:

- 64 文字の 16 進数でない値を設定していた場合、起動させるために**必ず**値を変更することになります。
- 一度もこの変数を設定していないデプロイでも鍵は変わります。空鍵フォールバックは利用できません — pepper は `AUTH_SECRET` から HKDF で導出されます（`AUTH_SECRET` も無い場合はハッシュを計算せず、`identifierHashScope` に `"unkeyed"` を記録します）。

既存ハッシュとの相関を維持する方法は提供していません。アップグレードを新しい相関期間の起点とみなし、切り替え時刻を監査記録と一緒に残してください。詳細は [Audit Log Schema](docs/security/audit-log-schema.md) を参照。

### 管理 / メンテナンススクリプト

メンテナンススクリプト（`scripts/purge-history.sh`、`scripts/purge-audit-logs.sh`、`scripts/rotate-master-key.sh`）には、オペレーター単位の `op_*` Bearer トークンが必要です。旧来の共有 `ADMIN_API_TOKEN` 環境変数は廃止されました。オペレーターは `/<locale>/admin/tenant/operator-tokens` でトークンを発行し、スクリプト実行時に渡します:

```bash
ADMIN_API_TOKEN=op_<token> scripts/purge-history.sh
ADMIN_API_TOKEN=op_<token> scripts/purge-audit-logs.sh
ADMIN_API_TOKEN=op_<token> TARGET_VERSION=<int> scripts/rotate-master-key.sh
```

詳細は [Admin Token Setup](docs/operations/admin-tokens.md) を参照してください。

### IdP のドメインが変わった / テナントがロックアウトされた

**症状**: IdP が送出するテナントクレームが変わった場合（Google Workspace のドメイン変更、SAML 属性の変更など）、既存のテナントメンバーはサインイン時に拒否され、`audit_logs` に `AUTH_LOGIN_FAILURE` として記録されます。原因は **4 つ**あり、この CLI で直せるのは最初の 2 つだけです:

| `metadata.reason` | クレーム関連フィールド（`metadata.claim` / `metadata.claimRefusal`） | 原因 | 対処 |
|---|---|---|---|
| `tenant_claim_unmapped` | クレーム値 | どのテナントにも未登録 | `tenant-domain add` |
| `tenant_mismatch` | クレーム値 | 別のテナントに登録済み | ユーザーを調査、または `add --from` でクレームを移動 |
| `tenant_mismatch` | `claimRefusal` あり（`claim` は無し） | IdP が送った値が**取り込み時点で拒否**された — 対になっていないサロゲート、制御文字・双方向制御文字・ゼロ幅文字、255 文字超、またはストレージ層が往復できない空白 | **IdP 側を修正してください。** その値は `add` で登録できないため、この CLI では復旧できません。`claimRefusal` が違反したルールを示します |
| `tenant_mismatch` | `claimRefusal` あり、かつ `claim` あり | 値は取り込みを通ったが**保存できない** — 印字可能 ASCII ではなく、レジストリの `CHECK` 制約が拒否する（後述の `preflight` を参照） | **IdP 側を修正**するか、そのテナントに ASCII のクレームを登録してください。`add` は同じ述語でこの値を拒否します |

後半 2 つは文言ではなく**フィールドの有無**で判別してください。`claimRefusal` はこのデプロイ自身の拒否判定だけが書き込みますが、`claim` の中身は IdP が指定した値なので、読み手が信頼するよう指示された形に見せかけることができます。`unmapped` は 4 つの原因を 3 つの見出しで報告します — `claimRefusal` を持つ 2 つは対処が同じなので同じ見出しにまとめています。オフライン運用 CLI `scripts/tenant-domain.ts`（`npm run tenant-domain`）で診断・復旧します — 特権接続文字列 `MIGRATION_DATABASE_URL` が必要です（アプリ本体の `DATABASE_URL` ロールはこのテーブルの行レベルセキュリティを回避できません）:

```bash
# 最近拒否された未登録クレームを確認（既定の期間: 30 日）
MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- unmapped
MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- unmapped --days 180

# 新しいクレームを既存テナントに登録（冪等 — 再実行しても安全）
MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- add --tenant <ref> --domain <new-claim> --by <operator-label>
```

`<ref>` にはテナントの UUID、登録済みクレームのいずれか、`external_id` を指定できます。最後の 1 つは、後述のプリフライトチェックがバックフィルのスキップを報告したテナント — つまり指定できるクレームを持たないテナント — を扱うときに必要になります。`slug` は意図的に**受け付けません**。サインインで作成されたテナントの slug は IdP クレームから `[^a-z0-9]+` を潰して生成されるため多対一であり、そのslugを最初に取得したテナントを作らせた者に先取りされうるからです。

`unmapped` が対象とするのは「問い合わせた期間」であり、このデプロイの保持期間ではありません。既定値は設定可能な保持期間の下限（30 日）で、出力にもその期間が明記されます。「何も拒否されていない」と判断する前に `--days <n>` で期間を広げてください。

`list`・`preflight`・`remove` も利用できます。サブコマンドなしで実行すると使用方法が表示されます。

**`tenant_mismatch`: クレームが誤ったテナントに登録されている場合**。この状態はオペレーターが何もしなくても発生します — 打ち間違えた、あるいは他者に先取りされたクレームを提示するサインインが 1 回あるだけで、そのサインインが作成したテナントに対してクレームが登録されます（`created_by = 'signin'`）。`remove` ではクレームは解放されません — 行を論理削除して `revoked_at` を設定するだけで所有テナントは変わらないため、続けて `add` を実行しても再び拒否されます。現在の所有テナントを明示する `add --from` でクレームを移動してください:

```bash
# --from には現在の所有テナントの UUID を、`list` が出力するとおりに指定します。
# slug・クレーム・external_id からは解決しません: 再割り当ては 1 つのテナントの
# メンバー全員を拒否しうる操作であり、打ち間違いで到達できてはならないためです。
MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- list --tenant <claim>
MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- add \
  --tenant <gaining-tenant-ref> --domain <claim> --by <operator-label> \
  --from <current-owner-uuid>
```

`add --from` は書き込みの前に、両テナントの id・name・slug・**アクティブメンバー数**と、移動によって失う側が被る影響を表示し、確認を求めます（非対話実行では `--yes`）。`--from` が実際の所有テナントと一致しない場合は拒否されます。また、対象行が事前に revoke されている必要は**ありません** — revoke してから再割り当てする手順では、クレームがどのテナントにも解決しない期間が生じ、両方のテナントのメンバーが拒否されてしまうためです。移動しても行の `created_by` は書き換えません — この値は「誰が最初にそのクレームを登録したか」というインシデント調査に必要な証跡です。**ただしレジストリは経路変更の履歴を保持しません。** 移動は `tenant_id` を上書きし、revoke 済みクレームの再登録は `revoked_at` を消すため、実行後の行からは以前の所有テナント・revoke されていた事実・変更の実行者のいずれも読み取れません。コマンドはこれらを `NOT RECOVERABLE from the row after this change` の行に出力します。この出力が唯一の記録なので、インシデント記録とともに保管してください。

**`GOOGLE_WORKSPACE_DOMAINS` を設定している場合**（[SECURITY.md](SECURITY.md) で推奨）、クレームを登録するだけでは復旧しません。`src/auth.config.ts` の `signIn` コールバックは、`hd` が `GOOGLE_WORKSPACE_DOMAINS` に含まれない Google サインインを、テナントクレームの解決より**前**に `reason: "provider_error"` として拒否します — この拒否はテナントクレームのチェックまで到達しないため、`tenant-domain unmapped` には何も表示されません。新しいドメインを `GOOGLE_WORKSPACE_DOMAINS` にも追加し、どのテナントのために追加したかを記録してください。この変数はデプロイ全体に効くグローバル設定である一方、クレームレジストリはテナント単位のスコープなので、記録がないと過去にどのテナントかがリネームしたすべてのドメインが静かに積み上がっていきます。そのテナントが不要になった時点で、追加したエントリを削除してください。**ロックアウト回避のために `GOOGLE_WORKSPACE_DOMAINS` を未設定に戻さないでください** — `allowDangerousEmailAccountLinking` は `allowedGoogleDomains.length > 0` から導出されるため、未設定に戻すとこのフラグは `false` になり（緩くなるのではなく**厳しくなり**）、元の拒否に加えて `OAuthAccountNotLinked` という別の失敗が発生します。

**既存デプロイで `prisma migrate deploy` を実行する前に**、プリフライトチェックを実行してください — バックフィルがレジストリから除外する 2 種類の行を、事前の運用判断のために可視化します:

```bash
MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- preflight
```

報告される内容は 3 つです。**正規化の衝突**（複数のテナントの `external_id` が 1 つのクレームに畳み込まれるケース）、**非 ASCII の `external_id`**、そして **Postgres 側とアプリケーション側の正規化のずれ**です。3 つともレジストリから除外されます。

**衝突は「敗者だけ」ではなく、衝突したすべての側が除外されます。** バックフィルは衝突したテナントの**どれにも**クレーム行を登録しません — 報告された衝突を「片方は既にクレームを保持しているので、残りだけ登録すればよい」と読まないでください。1 件だけを残すと、他のテナントの**新規**メンバーが勝者のテナントに黙って作成されてしまいます。これらのテナントは現時点では別個のものであり（アップグレード前のリゾルバは `external_id` を完全一致で照合していました）、しかもどこにもエラーが出ません。したがってプリフライトが返した行は、すべて明示的な判断と明示的な登録を必要とします:

- 衝突であれば、どのテナントが共通のクレーム文字列を取得し、他のテナントには代わりに何を割り当てるかを決めたうえで、それぞれに `tenant-domain add` を実行する。
- 非 ASCII の `external_id` であれば、そのテナントに別途 ASCII のクレームを登録すべきかを決めたうえで、`tenant-domain add` を実行する。

バックフィルを再実行しても、これらの行は登録されません。除外は「既にあればスキップ」ではなく無条件なので、2 回目の実行はこの母集団に対して構造上**何もしません**。登録できるのは `tenant-domain add` だけです。それまでの間、これらのテナントはリリース 1 の `external_id` 完全一致フォールバックによって現在とまったく同じように解決され続けます — アップグレードそのものでロックアウトされることはありません。ただしこのフォールバックは後続リリースで削除され、その時点でクレーム未登録のテナントはロックアウトになります。判断はその前に行ってください。

手書き SQL ではなく CLI を実行してください。このチェックが依存する「印字可能 ASCII」の述語は `src/lib/tenant/tenant-claim-registry.ts` の `NON_PRINTABLE_ASCII_SQL_CLASS` を唯一の出所とし、ドリフト検知テストがマイグレーションの CHECK・バックフィル・その `.sql` 版をこの定数に固定しています。ドキュメントから書き写した述語はこの保護の外側にあり、CHECK からずれたプリフライトは、最も重要な場面で自信を持って「問題なし」と報告します。どうしても CLI を実行できない環境では、述語と正規化式を `scripts/tenant-domain.ts` の `cmdPreflight` からコピーしてください — 書き写さないでください。

**バックフィルが引き継ぐ内容**。`20260228010000_tenant_external_id_and_bootstrap` マイグレーションを既に実行済みのデプロイでは、`tenant_claims` は既存テナントの `external_id` を 1 行ずつ引き継ぎます — そのマイグレーションより前から存在するテナントでは、これはテナント自身の UUID です（`bootstrap-` / `u-` を除くすべてのテナントに対する `UPDATE tenants SET external_id = id ...`）。`tenant_id` は `AUTH_TENANT_CLAIM_KEYS` が未設定時にフォールバックする先頭のキーであるため、生の UUID がそのままクレームとしてテナントメンバーシップを解決できてしまいます。バックフィルが引き継いだ内容を確認するには:

```sql
SELECT tenant_id, claim, created_by, created_at FROM tenant_claims WHERE created_by = 'backfill' ORDER BY created_at;
```

これは以前からの挙動です — 同じ UUID は、この機能追加以前から `Tenant.externalId` 経由でサインインを解決してきました — 今回それが明示的なクレーム行として可視化されただけです。`AUTH_TENANT_CLAIM_KEYS` を意図的に設定しているデプロイでは、クレームの名前空間が明示化された今、デフォルトのクレームキー一覧に `tenant_id` / `tenantId` を残すかどうかを改めて検討してください。

**`AUTH_TENANT_CLAIM_KEYS` の設定指針**。安全な値は、ユーザーがどのプロバイダーでサインインするかによって変わります。Google デプロイを堅牢にする構成が、SAML デプロイではテナント解決を黙って無効化します。自分のプロバイダーの項だけを読んでください。

**この変数を未設定にしても、堅牢な構成にはなりません** — 組み込みの一覧 `tenant_id, tenantId, organization, org, company, company_id` が選択され、そのすべてが IdP のアサートする属性であり、6 つすべてが `hd` を参照する**前に**評価されます。したがって、この変数を一度も設定していない複数接続の SAML デプロイは、後述する危険な構成の外側にいるのではなく、すでにその内側にいます。

**Google サインイン — 検証済みクレームのみの構成は `hd` です:**

```bash
# 検証済みクレームのみの構成。`hd` は自己申告のプロフィール属性ではなく Google が
# アサートする値であり、Google プロバイダーの場合にのみ採用されます。
AUTH_TENANT_CLAIM_KEYS=hd
```

**`hd` は Google 専用です。SAML でサインインするデプロイでは設定しないでください。** このキーはアカウントのプロバイダーが `google` の場合にのみ採用されます — SAML アサーションが文字どおり `hd` という名前のフィールドを含んでいても無視されます。このプロバイダーゲートこそが「`hd` という名前である」ことを「Google がアサートした」に変える仕組みです。したがって SAML のみのデプロイで `AUTH_TENANT_CLAIM_KEYS=hd` を設定すると、**すべてのサインインで**クレームが一切解決されなくなります。これは拒否ではなく、診断にも一切現れません:

- クレームが解決されないサインインは「クレームが提示されなかった」として扱われるため、何も拒否されず、`AUTH_LOGIN_FAILURE` 行も記録されません。
- そして**初回サインインのユーザー**は、組織のテナントに参加するのではなく、自分専用のブートストラップテナントに **OWNER** として作成されます — ユーザー 1 人につきテナントが 1 つ、黙って増え続けます。
- `tenant-domain unmapped` にも何も出ません。このコマンドは「提示されて拒否されたクレーム」を一覧するものであり、ここではそもそも何も提示されていないからです。
- さらに、後述の *インシデント対応: 登録すべきでなかったクレームが登録されてしまった場合* にある吸収の経路を準備してしまいます — これらのユーザーにクレームが解決した瞬間、各人の個人データ一式がテナントへその場で移行されます。

**SAML サインイン — テナントはアサーション内の属性ではなく、接続そのものに紐づけてください。** SAML には、Google の `hd` に相当する「デプロイ全体で使える検証済みクレームキー」は存在しません。このアプリに届く SAML 属性はすべてカスタマー自身の IdP がアサートした値であり、`saml-jackson` はデプロイ全体で共有される単一の OIDC クライアントであるため、クレームの名前空間をアサートした接続に紐づける仕組みがありません。したがって:

- IdP が SAML 経由でアサートする属性（例: `organization`）を指定してよいのは、このデプロイが SSO 接続を **1 つ**しかプロビジョニングしていない場合**に限り**ます。その場合、その接続を通じてアサートできるのは当該カスタマーの IdP だけです。
- SSO 接続が **2 つ以上**プロビジョニングされていると、あるカスタマーの IdP 管理者が別のカスタマーの登録済みクレーム文字列をアサートし、そのテナントを選択できてしまいます。接続を作るかどうかはオペレーターが制御できますが、その接続を通じて何がアサートされるかはカスタマー自身の IdP が制御します — この攻撃が成立するには後者だけで十分です。
- 複数カスタマーを SAML で収容する場合の答えは**接続単位のテナント紐づけ**です — アサーション内の属性ではなく、どの SSO 接続から届いたサインインかでテナントを決める方式です。現在のデプロイ構成はこの紐づけを提供していないため、それが利用できるようになるまでは、SSO 接続はデプロイあたり 1 つに保ち（カスタマーごとに Jackson OIDC クライアントを分けた別デプロイにし）、登録済みクレームは `tenant-domain list` で確認してください。

以上はいずれも、Google の `hd` のみに依存するデプロイ（本節が想定するインシデントの形）では発生しません。

**インシデント対応: 登録すべきでなかったクレームが登録されてしまった場合**。`tenant-domain remove` は行を削除せず（`revokedAt`）論理削除します — 先に削除してしまうと `tenant_claims.createdAt` が失われ、これは以下のクエリが必要とする 2 つのタイムスタンプの一方であるため、実際のインシデント対応の手順では実行できなくなってしまいます。行を削除しても、それが既に許可した内容は取り消されません:

- **新規メンバー**: そのクレームが有効だった期間に作成された `TenantMember` 行を列挙します:
  ```sql
  SELECT tm.tenant_id, tm.user_id, tm.created_at AS member_created_at
  FROM tenant_members tm
  JOIN tenant_claims tc ON tc.tenant_id = tm.tenant_id AND tc.claim = '<claim>'
  WHERE tm.created_at >= tc.created_at
    AND (tc.revoked_at IS NULL OR tm.created_at <= tc.revoked_at);
  ```
- **個人保管庫の吸収**: ブートストラップテナントのユーザーが、そのクレームを提示して初めてサインインすると、そのユーザーの**個人データ一式**が 1 つのトランザクションでテナントへ再割り当てされます — `User`/`Account`、`passwordEntry`、`tag`、`folder`、`session`、`extensionToken`、`passwordEntryHistory`、`vaultKey`、`audit_logs`（`audit_log_tenant_migrate` プロシージャ経由）、`emergencyAccessGrant`、`emergencyAccessKeyPair`、`passwordShare`、`shareAccessLog`、`attachment`、`notification`、`apiKey`、`webAuthnCredential`、そして `TenantMember`（`src/auth.ts` のブートストラップ移行ブロックを参照）。いずれのテーブルも**その場で**更新され、以前の `tenantId` を記録する履歴テーブルは存在しません。しかも移行されたユーザー自身の `audit_logs` 行も同じトランザクションで新テナントへ再割り当てされるため、データベース上には「これは以前テナント X に属していた」ことを示す記録が一切残りません。**このケースは復元不能な可能性があります。** 得られる手がかりは状況証拠にとどまります — 当該ユーザーの `AUTH_LOGIN` 行（クレームが有効だった時間帯の `audit_logs`）を、削除したクレームの `tenant_claims.createdAt` / `revokedAt` と突き合わせるのが最も近い方法です。

### 3. サービスの起動

**開発環境:**

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d db jackson redis
npm run db:migrate
npm run dev
```

[http://localhost:3000](http://localhost:3000) を開きます。

**本番環境:**

```bash
docker compose up -d
```

### 4. 初回セットアップ

1. Google または SAML SSO でサインイン
2. マスターパスフレーズを設定
3. パスワードの登録を開始

## ブラウザ拡張（Chrome/Edge）

`extension/` 配下の MV3 拡張です。

```bash
cd extension && npm install && npm run build
```

1. `chrome://extensions` → **デベロッパーモード**有効化 → **パッケージ化されていない拡張機能を読み込む** → `extension/dist` を選択
2. 必要に応じて拡張設定で `serverUrl` を設定
3. 接続、Vault アンロック、自動補完を利用

## セキュリティモデル

ゼロナレッジアーキテクチャ — サーバーは暗号文のみを保存し、ユーザーデータを復号できません。

- **鍵導出** — パスフレーズ → PBKDF2/Argon2id → ラッピング鍵 → ランダム 256 ビット秘密鍵をラップ
- **ドメイン分離** — 秘密鍵 → HKDF → 暗号化鍵 + 認証鍵に分離
- **Secret Key** — アカウント固有の追加ソルトでサーバー侵害に対する防御を強化
- **AAD バインディング** — 追加認証データで暗号文をユーザー・エントリ ID に紐付け（E2E 保管庫）。サーバー暗号化の共有リンク / Send は暗号文を所有テナントにバインド
- **セッションセキュリティ** — データベースセッション（JWT ではない）、テナント/チームポリシーによる絶対タイムアウト（デフォルト 30 日、ポリシーで最短 5 分まで設定可能）、単一のアイドルタイムアウト（デフォルト 15 分、設定可能）で自動ロック（タブの表示/非表示は問わない）
- **クリップボードクリア** — コピーしたパスワードは 30 秒後に自動消去
- **CSRF 防御** — JSON body + SameSite Cookie + CSP + 設定済み `APP_URL` / `AUTH_URL` に対する Origin ヘッダー検証（未設定時は fail-closed）

詳細は[暗号設計ホワイトペーパー](docs/security/cryptography-whitepaper.md)を参照してください。

## プロジェクト構成

```text
src/
├── app/[locale]/         # ページ（ランディング、ダッシュボード、認証）
├── app/api/              # API ルート（vault、passwords、tags、teams、SCIM 等）
├── components/           # UI コンポーネント（passwords、team、vault、settings 等）
├── lib/                  # コアロジック（暗号化、認証、バリデーション、レート制限）
└── i18n/                 # next-intl ルーティング
extension/                # Chrome/Edge MV3 ブラウザ拡張
ios/                      # ネイティブ iOS アプリ + AutoFill 認証情報プロバイダー拡張
cli/                      # Node.js CLI ツール
docs/                     # ドキュメント（アーキテクチャ、セキュリティ、運用、セットアップ）
```

## スクリプト

| コマンド | 説明 |
| --- | --- |
| `npm run dev` | 開発サーバー（Turbopack） |
| `npm run build` | プロダクションビルド |
| `npm run lint` | ESLint |
| `npm test` | テスト一括実行（vitest） |
| `npm run test:watch` | テスト（ウォッチモード） |
| `npm run test:coverage` | テスト（カバレッジ付き） |
| `npm run test:e2e` | Playwright E2E テスト |
| `npm run db:migrate` | Prisma マイグレーション（dev） |
| `npm run db:push` | マイグレーションなしでスキーマ反映 |
| `npm run db:seed` | シードデータ投入 |
| `npm run db:studio` | Prisma Studio GUI |
| `npm run generate:key` | 256 ビット hex キー生成 |
| `npm run init:env` | 対話式 .env ジェネレーター（dev/ci/production） |
| `npm run generate:env-example` | Zod スキーマからの .env.example 再生成 |
| `npm run check:env-docs` | スキーマ ↔ .env.example ↔ allowlist ↔ compose の整合性チェック |
| `npm run worker:audit-outbox` | 監査アウトボックスドレインワーカー実行（`OUTBOX_WORKER_DATABASE_URL` 必須） |
| `npm run test:integration` | 実 DB を使った統合テスト実行（Postgres 起動が必要） |
| `npm run version:bump` | git log からの次バージョン提案（対話式） |
| `npm run generate:icons` | アプリアイコン生成 |

<details>
<summary>CI / セキュリティ / 負荷テスト / ライセンススクリプト</summary>

| コマンド | 説明 |
| --- | --- |
| `npm run check:team-auth-rls` | チーム認証 + RLS パターン検証 |
| `npm run check:bypass-rls` | クエリ内の RLS バイパス検出 |
| `npm run check:crypto-domains` | 暗号ドメイン分離の検証 |
| `npm run licenses:check` | アプリ依存のライセンスチェック |
| `npm run licenses:check:strict` | ライセンスチェック（strict / CI用） |
| `npm run licenses:check:ext` | 拡張依存のライセンスチェック |
| `npm run licenses:check:ext:strict` | 拡張ライセンスチェック（strict / CI用） |
| `npm run licenses:check:cli` | CLI 依存のライセンスチェック |
| `npm run licenses:check:cli:strict` | CLI ライセンスチェック（strict / CI用） |
| `npm run test:cli` | CLI テスト実行 |
| `npm run test:load:smoke` | 負荷テスト用シードのスモークチェック |
| `npm run test:load:seed` | 負荷テスト用ユーザー/セッションをシード |
| `npm run test:load` | k6 mixed-workload シナリオ実行（要 k6） |
| `npm run test:load:health` | k6 health シナリオ実行（要 k6） |
| `npm run test:load:cleanup` | 負荷テスト用データの削除 |
| `npm run scim:smoke` | SCIM スモークチェック（`SCIM_TOKEN` 必須） |

</details>

## インポート用サンプル

- passwd-sso JSON: [`docs/assets/passwd-sso.json`](docs/assets/passwd-sso.json)
- passwd-sso CSV: [`docs/assets/passwd-sso.csv`](docs/assets/passwd-sso.csv)

## ドキュメント

- [Security Policy](SECURITY.md)
- [暗号設計ホワイトペーパー](docs/security/cryptography-whitepaper.md) — 鍵階層と暗号設計の全体像
- [脅威モデル STRIDE](docs/security/threat-model.md) — 体系的な脅威分析
- [セキュリティ考慮事項（日本語）](docs/security/considerations/ja.md) / [English](docs/security/considerations/en.md)
- [Docker セットアップ](docs/setup/docker/en.md) · [AWS](docs/setup/aws/en.md) · [Vercel](docs/setup/vercel/en.md) · [Azure](docs/setup/azure/en.md) · [GCP](docs/setup/gcp/en.md)
- [Terraform (AWS)（日本語）](infra/terraform/README.ja.md) / [English](infra/terraform/README.md)
- [デプロイ運用](docs/operations/deployment.md)
- [バックアップ & リカバリ（日本語）](docs/operations/backup-recovery/ja.md) / [English](docs/operations/backup-recovery/en.md)
- [Redis HA](docs/operations/redis-ha.md) — Redis Sentinel/Cluster 構成
- [Machine Identity & MCP Gateway](docs/architecture/machine-identity.md) — サービスアカウント、OAuth 2.1 PKCE、DCR、委任復号
- [監査ログリファレンス](docs/operations/audit-log-reference.md)
- [インシデント対応手順書](docs/operations/incident-runbook.md)
- [全ドキュメント](docs/README.md)

## ライセンス

MIT
