################################################################################
# Image signing key (cosign)
################################################################################
#
# scripts/deploy.sh signs every image it pushes and VERIFIES the signature before
# trusting a pre-existing tag or rolling back to one. Without this, ECR
# immutability alone does not stop a principal that holds ECR push rights but NOT
# ECS deploy rights from pre-placing a forged `git-<sha>` tag: deploy.sh's
# retry-safe "tag already exists → skip build" path would then deploy their
# image. That is a genuine privilege escalation wherever push and deploy roles
# are separated, which is exactly the split this stack uses.
#
# An ASYMMETRIC key is required: the private half never leaves KMS (cosign calls
# kms:Sign), so signing authority is an IAM permission rather than a copyable
# secret, and verification needs only the public key (kms:GetPublicKey).
resource "aws_kms_key" "image_signing" {
  description              = "${local.name_prefix} cosign image signing"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_P256"
  # Signing keys must survive a fumbled destroy: losing the private half
  # invalidates every signature already attached to images in ECR.
  deletion_window_in_days = 30
  enable_key_rotation     = false # KMS cannot auto-rotate asymmetric keys
  tags                    = local.tags
}

resource "aws_kms_alias" "image_signing" {
  name          = "alias/${local.name_prefix}-image-signing"
  target_key_id = aws_kms_key.image_signing.key_id
}

# Attach to the DEPLOY principal only. Splitting these two statements is the
# point of the control: a principal that can push to ECR but does not hold
# kms:Sign cannot produce a signature deploy.sh will accept, so pre-placing a
# forged `git-<sha>` tag no longer escalates into a deploy.
#
# `kms:Verify`/`GetPublicKey` are safe to grant widely (public half only) — put
# them on any principal that needs to verify, e.g. a future CI admission check.
resource "aws_iam_policy" "image_signing" {
  name        = "${local.name_prefix}-image-signing"
  description = "cosign sign (kms:Sign) + verify for the deploy principal"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SignImages"
        Effect   = "Allow"
        Action   = ["kms:Sign"]
        Resource = aws_kms_key.image_signing.arn
      },
      {
        Sid      = "VerifyImages"
        Effect   = "Allow"
        Action   = ["kms:Verify", "kms:GetPublicKey", "kms:DescribeKey"]
        Resource = aws_kms_key.image_signing.arn
      },
    ]
  })
  tags = local.tags
}

################################################################################
# ECR Repositories
################################################################################

resource "aws_ecr_repository" "app" {
  name                 = "${local.name_prefix}-app"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

resource "aws_ecr_repository" "jackson" {
  name                 = "${local.name_prefix}-jackson"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

################################################################################
# Lifecycle Policies — keep last 10 images, expire untagged after 7 days
################################################################################

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        # cosign stores a signature as its own image tagged `sha256-<digest>.sig`.
        # These are TAGGED, so the untagged rule never reaches them, and they do
        # not carry the `v`/`git-` prefixes below — without this rule they would
        # accumulate forever. Kept generously longer than the images they attest
        # so a signature never expires before its subject (which would make
        # `cosign verify` fail on an image that is still deployable).
        rulePriority = 2
        description  = "Expire cosign signature artifacts after 180 days"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["sha256-"]
          countType     = "sinceImagePushed"
          countUnit     = "days"
          countNumber   = 180
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 3
        description  = "Keep last 10 release-tagged images"
        selection = {
          # Immutable repo: images are pushed as version tags (vX.Y.Z), never
          # :latest. Retain the last 10 version-tagged images.
          tagStatus     = "tagged"
          tagPrefixList = ["v"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 4
        description  = "Keep last 20 git-SHA images (scripts/deploy.sh)"
        selection = {
          # deploy.sh pushes `git-<full-sha>`; without a rule these were retained
          # indefinitely (the `v` rule above does not match them). 20 keeps a
          # usable `--rollback-to` window.
          tagStatus     = "tagged"
          tagPrefixList = ["git-"]
          countType     = "imageCountMoreThan"
          countNumber   = 20
        }
        action = { type = "expire" }
      }
    ]
  })
}

resource "aws_ecr_lifecycle_policy" "jackson" {
  repository = aws_ecr_repository.jackson.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep last 10 tagged images"
        selection = {
          # Immutable repo: images are pushed as version tags (vX.Y.Z), never
          # :latest. Retain the last 10 version-tagged images.
          tagStatus     = "tagged"
          tagPrefixList = ["v"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}
