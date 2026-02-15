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
  pattern        = "{ $._logType = \"app\" && $.msg = \"request.end\" && $.status >= 500 }"

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
  pattern        = "{ $._logType = \"app\" && $.path = \"/api/health/ready\" && $.status = 503 }"

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
  pattern        = "{ $._logType = \"app\" && $.msg = \"request.end\" && $.durationMs >= ${var.alarm_latency_threshold_ms} }"

  metric_transformation {
    name          = "HighLatencyRequests"
    namespace     = "${local.name_prefix}/App"
    value         = "$.durationMs"
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
# SNS Topic Policy (allow EventBridge to publish, scoped by SourceArn)
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
      }
    ]
  })
}
