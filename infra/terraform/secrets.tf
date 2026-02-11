################################################################################
# AWS Secrets Manager
################################################################################

resource "aws_secretsmanager_secret" "app" {
  name = "${local.name_prefix}-app-secrets"
  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(var.app_secrets)
}

resource "aws_secretsmanager_secret" "jackson" {
  name = "${local.name_prefix}-jackson-secrets"
  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "jackson" {
  secret_id     = aws_secretsmanager_secret.jackson.id
  secret_string = jsonencode(var.jackson_secrets)
}
