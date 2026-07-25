################################################################################
# Application Load Balancer
################################################################################

resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  # M5: drop malformed HTTP header NAMES at the ALB. (Note: this does NOT
  # sanitise a well-formed X-Forwarded-For VALUE — see xff_header_processing_mode
  # below and the ecs.tf TRUST_PROXY_HEADERS comment for the real spoof control.)
  drop_invalid_header_fields = true

  # #1: pin XFF handling to "append" so the ALB always appends the connection
  # source IP to any client-supplied X-Forwarded-For (rather than "preserve",
  # which would forward a client-forged XFF unchanged). Combined with the app NOT
  # trusting the VPC CIDR (ecs.tf), the rightmost hop is always the one the ALB
  # actually observed, so a VPC-internal client cannot spoof another IP.
  xff_header_processing_mode = "append"

  tags = local.tags
}

################################################################################
# Target Groups
################################################################################

resource "aws_lb_target_group" "app" {
  name        = "${local.name_prefix}-app-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path                = "/api/health/ready"
    matcher             = "200"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "jackson" {
  name        = "${local.name_prefix}-jackson-tg"
  port        = 5225
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 30
    unhealthy_threshold = 3
  }
}

################################################################################
# Listeners
################################################################################

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.certificate_arn
  depends_on        = [aws_acm_certificate_validation.app]

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener_rule" "jackson_host" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.jackson.arn
  }

  condition {
    host_header {
      values = [var.jackson_domain]
    }
  }
}
