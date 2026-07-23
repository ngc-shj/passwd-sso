################################################################################
# AWS Secrets Manager
#
# SECURITY (2026-07 review, F3): the `secret_string` values below flow through
# Terraform STATE in plaintext (marking a variable `sensitive` hides it from CLI
# output but NOT from state). With the default local backend, that means real
# DB / OAuth / Auth / Redis / master-key values land in `terraform.tfstate` on
# disk — and any state backup, CI artifact, or developer laptop that holds it.
#
# Required mitigations:
#   1. Use the ENCRYPTED remote backend (S3 + `encrypt = true` + versioning +
#      strict IAM + access logging) — see backend.tf. Never leave state local
#      for a deployment that carries real secrets.
#   2. Preferred hardening (tracked follow-up): create the secret CONTAINERS here
#      and inject the VALUES out-of-band (e.g. `aws secretsmanager put-secret-value`
#      from a CI secret store), so the values never enter Terraform state at all.
#      Until that rework lands, (1) is the operative control.
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
