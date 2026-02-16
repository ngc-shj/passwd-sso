variable "project_name" {
  type        = string
  description = "Project name for resource naming"
}

variable "env" {
  type        = string
  description = "Environment name (e.g. dev, prod)"
}

variable "aws_region" {
  type        = string
  description = "AWS region"
}

variable "azs" {
  type        = list(string)
  description = "Availability zones"
}

variable "vpc_cidr" {
  type        = string
  description = "VPC CIDR"
}

variable "public_subnet_cidrs" {
  type        = list(string)
  description = "Public subnet CIDRs"
}

variable "private_subnet_cidrs" {
  type        = list(string)
  description = "Private subnet CIDRs"
}

variable "nat_gateway_count" {
  type        = number
  default     = 1
  description = "Number of NAT gateways"
}

variable "app_domain" {
  type        = string
  description = "Public domain for app (e.g. app.example.com)"
}

variable "jackson_domain" {
  type        = string
  description = "Public domain for SAML Jackson (e.g. sso.example.com)"
}

variable "hosted_zone_id" {
  type        = string
  description = "Route53 hosted zone ID"
}

variable "create_acm_certificate" {
  type        = bool
  default     = true
  description = "Whether to create ACM certificate"
}

variable "acm_certificate_arn" {
  type        = string
  default     = ""
  description = "Existing ACM certificate ARN if not created"
}

variable "app_image" {
  type        = string
  description = "Container image for app service"
}

variable "jackson_image" {
  type        = string
  description = "Container image for jackson service"
}

variable "app_cpu" {
  type        = number
  default     = 512
  description = "Fargate CPU for app"
}

variable "app_memory" {
  type        = number
  default     = 1024
  description = "Fargate memory for app"
}

variable "jackson_cpu" {
  type        = number
  default     = 256
  description = "Fargate CPU for jackson"
}

variable "jackson_memory" {
  type        = number
  default     = 512
  description = "Fargate memory for jackson"
}

variable "app_desired_count" {
  type    = number
  default = 1
}

variable "jackson_desired_count" {
  type    = number
  default = 1
}

variable "db_username" {
  type        = string
  description = "RDS master username"
}

variable "db_password" {
  type        = string
  description = "RDS master password"
  sensitive   = true
}

variable "db_name" {
  type    = string
  default = "passwd_sso"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "app_secrets" {
  type        = map(string)
  description = "Secrets for app (JSON stored in Secrets Manager)"
  sensitive   = true
}

variable "jackson_secrets" {
  type        = map(string)
  description = "Secrets for jackson (JSON stored in Secrets Manager)"
  sensitive   = true
}

variable "db_apply_immediately" {
  type        = bool
  default     = true
  description = "Apply RDS changes immediately"
}

variable "db_skip_final_snapshot" {
  type        = bool
  default     = true
  description = "Skip final snapshot on RDS deletion"
}

variable "db_multi_az" {
  type        = bool
  default     = false
  description = "Enable Multi-AZ for RDS"
}

variable "db_backup_retention_days" {
  type        = number
  default     = 7
  description = "Backup retention days"
}

variable "db_deletion_protection" {
  type        = bool
  default     = false
  description = "Enable deletion protection for RDS"
}

variable "redis_use_replication_group" {
  type        = bool
  default     = false
  description = "Use replication group (recommended for prod)"
}

variable "redis_replication_group_id" {
  type        = string
  default     = ""
  description = "Replication group id (optional override)"
}

variable "redis_auth_token" {
  type        = string
  default     = ""
  description = "Redis auth token (required when encryption is enabled)"
  sensitive   = true
}

variable "redis_transit_encryption_enabled" {
  type    = bool
  default = false
}

variable "redis_at_rest_encryption_enabled" {
  type    = bool
  default = false
}

variable "redis_num_node_groups" {
  type    = number
  default = 1
}

variable "redis_replicas_per_node_group" {
  type    = number
  default = 1
}

variable "enable_s3_attachments" {
  type        = bool
  default     = true
  description = "Create S3 bucket for attachments"
}

variable "attachments_bucket_name" {
  type        = string
  default     = ""
  description = "S3 bucket name for attachments (optional override)"
}

variable "s3_kms_key_arn" {
  type        = string
  default     = ""
  description = "KMS key ARN for S3 SSE-KMS encryption. If empty, SSE-S3 (AES256) is used."
}

variable "enable_cloudfront" {
  type        = bool
  default     = false
  description = "Create CloudFront distribution for attachments"
}

variable "cloudfront_aliases" {
  type        = list(string)
  default     = []
  description = "Custom domain aliases for CloudFront"
}

variable "cloudfront_certificate_arn" {
  type        = string
  default     = ""
  description = "ACM cert ARN (us-east-1) for CloudFront"
}

variable "log_retention_days" {
  type        = number
  default     = 14
  description = "CloudWatch log retention in days"
}

variable "enable_monitoring" {
  type        = bool
  default     = true
  description = "Enable CloudWatch metric filters and alarms"
}

variable "alarm_email" {
  type        = string
  default     = ""
  description = "Email address for alarm notifications. Empty = no SNS subscription."
}

variable "alarm_5xx_threshold" {
  type        = number
  default     = 5
  description = "5xx error count threshold per 5-minute period"
}

variable "alarm_latency_threshold_ms" {
  type        = number
  default     = 5000
  description = "API latency threshold in milliseconds"
}

variable "alarm_rds_connections_threshold" {
  type        = number
  default     = 80
  description = "RDS connection count alarm threshold. Default 80 assumes db.t4g.micro (max_connections ≈ 100). Review when changing instance type."
}

# ── Backup ─────────────────────────────────────────────

variable "enable_backup" {
  type        = bool
  default     = true
  description = "Enable AWS Backup for RDS"
}

variable "backup_vault_lock" {
  type        = bool
  default     = false
  description = "Enable Vault Lock (WORM). WARNING: irreversible after cooloff period"
}

variable "backup_vault_lock_cooloff_days" {
  type        = number
  default     = 3
  description = "Days before Vault Lock becomes immutable (min 3)"
}

variable "backup_min_retention_days" {
  type        = number
  default     = 7
  description = "Minimum backup retention (Vault Lock enforcement)"
}

variable "backup_max_retention_days" {
  type        = number
  default     = 120
  description = "Maximum backup retention (Vault Lock enforcement)"
}

variable "backup_retention_days" {
  type        = number
  default     = 35
  description = "Days to retain AWS Backup recovery points"
}

variable "backup_cross_region" {
  type        = string
  default     = ""
  description = "DR region for cross-region backup copy. Empty = disabled. (e.g. ap-southeast-1)"

  validation {
    condition     = var.backup_cross_region == "" || can(regex("^[a-z]{2}-[a-z]+-\\d+$", var.backup_cross_region))
    error_message = "backup_cross_region must be a valid AWS region (e.g. ap-southeast-1) or empty string."
  }
}

variable "backup_alert_email" {
  type        = string
  default     = ""
  description = "Email for backup failure alerts (SNS). Empty = alerts disabled."
}

variable "db_backup_window" {
  type        = string
  default     = "18:00-19:00"
  description = "RDS preferred backup window (UTC). 03:00-04:00 JST"

  validation {
    condition     = can(regex("^([01]\\d|2[0-3]):[0-5]\\d-([01]\\d|2[0-3]):[0-5]\\d$", var.db_backup_window))
    error_message = "db_backup_window must be in HH:MM-HH:MM format with valid times (e.g. 18:00-19:00)."
  }
}

variable "enable_s3_object_lock" {
  type        = bool
  default     = false
  description = "Enable S3 Object Lock (WORM/Compliance). Only for new buckets."
}

variable "s3_object_lock_days" {
  type        = number
  default     = 90
  description = "S3 Object Lock retention days (Compliance mode)"
}

variable "tags" {
  type    = map(string)
  default = {}
}
