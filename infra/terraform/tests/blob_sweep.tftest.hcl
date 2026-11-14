# The attachment backend switch, the retention-gc worker's own role and the
# preconditions on its task definition (#1020), against a mocked AWS provider:
# nothing here reaches an AWS account.
#
# Runs pinned to ./blob_sweep.runs.json: the terraform CI job requires the set
# of passed runs to equal that list (scripts/checks/check-terraform-test-count.mjs),
# and src/__tests__/infra/blob-sweep-wiring.test.ts fails when this file's run
# blocks and the list drift.
#
# Content asserts use `command = apply` (mocked) so the rendered values are
# known. Every expect_failures run is `command = plan`: under apply a run that
# fails as expected stops the file there.

mock_provider "aws" {
  # Random mock strings fail the provider's ARN validators.
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:loadbalancer/app/m/1" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:targetgroup/m/1" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:listener/app/m/1/1" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:ap-northeast-1:123456789012:mock" }
  }
  # locals.tf reads cache_nodes[0].address.
  mock_resource "aws_elasticache_cluster" {
    defaults = { cache_nodes = [{ address = "redis.local", id = "0001", port = 6379, availability_zone = "ap-northeast-1a", outpost_arn = "" }] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
}

mock_provider "aws" {
  alias = "dr"
}

# project_name and env as envs/prod/terraform.tfvars.example ships them, so a
# name over an AWS length limit fails here too.
variables {
  project_name         = "passwd-sso"
  env                  = "prod"
  aws_region           = "ap-northeast-1"
  azs                  = ["ap-northeast-1a", "ap-northeast-1c"]
  vpc_cidr             = "10.20.0.0/16"
  public_subnet_cidrs  = ["10.20.0.0/24", "10.20.1.0/24"]
  private_subnet_cidrs = ["10.20.10.0/24", "10.20.11.0/24"]
  app_domain           = "app.example.com"
  jackson_domain       = "sso.example.com"
  hosted_zone_id       = "ZXXXXXXXXXXXXX"
  # dns.tf's for_each keys are unknown under the mock.
  create_acm_certificate = false
  acm_certificate_arn    = "arn:aws:acm:ap-northeast-1:123456789012:certificate/mock"
  app_image              = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/passwd-sso-prod-app:v0.0.1"
  jackson_image          = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/passwd-sso-prod-jackson:v1.42.0"
  db_username            = "passwd"
}

# ── Content (mocked apply) ───────────────────────────────────────────────────

run "defaults" {
  command = apply

  assert {
    condition     = !contains(keys(jsondecode(aws_ecs_task_definition.retention_gc_worker.container_definitions)[0]), "environment")
    error_message = "with every default the retention container must have no environment key"
  }
  assert {
    condition     = [for s in jsondecode(aws_ecs_task_definition.retention_gc_worker.container_definitions)[0].secrets : s.name] == ["RETENTION_GC_DATABASE_URL"]
    error_message = "with every default the retention container's secrets must be unchanged (no DEPLOYMENT_ID)"
  }
  assert {
    condition     = [for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment : e.name] == ["TRUST_PROXY_HEADERS", "HOSTNAME", "JACKSON_URL", "AUDIT_ANCHOR_PUBLISHER_ENABLED", "AUDIT_ANCHOR_DESTINATION_S3_BUCKET"]
    error_message = "with every default the app container's env names must equal today's list (no BLOB_BACKEND)"
  }
  assert {
    condition     = aws_ecs_task_definition.retention_gc_worker.task_role_arn == aws_iam_role.ecs_retention_gc_task.arn
    error_message = "the retention task must run as its own role"
  }
  assert {
    condition     = aws_ecs_task_definition.app.task_role_arn == aws_iam_role.ecs_task.arn && aws_ecs_task_definition.audit_outbox_worker.task_role_arn == aws_iam_role.ecs_task.arn
    error_message = "the app and the outbox worker must keep ecs_task"
  }
  assert {
    condition     = length(aws_iam_role_policy.ecs_retention_gc_task_s3) == 0
    error_message = "on the db backend the retention role must hold no bucket policy"
  }
}

run "s3_report" {
  command = apply

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
    retention_gc_blob_sweep_mode          = "report"
  }

  assert {
    condition     = [for e in jsondecode(aws_ecs_task_definition.retention_gc_worker.container_definitions)[0].environment : e.name] == ["BLOB_BACKEND", "S3_ATTACHMENTS_BUCKET", "AWS_REGION", "RETENTION_GC_BLOB_SWEEP_MODE"]
    error_message = "the retention container must carry the backend keys and the sweep mode, and no grace when it is null"
  }
  assert {
    condition     = { for e in jsondecode(aws_ecs_task_definition.retention_gc_worker.container_definitions)[0].environment : e.name => e.value } == { BLOB_BACKEND = "s3", S3_ATTACHMENTS_BUCKET = aws_s3_bucket.attachments[0].id, AWS_REGION = "ap-northeast-1", RETENTION_GC_BLOB_SWEEP_MODE = "report" }
    error_message = "the retention container's env values must name s3, this stack's bucket, its region and the mode"
  }
  assert {
    condition     = [for s in jsondecode(aws_ecs_task_definition.retention_gc_worker.container_definitions)[0].secrets : s.name] == ["RETENTION_GC_DATABASE_URL", "DEPLOYMENT_ID"]
    error_message = "a running sweep needs DEPLOYMENT_ID"
  }
  assert {
    condition     = [for s in jsondecode(aws_ecs_task_definition.retention_gc_worker.container_definitions)[0].secrets : s.valueFrom if s.name == "DEPLOYMENT_ID"] == ["${aws_secretsmanager_secret.app.arn}:DEPLOYMENT_ID::"]
    error_message = "DEPLOYMENT_ID must come from the app secret's existing key"
  }
  assert {
    condition     = [for e in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment : e if contains(["BLOB_BACKEND", "S3_ATTACHMENTS_BUCKET", "AWS_REGION"], e.name)] == [{ name = "BLOB_BACKEND", value = "s3" }, { name = "S3_ATTACHMENTS_BUCKET", value = aws_s3_bucket.attachments[0].id }, { name = "AWS_REGION", value = "ap-northeast-1" }]
    error_message = "the app container must use the same backend and bucket as the worker"
  }
}

run "s3_delete_grace" {
  command = apply

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
    retention_gc_blob_sweep_mode          = "delete"
    retention_gc_blob_orphan_grace_ms     = 3024000000
  }

  assert {
    condition     = [for e in jsondecode(aws_ecs_task_definition.retention_gc_worker.container_definitions)[0].environment : e.value if e.name == "RETENTION_GC_BLOB_ORPHAN_GRACE_MS"] == ["3024000000"]
    error_message = "a set grace must reach the worker as RETENTION_GC_BLOB_ORPHAN_GRACE_MS"
  }
}

run "s3_sweep_off" {
  command = apply

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
  }

  assert {
    condition     = [for e in jsondecode(aws_ecs_task_definition.retention_gc_worker.container_definitions)[0].environment : e.name] == ["BLOB_BACKEND", "S3_ATTACHMENTS_BUCKET", "AWS_REGION"]
    error_message = "with the sweep off the worker still needs the backend (the purge deletes objects) but no sweep keys"
  }
  assert {
    condition     = [for s in jsondecode(aws_ecs_task_definition.retention_gc_worker.container_definitions)[0].secrets : s.name] == ["RETENTION_GC_DATABASE_URL"]
    error_message = "with the sweep off the worker gets no DEPLOYMENT_ID"
  }
}

run "iam_policy" {
  command = apply

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
    retention_gc_blob_sweep_mode          = "report"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.ecs_retention_gc_task_s3[0].policy).Statement == [{ Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.attachments[0].arn }, { Effect = "Allow", Action = ["s3:DeleteObject"], Resource = "${aws_s3_bucket.attachments[0].arn}/*" }, { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.attachments[0].arn}/.passwd-sso-deployment" }]
    error_message = "the retention role's statements must be ListBucket on the bucket, DeleteObject on its objects and Get/Put on the marker only"
  }
  assert {
    condition     = length(setintersection(toset(flatten([for s in jsondecode(aws_iam_role_policy.ecs_retention_gc_task_s3[0].policy).Statement : s.Action])), toset(["s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:BypassGovernanceRetention", "s3:PutLifecycleConfiguration", "s3:*", "*"]))) == 0 && alltrue([for a in flatten([for s in jsondecode(aws_iam_role_policy.ecs_retention_gc_task_s3[0].policy).Statement : s.Action]) : !startswith(a, "s3:PutBucket")])
    error_message = "the retention role must hold no forbidden action"
  }
  assert {
    condition     = aws_iam_role_policy.ecs_retention_gc_task_s3[0].role == aws_iam_role.ecs_retention_gc_task.id
    error_message = "the policy must attach to the retention role"
  }
  assert {
    condition     = jsondecode(aws_iam_role.ecs_retention_gc_task.assume_role_policy).Statement == [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole", Condition = { StringEquals = { "aws:SourceAccount" = "123456789012" } } }]
    error_message = "the retention role must be assumable by this account's ECS tasks only"
  }
}

# ── Preconditions (plan): each failure paired with its allow case ────────────

run "p1_s3_without_ack_fails" {
  command = plan

  variables {
    attachments_blob_backend = "s3"
  }

  expect_failures = [aws_ecs_task_definition.retention_gc_worker]
}

run "p1_s3_without_bucket_fails" {
  command = plan

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
    enable_s3_attachments                 = false
  }

  expect_failures = [aws_ecs_task_definition.retention_gc_worker]
}

run "p1_s3_with_bucket_and_ack_plans" {
  command = plan

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
  }
}

run "p2_s3_with_cmk_fails" {
  command = plan

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
    s3_kms_key_arn                        = "arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-4000-8000-000000000000"
  }

  expect_failures = [aws_ecs_task_definition.retention_gc_worker]
}

run "p2_db_with_cmk_plans" {
  command = plan

  variables {
    s3_kms_key_arn = "arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-4000-8000-000000000000"
  }
}

run "p3_report_on_db_fails" {
  command = plan

  variables {
    retention_gc_blob_sweep_mode = "report"
  }

  expect_failures = [aws_ecs_task_definition.retention_gc_worker]
}

run "p3_report_on_s3_plans" {
  command = plan

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
    retention_gc_blob_sweep_mode          = "report"
  }
}

run "p4_delete_null_grace_fails" {
  command = plan

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
    retention_gc_blob_sweep_mode          = "delete"
  }

  expect_failures = [aws_ecs_task_definition.retention_gc_worker]
}

# Default windows: RDS 7 d, AWS Backup 35 d (on) → 35 d.
run "p4_delete_grace_below_backup_window_fails" {
  command = plan

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
    retention_gc_blob_sweep_mode          = "delete"
    retention_gc_blob_orphan_grace_ms     = 3023999999
  }

  expect_failures = [aws_ecs_task_definition.retention_gc_worker]
}

run "p4_delete_grace_at_backup_window_plans" {
  command = plan

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
    retention_gc_blob_sweep_mode          = "delete"
    retention_gc_blob_orphan_grace_ms     = 3024000000
  }
}

# AWS Backup off: only the RDS window (7 d) counts.
run "p4_backup_off_grace_at_rds_window_plans" {
  command = plan

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
    retention_gc_blob_sweep_mode          = "delete"
    retention_gc_blob_orphan_grace_ms     = 604800000
    enable_backup                         = false
  }
}

run "p4_backup_off_grace_below_rds_window_fails" {
  command = plan

  variables {
    attachments_blob_backend              = "s3"
    attachments_blob_backend_empty_db_ack = true
    retention_gc_blob_sweep_mode          = "delete"
    retention_gc_blob_orphan_grace_ms     = 604799999
    enable_backup                         = false
  }

  expect_failures = [aws_ecs_task_definition.retention_gc_worker]
}

# ── C5: name_prefix bound ────────────────────────────────────────────────────
#
# No failing run for the bound: past 20 characters the provider's own name
# validation of aws_cloudwatch_event_rule.audit_anchor_publisher_role_task_definition
# (44-character suffix, 64 limit) fails the validate walk before any
# precondition is evaluated, which terraform test reports as an error, not as
# the expected failure. src/__tests__/infra/blob-sweep-wiring.test.ts evaluates
# the precondition's condition on both sides of the bound instead.

# Exactly 20 characters ("passwd-sso-prod-1234"): every name fits its limit.
run "c5_name_prefix_at_bound_plans" {
  command = plan

  variables {
    env = "prod-1234"
  }
}
