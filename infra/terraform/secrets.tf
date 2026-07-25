################################################################################
# AWS Secrets Manager
#
# SECURITY (2026-07 review, F3): secret VALUES must never enter Terraform state.
# Marking a variable `sensitive` hides it from CLI output but NOT from state —
# with any backend, an `aws_secretsmanager_secret_version` whose `secret_string`
# comes from a variable writes the plaintext into `terraform.tfstate`.
#
# Therefore Terraform manages only the secret CONTAINERS here. The VALUES are
# injected OUT-OF-BAND after apply, so they never touch state:
#
#   scripts/put-terraform-secrets.sh   # aws secretsmanager put-secret-value ...
#
# `ignore_changes = [secret_string]`-style handling is unnecessary because no
# `_version` resource exists — Terraform has no opinion on the value at all.
# The ECS task definitions reference the container ARN + JSON key
# (`${arn}:DATABASE_URL::`), which resolves against whatever value the
# out-of-band step wrote. Populate the secrets BEFORE the ECS services start,
# or the tasks fail to launch (Secrets Manager returns ResourceNotFound for an
# empty secret).
#
# Defense-in-depth: still use the ENCRYPTED remote backend (backend.tf) with
# versioning, strict IAM, and access logging — even without secret values in
# state, the state carries infra topology worth protecting.
#
# RESIDUAL secrets that DO enter state (not all secrets are out-of-band):
#   - RDS master password: NONE — AWS-managed via manage_master_user_password
#     (database.tf), stored in RDS's own Secrets Manager secret, not state (#4).
#   - ElastiCache Redis auth_token: DOES enter state when configured via
#     var.redis_auth_token — ElastiCache has no AWS-managed-token equivalent.
#     The encrypted remote backend + strict IAM above are the operative controls;
#     the token is rotatable out-of-band (database.tf ignore_changes = [auth_token]).
# So "no secret values in state" holds for the app/jackson/RDS secrets but NOT
# the Redis auth token — treat state as sensitive accordingly.
################################################################################

resource "aws_secretsmanager_secret" "app" {
  name = "${local.name_prefix}-app-secrets"
  tags = local.tags
}

resource "aws_secretsmanager_secret" "jackson" {
  name = "${local.name_prefix}-jackson-secrets"
  tags = local.tags
}
