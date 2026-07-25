#!/usr/bin/env bash
# -E (errtrace) makes the ERR trap fire for failures inside functions and
# subshells too, not only at top level — the compensating-rollback trap below
# depends on it.
set -Eeuo pipefail

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

# Refuse a dirty worktree on EVERY path (forward AND rollback). Both run
# `terraform apply`, which reads the LOCAL .tf files — an uncommitted/untracked
# infra change would otherwise be applied silently, and on the forward path the
# Dockerfile's `COPY . .` would ship untracked source under a clean-HEAD tag.
# git diff-index only sees TRACKED changes, so use --porcelain --untracked-files.
if [ -n "$(git status --porcelain --untracked-files=normal 2>/dev/null)" ]; then
  echo "ERROR: worktree has uncommitted or untracked changes — commit, stash, or" >&2
  echo "       gitignore them before deploying (apply reads local .tf; the image" >&2
  echo "       builds from COPY . .)." >&2
  git status --short --untracked-files=normal >&2
  exit 1
fi

if [ -n "$ROLLBACK_IMAGE" ]; then
  # ---- ROLLBACK PATH --------------------------------------------------------
  # Re-point services at a prior release WITHOUT rebuilding from HEAD (that would
  # redeploy current code) and WITHOUT a migration (a code-only rollback keeps
  # the existing, forward-compatible schema).
  #
  # The rollback ref MUST live in OUR repo, or the ECR existence check below is
  # meaningless: describe-images always queries $REPO_NAME, but Terraform would
  # deploy whatever host/repo the ref names. Without this guard,
  # `--rollback-to evil.example/img:git-<known-tag>` passes (because git-<tag>
  # exists in the trusted repo) yet deploys the attacker image. Require the ref
  # to be exactly ${ECR_URL}:<tag> or ${ECR_URL}@sha256:<digest>.
  case "$ROLLBACK_IMAGE" in
    "${ECR_URL}:"*)
      REF_KIND=tag
      ROLLBACK_TAG="${ROLLBACK_IMAGE##*:}"
      ;;
    "${ECR_URL}@sha256:"*)
      REF_KIND=digest
      ROLLBACK_DIGEST="${ROLLBACK_IMAGE##*@}"
      ;;
    *)
      echo "ERROR: --rollback-to must be \${ECR_URL}:<tag> or \${ECR_URL}@sha256:<digest>." >&2
      echo "       ECR_URL=${ECR_URL}" >&2
      echo "       got:   ${ROLLBACK_IMAGE}" >&2
      exit 1
      ;;
  esac

  # Resolve the ref to an immutable digest FROM ECR and deploy THAT digest, so
  # the thing we validated is exactly the thing we deploy (a tag could in theory
  # be re-pointed between check and use; the repo is IMMUTABLE, but resolving to
  # a digest removes the tag-indirection entirely).
  if [ "$REF_KIND" = tag ]; then
    ID_ARG="imageTag=${ROLLBACK_TAG}"
  else
    ID_ARG="imageDigest=${ROLLBACK_DIGEST}"
  fi
  DIGEST=$(aws ecr describe-images --region "$REGION" --repository-name "$REPO_NAME" \
    --image-ids "$ID_ARG" --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true)
  if [ -z "$DIGEST" ] || [ "$DIGEST" = "None" ]; then
    echo "ERROR: rollback image not found in ECR: $ROLLBACK_IMAGE" >&2
    exit 1
  fi
  IMAGE="${ECR_URL}@${DIGEST}"
  echo "==> ROLLBACK to ${IMAGE} (resolved from ${ROLLBACK_IMAGE}; no build, no migration)"
  RUN_MIGRATION=false
else
  # ---- FORWARD DEPLOY PATH --------------------------------------------------
  GIT_SHA=$(git rev-parse HEAD)          # FULL sha, not --short
  IMAGE="${ECR_URL}:git-${GIT_SHA}"
  RUN_MIGRATION=true

  # Build + push, but skip the push if this immutable tag already exists (ECR
  # repos are IMMUTABLE — re-pushing the same tag fails, which would break a
  # retry after a mid-deploy failure).
  #
  # SECURITY CAVEAT: the skip TRUSTS a pre-existing git-<sha> tag as this commit's
  # build. ECR immutability stops it being *overwritten*, but a principal with
  # ECR PUSH but NOT ECS-deploy rights could pre-place a forged git-<sha> ahead
  # of us; the skip would then deploy their image — a real privilege escalation
  # where push and deploy roles are separated. This is NOT closed here. To close
  # it, sign images at build (cosign/ECR image signing) and verify the signature
  # on this branch BEFORE trusting the existing tag. Tracked as a follow-up.
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
  TASK_ARN=$(echo "$RUN" | jq -r '.tasks[0].taskArn // empty')
  # run-task can return neither a task nor a failure (e.g. an empty tasks array
  # under some throttle/placement conditions); guard against feeding a null ARN
  # to the waiter, which would otherwise wait on nothing and pass vacuously.
  [ -n "$TASK_ARN" ] || { echo "ERROR: run-task returned no task ARN and no failure — aborting." >&2; exit 1; }
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
#
#    Collect EVERYTHING first — service name, the revision we WANT, and the
#    revision it is on NOW — for ALL services, BEFORE issuing a single
#    update-service. The compensating rollback needs the complete pre-deploy
#    picture; building it incrementally inside the update loop would leave the
#    not-yet-reached services unrecorded exactly when a mid-loop failure makes
#    the rollback necessary.
SERVICES=()
WANT_TD=()
PREV_TD=()
for pair in \
  "$(terraform -chdir="$TF_DIR" output -raw ecs_app_service_name):$(td_arn app_task_definition_arn)" \
  "$(terraform -chdir="$TF_DIR" output -raw ecs_jackson_service_name):$(td_arn jackson_task_definition_arn)" \
  "$(terraform -chdir="$TF_DIR" output -raw ecs_audit_outbox_worker_service_name):$(td_arn audit_outbox_worker_task_definition_arn)" \
  "$(terraform -chdir="$TF_DIR" output -raw ecs_retention_gc_worker_service_name):$(td_arn retention_gc_worker_task_definition_arn)"; do
  SVC="${pair%%:*}"; TD="${pair#*:}"
  BEFORE=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" --region "$REGION" \
    --query 'services[0].taskDefinition' --output text)
  [ -n "$BEFORE" ] && [ "$BEFORE" != "None" ] \
    || { echo "ERROR: could not read current task definition for $SVC" >&2; exit 1; }
  SERVICES+=("$SVC")
  WANT_TD+=("$TD")
  PREV_TD+=("$BEFORE")
done

# Compensating rollback: put EVERY service back on its pre-deploy revision. ECS
# only auto-reverts the service(s) that failed, so a partial failure otherwise
# leaves a version SPLIT (some services new, some reverted). This restores a
# uniform, known-good state across the whole stack, then WAITS and VERIFIES —
# a rollback that silently failed is worse than none, because the operator would
# believe the stack is consistent.
#
# Defined BEFORE the update loop and armed via trap so that a failure of the
# update-service call ITSELF (e.g. the 2nd of 4 throttled/denied) still triggers
# compensation; under `set -e` the script would otherwise exit at that line and
# never reach a rollback defined further down.
ROLLBACK_DONE=false
rollback_all() {
  # Guard against re-entry: the trap fires, and the explicit call sites below
  # would otherwise run it a second time.
  [ "$ROLLBACK_DONE" = false ] || return 0
  ROLLBACK_DONE=true
  echo "==> Compensating rollback — restoring all services to their pre-deploy revision" >&2
  local i failed_rb=()
  for i in "${!SERVICES[@]}"; do
    echo "    ${SERVICES[$i]} → ${PREV_TD[$i]}" >&2
    if ! aws ecs update-service --cluster "$CLUSTER" --service "${SERVICES[$i]}" \
        --task-definition "${PREV_TD[$i]}" --region "$REGION" \
        --query 'service.serviceName' --output text >/dev/null; then
      echo "    ERROR: rollback update-service FAILED for ${SERVICES[$i]}" >&2
      failed_rb+=("${SERVICES[$i]}")
    fi
  done
  echo "    waiting for rolled-back services to stabilize..." >&2
  if ! aws ecs wait services-stable --cluster "$CLUSTER" --services "${SERVICES[@]}" --region "$REGION"; then
    echo "    ERROR: rolled-back services did not stabilize" >&2
    failed_rb+=("<stabilize>")
  fi
  # Verify each service actually landed back on its pre-deploy revision.
  for i in "${!SERVICES[@]}"; do
    local now
    now=$(aws ecs describe-services --cluster "$CLUSTER" --services "${SERVICES[$i]}" \
      --region "$REGION" --query 'services[0].taskDefinition' --output text 2>/dev/null || echo "")
    if [ "$now" != "${PREV_TD[$i]}" ]; then
      echo "    ERROR: ${SERVICES[$i]} is on $now, expected ${PREV_TD[$i]}" >&2
      failed_rb+=("${SERVICES[$i]}")
    fi
  done
  if [ ${#failed_rb[@]} -ne 0 ]; then
    echo "==> COMPENSATING ROLLBACK INCOMPLETE — MANUAL INTERVENTION REQUIRED." >&2
    echo "    unresolved: ${failed_rb[*]}" >&2
    return 1
  fi
  echo "    compensating rollback verified: all services back on their pre-deploy revision." >&2
  return 0
}

# Arm the traps: any unhandled failure (set -e) or interrupt from here on runs
# the compensation before exiting, so we never leave a half-updated stack behind.
#
# ERR and the signals need SEPARATE handlers. On a signal received between
# commands, `$?` is the exit status of the last COMPLETED command — normally 0 —
# so a shared handler doing `exit $?` would exit 0 and report a deploy that was
# interrupted mid-rollout as a SUCCESS to CI/CD. Signals therefore carry their
# own conventional non-zero status (128 + signal number).
on_err() {
  local rc=$?
  trap - ERR INT TERM
  # `set -e` fires ERR with a zero status only in pathological cases; force a
  # non-zero exit either way so an abort can never look like success.
  [ "$rc" -ne 0 ] || rc=1
  echo "ERROR: deploy aborted (exit $rc) — compensating." >&2
  rollback_all || true
  exit "$rc"
}
on_signal() {
  local rc="$1"
  trap - ERR INT TERM
  echo "ERROR: deploy interrupted by signal (exit $rc) — compensating." >&2
  rollback_all || true
  exit "$rc"
}
trap on_err ERR
trap 'on_signal 130' INT   # 128 + SIGINT(2)
trap 'on_signal 143' TERM  # 128 + SIGTERM(15)

for i in "${!SERVICES[@]}"; do
  echo "==> Updating service ${SERVICES[$i]} → ${WANT_TD[$i]} (was ${PREV_TD[$i]})"
  aws ecs update-service --cluster "$CLUSTER" --service "${SERVICES[$i]}" \
    --task-definition "${WANT_TD[$i]}" --region "$REGION" \
    --query 'service.serviceName' --output text
done

# 6. Block until every service reconciles, then assert the rollout SUCCEEDED.
#    `update-service` only enqueues the change.
echo "==> Waiting for services to stabilize: ${SERVICES[*]}"
if ! aws ecs wait services-stable --cluster "$CLUSTER" --services "${SERVICES[@]}" --region "$REGION"; then
  trap - ERR INT TERM
  echo "ERROR: services did not stabilize — see ECS events/CloudWatch" >&2
  rollback_all || true
  exit 1
fi

# services-stable resolves once running == desired and deployments settle — but a
# circuit-breaker ROLLBACK ALSO stabilizes: ECS starts a NEW deployment on the
# previous (good) task def, which reaches rolloutState=COMPLETED. So COMPLETED
# alone does NOT prove our revision won — the PRIMARY could be COMPLETED on the
# OLD def. Assert BOTH: rolloutState == COMPLETED AND the PRIMARY deployment's
# taskDefinition == the exact ARN we requested for THIS service.
FAILED=()
for i in "${!SERVICES[@]}"; do
  SVC="${SERVICES[$i]}"
  read -r STATE ACTIVE_TD < <(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" --region "$REGION" \
    --query "services[0].deployments[?status=='PRIMARY']|[0].[rolloutState,taskDefinition]" --output text)
  if [ "$STATE" != "COMPLETED" ]; then
    echo "ERROR: service $SVC rollout state = $STATE (expected COMPLETED)" >&2
    FAILED+=("$SVC")
  elif [ "$ACTIVE_TD" != "${WANT_TD[$i]}" ]; then
    echo "ERROR: service $SVC settled on $ACTIVE_TD, not the requested ${WANT_TD[$i]} — circuit-breaker rolled it back." >&2
    FAILED+=("$SVC")
  fi
done
if [ ${#FAILED[@]} -ne 0 ]; then
  trap - ERR INT TERM
  echo "ERROR: rollout failed for: ${FAILED[*]}" >&2
  rollback_all || true
  exit 1
fi

# Success — disarm the compensation trap so a failure in any later step (there
# are none today) cannot roll back a deploy that already succeeded.
trap - ERR INT TERM

echo "==> Done. All services stable on the new revision."
