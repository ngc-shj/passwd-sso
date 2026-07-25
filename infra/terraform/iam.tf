################################################################################
# ECS Task Execution Role (pulling images, accessing secrets)
################################################################################

resource "aws_iam_role" "ecs_task_execution" {
  name = "${local.name_prefix}-ecs-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "ecs_exec" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_exec_secrets" {
  name = "${local.name_prefix}-ecs-secrets"
  role = aws_iam_role.ecs_task_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [aws_secretsmanager_secret.app.arn, aws_secretsmanager_secret.jackson.arn]
      }
    ]
  })
}

################################################################################
# ECS Task Role (runtime AWS API access from containers)
################################################################################

resource "aws_iam_role" "ecs_task" {
  name = "${local.name_prefix}-ecs-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

# ECS Exec (SSM) — lets an operator open an interactive shell INTO a running task
# (`aws ecs execute-command`). The only sanctioned path to psql the RDS instance:
# RDS's SG allows 5432 only from the ECS SG (network.tf), so no operator laptop
# can reach it. During bootstrap the migrate task is launched with
# --enable-execute-command and used to create the least-privilege DB roles; in
# steady state it is the break-glass path for DB inspection. These four
# ssmmessages actions are exactly what the SSM agent needs for the exec channel;
# CloudWatch/S3 session logging is optional and not required here.
resource "aws_iam_role_policy" "ecs_exec_ssm" {
  name = "${local.name_prefix}-ecs-exec-ssm"
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ]
      Resource = "*"
    }]
  })
}

resource "aws_iam_role_policy" "ecs_s3_access" {
  count = var.enable_s3_attachments ? 1 : 0
  name  = "${local.name_prefix}-ecs-s3"
  role  = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = "${aws_s3_bucket.attachments[0].arn}/*"
    }]
  })
}
