################################################################################
# ACM Certificate
################################################################################

resource "aws_acm_certificate" "app" {
  count                     = var.create_acm_certificate ? 1 : 0
  domain_name               = var.app_domain
  validation_method         = "DNS"
  subject_alternative_names = [var.jackson_domain]
  tags                      = local.tags
}

resource "aws_route53_record" "cert_validation" {
  count   = var.create_acm_certificate ? length(aws_acm_certificate.app[0].domain_validation_options) : 0
  zone_id = var.hosted_zone_id
  name    = aws_acm_certificate.app[0].domain_validation_options[count.index].resource_record_name
  type    = aws_acm_certificate.app[0].domain_validation_options[count.index].resource_record_type
  records = [aws_acm_certificate.app[0].domain_validation_options[count.index].resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "app" {
  count                   = var.create_acm_certificate ? 1 : 0
  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = aws_route53_record.cert_validation[*].fqdn
}

################################################################################
# Route53 DNS Records
################################################################################

resource "aws_route53_record" "app" {
  zone_id = var.hosted_zone_id
  name    = var.app_domain
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "jackson" {
  zone_id = var.hosted_zone_id
  name    = var.jackson_domain
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
