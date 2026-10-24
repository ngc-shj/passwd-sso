################################################################################
# SNS Topic for Alarm Notifications
################################################################################

resource "aws_sns_topic" "alarms" {
  count = var.enable_monitoring ? 1 : 0
  name  = "${local.name_prefix}-alarms"
  tags  = local.tags
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.enable_monitoring && var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

################################################################################
# CloudWatch Metric Filters (pino JSON logs)
################################################################################

resource "aws_cloudwatch_log_metric_filter" "app_5xx" {
  count          = var.enable_monitoring ? 1 : 0
  name           = "${local.name_prefix}-5xx-errors"
  log_group_name = aws_cloudwatch_log_group.app.name
  # request.error is an unhandled throw: it carries no status, and Next answers 500.
  pattern = "{ $._stream = \"app\" && (($.msg = \"request.end\" && $.status >= 500) || $.msg = \"request.error\") }"

  metric_transformation {
    name          = "App5xxErrors"
    namespace     = "${local.name_prefix}/App"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "health_check_failures" {
  count          = var.enable_monitoring ? 1 : 0
  name           = "${local.name_prefix}-health-check-failures"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $._stream = \"app\" && $.path = \"/api/health/ready\" && $.status = 503 }"

  metric_transformation {
    name          = "HealthCheckFailures"
    namespace     = "${local.name_prefix}/App"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "high_latency" {
  count          = var.enable_monitoring ? 1 : 0
  name           = "${local.name_prefix}-high-latency"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $._stream = \"app\" && $.msg = \"request.end\" && $.durationMs >= ${var.alarm_latency_threshold_ms} }"

  metric_transformation {
    name          = "HighLatencyRequests"
    namespace     = "${local.name_prefix}/App"
    value         = "$.durationMs"
    default_value = "0"
  }
}

# RLS bypass reports (#911, report mode): a bypassed statement reached a table
# outside its grant. One filter per log group that carries a pool built by
# src/lib/db/pool-factory.ts; the line is emitted with this _logType there.
# The enforce flip waits for these to read zero over a window, after a canary
# has shown each one counting.
locals {
  rls_bypass_report_log_groups = {
    app                       = aws_cloudwatch_log_group.app.name
    audit_outbox_worker       = aws_cloudwatch_log_group.audit_outbox_worker.name
    retention_gc_worker       = aws_cloudwatch_log_group.retention_gc_worker.name
    audit_anchor_publisher    = aws_cloudwatch_log_group.audit_anchor_publisher.name
    audit_chain_verify_worker = aws_cloudwatch_log_group.audit_chain_verify_worker.name
  }
}

resource "aws_cloudwatch_log_metric_filter" "rls_bypass_not_granted" {
  for_each       = var.enable_monitoring ? local.rls_bypass_report_log_groups : {}
  name           = "${local.name_prefix}-rls-bypass-not-granted-${each.key}"
  log_group_name = each.value
  pattern        = "{ $._logType = \"rls.bypass_not_granted\" }"

  metric_transformation {
    name          = "RlsBypassNotGranted"
    namespace     = "${local.name_prefix}/App"
    value         = "1"
    default_value = "0"
  }
}

################################################################################
# CloudWatch Alarms
################################################################################

# ALB 5xx error rate (from ALB native metrics — more authoritative)
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-alb-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = var.alarm_5xx_threshold
  alarm_description   = "App target 5xx error count exceeded threshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.app.arn_suffix
  }

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

# A WARNING from rls_bypass_admits whose text the listener could not parse
# (function and listener disagree on the format). Counted on the same metric so
# a format drift raises the alarm below instead of reading as zero reports.
resource "aws_cloudwatch_log_metric_filter" "rls_bypass_notice_unparsed" {
  for_each       = var.enable_monitoring ? local.rls_bypass_report_log_groups : {}
  name           = "${local.name_prefix}-rls-bypass-notice-unparsed-${each.key}"
  log_group_name = each.value
  pattern        = "{ $._logType = \"rls.bypass_notice_unparsed\" }"

  metric_transformation {
    name          = "RlsBypassNotGranted"
    namespace     = "${local.name_prefix}/App"
    value         = "1"
    default_value = "0"
  }
}

# Any RLS bypass report. Report mode admits the statement, so without this
# alarm an ungranted reach is visible only to someone reading the metric. Both
# filter resources (reports and unparsed reports, one filter per log group
# each) publish to the same metric, so one alarm covers them; a report line
# names the table and purpose.
resource "aws_cloudwatch_metric_alarm" "rls_bypass_not_granted" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-rls-bypass-not-granted"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "RlsBypassNotGranted"
  namespace           = "${local.name_prefix}/App"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "An RLS bypass reached a table outside its grant (rls.bypass_not_granted), or a report could not be parsed (rls.bypass_notice_unparsed); see docs/operations/alerts.md"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

# Health check failure alarm (from log metric filter)
resource "aws_cloudwatch_metric_alarm" "health_check_failure" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-health-check-failure"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthCheckFailures"
  namespace           = "${local.name_prefix}/App"
  period              = 300
  statistic           = "Sum"
  threshold           = 2
  alarm_description   = "Health check endpoint returned 503 multiple times"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

# ALB unhealthy host count alarm
resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-unhealthy-hosts"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "ALB detected unhealthy targets"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.app.arn_suffix
  }

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

# High latency alarm
resource "aws_cloudwatch_metric_alarm" "high_latency" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-high-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "HighLatencyRequests"
  namespace           = "${local.name_prefix}/App"
  period              = 300
  statistic           = "Average"
  threshold           = var.alarm_latency_threshold_ms
  alarm_description   = "API latency exceeded threshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

# RDS connection count approaching max_connections limit
resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-rds-connections-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Maximum"
  threshold           = var.alarm_rds_connections_threshold
  alarm_description   = "RDS connection count approaching max_connections limit"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

################################################################################
# Background worker liveness alarms
################################################################################
#
# A background worker that crash-loops or exits leaves audit events PENDING or
# retention un-enforced with NO request-serving symptom — so it must be alarmed
# independently. RunningTaskCount (Container Insights, enabled on the cluster)
# drops below 1 when the service has no running task. `treat_missing_data =
# breaching` so a total metric outage (service never started) also alarms.
#
# NOTE: this catches a worker that is DOWN, not one that is UP-but-stuck (booted
# but making no progress). Detecting the stuck case needs an app-emitted custom
# metric (audit_outbox PENDING-row age / retention queue age) that the worker
# does not publish yet — a documented follow-up (M5). The compose/k8s guidance
# and docs already call out heartbeat-log monitoring as the interim control.

resource "aws_cloudwatch_metric_alarm" "audit_outbox_worker_down" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-audit-outbox-worker-down"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "audit-outbox-worker has no running task — audit events accumulate as PENDING"
  treat_missing_data  = "breaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.audit_outbox_worker.name
  }

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

resource "aws_cloudwatch_metric_alarm" "retention_gc_worker_down" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-retention-gc-worker-down"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "retention-gc-worker has no running task — retention/deletion is not enforced"
  treat_missing_data  = "breaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.retention_gc_worker.name
  }

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

resource "aws_cloudwatch_metric_alarm" "audit_anchor_publisher_down" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-audit-anchor-publisher-down"
  comparison_operator = "LessThanThreshold"
  # 10 minutes, not the other workers' 2: the publisher deploys with
  # minimum_healthy_percent = 0, so every deploy has a window with no task —
  # the old one draining for up to its 120 s stopTimeout, then the new one
  # being placed and pulling the image.
  evaluation_periods  = 10
  datapoints_to_alarm = 10
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "audit-anchor-publisher has had no running task for 10 minutes — no audit anchor is being published; see docs/operations/alerts.md"
  treat_missing_data  = "breaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.audit_anchor_publisher.name
  }

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

################################################################################
# Audit-anchor publisher cadence
################################################################################
#
# The publisher's lines and the patterns below are pinned to each other by
# src/workers/audit-anchor-publisher.metric-filter.test.ts, which drives the
# real publisher and matches these patterns against what it logs.

# One line per healthy boundary: a published manifest, or nothing to publish on
# an install where no tenant has ever enabled the chain. A skip of any other
# kind never counts — the boundary marker is a database row, so a
# database-writable way to make runs skip must not read as health.
resource "aws_cloudwatch_log_metric_filter" "audit_anchor_cadence_healthy" {
  count          = var.enable_monitoring ? 1 : 0
  name           = "${local.name_prefix}-audit-anchor-cadence-healthy"
  log_group_name = aws_cloudwatch_log_group.audit_anchor_publisher.name
  pattern        = "{ $._logType = \"audit-anchor-publisher.cadence_healthy\" }"

  # No default_value: an hour with no publisher log at all must read as
  # missing (breaching below), not as a reported zero.
  metric_transformation {
    name      = "AuditAnchorCadenceHealthy"
    namespace = "${local.name_prefix}/AuditAnchor"
    value     = "1"
  }
}

# ~25 h without a healthy boundary (one per 24 h cadence, plus an hour). A
# deliberate full disable of the chain also lands here and stays in ALARM —
# that is the state to see.
resource "aws_cloudwatch_metric_alarm" "audit_anchor_cadence_absent" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-audit-anchor-cadence-absent"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 25
  datapoints_to_alarm = 25
  metric_name         = "AuditAnchorCadenceHealthy"
  namespace           = "${local.name_prefix}/AuditAnchor"
  period              = 3600
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "No healthy audit-anchor cadence (published, or never-enabled skipped_no_tenants) for 25 h; see docs/operations/alerts.md"
  treat_missing_data  = "breaching"

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

# The chain-enabled tenant count fell from positive to 0: no tenant is
# chain-enabled now, but an audit_chain_anchors row shows one was
# (everChainEnabled). Alarmed on its own so the cause is named the same day,
# not only by the absence alarm a day later.
resource "aws_cloudwatch_log_metric_filter" "audit_anchor_chain_enabled_fell_to_zero" {
  count          = var.enable_monitoring ? 1 : 0
  name           = "${local.name_prefix}-audit-anchor-chain-enabled-fell-to-zero"
  log_group_name = aws_cloudwatch_log_group.audit_anchor_publisher.name
  pattern        = "{ $._logType = \"audit-anchor-publisher.cadence\" && $.kind = \"skipped_no_tenants\" && $.chainEnabledTenantCount = 0 && $.everChainEnabled IS TRUE }"

  metric_transformation {
    name          = "AuditAnchorChainEnabledFellToZero"
    namespace     = "${local.name_prefix}/AuditAnchor"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "audit_anchor_chain_enabled_fell_to_zero" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-audit-anchor-chain-enabled-fell-to-zero"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "AuditAnchorChainEnabledFellToZero"
  namespace           = "${local.name_prefix}/AuditAnchor"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "No tenant is audit-chain-enabled any more, though one was: nothing is anchored; see docs/operations/alerts.md"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

# The publisher's failure lines, one filter and one alarm each so the page
# names the failure. lock_held is here though it is not a failure of the run:
# on ECS the service runs one task and stops the old one before starting the
# new, so a held lock means a second publisher against this database.
# stale_boundary is a skip, not a failure, but on ECS it has no legitimate
# cause: the marker is past the run's boundary yet not past the wall clock's,
# so another writer moved it — a second publisher, or a database write. A clock
# that went back reads the marker as ahead instead (BOUNDARY_MARKER_AHEAD,
# under cadence_failed).
locals {
  audit_anchor_publisher_failure_log_types = {
    cadence_failed             = "audit-anchor-publisher.cadence_failed"
    lock_held                  = "audit-anchor-publisher.lock_held"
    stale_boundary             = "audit-anchor-publisher.stale_boundary"
    upload_failed              = "audit-anchor-publisher.upload_failed"
    upload_cap_reached         = "audit-anchor-publisher.upload_cap_reached"
    commit_failed_after_upload = "audit-anchor-publisher.commit_failed_after_upload"
    pause_persist_failed       = "audit-anchor-publisher.pause_persist_failed"
    pool_error                 = "audit-anchor-publisher.pool.error"
    cadence_error              = "audit-anchor-publisher.cadence_error"
  }
}

resource "aws_cloudwatch_log_metric_filter" "audit_anchor_publisher_failure" {
  for_each       = var.enable_monitoring ? local.audit_anchor_publisher_failure_log_types : {}
  name           = "${local.name_prefix}-audit-anchor-publisher-${replace(each.key, "_", "-")}"
  log_group_name = aws_cloudwatch_log_group.audit_anchor_publisher.name
  pattern        = "{ $._logType = \"${each.value}\" }"

  metric_transformation {
    name          = "AuditAnchorPublisher_${each.key}"
    namespace     = "${local.name_prefix}/AuditAnchor"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "audit_anchor_publisher_failure" {
  for_each            = var.enable_monitoring ? local.audit_anchor_publisher_failure_log_types : {}
  alarm_name          = "${local.name_prefix}-audit-anchor-publisher-${replace(each.key, "_", "-")}"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "AuditAnchorPublisher_${each.key}"
  namespace           = "${local.name_prefix}/AuditAnchor"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The audit-anchor publisher logged ${each.value}; see docs/operations/alerts.md"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

# The publisher's own audit write failed (reason anchor_publisher_emit_failed):
# that AUDIT_ANCHOR_* row never reaches audit_logs, and this line is the record
# of which emit it was.
resource "aws_cloudwatch_log_metric_filter" "audit_anchor_publisher_dead_letter" {
  count          = var.enable_monitoring ? 1 : 0
  name           = "${local.name_prefix}-audit-anchor-publisher-dead-letter"
  log_group_name = aws_cloudwatch_log_group.audit_anchor_publisher.name
  pattern        = "{ $._logType = \"audit-dead-letter\" }"

  metric_transformation {
    name          = "AuditAnchorPublisher_dead_letter"
    namespace     = "${local.name_prefix}/AuditAnchor"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "audit_anchor_publisher_dead_letter" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-audit-anchor-publisher-dead-letter"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "AuditAnchorPublisher_dead_letter"
  namespace           = "${local.name_prefix}/AuditAnchor"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The audit-anchor publisher dead-lettered one of its own audit rows; see docs/operations/alerts.md"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

################################################################################
# Audit-chain verify worker heartbeat
################################################################################
#
# One heartbeat per tick (hourly), emitted whatever the tick found: liveness is
# its presence, coverage and tampering are its counts. Pinned to the worker's
# real line by scripts/__tests__/audit-chain-verify-heartbeat.test.mjs.

resource "aws_cloudwatch_log_metric_filter" "audit_chain_verify_heartbeat" {
  count          = var.enable_monitoring ? 1 : 0
  name           = "${local.name_prefix}-audit-chain-verify-heartbeat"
  log_group_name = aws_cloudwatch_log_group.audit_chain_verify_worker.name
  pattern        = "{ $._logType = \"audit-chain-verify-heartbeat\" }"

  # No default_value, as for the cadence filter: silence must read as missing.
  metric_transformation {
    name      = "AuditChainVerifyHeartbeat"
    namespace = "${local.name_prefix}/AuditChainVerify"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "audit_chain_verify_heartbeat_absent" {
  count               = var.enable_monitoring ? 1 : 0
  alarm_name          = "${local.name_prefix}-audit-chain-verify-heartbeat-absent"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = "AuditChainVerifyHeartbeat"
  namespace           = "${local.name_prefix}/AuditChainVerify"
  period              = 3600
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "No audit-chain verify heartbeat for 2 h — the verifier is down or stuck; see docs/operations/alerts.md"
  treat_missing_data  = "breaching"

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

# A tenant whose verification threw (coverage gap), and a tenant whose chain
# failed verification (tamper signal).
locals {
  audit_chain_verify_count_alarms = {
    errored = "erroredTenantCount"
    failed  = "failedTenantCount"
  }
}

resource "aws_cloudwatch_log_metric_filter" "audit_chain_verify_count" {
  for_each       = var.enable_monitoring ? local.audit_chain_verify_count_alarms : {}
  name           = "${local.name_prefix}-audit-chain-verify-${each.key}"
  log_group_name = aws_cloudwatch_log_group.audit_chain_verify_worker.name
  pattern        = "{ $._logType = \"audit-chain-verify-heartbeat\" && $.${each.value} > 0 }"

  metric_transformation {
    name          = "AuditChainVerify_${each.value}"
    namespace     = "${local.name_prefix}/AuditChainVerify"
    value         = "$.${each.value}"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "audit_chain_verify_count" {
  for_each            = var.enable_monitoring ? local.audit_chain_verify_count_alarms : {}
  alarm_name          = "${local.name_prefix}-audit-chain-verify-${each.key}"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "AuditChainVerify_${each.value}"
  namespace           = "${local.name_prefix}/AuditChainVerify"
  period              = 3600
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The audit-chain verify heartbeat reported ${each.value} > 0; see docs/operations/alerts.md"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
  tags          = local.tags
}

################################################################################
# EventBridge: ECS Task Stop Detection
################################################################################

resource "aws_cloudwatch_event_rule" "ecs_task_stopped" {
  count       = var.enable_monitoring ? 1 : 0
  name        = "${local.name_prefix}-ecs-task-stopped"
  description = "ECS task stopped unexpectedly"

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      clusterArn    = [aws_ecs_cluster.main.arn]
      lastStatus    = ["STOPPED"]
      desiredStatus = ["STOPPED"]
    }
  })

  tags = local.tags
}

resource "aws_cloudwatch_event_target" "ecs_task_stopped_sns" {
  count     = var.enable_monitoring ? 1 : 0
  rule      = aws_cloudwatch_event_rule.ecs_task_stopped[0].name
  target_id = "send-to-sns"
  arn       = aws_sns_topic.alarms[0].arn
}

################################################################################
# EventBridge: CloudTrail events nothing else would surface
################################################################################
#
# These rules match "AWS API Call via CloudTrail" events, which EventBridge
# receives only from an account with a trail logging management events.
# Terraform defines no trail: one (or an organisation trail) is a deployment
# prerequisite, checked in the manual test.

# ECS Exec is logged NONE (ecs.tf), so the session itself leaves no
# transcript; this event is the record that one was opened.
resource "aws_cloudwatch_event_rule" "ecs_execute_command" {
  count       = var.enable_monitoring ? 1 : 0
  name        = "${local.name_prefix}-ecs-execute-command"
  description = "An ECS Exec session was opened (CloudTrail ExecuteCommand)"

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["ecs.amazonaws.com"]
      eventName   = ["ExecuteCommand"]
    }
  })

  tags = local.tags
}

resource "aws_cloudwatch_event_target" "ecs_execute_command_sns" {
  count     = var.enable_monitoring ? 1 : 0
  rule      = aws_cloudwatch_event_rule.ecs_execute_command[0].name
  target_id = "send-to-sns"
  arn       = aws_sns_topic.alarms[0].arn
}

# The publisher's task role is the only principal the anchors bucket policy
# lets write a manifest. A task run with that role as an override — any image,
# any command — could write one, so every such RunTask / StartTask is surfaced.
# The publisher's own service never sends an override. Changes to the role
# itself (UpdateAssumeRolePolicy, PutRolePolicy, AttachRolePolicy, a delete and
# re-create) are IAM events, which EventBridge delivers only in us-east-1; this
# stack has no provider there, so those reach CloudTrail but are not alarmed
# here (docs/operations/alerts.md).
#
# Both rules match the role by its full ARN and by its bare name. CloudTrail
# records the request as sent, and RegisterTaskDefinition's taskRoleArn takes
# "the short name or full ARN" of the role; RunTask's override is documented as
# an ARN, but an exact match on one spelling is a bypass the moment the API
# accepts the other, and the second entry costs nothing. The role has no path,
# so these two are the only spellings that name it.
locals {
  audit_anchor_publisher_role_spellings = [
    aws_iam_role.ecs_audit_anchor_publisher_task.arn,
    aws_iam_role.ecs_audit_anchor_publisher_task.name,
  ]
}

resource "aws_cloudwatch_event_rule" "audit_anchor_publisher_role_override" {
  count       = var.enable_monitoring ? 1 : 0
  name        = "${local.name_prefix}-audit-anchor-publisher-role-override"
  description = "An ECS task was run with the audit-anchor publisher's task role as a taskRoleArn override"

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["ecs.amazonaws.com"]
      eventName   = ["RunTask", "StartTask"]
      requestParameters = {
        overrides = {
          taskRoleArn = local.audit_anchor_publisher_role_spellings
        }
      }
    }
  })

  tags = local.tags
}

resource "aws_cloudwatch_event_target" "audit_anchor_publisher_role_override_sns" {
  count     = var.enable_monitoring ? 1 : 0
  rule      = aws_cloudwatch_event_rule.audit_anchor_publisher_role_override[0].name
  target_id = "send-to-sns"
  arn       = aws_sns_topic.alarms[0].arn
}

# The same role baked into a task definition of another family: a run of that
# definition needs no override, so the rule above never sees it. The
# publisher's own family is excluded — every publisher deploy registers a
# revision naming the role. A separate rule because the field set differs; one
# pattern ORs only within a field.
resource "aws_cloudwatch_event_rule" "audit_anchor_publisher_role_task_definition" {
  count       = var.enable_monitoring ? 1 : 0
  name        = "${local.name_prefix}-audit-anchor-publisher-role-task-definition"
  description = "A task definition outside the audit-anchor publisher's family was registered with its task role"

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["ecs.amazonaws.com"]
      eventName   = ["RegisterTaskDefinition"]
      requestParameters = {
        taskRoleArn = local.audit_anchor_publisher_role_spellings
        family      = [{ anything-but = aws_ecs_task_definition.audit_anchor_publisher.family }]
      }
    }
  })

  tags = local.tags
}

resource "aws_cloudwatch_event_target" "audit_anchor_publisher_role_task_definition_sns" {
  count     = var.enable_monitoring ? 1 : 0
  rule      = aws_cloudwatch_event_rule.audit_anchor_publisher_role_task_definition[0].name
  target_id = "send-to-sns"
  arn       = aws_sns_topic.alarms[0].arn
}

# A task runs with the publisher's role when an override names it (the
# override rule) or its task definition does. For a definition of another
# family, the task-definition rule fires at registration. For the publisher's
# own family, which every deploy registers, a task is legitimate only when the
# publisher service launched it: anything else that starts one — RunTask,
# StartTask, another service, a service of the same name in another cluster —
# runs as the publisher with no override and no new registration. The two
# rules below close that route.
#
# This one needs no trail: ECS emits "ECS Task State Change" natively, and
# each event's detail carries `clusterArn`, `taskDefinitionArn` (with its
# revision) and `group`, which is "service:<service name>" for a task a service
# launched and "family:<family>" by default otherwise. It matches every task of
# the publisher's family except one in this cluster whose group is the
# publisher service's. The ARN prefix ends in ":" so a family that merely
# starts with this one's name does not match. `group` is a RunTask/StartTask
# parameter as well, so a caller can claim "service:<publisher>" for a task it
# started itself; the CloudTrail rule after this one is what catches that. A
# task emits several state changes (PROVISIONING … STOPPED), so one such task
# can notify more than once.
resource "aws_cloudwatch_event_rule" "audit_anchor_publisher_family_task_outside_service" {
  count       = var.enable_monitoring ? 1 : 0
  name        = "${local.name_prefix}-audit-anchor-publisher-family-task-outside-service"
  description = "A task of the audit-anchor publisher's family ran outside the publisher service"

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      taskDefinitionArn = [{ prefix = "${aws_ecs_task_definition.audit_anchor_publisher.arn_without_revision}:" }]
      "$or" = [
        { clusterArn = [{ anything-but = aws_ecs_cluster.main.arn }] },
        { group = [{ anything-but = "service:${aws_ecs_service.audit_anchor_publisher.name}" }] },
      ]
    }
  })

  tags = local.tags
}

resource "aws_cloudwatch_event_target" "audit_anchor_publisher_family_task_outside_service_sns" {
  count     = var.enable_monitoring ? 1 : 0
  rule      = aws_cloudwatch_event_rule.audit_anchor_publisher_family_task_outside_service[0].name
  target_id = "send-to-sns"
  arn       = aws_sns_topic.alarms[0].arn
}

# A RunTask / StartTask of the publisher's family, whatever `group` it claims
# and in whichever cluster: the publisher service's scheduler starts its tasks
# without either call (a deploy raises neither: the manual test checks it), so
# every one is a task started by someone else. Needs the trail. It
# matches the family as RunTask takes it — "family", "family:revision" or the
# full ARN — with the ":" terminator on the prefixes, as above.
resource "aws_cloudwatch_event_rule" "audit_anchor_publisher_family_run_task" {
  count       = var.enable_monitoring ? 1 : 0
  name        = "${local.name_prefix}-audit-anchor-publisher-family-run-task"
  description = "A task of the audit-anchor publisher's family was started with RunTask or StartTask"

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["ecs.amazonaws.com"]
      eventName   = ["RunTask", "StartTask"]
      requestParameters = {
        taskDefinition = [
          aws_ecs_task_definition.audit_anchor_publisher.family,
          { prefix = "${aws_ecs_task_definition.audit_anchor_publisher.family}:" },
          aws_ecs_task_definition.audit_anchor_publisher.arn_without_revision,
          { prefix = "${aws_ecs_task_definition.audit_anchor_publisher.arn_without_revision}:" },
        ]
      }
    }
  })

  tags = local.tags
}

resource "aws_cloudwatch_event_target" "audit_anchor_publisher_family_run_task_sns" {
  count     = var.enable_monitoring ? 1 : 0
  rule      = aws_cloudwatch_event_rule.audit_anchor_publisher_family_run_task[0].name
  target_id = "send-to-sns"
  arn       = aws_sns_topic.alarms[0].arn
}

# The anchors bucket policy (storage.tf) holds only while nobody replaces it,
# and the account root always can. Any change to the policy, the lifecycle,
# Object Lock or versioning is surfaced; a Terraform apply that touches them is
# the expected false positive.
resource "aws_cloudwatch_event_rule" "audit_anchor_bucket_config_change" {
  count       = var.enable_monitoring && var.enable_s3_audit_anchors ? 1 : 0
  name        = "${local.name_prefix}-audit-anchor-bucket-config-change"
  description = "The audit anchors bucket's policy, lifecycle, Object Lock or versioning configuration changed"

  event_pattern = jsonencode({
    source      = ["aws.s3"]
    detail-type = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["s3.amazonaws.com"]
      eventName = [
        "PutBucketPolicy",
        "DeleteBucketPolicy",
        "PutBucketLifecycle",
        "PutBucketLifecycleConfiguration",
        "PutObjectLockConfiguration",
        "PutBucketVersioning",
      ]
      requestParameters = {
        bucketName = [aws_s3_bucket.audit_anchors[0].id]
      }
    }
  })

  tags = local.tags
}

resource "aws_cloudwatch_event_target" "audit_anchor_bucket_config_change_sns" {
  count     = var.enable_monitoring && var.enable_s3_audit_anchors ? 1 : 0
  rule      = aws_cloudwatch_event_rule.audit_anchor_bucket_config_change[0].name
  target_id = "send-to-sns"
  arn       = aws_sns_topic.alarms[0].arn
}

################################################################################
# SNS Topic Policy (allow EventBridge + CloudWatch Alarms to publish)
################################################################################

resource "aws_sns_topic_policy" "alarms" {
  count = var.enable_monitoring ? 1 : 0
  arn   = aws_sns_topic.alarms[0].arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowEventBridgePublish"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.alarms[0].arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = concat(
              [
                aws_cloudwatch_event_rule.ecs_task_stopped[0].arn,
                aws_cloudwatch_event_rule.ecs_execute_command[0].arn,
                aws_cloudwatch_event_rule.audit_anchor_publisher_role_override[0].arn,
                aws_cloudwatch_event_rule.audit_anchor_publisher_role_task_definition[0].arn,
                aws_cloudwatch_event_rule.audit_anchor_publisher_family_task_outside_service[0].arn,
                aws_cloudwatch_event_rule.audit_anchor_publisher_family_run_task[0].arn,
              ],
              aws_cloudwatch_event_rule.audit_anchor_bucket_config_change[*].arn,
            )
          }
        }
      },
      {
        Sid       = "AllowCloudWatchAlarmsPublish"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.alarms[0].arn
        Condition = {
          ArnLike = {
            "aws:SourceArn" = "arn:aws:cloudwatch:*:*:alarm:${local.name_prefix}-*"
          }
        }
      }
    ]
  })
}
