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
    app                 = aws_cloudwatch_log_group.app.name
    audit_outbox_worker = aws_cloudwatch_log_group.audit_outbox_worker.name
    retention_gc_worker = aws_cloudwatch_log_group.retention_gc_worker.name
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
            "aws:SourceArn" = aws_cloudwatch_event_rule.ecs_task_stopped[0].arn
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
