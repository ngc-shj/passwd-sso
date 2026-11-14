locals {
  name_prefix = "${var.project_name}-${var.env}"
  tags = merge(var.tags, {
    Project = var.project_name
    Env     = var.env
  })

  certificate_arn = var.create_acm_certificate ? aws_acm_certificate.app[0].arn : var.acm_certificate_arn

  attachments_bucket_name = var.attachments_bucket_name != "" ? var.attachments_bucket_name : "${local.name_prefix}-attachments"

  # The orphan sweep's deployment marker. Equals blobMarkerKey() in
  # src/lib/blob-store/object-ref.ts (MARKER_NAME) with BLOB_OBJECT_PREFIX
  # deliberately unset on AWS; src/__tests__/infra/blob-sweep-wiring.test.ts
  # pins the two together. The retention-gc role may read and write this key
  # and no other.
  blob_marker_key = ".passwd-sso-deployment"

  # BLOB_BACKEND and its S3 settings, for the app AND the retention-gc worker;
  # empty on the db backend. one() rather than [0]: with s3 but no bucket an
  # index errors before any precondition is evaluated, while one() of an empty
  # list is a plain null here and precondition 1 (ecs.tf) reports. Never put it
  # in a template without a guard (the retention role's policy has a count).
  attachment_blob_env = var.attachments_blob_backend == "s3" ? [
    { name = "BLOB_BACKEND", value = "s3" },
    { name = "S3_ATTACHMENTS_BUCKET", value = one(aws_s3_bucket.attachments[*].id) },
    { name = "AWS_REGION", value = var.aws_region },
  ] : []

  # The worker's env: the backend, plus the sweep settings when it runs. A
  # container whose list is empty gets no environment key at all (ecs.tf), so
  # the defaults render the task definition unchanged.
  retention_gc_blob_env = concat(
    local.attachment_blob_env,
    var.retention_gc_blob_sweep_mode != "off" ? [
      { name = "RETENTION_GC_BLOB_SWEEP_MODE", value = var.retention_gc_blob_sweep_mode },
    ] : [],
    var.retention_gc_blob_sweep_mode != "off" && var.retention_gc_blob_orphan_grace_ms != null ? [
      { name = "RETENTION_GC_BLOB_ORPHAN_GRACE_MS", value = tostring(var.retention_gc_blob_orphan_grace_ms) },
    ] : [],
  )

  # Preconditions 1 and 2, on the app AND the retention-gc task definitions
  # (ecs.tf): both read BLOB_BACKEND, so either one alone would let the other
  # be planned with a backend it cannot use.
  attachment_backend_bucket_ready = var.attachments_blob_backend != "s3" || (var.enable_s3_attachments && var.attachments_blob_backend_empty_db_ack)
  attachment_backend_sse_ready    = var.attachments_blob_backend != "s3" || var.s3_kms_key_arn == ""

  # How far back a database restore can reach, in milliseconds (the orphan
  # grace's unit): the RDS automated backups, and AWS Backup's recovery points
  # when it is on.
  blob_restore_window_ms = max(var.db_backup_retention_days, var.enable_backup ? var.backup_retention_days : 0) * 86400000

  redis_endpoint = var.redis_use_replication_group ? aws_elasticache_replication_group.main[0].primary_endpoint_address : aws_elasticache_cluster.main[0].cache_nodes[0].address
}
