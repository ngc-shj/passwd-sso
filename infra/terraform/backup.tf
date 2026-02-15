################################################################################
# AWS Backup — Ransomware-Resistant Vault
################################################################################

# Backup Vault (WORM: Vault Lock で削除不可)
resource "aws_backup_vault" "main" {
  count = var.enable_backup ? 1 : 0
  name  = "${local.name_prefix}-vault"
  tags  = local.tags
}

# Vault Lock (Compliance mode — root でもロック期間中は削除不可)
resource "aws_backup_vault_lock_configuration" "main" {
  count               = var.enable_backup && var.backup_vault_lock ? 1 : 0
  backup_vault_name   = aws_backup_vault.main[0].name
  min_retention_days  = var.backup_min_retention_days
  max_retention_days  = var.backup_max_retention_days
  changeable_for_days = var.backup_vault_lock_cooloff_days
  # changeable_for_days: ロック適用後の猶予期間 (設定変更可能)
  # 猶予期間後は Compliance mode (不可逆) になる
}

# Backup Plan (日次スナップショット + クロスリージョンコピー)
resource "aws_backup_plan" "main" {
  count = var.enable_backup ? 1 : 0
  name  = "${local.name_prefix}-daily"

  rule {
    rule_name         = "daily-backup"
    target_vault_name = aws_backup_vault.main[0].name
    schedule          = "cron(0 19 * * ? *)" # 04:00 JST (RDS native と 1h ずらし)
    start_window      = 60                   # 開始猶予 60 分
    completion_window = 180                  # 完了猶予 180 分

    lifecycle {
      delete_after = var.backup_retention_days
    }

    # クロスリージョンコピー (ランサムウェア/リージョン障害対策)
    dynamic "copy_action" {
      for_each = var.backup_cross_region != "" ? [1] : []
      content {
        destination_vault_arn = aws_backup_vault.cross_region[0].arn
        lifecycle {
          delete_after = var.backup_retention_days
        }
      }
    }
  }

  tags = local.tags
}

################################################################################
# Cross-Region Vault (DR 用、別リージョン)
################################################################################

# DR 用プロバイダー (cross_region 未指定時は primary region にフォールバック)
provider "aws" {
  alias  = "dr"
  region = var.backup_cross_region != "" ? var.backup_cross_region : var.aws_region
}

resource "aws_backup_vault" "cross_region" {
  count    = var.enable_backup && var.backup_cross_region != "" ? 1 : 0
  provider = aws.dr
  name     = "${local.name_prefix}-vault-dr"
  tags     = local.tags
}

# DR vault にも Vault Lock を適用
resource "aws_backup_vault_lock_configuration" "cross_region" {
  count               = var.enable_backup && var.backup_cross_region != "" && var.backup_vault_lock ? 1 : 0
  provider            = aws.dr
  backup_vault_name   = aws_backup_vault.cross_region[0].name
  min_retention_days  = var.backup_min_retention_days
  max_retention_days  = var.backup_max_retention_days
  changeable_for_days = var.backup_vault_lock_cooloff_days
}

################################################################################
# IAM Role for AWS Backup
################################################################################

resource "aws_iam_role" "backup" {
  count = var.enable_backup ? 1 : 0
  name  = "${local.name_prefix}-backup"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "backup.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  count      = var.enable_backup ? 1 : 0
  role       = aws_iam_role.backup[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "backup_restore" {
  count      = var.enable_backup ? 1 : 0
  role       = aws_iam_role.backup[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

# Selection: RDS を対象に含める
resource "aws_backup_selection" "rds" {
  count        = var.enable_backup ? 1 : 0
  name         = "${local.name_prefix}-rds"
  plan_id      = aws_backup_plan.main[0].id
  iam_role_arn = aws_iam_role.backup[0].arn

  resources = [
    aws_db_instance.main.arn,
  ]
}

################################################################################
# Backup Job Failure Monitoring (EventBridge → SNS)
################################################################################

resource "aws_sns_topic" "backup_alerts" {
  count = var.enable_backup && var.backup_alert_email != "" ? 1 : 0
  name  = "${local.name_prefix}-backup-alerts"
  tags  = local.tags
}

resource "aws_sns_topic_subscription" "backup_alerts_email" {
  count     = var.enable_backup && var.backup_alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.backup_alerts[0].arn
  protocol  = "email"
  endpoint  = var.backup_alert_email
}

# SNS Topic Policy — EventBridge からの Publish を許可 (SourceArn で最小権限)
resource "aws_sns_topic_policy" "backup_alerts" {
  count = var.enable_backup && var.backup_alert_email != "" ? 1 : 0
  arn   = aws_sns_topic.backup_alerts[0].arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.backup_alerts[0].arn
      Condition = {
        ArnEquals = {
          "aws:SourceArn" = [
            aws_cloudwatch_event_rule.backup_job_failure[0].arn,
            aws_cloudwatch_event_rule.backup_copy_failure[0].arn,
          ]
        }
      }
    }]
  })
}

# Backup Job 失敗検知 (FAILED / ABORTED / EXPIRED)
resource "aws_cloudwatch_event_rule" "backup_job_failure" {
  count       = var.enable_backup && var.backup_alert_email != "" ? 1 : 0
  name        = "${local.name_prefix}-backup-job-fail"
  description = "Detect AWS Backup job failures"

  event_pattern = jsonencode({
    source      = ["aws.backup"]
    detail-type = ["Backup Job State Change"]
    detail = {
      state           = ["FAILED", "ABORTED", "EXPIRED"]
      backupVaultName = [aws_backup_vault.main[0].name]
    }
  })

  tags = local.tags
}

resource "aws_cloudwatch_event_target" "backup_job_failure" {
  count     = var.enable_backup && var.backup_alert_email != "" ? 1 : 0
  rule      = aws_cloudwatch_event_rule.backup_job_failure[0].name
  target_id = "backup-job-fail-sns"
  arn       = aws_sns_topic.backup_alerts[0].arn
}

# Copy Job 失敗検知 (クロスリージョンコピーの失敗)
resource "aws_cloudwatch_event_rule" "backup_copy_failure" {
  count       = var.enable_backup && var.backup_alert_email != "" ? 1 : 0
  name        = "${local.name_prefix}-backup-copy-fail"
  description = "Detect AWS Backup cross-region copy failures"

  event_pattern = jsonencode({
    source      = ["aws.backup"]
    detail-type = ["Copy Job State Change"]
    detail = {
      state                 = ["FAILED", "ABORTED", "EXPIRED"]
      sourceBackupVaultName = [aws_backup_vault.main[0].name]
    }
  })

  tags = local.tags
}

resource "aws_cloudwatch_event_target" "backup_copy_failure" {
  count     = var.enable_backup && var.backup_alert_email != "" ? 1 : 0
  rule      = aws_cloudwatch_event_rule.backup_copy_failure[0].name
  target_id = "backup-copy-fail-sns"
  arn       = aws_sns_topic.backup_alerts[0].arn
}
