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
# 2. Uncomment the block below and run: terraform init -migrate-state
################################################################################

# terraform {
#   backend "s3" {
#     bucket         = "passwd-sso-terraform-state"
#     key            = "env/terraform.tfstate"
#     region         = "ap-northeast-1"
#     encrypt        = true
#     dynamodb_table = "passwd-sso-terraform-lock"
#   }
# }
