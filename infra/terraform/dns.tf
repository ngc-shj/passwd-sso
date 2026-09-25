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

# for_each, NOT count. `count = length(domain_validation_options)` cannot be
# planned for a certificate that does not exist yet — the list is unknown until
# apply, so a first-time bootstrap dies with "Invalid count argument". The map
# keys here are the domain names, which come from var.app_domain /
# var.jackson_domain and are therefore known at plan time even though the record
# VALUES are not. This is the pattern the aws_acm_certificate docs use.
resource "aws_route53_record" "cert_validation" {
  for_each = var.create_acm_certificate ? {
    for dvo in aws_acm_certificate.app[0].domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id = var.hosted_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 300
  # A validation record left behind by a partially-failed destroy would
  # otherwise fail the next create with "record already exists".
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  count                   = var.create_acm_certificate ? 1 : 0
  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
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
