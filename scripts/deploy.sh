#!/usr/bin/env bash
set -euo pipefail

# Steady-state deploy for the AWS ECS stack (environment already bootstrapped).
#
# Ordering (migration-first) is owned HERE, not by Terraform: Terraform manages
# the task DEFINITIONS (services have ignore_changes = [task_definition]); this
# script registers the new defs via apply, runs the DB migration, and only THEN
# advances every service's running revision. New code never runs against an
# un-migrated schema.
#
#   1. reject a dirty worktree; resolve the FULL commit SHA
#   2. build + push an immutable tag (skip push if the digest already exists)
#   3. terraform apply -var-file=... -var app_image=...   (task defs only)
#   4. run the migrate task, wait for exit 0
#   5. update-service app + jackson + both workers to the new task-def ARNs
#
# For a BRAND-NEW environment do NOT use this script — see
# infra/terraform/README.md "First-time bootstrap".
#
# Required env:
#   AWS_REGION, ECR_URL (app repo URL), TF_VAR_FILE (e.g. envs/prod/terraform.tfvars)
# Optional:
#   TF_DIR (default infra/terraform)

REGION="${AWS_REGION:?AWS_REGION env required}"
ECR_URL="${ECR_URL:?ECR_URL env required (e.g. <acct>.dkr.ecr.<region>.amazonaws.com/passwd-sso-prod-app)}"
TF_VAR_FILE="${TF_VAR_FILE:?TF_VAR_FILE env required (e.g. envs/prod/terraform.tfvars)}"
TF_DIR="${TF_DIR:-infra/terraform}"

for cmd in aws docker terraform git jq; do
  command -v "$cmd" &>/dev/null || { echo "ERROR: $cmd is required." >&2; exit 1; }
done

# 1. Refuse a dirty worktree so the deployed SHA always matches committed code.
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  echo "ERROR: worktree has uncommitted changes — commit or stash before deploying." >&2
  exit 1
fi
GIT_SHA=$(git rev-parse HEAD)          # FULL sha, not --short
IMAGE="${ECR_URL}:git-${GIT_SHA}"
REPO_NAME="${ECR_URL##*/}"
REGISTRY="${ECR_URL%%/*}"

# 2. Build + push, but skip the push if this immutable tag already exists
#    (ECR repos are IMMUTABLE — re-pushing the same tag fails, which would break
#    a retry after a mid-deploy failure).
if aws ecr describe-images --region "$REGION" --repository-name "$REPO_NAME" \
     --image-ids imageTag="git-${GIT_SHA}" >/dev/null 2>&1; then
  echo "==> Image git-${GIT_SHA} already in ECR — skipping build/push (retry-safe)"
else
  echo "==> Building ${IMAGE}"
  docker build -t "$IMAGE" .
  echo "==> Pushing to ECR"
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$REGISTRY"
  docker push "$IMAGE"
fi

# 3. Register the new task definitions (services stay put — ignore_changes).
echo "==> terraform apply (task definitions only; services unchanged)"
terraform -chdir="$TF_DIR" apply -var-file="$TF_VAR_FILE" -var "app_image=$IMAGE"

CLUSTER=$(terraform -chdir="$TF_DIR" output -raw ecs_cluster_name)

td_arn() { terraform -chdir="$TF_DIR" output -raw "$1"; }

# 4. Run the migration on the freshly-registered migrate task def.
MIGRATE_TD=$(td_arn migrate_task_definition_arn)
SUBNETS=$(terraform -chdir="$TF_DIR" output -json private_subnet_ids | jq -r 'join(",")')
SG=$(terraform -chdir="$TF_DIR" output -raw ecs_security_group_id)

echo "==> Running migration task"
RUN=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$MIGRATE_TD" \
  --launch-type FARGATE --region "$REGION" \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG]}" \
  --output json)
FAIL=$(echo "$RUN" | jq -r '.failures[0].reason // empty')
[ -z "$FAIL" ] || { echo "ERROR: run-task failed: $FAIL" >&2; exit 1; }
TASK_ARN=$(echo "$RUN" | jq -r '.tasks[0].taskArn')
echo "    task: $TASK_ARN — waiting..."
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION"
CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --region "$REGION" --query 'tasks[0].containers[0].exitCode' --output text)
[ "$CODE" = "0" ] || { echo "ERROR: migration exited $CODE — see CloudWatch" >&2; exit 1; }
echo "    migration OK"

# 5. Advance every service to its new task-def revision (post-migration).
for pair in \
  "$(terraform -chdir="$TF_DIR" output -raw ecs_app_service_name):$(td_arn app_task_definition_arn)" \
  "$(terraform -chdir="$TF_DIR" output -raw ecs_audit_outbox_worker_service_name):$(td_arn audit_outbox_worker_task_definition_arn)" \
  "$(terraform -chdir="$TF_DIR" output -raw ecs_retention_gc_worker_service_name):$(td_arn retention_gc_worker_task_definition_arn)"; do
  SVC="${pair%%:*}"; TD="${pair#*:}"
  echo "==> Updating service $SVC → $TD"
  aws ecs update-service --cluster "$CLUSTER" --service "$SVC" \
    --task-definition "$TD" --region "$REGION" --query 'service.serviceName' --output text
done

echo "==> Done. Monitor: aws ecs wait services-stable --cluster $CLUSTER --services <service>"
