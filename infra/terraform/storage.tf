################################################################################
# S3 — Attachments
################################################################################

resource "aws_s3_bucket" "attachments" {
  count  = var.enable_s3_attachments ? 1 : 0
  bucket = local.attachments_bucket_name

  object_lock_enabled = var.enable_s3_object_lock

  tags = merge(local.tags, { Name = "${local.name_prefix}-attachments" })
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments" {
  count  = var.enable_s3_attachments ? 1 : 0
  bucket = aws_s3_bucket.attachments[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.s3_kms_key_arn != "" ? "aws:kms" : "AES256"
      kms_master_key_id = var.s3_kms_key_arn != "" ? var.s3_kms_key_arn : null
    }
    bucket_key_enabled = var.s3_kms_key_arn != "" ? true : false
  }
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  count                   = var.enable_s3_attachments ? 1 : 0
  bucket                  = aws_s3_bucket.attachments[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "attachments" {
  count  = var.enable_s3_attachments ? 1 : 0
  bucket = aws_s3_bucket.attachments[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

# S3 Object Lock (ランサムウェア耐性 — Compliance mode)
# 注意: Object Lock はバケット作成時に object_lock_enabled = true が必要。既存バケットへの後付け不可。
resource "aws_s3_bucket_object_lock_configuration" "attachments" {
  count  = var.enable_s3_attachments && var.enable_s3_object_lock ? 1 : 0
  bucket = aws_s3_bucket.attachments[0].id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.s3_object_lock_days
    }
  }
}

################################################################################
# CloudFront — Attachments CDN (optional)
################################################################################

resource "aws_cloudfront_origin_access_control" "attachments" {
  count                             = var.enable_cloudfront && var.enable_s3_attachments ? 1 : 0
  name                              = "${local.name_prefix}-attachments-oac"
  description                       = "OAC for attachments bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "attachments" {
  count           = var.enable_cloudfront && var.enable_s3_attachments ? 1 : 0
  enabled         = true
  is_ipv6_enabled = true
  comment         = "passwd-sso attachments"

  origin {
    domain_name              = aws_s3_bucket.attachments[0].bucket_regional_domain_name
    origin_id                = "attachments-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.attachments[0].id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "attachments-s3"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    # AWS Managed Cache Policy: CachingOptimized
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  viewer_certificate {
    acm_certificate_arn            = var.cloudfront_certificate_arn != "" ? var.cloudfront_certificate_arn : null
    cloudfront_default_certificate = var.cloudfront_certificate_arn == "" ? true : null
    ssl_support_method             = var.cloudfront_certificate_arn != "" ? "sni-only" : null
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  aliases = var.cloudfront_aliases

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = local.tags
}

resource "aws_s3_bucket_policy" "attachments" {
  count  = var.enable_cloudfront && var.enable_s3_attachments ? 1 : 0
  bucket = aws_s3_bucket.attachments[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.attachments[0].arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.attachments[0].arn
          }
        }
      }
    ]
  })
}
