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
# and enabling it requires at least one destination. Without an external anchor
# the audit chain only detects tampering inside the database boundary — an
# attacker with DB write access can rewrite history undetected — so this is a
# hard boot requirement, not a feature flag (var.enable_s3_audit_anchors is
# validated true; the count stays so existing state keeps its address).
#
# Kept separate from the attachments bucket rather than sharing it under a
# prefix: the two have opposite access shapes. Attachments are read/write/delete
# by the app; anchors are evidence, written only by the publisher's own task
# role (iam.tf) and never deleted.
#
# The filesystem destination is not a usable alternative here: a Fargate task's
# filesystem is ephemeral, so anchors written there vanish with the task and the
# tamper-evidence they exist to provide is lost.
################################################################################

module "anchor_prefix" {
  source = "./modules/anchor-prefix"
  prefix = var.audit_anchor_s3_prefix
}

locals {
  # Every anchor path below is built from the module's output, never from the
  # variable: the module is where the prefix is validated.
  audit_anchor_prefix = module.anchor_prefix.prefix

  # The manifest key shape, `YYYY-MM-DD.kid-<kid>.jws`, from
  # buildManifestArtifactKey (src/workers/audit-anchor-publisher.ts), joined to
  # the prefix as joinS3Key does. S3 policy wildcards: `?` is one character,
  # `*` any sequence (including `/`). Pinned to the builder by
  # src/__tests__/infra/audit-anchor-key-contract.test.ts.
  audit_anchor_manifest_pattern = "${local.audit_anchor_prefix}/????-??-??.kid-*.jws"
  # The rotation runbook's operator writes (Steps 4-5): the rotation advisory
  # and the public-key archive the verifiers read.
  audit_anchor_break_glass_patterns = [
    "${local.audit_anchor_prefix}/key-rotation-*",
    "${local.audit_anchor_prefix}/public-keys/*",
  ]

  # A retention past this is refused (bucket policy below): the default plus a
  # margin for clock skew and a retain-until computed from a longer year.
  audit_anchor_retention_cap_days = var.audit_anchor_object_lock_days + 31
}

resource "aws_s3_bucket" "audit_anchors" {
  count  = var.enable_s3_audit_anchors ? 1 : 0
  bucket = "${local.name_prefix}-audit-anchors"

  # Always on, independent of var.enable_s3_object_lock (which governs the
  # attachments bucket). The provider marks this argument ForceNew: on a bucket
  # created without Object Lock, flipping it plans a REPLACEMENT. Enable Object
  # Lock in place first (put-object-lock-configuration on the versioned bucket,
  # see docs/operations/deployment.md) so the refreshed state already reads
  # true and no replacement is planned.
  object_lock_enabled = true

  # A replacement would destroy evidence the COMPLIANCE lock exists to keep, so
  # a plan that needs one fails instead of being applied.
  lifecycle {
    prevent_destroy = true
  }

  tags = merge(local.tags, { Name = "${local.name_prefix}-audit-anchors" })
}

resource "aws_s3_bucket_versioning" "audit_anchors" {
  count  = var.enable_s3_audit_anchors ? 1 : 0
  bucket = aws_s3_bucket.audit_anchors[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit_anchors" {
  count  = var.enable_s3_audit_anchors ? 1 : 0
  bucket = aws_s3_bucket.audit_anchors[0].id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.audit_anchor_object_lock_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.audit_anchors]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_anchors" {
  count  = var.enable_s3_audit_anchors ? 1 : 0
  bucket = aws_s3_bucket.audit_anchors[0].id

  rule {
    # SSE-S3 always, never var.s3_kms_key_arn: anchors are signed and
    # tag-pseudonymised, so a CMK adds no confidentiality they need, and a CMK
    # scheduled for deletion would make COMPLIANCE-locked evidence unreadable
    # for the rest of its retention.
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

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

# Who may write what, by key shape. Every statement is a Deny with
# Principal "*": an exception is an `ArnNotEquals aws:PrincipalArn` condition,
# never a NotPrincipal — NotPrincipal names the role, not the assumed-role
# session a task actually signs with, so it would deny the publisher too.
#
# This holds only while nobody replaces the policy, and the account root always
# can. Changes to it, the lifecycle, Object Lock or versioning are alarmed
# (monitoring.tf, audit_anchor_bucket_config_change); a Terraform apply is the
# expected false positive.
resource "aws_s3_bucket_policy" "audit_anchors" {
  count  = var.enable_s3_audit_anchors ? 1 : 0
  bucket = aws_s3_bucket.audit_anchors[0].id

  # The public access block first, so S3 evaluates this policy with
  # block_public_policy already in force.
  depends_on = [aws_s3_bucket_public_access_block.audit_anchors]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Manifests: the publisher's own task role and nobody else.
        Sid       = "DenyManifestWriteExceptPublisher"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.audit_anchors[0].arn}/${local.audit_anchor_manifest_pattern}"
        Condition = {
          ArnNotEquals = { "aws:PrincipalArn" = aws_iam_role.ecs_audit_anchor_publisher_task.arn }
        }
      },
      merge(
        {
          # Rotation advisory and public-key archive: the break-glass operator
          # only. With no operator role configured, nobody — an unconditional
          # Deny, never a condition with an empty value list.
          Sid       = "DenyBreakGlassPathWriteExceptOperator"
          Effect    = "Deny"
          Principal = "*"
          Action    = "s3:PutObject"
          Resource  = [for p in local.audit_anchor_break_glass_patterns : "${aws_s3_bucket.audit_anchors[0].arn}/${p}"]
        },
        # A for-expression rather than `cond ? {...} : {}`, whose two arms
        # have different object types and are refused.
        {
          for k, v in {
            Condition = { ArnNotEquals = { "aws:PrincipalArn" = var.audit_anchor_break_glass_role_arn } }
          } : k => v if var.audit_anchor_break_glass_role_arn != ""
        }
      ),
      {
        # Everything else in the bucket: no one, with no principal exception —
        # the publisher writing <prefix>/other is refused too.
        Sid       = "DenyPutOutsideAnchorPaths"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        NotResource = concat(
          ["${aws_s3_bucket.audit_anchors[0].arn}/${local.audit_anchor_manifest_pattern}"],
          [for p in local.audit_anchor_break_glass_patterns : "${aws_s3_bucket.audit_anchors[0].arn}/${p}"],
        )
      },
      {
        # Extend-only under COMPLIANCE, and capped below; still only the two
        # writers may set it (a PUT carrying lock headers needs it too).
        Sid       = "DenyRetentionChangeExceptWriters"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObjectRetention"
        Resource  = "${aws_s3_bucket.audit_anchors[0].arn}/*"
        Condition = {
          ArnNotEquals = {
            "aws:PrincipalArn" = compact([
              aws_iam_role.ecs_audit_anchor_publisher_task.arn,
              var.audit_anchor_break_glass_role_arn,
            ])
          }
        }
      },
      {
        # A delete marker would hide an anchor from a read by key. No exception.
        Sid       = "DenyDelete"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource  = "${aws_s3_bucket.audit_anchors[0].arn}/*"
      },
      {
        # A bucket-level action, so the bucket ARN: an expiration rule creates
        # delete markers.
        Sid       = "DenyLifecycleConfiguration"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutLifecycleConfiguration"
        Resource  = aws_s3_bucket.audit_anchors[0].arn
      },
      {
        # Also refuses a PUT without the header, so every writer must send it
        # (S3Destination.upload does).
        Sid       = "DenyNonComplianceLockMode"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.audit_anchors[0].arn}/*"
        Condition = {
          StringNotEquals = { "s3:object-lock-mode" = "COMPLIANCE" }
        }
      },
      {
        # COMPLIANCE retention cannot be shortened, so an over-long one is the
        # only retention abuse left: an object nobody can ever remove.
        Sid       = "DenyRetentionAboveCap"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:PutObject", "s3:PutObjectRetention"]
        Resource  = "${aws_s3_bucket.audit_anchors[0].arn}/*"
        Condition = {
          NumericGreaterThan = { "s3:object-lock-remaining-retention-days" = tostring(local.audit_anchor_retention_cap_days) }
        }
      },
      {
        # SSE-S3 or the bucket default; never SSE-KMS (see the encryption
        # configuration above).
        Sid       = "DenyNonSseS3"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.audit_anchors[0].arn}/*"
        Condition = {
          StringNotEqualsIfExists = { "s3:x-amz-server-side-encryption" = "AES256" }
        }
      },
    ]
  })
}
