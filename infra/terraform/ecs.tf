################################################################################
# ECS Cluster
################################################################################

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"
  tags = local.tags
}

################################################################################
# App Task Definition
################################################################################

resource "aws_ecs_task_definition" "app" {
  family                   = "${local.name_prefix}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.app_cpu
  memory                   = var.app_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "app"
      image     = var.app_image
      essential = true
      portMappings = [{
        containerPort = 3000
        hostPort      = 3000
        protocol      = "tcp"
      }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
      secrets = [
        { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.app.arn}:DATABASE_URL::" },
        { name = "AUTH_URL", valueFrom = "${aws_secretsmanager_secret.app.arn}:AUTH_URL::" },
        { name = "AUTH_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:AUTH_SECRET::" },
        { name = "AUTH_GOOGLE_ID", valueFrom = "${aws_secretsmanager_secret.app.arn}:AUTH_GOOGLE_ID::" },
        { name = "AUTH_GOOGLE_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:AUTH_GOOGLE_SECRET::" },
        { name = "AUTH_JACKSON_ID", valueFrom = "${aws_secretsmanager_secret.app.arn}:AUTH_JACKSON_ID::" },
        { name = "AUTH_JACKSON_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:AUTH_JACKSON_SECRET::" },
        { name = "SHARE_MASTER_KEY", valueFrom = "${aws_secretsmanager_secret.app.arn}:SHARE_MASTER_KEY::" },
        { name = "REDIS_URL", valueFrom = "${aws_secretsmanager_secret.app.arn}:REDIS_URL::" },
      ]
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"const c=new AbortController();setTimeout(()=>c.abort(),5000);fetch('http://localhost:3000/api/health/live',{signal:c.signal}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 10
        retries     = 3
        startPeriod = 60
      }
    }
  ])
  tags = local.tags
}

################################################################################
# Jackson Task Definition
################################################################################

resource "aws_ecs_task_definition" "jackson" {
  family                   = "${local.name_prefix}-jackson"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.jackson_cpu
  memory                   = var.jackson_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn

  container_definitions = jsonencode([
    {
      name      = "jackson"
      image     = var.jackson_image
      essential = true
      portMappings = [{
        containerPort = 5225
        hostPort      = 5225
        protocol      = "tcp"
      }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.jackson.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
      secrets = [
        { name = "JACKSON_API_KEYS", valueFrom = "${aws_secretsmanager_secret.jackson.arn}:JACKSON_API_KEYS::" },
        { name = "DB_URL", valueFrom = "${aws_secretsmanager_secret.jackson.arn}:DB_URL::" },
        { name = "NEXTAUTH_URL", valueFrom = "${aws_secretsmanager_secret.jackson.arn}:NEXTAUTH_URL::" },
        { name = "EXTERNAL_URL", valueFrom = "${aws_secretsmanager_secret.jackson.arn}:EXTERNAL_URL::" },
        { name = "NEXTAUTH_SECRET", valueFrom = "${aws_secretsmanager_secret.jackson.arn}:NEXTAUTH_SECRET::" },
      ]
      environment = [
        { name = "DB_ENGINE", value = "sql" },
        { name = "DB_TYPE", value = "postgres" },
        { name = "NEXTAUTH_ACL", value = "*" },
      ]
    }
  ])
  tags = local.tags
}

################################################################################
# Migrate Task Definition (one-off, run via ECS RunTask before app deploy)
################################################################################

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name_prefix}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn

  container_definitions = jsonencode([
    {
      name      = "migrate"
      image     = var.app_image
      essential = true
      command   = ["npx", "prisma", "migrate", "deploy"]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "migrate"
        }
      }
      secrets = [
        { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.app.arn}:DATABASE_URL::" },
      ]
    }
  ])
  tags = local.tags
}

################################################################################
# ECS Services
################################################################################

resource "aws_ecs_service" "app" {
  name            = "${local.name_prefix}-app"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.app_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = 3000
  }

  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener.https]
  tags       = local.tags
}

resource "aws_ecs_service" "jackson" {
  name            = "${local.name_prefix}-jackson"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.jackson.arn
  desired_count   = var.jackson_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.jackson.arn
    container_name   = "jackson"
    container_port   = 5225
  }

  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener.https]
  tags       = local.tags
}
