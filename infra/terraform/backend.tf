################################################################################
# Remote State Backend (S3 + DynamoDB)
#
# 1. Create the S3 bucket and DynamoDB table first:
#    aws s3api create-bucket \
#      --bucket passwd-sso-terraform-state \
#      --region ap-northeast-1 \
#      --create-bucket-configuration LocationConstraint=ap-northeast-1
#    aws s3api put-bucket-versioning \
#      --bucket passwd-sso-terraform-state \
#      --versioning-configuration Status=Enabled
#    aws dynamodb create-table \
#      --table-name passwd-sso-terraform-lock \
#      --attribute-definitions AttributeName=LockID,AttributeType=S \
#      --key-schema AttributeName=LockID,KeyType=HASH \
#      --billing-mode PAY_PER_REQUEST \
#      --region ap-northeast-1
#
# 2. Run: terraform init -migrate-state
#
# SECURITY (2026-07 review, F3): the encrypted remote backend is now the DEFAULT,
# not an opt-in. State must never sit unencrypted on a local disk or CI runner.
# `encrypt = true` enforces SSE on the state object; the versioned bucket lets you
# recover from a bad apply; the DynamoDB table prevents concurrent-apply
# corruption. Restrict the bucket with a strict IAM policy and enable S3 access
# logging (see infra/terraform README). Secret VALUES no longer enter state
# (see secrets.tf), but the state still describes the full infra topology — keep
# it encrypted and access-controlled regardless.
################################################################################

terraform {
  backend "s3" {
    bucket         = "passwd-sso-terraform-state"
    key            = "env/terraform.tfstate"
    region         = "ap-northeast-1"
    encrypt        = true
    dynamodb_table = "passwd-sso-terraform-lock"
  }
}
