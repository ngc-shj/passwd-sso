locals {
  name_prefix = "${var.project_name}-${var.env}"
  tags = merge(var.tags, {
    Project = var.project_name
    Env     = var.env
  })

  certificate_arn = var.create_acm_certificate ? aws_acm_certificate.app[0].arn : var.acm_certificate_arn

  attachments_bucket_name = var.attachments_bucket_name != "" ? var.attachments_bucket_name : "${local.name_prefix}-attachments"

  redis_endpoint = var.redis_use_replication_group ? aws_elasticache_replication_group.main[0].primary_endpoint_address : aws_elasticache_cluster.main[0].cache_nodes[0].address
}
