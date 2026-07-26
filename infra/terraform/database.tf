################################################################################
# RDS PostgreSQL
################################################################################

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnets"
  subnet_ids = aws_subnet.private[*].id
  tags       = merge(local.tags, { Name = "${local.name_prefix}-db-subnets" })
}

# SECURITY (#4): the DB master password is AWS-managed, NOT passed via a
# Terraform variable. `manage_master_user_password = true` makes RDS store the
# password in its OWN dedicated Secrets Manager secret (rotatable), so the
# plaintext never enters Terraform state — a var-supplied `password` would. The
# app connects via DATABASE_URL (app Secrets Manager secret, injected
# out-of-band), so it does not need the master password here.
resource "aws_db_instance" "main" {
  identifier                  = "${local.name_prefix}-db"
  engine                      = "postgres"
  engine_version              = "16.3"
  instance_class              = var.db_instance_class
  allocated_storage           = var.db_allocated_storage
  db_subnet_group_name        = aws_db_subnet_group.main.name
  vpc_security_group_ids      = [aws_security_group.rds.id]
  db_name                     = var.db_name
  username                    = var.db_username
  manage_master_user_password = true
  skip_final_snapshot         = var.db_skip_final_snapshot
  final_snapshot_identifier   = var.db_skip_final_snapshot ? null : "${local.name_prefix}-db-final"
  publicly_accessible         = false
  multi_az                    = var.db_multi_az
  apply_immediately           = var.db_apply_immediately
  backup_retention_period     = var.db_backup_retention_days
  backup_window               = var.db_backup_window
  deletion_protection         = var.db_deletion_protection
  storage_encrypted           = true
  tags                        = merge(local.tags, { Name = "${local.name_prefix}-db" })
}

################################################################################
# ElastiCache Redis
################################################################################

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis-subnets"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_cluster" "main" {
  count                = var.redis_use_replication_group ? 0 : 1
  cluster_id           = "${local.name_prefix}-redis"
  engine               = "redis"
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]
  tags                 = merge(local.tags, { Name = "${local.name_prefix}-redis" })
}

resource "aws_elasticache_replication_group" "main" {
  count                      = var.redis_use_replication_group ? 1 : 0
  replication_group_id       = var.redis_replication_group_id != "" ? var.redis_replication_group_id : "${local.name_prefix}-redis"
  description                = "passwd-sso redis"
  engine                     = "redis"
  node_type                  = var.redis_node_type
  num_node_groups            = var.redis_num_node_groups
  replicas_per_node_group    = var.redis_replicas_per_node_group
  port                       = 6379
  parameter_group_name       = "default.redis7"
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  transit_encryption_enabled = var.redis_transit_encryption_enabled
  at_rest_encryption_enabled = var.redis_at_rest_encryption_enabled
  auth_token                 = var.redis_auth_token != "" ? var.redis_auth_token : null
  automatic_failover_enabled = true
  multi_az_enabled           = true
  tags                       = merge(local.tags, { Name = "${local.name_prefix}-redis" })

  lifecycle {
    # SECURITY (#4): ElastiCache has NO AWS-managed auth-token equivalent to RDS
    # manage_master_user_password, so a configured auth_token DOES land in
    # Terraform state (state encryption + strict IAM in backend.tf are the
    # operative controls — see the residual-risk note in secrets.tf/README).
    # ignore_changes lets the token be ROTATED out-of-band (via the AWS console/
    # CLI) without Terraform reverting it, so day-2 rotation does not require
    # putting a new value back through a Terraform variable → state.
    ignore_changes = [auth_token]

    precondition {
      condition     = !var.redis_transit_encryption_enabled || var.redis_auth_token != ""
      error_message = "redis_auth_token is required when redis_transit_encryption_enabled is true."
    }
  }
}
