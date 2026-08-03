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

## Self-Hosted Backups (Docker Compose)

The sections above describe the AWS path (RDS snapshots, PITR, Backup Vault
Lock). A self-hosted deployment has none of that, and until `scripts/backup-db.sh`
landed the repository documented no backup procedure for it at all.

```bash
scripts/backup-db.sh                       # defaults: ~/passwd-sso-backups, keep 7
BACKUP_DIR=/mnt/vault BACKUP_RETAIN=30 scripts/backup-db.sh
BACKUP_DRY_RUN=true scripts/backup-db.sh   # preview the prune, dump nothing
```

Only one run may hold a destination at a time. If a run is killed hard — SIGKILL,
OOM, power loss — the lock survives it and the next run stops with
`BACKUP_ERR:LOCKED` naming the holder. That is deliberate: taking the lock
automatically raced two runs into one directory in every variant tried. When you
have confirmed no backup is running, take it explicitly:

```bash
BACKUP_FORCE_UNLOCK=true scripts/backup-db.sh
```

Each run produces one directory:

```
20260803T164500Z/
  passwd_sso.dump    application data (pg_dump -Fc --create)
  jackson.dump       SSO connection records — restoring without this loses every IdP binding
  globals.sql        cluster roles (pg_dumpall --globals-only --no-role-passwords)
  MANIFEST           host, mode, per-member size and entry count, tool versions
```

What the script guarantees, and what it does not:

- **Validated, not merely written.** Each archive is read back by `pg_restore`
  — the implementation that will restore it — before the run is published. A
  truncated dump is non-empty and unreadable, which a size check cannot detect.
- **Atomic.** Work happens in `<stamp>.partial` and is renamed only after every
  member validates, so a half-written run is never mistaken for a generation.
  A validation failure is kept as `<stamp>.FAILED` for diagnosis rather than
  deleted: the fault may be the reader, and destroying a possibly-good archive
  to punish the validator is the wrong direction.
- **A failed run's corpus is kept, but not forever.** A validation failure is
  retained as `<stamp>.FAILED` for diagnosis; those are bounded by `BACKUP_RETAIN`
  and by `BACKUP_FAILED_MAX_AGE_DAYS` (default 7). A retained failure is a full
  plaintext copy of the database, so it is subject to the same handling as a
  successful generation.
- **The pruner never endangers the run just taken.** It is excluded by resolved
  path, not by assuming it sorts newest — a clock step or two hosts sharing one
  destination can make it the oldest name.
- **`globals.sql` carries structural assurance only.** It is plain SQL, so
  `pg_restore` is not its reader; the script checks the trailing completion
  marker and the role count.
- **The archives are plaintext secrets.** They hold every ciphertext blob, the
  audit log, and every wrapped key. The script verifies the destination's mode,
  owner, extended ACLs, mount options and ancestors before writing, and refuses
  a filesystem that cannot enforce ownership — a USB stick is a case for an
  encrypted volume, not for writing the corpus unprotected. **Encryption at
  rest and offsite replication are out of scope**: anyone who can read
  `$BACKUP_DIR` has the database.

Restoring is deliberately not the script's job. Follow
[dev-host-migration.md](../dev-host-migration.md) step 5 — the ordering
constraint there (empty volume → initdb → restore) is what lands the correct
roles and ACLs.
