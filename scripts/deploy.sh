#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/deploy.sh [--skip-migrate]
#
# Prerequisites:
#   Run `terraform apply` first to update task definitions with the new image.
#   Terraform sets the same var.app_image for both app and migrate task defs,
#   guaranteeing schema/code consistency. Use immutable tags (e.g. git-abc1234)
#   or digests (repo@sha256:...) — never use :latest.

CLUSTER="${ECS_CLUSTER:-passwd-sso-prod-cluster}"
MIGRATE_TASK="${MIGRATE_TASK_DEF:-passwd-sso-prod-migrate}"
APP_SERVICE="${APP_SERVICE:-passwd-sso-prod-app}"
SUBNETS="${SUBNETS:?'SUBNETS env required'}"
SECURITY_GROUPS="${SECURITY_GROUPS:?'SECURITY_GROUPS env required'}"

# Verify required tools
for cmd in aws jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required but not installed." >&2
    exit 1
  fi
done

SKIP_MIGRATE=false
if [[ "${1:-}" == "--skip-migrate" ]]; then
  SKIP_MIGRATE=true
fi

# Step 1: Run migration (unless skipped)
if [[ "$SKIP_MIGRATE" == "false" ]]; then
  echo "==> Running database migration..."
  RUN_RESULT=$(aws ecs run-task \
    --cluster "$CLUSTER" \
    --task-definition "$MIGRATE_TASK" \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SECURITY_GROUPS]}" \
    --output json)

  # Check for run-task failures (capacity, permissions, etc.)
  FAILURE_REASON=$(echo "$RUN_RESULT" | jq -r '.failures[0].reason // empty')
  if [[ -n "$FAILURE_REASON" ]]; then
    FAILURE_ARN=$(echo "$RUN_RESULT" | jq -r '.failures[0].arn // "N/A"')
    echo "ERROR: Failed to start migration task: $FAILURE_REASON (arn: $FAILURE_ARN)" >&2
    exit 1
  fi

  TASK_ARN=$(echo "$RUN_RESULT" | jq -r '.tasks[0].taskArn // empty')
  if [[ -z "$TASK_ARN" ]]; then
    echo "ERROR: run-task returned no task ARN" >&2
    echo "$RUN_RESULT" | jq . >&2
    exit 1
  fi
  echo "    Task: $TASK_ARN"
  echo "    Waiting for completion..."

  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

  EXIT_CODE=$(aws ecs describe-tasks \
    --cluster "$CLUSTER" \
    --tasks "$TASK_ARN" \
    --query 'tasks[0].containers[0].exitCode' \
    --output text)

  if [[ "$EXIT_CODE" != "0" ]]; then
    STOPPED_REASON=$(aws ecs describe-tasks \
      --cluster "$CLUSTER" \
      --tasks "$TASK_ARN" \
      --query 'tasks[0].stoppedReason' \
      --output text)
    echo "ERROR: Migration failed (exit code: $EXIT_CODE)" >&2
    echo "    Stopped reason: $STOPPED_REASON" >&2
    echo "    Check CloudWatch Logs for details." >&2
    exit 1
  fi
  echo "    Migration completed successfully."
fi

# Step 2: Update app service (force new deployment)
echo "==> Updating app service..."
aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$APP_SERVICE" \
  --force-new-deployment \
  --query 'service.serviceName' \
  --output text

echo "==> Deployment initiated. Monitor with:"
echo "    aws ecs wait services-stable --cluster $CLUSTER --services $APP_SERVICE"
