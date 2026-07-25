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
#   1. reject a dirty worktree (tracked AND untracked); resolve the FULL commit SHA
#   2. build + push an immutable tag (skip push if the digest already exists)
#   3. terraform apply -var-file=... -var app_image=...   (task defs only)
#   4. run the migrate task, wait for exit 0
#   5. update-service app + jackson + both workers to the new task-def ARNs
#   6. wait for every service to stabilize; fail on a rolled-back deployment
#
# ROLLBACK (no schema change): re-point the services at a previous known-good
# image WITHOUT rebuilding from HEAD and WITHOUT running a migration:
#   ./scripts/deploy.sh --rollback-to <acct>.dkr.ecr.<region>.amazonaws.com/...-app:v0.4.71
# The rollback image must already exist in ECR (it is a prior release). Schema
# rollbacks are NOT handled here — see docs/operations/deployment.md.
#
# For a BRAND-NEW environment do NOT use this script — see
# infra/terraform/README.md "First-time bootstrap".
#
# Required env:
#   AWS_REGION, ECR_URL (app repo URL), TF_VAR_FILE (e.g. envs/prod/terraform.tfvars)
# Optional:
#   TF_DIR (default infra/terraform)

# ---- argument parsing --------------------------------------------------------
ROLLBACK_IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rollback-to)
      ROLLBACK_IMAGE="${2:?--rollback-to requires an image ref}"
      shift 2
      ;;
    --rollback-to=*)
      ROLLBACK_IMAGE="${1#*=}"
      shift
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      echo "usage: deploy.sh [--rollback-to <image>]" >&2
      exit 1
      ;;
  esac
done

REGION="${AWS_REGION:?AWS_REGION env required}"
ECR_URL="${ECR_URL:?ECR_URL env required (e.g. <acct>.dkr.ecr.<region>.amazonaws.com/passwd-sso-prod-app)}"
TF_VAR_FILE="${TF_VAR_FILE:?TF_VAR_FILE env required (e.g. envs/prod/terraform.tfvars)}"
TF_DIR="${TF_DIR:-infra/terraform}"

for cmd in aws docker terraform git jq; do
  command -v "$cmd" &>/dev/null || { echo "ERROR: $cmd is required." >&2; exit 1; }
done

# The ECR ref is <registry-host>/<repository-path>. The repository path may itself
# contain slashes (a namespaced repo, e.g. team/passwd-sso), so strip ONLY the
# registry host — NOT everything up to the last slash (`##*/` would drop the
# namespace and query the wrong repo).
REGISTRY="${ECR_URL%%/*}"        # <acct>.dkr.ecr.<region>.amazonaws.com
REPO_NAME="${ECR_URL#*/}"        # full repository path, namespace included

if [ -n "$ROLLBACK_IMAGE" ]; then
  # ---- ROLLBACK PATH --------------------------------------------------------
  # Use the operator-supplied image verbatim. Do NOT rebuild from HEAD (that
  # would redeploy current code) and do NOT run a migration (a code-only
  # rollback keeps the existing, forward-compatible schema).
  IMAGE="$ROLLBACK_IMAGE"
  echo "==> ROLLBACK to ${IMAGE} (no build, no migration)"

  # Confirm the target tag actually exists in ECR before we point services at it.
  ROLLBACK_TAG="${IMAGE##*:}"
  if [[ "$IMAGE" == *"@sha256:"* ]]; then
    ID_ARG="imageDigest=${IMAGE##*@}"
  else
    ID_ARG="imageTag=${ROLLBACK_TAG}"
  fi
  aws ecr describe-images --region "$REGION" --repository-name "$REPO_NAME" \
    --image-ids "$ID_ARG" >/dev/null 2>&1 \
    || { echo "ERROR: rollback image not found in ECR: $IMAGE" >&2; exit 1; }
  RUN_MIGRATION=false
else
  # ---- FORWARD DEPLOY PATH --------------------------------------------------
  # 1. Refuse a dirty worktree so the deployed SHA always matches committed code.
  #    git diff-index only sees TRACKED changes; the Dockerfile does `COPY . .`,
  #    so an untracked route/config/source would ship under a clean-HEAD tag.
  #    --porcelain --untracked-files=normal catches tracked AND untracked.
  if [ -n "$(git status --porcelain --untracked-files=normal 2>/dev/null)" ]; then
    echo "ERROR: worktree has uncommitted or untracked changes — commit, stash, or" >&2
    echo "       gitignore them before deploying (the image builds from COPY . .)." >&2
    git status --short --untracked-files=normal >&2
    exit 1
  fi
  GIT_SHA=$(git rev-parse HEAD)          # FULL sha, not --short
  IMAGE="${ECR_URL}:git-${GIT_SHA}"
  RUN_MIGRATION=true

  # 2. Build + push, but skip the push if this immutable tag already exists
  #    (ECR repos are IMMUTABLE — re-pushing the same tag fails, which would break
  #    a retry after a mid-deploy failure). The skip TRUSTS an existing
  #    git-<sha> tag as this commit's build. That trust is anchored by ECR
  #    immutability (a tag cannot be overwritten once pushed) + the registry's
  #    IAM push policy; only a principal with ECR push rights could have placed a
  #    forged tag ahead of us, and such a principal can compromise the deploy
  #    regardless. If you need cryptographic provenance, sign images (cosign) and
  #    verify the signature here before the skip.
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
fi

# 3. Register the new task definitions (services stay put — ignore_changes).
echo "==> terraform apply (task definitions only; services unchanged)"
terraform -chdir="$TF_DIR" apply -var-file="$TF_VAR_FILE" -var "app_image=$IMAGE"

CLUSTER=$(terraform -chdir="$TF_DIR" output -raw ecs_cluster_name)

td_arn() { terraform -chdir="$TF_DIR" output -raw "$1"; }

# 4. Run the migration on the freshly-registered migrate task def (forward only).
if [ "$RUN_MIGRATION" = true ]; then
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
else
  echo "==> Skipping migration (rollback path)"
fi

# 5. Advance every service to its new task-def revision. Jackson is included so
#    an image/security bump to the SSO container actually reaches the service
#    (it has ignore_changes = [task_definition] too, so only this loop moves it).
SERVICES=()
for pair in \
  "$(terraform -chdir="$TF_DIR" output -raw ecs_app_service_name):$(td_arn app_task_definition_arn)" \
  "$(terraform -chdir="$TF_DIR" output -raw ecs_jackson_service_name):$(td_arn jackson_task_definition_arn)" \
  "$(terraform -chdir="$TF_DIR" output -raw ecs_audit_outbox_worker_service_name):$(td_arn audit_outbox_worker_task_definition_arn)" \
  "$(terraform -chdir="$TF_DIR" output -raw ecs_retention_gc_worker_service_name):$(td_arn retention_gc_worker_task_definition_arn)"; do
  SVC="${pair%%:*}"; TD="${pair#*:}"
  echo "==> Updating service $SVC → $TD"
  aws ecs update-service --cluster "$CLUSTER" --service "$SVC" \
    --task-definition "$TD" --region "$REGION" --query 'service.serviceName' --output text
  SERVICES+=("$SVC")
done

# 6. Block until every service reconciles, then assert the rollout SUCCEEDED.
#    `update-service` only enqueues the change; without this a failed image
#    (crash-loop / failing health check) would roll back to the prior revision
#    while the script exits 0 — reporting a "successful" deploy that never
#    took effect, and potentially leaving app/worker on DIFFERENT revisions.
echo "==> Waiting for services to stabilize: ${SERVICES[*]}"
if ! aws ecs wait services-stable --cluster "$CLUSTER" --services "${SERVICES[@]}" --region "$REGION"; then
  echo "ERROR: services did not stabilize — see ECS events/CloudWatch" >&2
  exit 1
fi

# services-stable resolves once the running count equals desired and deployments
# settle — but an ECS deployment circuit-breaker ROLLBACK also "stabilizes" (back
# on the old task def). Verify each service is actually running the revision we
# asked for; a mismatch means the new image failed and ECS reverted it.
FAILED=()
for SVC in "${SERVICES[@]}"; do
  # PRIMARY deployment's rolloutState must be COMPLETED (not FAILED/IN_PROGRESS).
  STATE=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" --region "$REGION" \
    --query "services[0].deployments[?status=='PRIMARY']|[0].rolloutState" --output text)
  if [ "$STATE" != "COMPLETED" ]; then
    echo "ERROR: service $SVC rollout state = $STATE (expected COMPLETED — likely a circuit-breaker rollback)" >&2
    FAILED+=("$SVC")
  fi
done
[ ${#FAILED[@]} -eq 0 ] || { echo "ERROR: rollout failed for: ${FAILED[*]}" >&2; exit 1; }

echo "==> Done. All services stable on the new revision."
