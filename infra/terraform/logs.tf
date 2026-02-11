################################################################################
# CloudWatch Log Groups
################################################################################

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name_prefix}/app"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "jackson" {
  name              = "/ecs/${local.name_prefix}/jackson"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}
