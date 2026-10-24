# Terraform (AWS) for passwd-sso

## Architecture

- **ECS Fargate** — app (Next.js) + jackson (BoxyHQ SAML Jackson)
- **ALB** — HTTPS 終端、ホストヘッダルーティング
- **RDS PostgreSQL 16** — 暗号化ストレージ、Multi-AZ (prod)
- **ElastiCache Redis 7** — セッション/キャッシュ、レプリケーション (prod)
- **ECR** — コンテナイメージリポジトリ (app + jackson)
- **Secrets Manager** — アプリ/Jackson シークレット管理
- **Route53 + ACM** — DNS + SSL/TLS 証明書
- **S3** — 添付ファイルストレージ (+ optional CloudFront CDN)

## Directory Structure

```
infra/terraform/
├── network.tf          # VPC, Subnets, NAT, Security Groups
├── database.tf         # RDS PostgreSQL, ElastiCache Redis
├── storage.tf          # S3, CloudFront
├── ecs.tf              # ECS Cluster, Task Definitions, Services
├── alb.tf              # ALB, Target Groups, Listeners
├── dns.tf              # ACM Certificate, Route53 Records
├── ecr.tf              # ECR Repositories, Lifecycle Policies
├── iam.tf              # IAM Roles (execution + task)
├── secrets.tf          # Secrets Manager
├── logs.tf             # CloudWatch Log Groups
├── backend.tf          # Remote state (S3 + DynamoDB) template
├── locals.tf           # Local values
├── variables.tf        # Input variables
├── outputs.tf          # Output values
├── providers.tf        # AWS provider
├── versions.tf         # Terraform + provider version constraints
├── terraform.tfvars.example
└── envs/
    ├── dev/
    │   ├── backend.hcl              # この環境の state key（コミットする）
    │   └── terraform.tfvars.example
    └── prod/
        ├── backend.hcl
        └── terraform.tfvars.example
```

## Quick Start

### 1. Setup

```bash
cd infra/terraform

# Copy the example tfvars and fill in actual values
cp envs/dev/terraform.tfvars.example envs/dev/terraform.tfvars
# Edit envs/dev/terraform.tfvars with real secrets

# S3 バックエンドは無条件に宣言されているため、バケットとロックテーブルが先に存在
# している必要があります（"Remote State Backend" 参照）。-backend-config でこの環境の
# state key を選択します。
terraform init -reconfigure -backend-config=envs/dev/backend.hcl
```

> **シークレットは Terraform state に平文で保存されます。** tfvars で渡した
> シークレット値は `terraform.tfstate` に平文で書き込まれます（`secrets.tf` の
> SECURITY 注記を参照）。実シークレットで apply する前に、必ず下記の暗号化 S3
> リモートバックエンドを設定してください。ローカル state のまま本番デプロイし
> ないこと。tfvars は全て gitignore 済みで、実値は決してコミットしない。

### 2. Plan & Apply（既存環境の更新）

```bash
terraform plan  -var-file=envs/dev/terraform.tfvars
terraform apply -var-file=envs/dev/terraform.tfvars
```

> **新規環境の初回 bootstrap** には順序制約があります（接続文字列 secret は RDS/Redis
> 作成後にしか生成できない、RDS は `initdb/*.sql` を実行しないため `passwd_app` /
> worker ロールを migration 前に手動作成が必要、等）。多段階手順は英語版 README の
> "First-time bootstrap" を参照してください。

### 3. Push Container Images

> **イミュータブルタグ。** ECR リポジトリは `IMMUTABLE`（`ecr.tf` 参照）。タグは
> 一度しか push できず上書き不可のため `:latest` は push せず、イミュータブルな
> バージョンタグ（リポジトリの `vX.Y.Z` 形式）または digest を使うこと。既存タグ
> の再 push は `ImageTagAlreadyExistsException` で失敗する。ECS タスク定義・k8s
> マニフェストはデプロイ時に正確なバージョンタグまたは `@sha256:` digest を参照
> すること。`app_image` / `jackson_image` 変数は `:latest` を拒否する。

```bash
# Login to ECR
aws ecr get-login-password --region ap-northeast-1 | \
  docker login --username AWS --password-stdin $(terraform output -raw ecr_app_repository_url | cut -d/ -f1)

# Build and push app with an immutable version tag (matches package.json version).
# NOTE: `terraform output` のため infra/terraform で実行するが、Docker build の
# CONTEXT はリポジトリルート (../..) — Dockerfile はそこにある（ここには無い）。
VERSION=$(node -p "require('../../package.json').version")   # e.g. 0.4.71
docker build -f ../../Dockerfile \
  -t $(terraform output -raw ecr_app_repository_url):v${VERSION} \
  ../..
docker push $(terraform output -raw ecr_app_repository_url):v${VERSION}

# Push jackson (pull from Docker Hub, retag, push). jackson has no local version
# SSOT — pin to a SPECIFIC upstream boxyhq/jackson release tag (not :latest).
JACKSON_VERSION=1.42.0   # pick a concrete upstream release; bump deliberately
docker pull boxyhq/jackson:${JACKSON_VERSION}
docker tag boxyhq/jackson:${JACKSON_VERSION} $(terraform output -raw ecr_jackson_repository_url):v${JACKSON_VERSION}
docker push $(terraform output -raw ecr_jackson_repository_url):v${JACKSON_VERSION}
```

### 4. 新しいイメージバージョンをデプロイ（steady state）

migration-first の順序は Terraform ではなく `scripts/deploy.sh` が所有します。
Terraform は task **定義**のみ管理し（サービスは `ignore_changes = [task_definition]`）、
deploy.sh が「apply で新定義を登録 → migration 実行 → 全サービス（app + jackson +
両 worker の計 4 つ）を新 task-def へ update-service」を順に行います。新コードが未
migration スキーマで動くことはありません。

```bash
export AWS_REGION=<region>
export ECR_URL=<account>.dkr.ecr.<region>.amazonaws.com/passwd-sso-prod-app
export TF_VAR_FILE=envs/prod/terraform.tfvars
./scripts/deploy.sh   # build → push → apply(定義のみ) → migration → update-service
```

deploy.sh は dirty/untracked worktree を拒否し full commit SHA を使用、同一タグが
ECR に既存なら build/push をスキップ（migration 失敗後の再実行が安全）します。
update-service 後は services-stable を待ち、`rolloutState == COMPLETED` に加えて
PRIMARY deployment の taskDefinition が要求 ARN と一致することまで検証します
（circuit-breaker による旧 revision への自動 rollback も COMPLETED になるため）。
いずれかが失敗した場合は全サービスをデプロイ前 revision へ戻す補償 rollback を
実行します。詳細は docs/operations/deployment.md を参照。新規環境の初回構築は
「初回 bootstrap」を参照。

steady-state の migration は expand-and-contract（新旧コード双方と互換）である
必要があります。migration 実行中も旧 app/worker が稼働しているためです。破壊的 DDL は
`scripts/checks/check-destructive-migration.mjs` が CI で検出します。

### イメージ署名（cosign + KMS）

deploy.sh は push した全イメージを cosign で署名し、デプロイ前に署名を検証します。
検証に失敗したイメージは apply 前に拒否されます。ECR の immutability はタグの
「上書き」を防ぎますが「先に作られる」ことは防げないため、ECR push 権限のみを持つ
主体が `git-<sha>` を先置きすると、deploy.sh の「既存タグならビルドを省略」経路が
そのイメージを採用してしまいます。署名権限（`kms:Sign`）を分離することでこれを
遮断しています。

`cosign` を PATH に用意し、環境ごとに一度だけデプロイ用ロールへ権限を付与します。

```bash
aws iam attach-role-policy --role-name <deploy-role> \
  --policy-arn "$(terraform output -raw image_signing_policy_arn)"
```

署名導入前に push されたイメージは署名を持たないため拒否されます。クリーンな
チェックアウトから push し直すか、既存 digest を一度署名してください。詳細は
docs/operations/deployment.md "Image Signing" を参照。

## Remote State Backend

`backend.tf` は暗号化 S3 + DynamoDB バックエンドを**無条件に**宣言しているため、
opt-in ではありません。バケットとロックテーブルが存在するまで `terraform init` は
失敗します。**先にそれらを作成してください** — 正確なコマンド（バケット＋バージョ
ニング＋暗号化＋パブリックアクセス遮断＋ロックテーブル）は `backend.tf` のコメント
にあります。Terraform state はシークレット値を平文で保持するため、ローカル state
（開発端末や CI アーティファクト上）はシークレット流出です。リモートバックエンドは
保存時暗号化（`encrypt = true`）・バージョニング・（バケットポリシー/IAM による）
厳格なアクセス制御とアクセスログを提供します。

### 環境ごとに state を分ける

`backend.tf` は `key = "env/terraform.tfstate"` をハードコードしています。この key は
全環境で共通なので、同じディレクトリから `dev` と `prod` を実行すると**1つの state に
衝突します**。環境ごとの key は `envs/<env>/backend.hcl` に置き、init 時に選択します。

```bash
terraform init -reconfigure -backend-config=envs/dev/backend.hcl
terraform plan -var-file=envs/dev/terraform.tfvars
```

環境を切り替えるたびに、別の `backend.hcl` で `init -reconfigure` を再実行する必要が
あります。backend key と `-var-file` が食い違うと、一方の環境の state がもう一方の
リソースを指すことになるため、頻繁に切り替えるならチェックアウトや git worktree を
環境ごとに分けるほうが安全です。

### 変数ファイルは決してコミットしない

Terraform が自動ロードする tfvars の形式（`*.tfvars` / `*.tfvars.json`、`*.auto.tfvars`
を含む）は `infra/terraform/` 配下の任意の深さで gitignore 済みで、追跡されるのは
`*.tfvars.example` テンプレートのみです。tfvars は**シークレットフリーではない**ため
これが効いてきます — 2026-07 レビュー (F3) で app/Jackson のシークレット値は Terraform
から外れましたが、`redis_auth_token` は変数として渡すしかなく（ElastiCache に AWS 管理
トークン相当が無いため）、追跡された変数ファイルは認証情報の流出そのものです。
`backend.hcl` は state key しか持たないのでコミットします。

## Secrets Management

app/Jackson のシークレット値は Terraform で管理せず、state にも入れません（2026-07
レビュー F3）。Terraform は空のコンテナ（`secrets.tf`）のみを作成し、値は
`terraform apply` の後・ECS サービス起動の前に、コミットしない JSON ファイルから
out-of-band で注入します。RDS マスターパスワードも AWS 管理
（`manage_master_user_password`）なので state に入りません。

> **例外:** ElastiCache Redis の `auth_token` は設定時に Terraform state へ入ります
> — ElastiCache に AWS 管理トークン相当がないためです。暗号化リモートバックエンド +
> 厳格な IAM（backend.tf）が実効的な統制で、トークンは out-of-band でローテーション
> 可能（`ignore_changes = [auth_token]`）。state を機密として扱ってください。

```bash
# app-secrets.json / jackson-secrets.json: 下表のキーを持つ JSON オブジェクト
# (mode 0600、注入後に削除。コミット禁止)。
scripts/put-terraform-secrets.sh \
  --name-prefix passwd-sso-prod \
  --app-file ./app-secrets.json \
  --jackson-file ./jackson-secrets.json
```

空のシークレットは ECS タスク起動を失敗させるため、サービス起動前に実行すること。
ECS タスク定義は `{secret_arn}:KEY::` 形式で個別キーを参照し、スクリプトが書き込んだ
値に解決されます。

### Required Secrets (app)

| Key | Description |
|-----|-------------|
| `DATABASE_URL` | PostgreSQL 接続文字列（app ロール、NOSUPERUSER） |
| `MIGRATION_DATABASE_URL` | migrate タスク用の SUPERUSER 接続文字列（`prisma migrate deploy` の DDL）。RDS マスターパスワードは `db_master_user_secret_arn` から取得。 |
| `AUTH_URL` | アプリの公開URL |
| `AUTH_SECRET` | Auth.js セッション暗号化キー |
| `AUTH_GOOGLE_ID` | Google OAuth Client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth Client Secret |
| `AUTH_JACKSON_ID` | Jackson 接続 1 つのクライアント ID（プロバイダー `saml-jackson`）— その接続自身の `clientID`。`dummy` や `tenant=…&product=…` 形式は不可。SAML を使わない場合は空文字列。 |
| `AUTH_JACKSON_SECRET` | その接続自身の `clientSecret` |
| `AUTH_JACKSON_CONNECTIONS` | 追加の Jackson 接続。JSON 配列の文字列 `[{"id","name","clientId","clientSecret"}]` で、エントリごとにプロバイダー `saml-jackson-<id>` を 1 つ登録。`enable_jackson_connections = true` のときのみ参照。SSO プロバイダーが 2 つ以上なら、ルート README の "SSO tenant claim binding upgrade" を済ませてから `auth_claim_binding = "strict"` を設定（未設定だとアプリは起動しない）。 |
| `SHARE_MASTER_KEY` | 組織暗号化マスターキー (256-bit hex) |
| `SESSION_TOKEN_HMAC_KEY` | セッショントークン HMAC キー (256-bit hex)。**本番必須**（env 検証 + 実行時 fail-closed）。セッション認証をマスターキーローテーションから分離。app ECS タスクにマッピング。`npm run generate:key` で生成。 |
| `REDIS_URL` | Redis 接続文字列 |
| `OUTBOX_WORKER_DATABASE_URL` | audit-outbox-worker ECS サービス用の最小権限 DB URL（`passwd_outbox_worker` ロール） |
| `RETENTION_GC_DATABASE_URL` | retention-gc-worker ECS サービス用の最小権限 DB URL（`passwd_retention_gc_worker` ロール） |
| `VERIFIER_PEPPER_KEY` | 保管庫データ HMAC 用ペッパー (256-bit hex)。**本番必須**。app ECS タスクにマッピング。`npm run generate:key` で生成。 |
| `SMTP_USER` | マジックリンクメール用 SMTP ユーザー名。`smtp_host` 設定かつ `smtp_auth_enabled = true` のときのみ参照。認証なしリレーは空文字列で表す（キー欠落は ECS が起動拒否）。 |
| `SMTP_PASS` | SMTP パスワード。条件は `SMTP_USER` と同じ。 |
| `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` | audit-anchor publisher ECS サービス用の最小権限 DB URL（`passwd_anchor_publisher` ロール）。`bootstrap-rds-roles.mjs` がこのパスワードでロールに `LOGIN` を付与するため、このシークレットが唯一の控え。 |
| `AUDIT_ANCHOR_SIGNING_KEY` | publisher がマニフェスト署名に使う Ed25519 シード (32-byte hex)。publisher タスクにのみマッピング。`npm run generate:audit-anchor-signing-key` で生成。 |
| `AUDIT_ANCHOR_TAG_SECRET` | マニフェスト内テナントタグ用 HMAC シークレット (32-byte hex)。publisher タスクにのみマッピング。`npm run generate:audit-anchor-tag-secret` で生成。 |
| `DEPLOYMENT_ID` | 全マニフェストでこのデプロイメントを示す UUID。初回起動時に保存した値と異なると publisher は起動を拒否する。デプロイメントごとに 1 回生成し、保存済みの値を再利用するのは前任が既に存在しない同一デプロイメントの後継のみ — クローンや復元コピーは新しい値を生成する。publisher タスクにのみマッピング。 |

4 つの worker は app イメージ（`node dist/<worker>.js`）で専用 ECS サービス
（`*-audit-outbox-worker` / `*-retention-gc-worker` / `*-audit-anchor-publisher` /
`*-audit-chain-verify-worker`）として起動、`desired_count =
var.worker_desired_count`（初回 bootstrap は 0、定常運用は 1。publisher は最大 1）、
LB なし。クラッシュ時は ECS が自動再起動。liveness は前の 3 つが
`RunningTaskCount < 1`（Container Insights）、verify worker は heartbeat の欠落で
監視（monitoring.tf）。これらがないと監査は PENDING のまま、保持期限も執行されず、
アンカーも公開されないため、上記 worker DB URL と publisher の鍵は apply 前に必ず
設定すること。

> **`SESSION_TOKEN_HMAC_KEY` のローテーション。** セッションの DB digest と Redis
> キャッシュキーは両方この鍵から導出されるため、変更すると全 digest が変わり
> **全セッションが失効**（全ユーザー再認証）します。ハード cutover で行うこと:
> (1) 旧鍵タスクがローテーション中にセッションを発行しないよう app サービスを
> `desired_count = 0` にスケールダウン、(2) 新値を投入、(3) `DELETE FROM sessions`
> + Redis セッション keyspace を flush、(4) 新鍵で app をスケールアップ。手順 (1) を
> 省くと、purge と再デプロイの間に旧タスクが旧鍵で孤立セッションを作り得ます。
> docs/operations/key-provider-setup.md を参照。

### Required Secrets (jackson)

| Key | Description |
|-----|-------------|
| `JACKSON_API_KEYS` | Jackson API キー |
| `DB_URL` | PostgreSQL 接続文字列 |
| `NEXTAUTH_URL` | Jackson の公開URL |
| `EXTERNAL_URL` | Jackson の外部URL |
| `NEXTAUTH_SECRET` | Jackson セッション暗号化キー |

## Audit anchor publisher

`*-audit-anchor-publisher`（`ecs.tf`）は日次の cadence 境界（00:05 UTC）ごとに
マニフェストを 1 つ署名し、アンカーバケット（`storage.tf`）に書き込みます。
`*-audit-chain-verify-worker` は全テナントの監査チェーンを 1 時間ごとに検証し、
heartbeat をログに出します。どちらも app イメージで動きます。

| 変数 | デフォルト | 意味 |
|------|-----------|------|
| `audit_anchor_s3_prefix` | `"audit-anchors"` | publisher が書き込むキー接頭辞。バケットポリシーの全ステートメントはこれを基に組み立てられる。`modules/anchor-prefix` で検証（規則は下記）。デフォルトはローテーション runbook の既存レイアウトなので、既存環境の次の plan に新しい値は不要。 |
| `audit_anchor_break_glass_role_arn` | `""` | ローテーション runbook の Step 4–5 のオブジェクトを書き込める運用者の IAM ロール ARN（`arn:aws…:iam::<12 桁>:role/<名前>` として検証）。空なら誰もそのパスに書けない（無条件 Deny）。これらの手順を実行する前に設定すること。 |
| `audit_anchor_object_lock_days` | `2557` | バケットのデフォルト COMPLIANCE 保持日数。`>= 2557` を検証。publisher は PUT ごとに独自の retain-until（2555 日 = 7 × 365）を送る。バケットポリシーはこの値より 31 日を超えて長い保持を拒否するため、この値を上げるとその上限も上がる。 |
| `enable_s3_audit_anchors` | `true` | `true` であることを検証。本番はアンカー送信先なしでは起動を拒否し、この構成が配線する送信先は S3 バケットだけ。 |

**接頭辞の規則。** `[A-Za-z0-9._-]` からなるセグメントを `/` で 1 つ以上つないだもの
で、どのセグメントも `.` や `..` ではないこと。`*` や `?`（ポリシーの全ステートメント
を広げてしまう）と、先頭・末尾・連続の `/`（文書上のキーと publisher が組み立てる
キーがずれる）は不可。`a`、`a/b`、`a.b`、`.a` は可、`""`、`*`、`?`、`/a`、`a/`、
`a//b`、`.`、`..`、`a/../b`、`a/./b` は不可。Terraform 上の規則は、provider を持たない
モジュール `modules/anchor-prefix` の変数バリデーションの 1 か所だけにあり、ルート
はこれを無条件に呼び出し、バケットポリシー・publisher の IAM ポリシー・タスク env
はいずれもモジュールの出力を読みます。AWS 認証情報なしで、そのモジュールの
`terraform test` が `prefix-vectors.json`（publisher の Zod スキーマのテストと同じ
ベクタ）に対して検証します。publisher 自体は、この Terraform 以外のデプロイ向けに
未設定・空の接頭辞（バケット直下）も受け付けますが、ここでは常に空ではありません
（バケットポリシーが必要とするため）。

**誰が何を書けるか**（`aws_s3_bucket_policy.audit_anchors`。全ステートメントが
`Principal: "*"` の `Deny` で、例外がある場合は `ArnNotEquals aws:PrincipalArn`
条件で表す）:

| キー | 内容 | 書き込める主体 |
|------|------|---------------|
| `<prefix>/????-??-??.kid-*.jws` | 日次マニフェスト | publisher のタスクロールのみ |
| `<prefix>/key-rotation-*` | ローテーション告知（runbook Step 4） | break-glass ロールのみ |
| `<prefix>/public-keys/*` | 公開鍵アーカイブ（runbook Step 5） | break-glass ロールのみ |
| それ以外 | — | 誰も書けない（publisher も含む） |

加えて、`s3:DeleteObject` と `s3:DeleteObjectVersion` は全員に拒否、
`s3:ReplicateObject`・`s3:ReplicateDelete`・`s3:ReplicateTags` も全員に拒否
（レプリカはこれらのアクションで書き込まれ `s3:PutObject` ではない。このバケットは
レプリケーション先にならない）、`s3:PutObjectRetention` は上記 2 ロール以外に拒否、`s3:PutLifecycleConfiguration`
はバケットに対して拒否、`x-amz-object-lock-mode: COMPLIANCE` のない（ヘッダ欠落を
含む）`PutObject`、上限を超える保持、`AES256` 以外の SSE は拒否されます。バケット
は Object Lock（`enable_s3_object_lock` に関係なく常に有効）、バージョニング、
SSE-S3（`s3_kms_key_arn` は使わない。削除予定の CMK はロック中の証跡を読めなく
する）、`prevent_destroy` を持ちます。ポリシーは誰も置き換えない間だけ有効で、
アカウントの root はいつでも置き換えられます。バケットのポリシー・ライフサイクル・
Object Lock・バージョニング設定の変更は EventBridge ルール
`<name_prefix>-audit-anchor-bucket-config-change` が通知します（それらに触れる
Terraform apply は想定内の誤検知）。Object Lock なしで作られた既存のアンカー
バケットは、次の plan の前にその場での手順が必要です —
`docs/operations/deployment.md` の "Existing anchors bucket without Object Lock"
を参照。

**サービス。**

- publisher: 専用タスクロール（`*-ecs-audit-anchor-publisher-task`。
  `<bucket>/<prefix>/*` への `s3:PutObject` と `s3:PutObjectRetention` のみで、
  読み取り・一覧・削除なし。引き受けられるのはこのアカウントの ECS タスクのみ
  （`aws:SourceAccount`）で、このロールをタスクロールの上書きとして渡す
  `RunTask`/`StartTask` は EventBridge ルール
  `<name_prefix>-audit-anchor-publisher-role-override` が通知する。ロール自体への
  IAM 変更はこのスタックでは通知しない — `docs/operations/alerts.md` を参照）。env は `AUDIT_ANCHOR_PUBLISHER_ENABLED=true`、
  バケット、接頭辞、`AWS_REGION`。secrets は `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`、
  `AUDIT_ANCHOR_SIGNING_KEY`、`AUDIT_ANCHOR_TAG_SECRET`、`DEPLOYMENT_ID`（後ろの 3 つ
  は他のどのタスクにも渡らない）。`desired_count = min(1, worker_desired_count)`、
  `deployment_maximum_percent = 100`、`deployment_minimum_healthy_percent = 0`:
  デプロイは旧タスクを停止してから（SIGTERM。スケジュールを止め、実行中の 1 回を
  `stopTimeout = 120` 以内に終える）新タスクを起動し、新タスクの起動時実行は現在の
  境界が未公開のときだけ公開します。ロググループ
  `/ecs/<name_prefix>/audit-anchor-publisher`。
- verify worker: タスクロールなし（AWS API を呼ばない）。secret は app シークレット
  の `DATABASE_URL` だけで、`AUDIT_CHAIN_VERIFY_DATABASE_URL` として渡される。これは
  `passwd_app` ロールで、app が読む全テーブルを読め、app の書き込み権限もすべて
  持つが、worker が読むのは `tenants`、`audit_chain_anchors`、`audit_logs` だけ —
  専用の読み取り専用ロールはフォローアップ（SC3）。ロググループ
  `/ecs/<name_prefix>/audit-chain-verify-worker`。
- 両ロググループは RLS bypass レポートのメトリクスフィルタ対象。
- クラスタは ECS Exec のセッションログを明示的に `NONE` にしている: bootstrap の
  運用シェルはロールのパスワードを扱い、記録が残るとそれを保持してしまうため。
  exec セッションの監査として残るのは CloudTrail の `ExecuteCommand` で、
  EventBridge ルール `<name_prefix>-ecs-execute-command` が通知する — ただし
  バケット設定ルールと同様、管理イベントを記録する trail のあるアカウントからしか
  イベントを受け取らない。Terraform は trail を定義しないので
  `docs/operations/deployment.md` の "CloudTrail prerequisite" を参照。

**`DEPLOYMENT_ID`。** デプロイメントごとに 1 回生成し（`node -e
'console.log(crypto.randomUUID())'`）、app シークレットに追加します。保存済みの値を
再利用するのは、前任が既に存在しない同一デプロイメントの後継のみ。クローンや
復元コピーは新しい値を生成し、ローテーション runbook の "DEPLOYMENT_ID change
recovery" に従います。`docs/operations/deployment.md` の "`DEPLOYMENT_ID`" を参照。

**Outputs**（runbook と `scripts/deploy.sh` が使う）: `audit_anchors_bucket_name`、
`audit_anchor_s3_prefix`、`audit_anchor_publisher_task_role_arn`、
`ecs_audit_anchor_publisher_service_name`、
`ecs_audit_chain_verify_worker_service_name`、
`audit_anchor_publisher_task_definition_arn`、
`audit_chain_verify_worker_task_definition_arn`。`deploy.sh` は 6 サービスすべてを
更新・ロールバックします。

各アラームの意味と対処: `docs/operations/alerts.md`。

## Production Recommendations

- `db_skip_final_snapshot = false`, `db_deletion_protection = true`
- `db_multi_az = true`
- `redis_use_replication_group = true` + 暗号化/認証有効化
- `nat_gateway_count = 2` (AZ ごとに 1 つ)
- `app_desired_count >= 2`
- `create_acm_certificate = false` の場合は `acm_certificate_arn` を指定
- CloudFront を使う場合、証明書は `us-east-1` の ACM が必要
- 添付ファイルの暗号化を強化するには `s3_kms_key_arn` で SSE-KMS を有効化

## Security Notes

### CloudFront と添付ファイルのアクセス制御

CloudFront を有効化すると、S3 への直接アクセスは OAC で防止されますが、
CloudFront ディストリビューション自体はデフォルトで**公開**になります。

添付ファイルへのアクセスを認証済みユーザーに限定するには、以下のいずれかを検討してください:

- **CloudFront を無効化**（推奨）: `enable_cloudfront = false` のまま、アプリの API 経由で S3 に署名付き URL を発行してアクセスを制御
- **CloudFront 署名付き URL/Cookie**: CloudFront キーペアを作成し、アプリ側で署名付き URL を生成
- **Lambda@Edge**: リクエスト時にセッション Cookie を検証するカスタム認証

現在のデフォルト設定（`enable_cloudfront = false`）は最も安全です。
