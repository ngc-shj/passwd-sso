# バックアップ・リカバリ戦略

## RPO / RTO

| 指標 | 目標 | 手段 |
|------|------|------|
| RPO (データ損失許容) | 1 時間 | RDS PITR (5 分間隔 WAL) + 日次スナップショット |
| RTO (復旧時間目標) | 2 時間 | RDS スナップショット復元 + ECS サービス再起動 |

## ランサムウェア対策の 3 層防御

| 層 | 対象 | 機構 | 効果 |
|----|------|------|------|
| 1 | RDS スナップショット | AWS Backup Vault Lock (Compliance) | root でも削除不可 |
| 2 | S3 添付ファイル | S3 Object Lock (Compliance) | 保持期間中は root でも削除不可 |
| 3 | RDS ネイティブ | backup_retention + deletion_protection | 基本保護 |

## バックアップスケジュール

| バックアップ | スケジュール (UTC) | JST | 保持期間 |
|-------------|-------------------|-----|---------|
| RDS ネイティブ (PITR) | 18:00-19:00 | 03:00-04:00 | `db_backup_retention_days` (default: 7) |
| AWS Backup (日次スナップショット) | 19:00 | 04:00 | `backup_retention_days` (default: 35) |
| クロスリージョンコピー | AWS Backup 完了後自動 | - | `backup_retention_days` |

RDS ネイティブと AWS Backup は 1 時間ずらして I/O 負荷を分散。

## AWS Backup Vault Lock

Vault Lock は **Compliance mode** で適用される。

- `changeable_for_days` (default: 3): ロック適用後の猶予期間。この間は設定変更可能
- 猶予期間終了後: **不可逆** — Compliance mode が確定
- 確定後は `min_retention_days` 未満でのバックアップ削除が不可能
- Vault 自体の削除も、中にリカバリポイントがある限り不可

### 初回適用手順

1. `backup_vault_lock = false` でデプロイし動作確認
2. バックアップが正常に取得されることを確認
3. `backup_vault_lock = true` に変更して `terraform apply`
4. 猶予期間 (3 日) 内に設定を確認
5. 猶予期間終了後、Compliance mode が確定

## S3 Object Lock

添付ファイルバケットに **Compliance mode** の Object Lock を適用。

- 保持期間中 (`s3_object_lock_days`, default: 90 日) は root でも削除不可
- `GOVERNANCE` mode ではなく `COMPLIANCE` mode を採用 (Governance は `s3:BypassGovernanceRetention` で回避可能)
- **制限**: バケット作成時に `object_lock_enabled = true` が必要。既存バケットへの後付け不可
- 既存環境は `enable_s3_object_lock = false` (default) で影響なし

## バックアップ失敗監視

`backup_alert_email` を設定すると、以下のイベントを SNS メール通知:

| EventBridge ルール | 検知対象 |
|-------------------|---------|
| Backup Job State Change | FAILED / ABORTED / EXPIRED |
| Copy Job State Change | FAILED / ABORTED / EXPIRED (クロスリージョンコピー失敗) |

## 復元手順

### RDS スナップショットからの復元

```bash
# 1. 利用可能なリカバリポイントを確認
aws backup list-recovery-points-by-backup-vault \
  --backup-vault-name <VAULT_NAME> \
  --query 'RecoveryPoints[*].[RecoveryPointArn,CreationDate,Status]' \
  --output table

# 2. リカバリポイントから RDS インスタンスを復元
aws backup start-restore-job \
  --recovery-point-arn <RECOVERY_POINT_ARN> \
  --iam-role-arn <BACKUP_ROLE_ARN> \
  --metadata '{
    "DBInstanceIdentifier": "<NEW_INSTANCE_ID>",
    "DBInstanceClass": "db.t4g.micro",
    "DBSubnetGroupName": "<SUBNET_GROUP>",
    "VpcSecurityGroupIds": "<SG_ID>"
  }'

# 3. 復元ジョブの状態を確認
aws backup describe-restore-job --restore-job-id <JOB_ID>

# 4. 復元後の RDS エンドポイントを確認
aws rds describe-db-instances \
  --db-instance-identifier <NEW_INSTANCE_ID> \
  --query 'DBInstances[0].Endpoint'

# 5. アプリケーションの DATABASE_URL を更新
# Secrets Manager の値を新しいエンドポイントに変更

# 6. ECS サービスを再デプロイ
aws ecs update-service \
  --cluster <CLUSTER_NAME> \
  --service <SERVICE_NAME> \
  --force-new-deployment
```

### RDS PITR (Point-in-Time Recovery)

```bash
# 特定時刻の状態に復元 (PITR)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier <ORIGINAL_INSTANCE_ID> \
  --target-db-instance-identifier <NEW_INSTANCE_ID> \
  --restore-time "2026-01-15T10:30:00Z" \
  --db-subnet-group-name <SUBNET_GROUP> \
  --vpc-security-group-ids <SG_ID>
```

## 月次復元訓練チェックリスト

以下を毎月実施し、結果を記録する:

- [ ] AWS Backup からスナップショット復元を実行
- [ ] 復元した RDS インスタンスに接続確認
- [ ] アプリケーション起動 → ログイン → Vault 解錠
- [ ] 暗号化データの復号確認 (パスワードエントリの表示)
- [ ] RTO 測定 (復元開始からサービス復旧までの時間)
- [ ] クロスリージョンコピーの到達確認 (DR vault にリカバリポイントが存在すること)
- [ ] テスト用インスタンスの削除
- [ ] 結果の記録・報告

## KMS キー保護

本 Terraform コードではデフォルトで AWS Managed Key を使用:

- Backup Vault: `aws/backup`
- RDS: `aws/rds`
- S3: SSE-S3 (AES256)

### CMK (カスタマー管理キー) を使用する場合の注意

CMK に依存する場合、キー停止・削除予約で **実質復元不能化** のリスクがある。

対策:

- `kms:ScheduleKeyDeletion` / `kms:DisableKey` を IAM ポリシーで制限
- キー管理者とバックアップ管理者の職務分離 (Separation of Duties)
- KMS キー削除の待機期間を最大 30 日に設定
- CloudTrail で KMS API コールを監視

## Terraform 変数リファレンス

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `enable_backup` | `true` | AWS Backup の有効化 |
| `backup_vault_lock` | `false` | Vault Lock (WORM) の有効化。猶予期間後は不可逆 |
| `backup_vault_lock_cooloff_days` | `3` | Vault Lock の猶予期間 (最小 3 日) |
| `backup_min_retention_days` | `7` | Vault Lock 最小保持日数 |
| `backup_max_retention_days` | `120` | Vault Lock 最大保持日数 |
| `backup_retention_days` | `35` | AWS Backup リカバリポイント保持日数 |
| `backup_cross_region` | `""` | DR リージョン (空 = 無効)。例: `ap-southeast-1` |
| `backup_alert_email` | `""` | バックアップ失敗通知メール (空 = 無効) |
| `db_backup_window` | `"18:00-19:00"` | RDS バックアップウィンドウ (UTC) |
| `enable_s3_object_lock` | `false` | S3 Object Lock (新規バケットのみ) |
| `s3_object_lock_days` | `90` | Object Lock 保持日数 (Compliance mode) |

## 本番適用後の必須検証

以下すべて完了するまで本番リリース完了とみなさない:

1. `aws backup start-backup-job` の手動実行 → バックアップ正常完了を確認
2. クロスリージョンコピーの到達確認 (DR vault にリカバリポイントが存在すること)
3. Vault Lock 有効化後の「削除不能」検証 (非本番環境で `aws backup delete-recovery-point` が拒否されることを確認)
4. 月次リストア演習: スナップショットから RDS 復元 → アプリ起動 → ログイン → 暗号復号の E2E 確認 → RTO 測定
5. EventBridge → SNS 通知到達確認 (テスト用に `aws events put-events` で FAILED イベントを送信)
