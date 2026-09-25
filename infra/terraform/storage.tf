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

    # Refuse SSE-C uploads. With customer-provided keys the caller holds the only
    # copy of the key and S3 stores none of it, so an object written that way is
    # unreadable to this account forever — the write path of a ransomware attack
    # on the attachment store, and unrecoverable by any backup of the bucket
    # itself. Nothing here uses SSE-C: attachments are already E2E-encrypted by
    # the client before upload, and the server-side layer is SSE-S3/SSE-KMS.
    #
    # Stated explicitly because leaving it unset is NOT neutral. AWS now blocks
    # SSE-C by default on new buckets, and the provider treats an absent argument
    # as the empty list, so the first apply after bucket creation planned to
    # UNBLOCK it — silently trading the default protection away as drift
    # correction. Found on the first AWS bootstrap.
    blocked_encryption_types = ["SSE-C"]
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

################################################################################
# S3 — Audit chain anchors
#
# AUDIT_ANCHOR_PUBLISHER_ENABLED=true is REQUIRED in production (env-schema.ts),
# and enabling it requires a signing key, a tag secret, and at least one
# destination. Without an external anchor the audit chain only detects tampering
# inside the database boundary — an attacker with DB write access can rewrite
# history undetected — so this is a hard boot requirement, not a feature flag.
#
# Kept separate from the attachments bucket rather than sharing it under a
# prefix: the two have opposite access shapes. Attachments are read/write/delete
# by the app; anchors are evidence, so the task role below gets PUT and GET and
# NO DeleteObject, and versioning is on so an overwrite cannot erase the prior
# anchor either. Sharing one bucket would have to grant the union.
#
# The filesystem destination is not a usable alternative here: a Fargate task's
# filesystem is ephemeral, so anchors written there vanish with the task and the
# tamper-evidence they exist to provide is lost.
################################################################################

resource "aws_s3_bucket" "audit_anchors" {
  count  = var.enable_s3_audit_anchors ? 1 : 0
  bucket = "${local.name_prefix}-audit-anchors"

  object_lock_enabled = var.enable_s3_object_lock

  tags = merge(local.tags, { Name = "${local.name_prefix}-audit-anchors" })
}

resource "aws_s3_bucket_versioning" "audit_anchors" {
  count  = var.enable_s3_audit_anchors ? 1 : 0
  bucket = aws_s3_bucket.audit_anchors[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_anchors" {
  count  = var.enable_s3_audit_anchors ? 1 : 0
  bucket = aws_s3_bucket.audit_anchors[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.s3_kms_key_arn != "" ? "aws:kms" : "AES256"
      kms_master_key_id = var.s3_kms_key_arn != "" ? var.s3_kms_key_arn : null
    }
    bucket_key_enabled = var.s3_kms_key_arn != "" ? true : false

    # See the attachments bucket: an SSE-C write is unreadable to this account
    # forever, which for the anchor store would destroy the evidence it holds.
    blocked_encryption_types = ["SSE-C"]
  }
}

resource "aws_s3_bucket_public_access_block" "audit_anchors" {
  count                   = var.enable_s3_audit_anchors ? 1 : 0
  bucket                  = aws_s3_bucket.audit_anchors[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
