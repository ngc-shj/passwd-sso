# Backup & Recovery Strategy

## RPO / RTO

| Metric | Target | Mechanism |
|--------|--------|-----------|
| RPO (Recovery Point Objective) | 1 hour | RDS PITR (5-min WAL interval) + daily snapshots |
| RTO (Recovery Time Objective) | 2 hours | RDS snapshot restore + ECS service restart |

## 3-Layer Ransomware Defense

| Layer | Target | Mechanism | Effect |
|-------|--------|-----------|--------|
| 1 | RDS snapshots | AWS Backup Vault Lock (Compliance) | Root cannot delete |
| 2 | S3 attachments | S3 Object Lock (Compliance) | Root cannot delete during retention |
| 3 | RDS native | backup_retention + deletion_protection | Basic protection |

## Backup Schedule

| Backup | Schedule (UTC) | JST | Retention |
|--------|---------------|-----|-----------|
| RDS native (PITR) | 18:00-19:00 | 03:00-04:00 | `db_backup_retention_days` (default: 7) |
| AWS Backup (daily snapshot) | 19:00 | 04:00 | `backup_retention_days` (default: 35) |
| Cross-region copy | Automatic after AWS Backup | - | `backup_retention_days` |

RDS native and AWS Backup are staggered by 1 hour to distribute I/O load.

## AWS Backup Vault Lock

Vault Lock is applied in **Compliance mode**.

- `changeable_for_days` (default: 3): Cooloff period after lock is applied. Settings can be changed during this period
- After cooloff period: **Irreversible** — Compliance mode is permanent
- After confirmation, backup deletion below `min_retention_days` is impossible
- Vault itself cannot be deleted while it contains recovery points

### Initial Deployment Steps

1. Deploy with `backup_vault_lock = false` and verify operation
2. Confirm backups are being created successfully
3. Change to `backup_vault_lock = true` and run `terraform apply`
4. Verify settings during the cooloff period (3 days)
5. After cooloff period, Compliance mode becomes permanent

## S3 Object Lock

Attachments bucket uses **Compliance mode** Object Lock.

- During retention period (`s3_object_lock_days`, default: 90 days), even root cannot delete
- Uses `COMPLIANCE` mode, not `GOVERNANCE` (Governance can be bypassed via `s3:BypassGovernanceRetention`)
- **Limitation**: Requires `object_lock_enabled = true` at bucket creation. Cannot be added to existing buckets
- Existing environments use `enable_s3_object_lock = false` (default) with no impact

## Backup Failure Monitoring

When `backup_alert_email` is configured, the following events trigger SNS email notifications:

| EventBridge Rule | Detection Target |
|-----------------|-----------------|
| Backup Job State Change | FAILED / ABORTED / EXPIRED |
| Copy Job State Change | FAILED / ABORTED / EXPIRED (cross-region copy failures) |

## Recovery Procedures

### Restore from RDS Snapshot

```bash
# 1. List available recovery points
aws backup list-recovery-points-by-backup-vault \
  --backup-vault-name <VAULT_NAME> \
  --query 'RecoveryPoints[*].[RecoveryPointArn,CreationDate,Status]' \
  --output table

# 2. Restore RDS instance from recovery point
aws backup start-restore-job \
  --recovery-point-arn <RECOVERY_POINT_ARN> \
  --iam-role-arn <BACKUP_ROLE_ARN> \
  --metadata '{
    "DBInstanceIdentifier": "<NEW_INSTANCE_ID>",
    "DBInstanceClass": "db.t4g.micro",
    "DBSubnetGroupName": "<SUBNET_GROUP>",
    "VpcSecurityGroupIds": "<SG_ID>"
  }'

# 3. Check restore job status
aws backup describe-restore-job --restore-job-id <JOB_ID>

# 4. Get restored RDS endpoint
aws rds describe-db-instances \
  --db-instance-identifier <NEW_INSTANCE_ID> \
  --query 'DBInstances[0].Endpoint'

# 5. Update application DATABASE_URL
# Update the Secrets Manager value with the new endpoint

# 6. Redeploy ECS service
aws ecs update-service \
  --cluster <CLUSTER_NAME> \
  --service <SERVICE_NAME> \
  --force-new-deployment
```

### RDS PITR (Point-in-Time Recovery)

```bash
# Restore to a specific point in time
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier <ORIGINAL_INSTANCE_ID> \
  --target-db-instance-identifier <NEW_INSTANCE_ID> \
  --restore-time "2026-01-15T10:30:00Z" \
  --db-subnet-group-name <SUBNET_GROUP> \
  --vpc-security-group-ids <SG_ID>
```

## Monthly Recovery Drill Checklist

Execute monthly and record results:

- [ ] Execute snapshot restore from AWS Backup
- [ ] Verify connection to restored RDS instance
- [ ] Application startup → Login → Vault unlock
- [ ] Verify encrypted data decryption (display password entries)
- [ ] Measure RTO (time from restore start to service recovery)
- [ ] Verify cross-region copy arrival (recovery point exists in DR vault)
- [ ] Delete test instances
- [ ] Record and report results

## KMS Key Protection

This Terraform code uses AWS Managed Keys by default:

- Backup Vault: `aws/backup`
- RDS: `aws/rds`
- S3: SSE-S3 (AES256)

### Considerations When Using CMK (Customer Managed Keys)

When depending on CMK, key disabling/deletion scheduling creates a risk of **effectively unrecoverable** backups.

Mitigations:

- Restrict `kms:ScheduleKeyDeletion` / `kms:DisableKey` via IAM policies
- Separation of Duties between key administrators and backup administrators
- Set KMS key deletion waiting period to maximum 30 days
- Monitor KMS API calls via CloudTrail

## Terraform Variable Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `enable_backup` | `true` | Enable AWS Backup |
| `backup_vault_lock` | `false` | Enable Vault Lock (WORM). Irreversible after cooloff |
| `backup_vault_lock_cooloff_days` | `3` | Vault Lock cooloff period (min 3 days) |
| `backup_min_retention_days` | `7` | Vault Lock minimum retention |
| `backup_max_retention_days` | `120` | Vault Lock maximum retention |
| `backup_retention_days` | `35` | AWS Backup recovery point retention |
| `backup_cross_region` | `""` | DR region (empty = disabled). e.g. `ap-southeast-1` |
| `backup_alert_email` | `""` | Backup failure notification email (empty = disabled) |
| `db_backup_window` | `"18:00-19:00"` | RDS backup window (UTC) |
| `enable_s3_object_lock` | `false` | S3 Object Lock (new buckets only) |
| `s3_object_lock_days` | `90` | Object Lock retention days (Compliance mode) |

## Required Post-Deployment Verification

The following must all be completed before considering production deployment done:

1. Manual execution of `aws backup start-backup-job` → Verify successful backup completion
2. Cross-region copy arrival verification (recovery point exists in DR vault)
3. Vault Lock "undeletable" verification (confirm `aws backup delete-recovery-point` is rejected in non-production)
4. Monthly restore drill: snapshot → RDS restore → app startup → login → decryption E2E verification → RTO measurement
5. EventBridge → SNS notification delivery verification (send test FAILED event via `aws events put-events`)
