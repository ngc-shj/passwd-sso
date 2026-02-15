################################################################################
# Network
################################################################################

output "vpc_id" {
  value = aws_vpc.main.id
}

################################################################################
# ALB
################################################################################

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

################################################################################
# Database & Cache
################################################################################

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "redis_endpoint" {
  value = local.redis_endpoint
}

################################################################################
# Secrets
################################################################################

output "app_secrets_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "jackson_secrets_arn" {
  value = aws_secretsmanager_secret.jackson.arn
}

################################################################################
# Storage
################################################################################

output "attachments_bucket_name" {
  value = var.enable_s3_attachments ? aws_s3_bucket.attachments[0].bucket : null
}

output "cloudfront_domain_name" {
  value = var.enable_cloudfront ? aws_cloudfront_distribution.attachments[0].domain_name : null
}

################################################################################
# ECR
################################################################################

output "ecr_app_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "ecr_jackson_repository_url" {
  value = aws_ecr_repository.jackson.repository_url
}

################################################################################
# ECS
################################################################################

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_app_service_name" {
  value = aws_ecs_service.app.name
}

output "ecs_jackson_service_name" {
  value = aws_ecs_service.jackson.name
}

################################################################################
# URLs
################################################################################

output "app_url" {
  value = "https://${var.app_domain}"
}

output "jackson_url" {
  value = "https://${var.jackson_domain}"
}

################################################################################
# Monitoring
################################################################################

output "sns_alarms_topic_arn" {
  value = var.enable_monitoring ? aws_sns_topic.alarms[0].arn : null
}

################################################################################
# Backup
################################################################################

output "backup_vault_arn" {
  value = var.enable_backup ? aws_backup_vault.main[0].arn : null
}
