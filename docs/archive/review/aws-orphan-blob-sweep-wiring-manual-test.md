# Manual test: aws-orphan-blob-sweep-wiring

Deployment artifacts in the diff: four Terraform variables and their preconditions (`variables.tf`,
`locals.tf`, `ecs.tf`), the retention-gc worker's own task role and its count-gated S3 policy
(`iam.tf`), the app and retention-gc container environments (`ecs.tf`), a renamed EventBridge rule
with a `name_prefix` precondition (`monitoring.tf`), an output (`outputs.tf`), and the worker's
`--count-db-blobs` subcommand (`scripts/retention-gc-worker.ts`). Tier-1 (infrastructure) with a
Tier-2 part: it adds an IAM role and policy.

The Terraform logic is covered locally under a mocked AWS provider and the subcommand against a
real PostgreSQL (M0). Everything that needs the deployed account is `verifiable-local` by the
operator (VE1: Claude runs no `terraform plan` or `apply` against it) or `blocked-deferred` until a
stack opts into S3 (VE2), and lists the command and the expected observation. Commands run from
`infra/terraform` after this setup:

```bash
REGION=<region>
export TF_VAR_FILE=envs/prod/terraform.tfvars      # the file scripts/deploy.sh applies
CLUSTER=$(terraform output -raw ecs_cluster_name)
RG_SVC=$(terraform output -raw ecs_retention_gc_worker_service_name)
NP=${RG_SVC%-retention-gc-worker}                  # the name_prefix
RG_LOG=/ecs/$NP/retention-gc-worker
# The image the app runs now: deploy.sh applies with -var app_image=<digest>, so
# a plan with the tfvars' tag would show every task definition replaced.
APP_TD=$(aws ecs describe-services --cluster "$CLUSTER" --region "$REGION" \
  --services "$(terraform output -raw ecs_app_service_name)" --query 'services[0].taskDefinition' --output text)
RUNNING=$(aws ecs describe-task-definition --task-definition "$APP_TD" --region "$REGION" \
  --query "taskDefinition.containerDefinitions[?name=='app'].image | [0]" --output text)
TFV="-var-file=$TF_VAR_FILE -var app_image=$RUNNING"   # previews only; every apply is deploy.sh's
```

Every plan here is a preview. Every apply is `scripts/deploy.sh`'s, with the variables set in
`$TF_VAR_FILE`: a standalone `terraform apply` would take the tfvars' image tag, and a `-var`
passed to it is undone by the next `deploy.sh`.

## Pre-conditions

- The operator's credentials for the account, and the stack's real tfvars.
- The stack deployed from `main` before this change, so the default plan (M1) is a diff against
  what is running.
- For M2–M5 (VE2): a stack whose database holds no attachments — a new one, or one confirmed by
  `--count-db-blobs` — with `enable_s3_attachments = true` and `s3_kms_key_arn = ""`.
- For M3: an operator principal allowed `iam:SimulatePrincipalPolicy`, and one allowed
  `s3:ListBucketVersions` and `s3:DeleteObjectVersion` on the attachments bucket.

## M0 — Local verification (verifiable-local, executed)

| Check | Command | Result |
|---|---|---|
| Format | `terraform fmt -check -recursive` | exit 0 |
| Validate | `terraform init -backend=false && terraform validate` | exit 0 |
| Root module, mocked provider | `terraform test -json` in `infra/terraform` | 18 passed, exit 0 |
| Run manifest | `check-terraform-test-count.mjs <out> tests/blob_sweep.runs.json` | 18/18, exit 0 |
| anchor-prefix module (unchanged) | `terraform test -json` + count check against `prefix-vectors.json` | 18/18, exit 0 |
| Vitest | `src/__tests__/infra/`, `src/lib/blob-store/`, `src/workers/retention-gc-worker/`, `scripts/__tests__/check-terraform-test-count.test.mjs`, `scripts/__tests__/retention-gc-worker-env.test.mjs` | pass |
| Integration (real PostgreSQL) | `retention-gc-count-db-blobs.integration.test.ts` | run by the orchestrator with the workers stopped |

Each precondition was red-proved on a scratch copy: with the precondition removed, every
`*_fails` run that names it reports "Missing expected failure".

## M1 — Default plan: what an existing stack sees (verifiable-local by the operator, VE1)

**Steps.** With the stack's tfvars unchanged (no new variable set):

```bash
terraform plan $TFV -out=default.tfplan
terraform show -json default.tfplan \
  | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | "\(.change.actions | join(",")) \(.address)"'
```

**Expected.** Exactly these changes, and nothing else:

| Action | Address | Why |
|---|---|---|
| create | `aws_iam_role.ecs_retention_gc_task` | the worker's own role (C2) |
| delete,create (replace) | `aws_ecs_task_definition.retention_gc_worker` | `task_role_arn` changes; task definitions are immutable, and `skip_destroy` keeps the old revision registered |
| delete,create (replace) | `aws_ecs_task_definition.audit_outbox_worker` | `task_role_arn` removed: the outbox worker runs with no task role (round-1 S-1) |
| delete (when it existed) | `aws_iam_role_policy.ecs_s3_access[0]` | the app's bucket policy now exists only with `attachments_blob_backend = "s3"`; it existed on every stack with `enable_s3_attachments` |
| delete,create (replace) or create | `aws_cloudwatch_event_rule.audit_anchor_publisher_family_task_outside_service[0]` | the shortened name (C5). `create` on a stack whose old 66-character name never applied |
| delete,create (replace) or create | `aws_cloudwatch_event_target.audit_anchor_publisher_family_task_outside_service_sns[0]` | follows the rule (its `rule` forces replacement) |
| update | `aws_sns_topic_policy.alarms[0]` | the topic policy lists the rule's ARN, which changes with the name |

- No `aws_iam_role_policy.ecs_retention_gc_task_s3` (count 0 on the `db` default).
- No change to `aws_ecs_task_definition.app` or any task definition not listed: the app's
  environment list is unchanged with every default, and the image is the running one.
- No change to `aws_ecs_service.*` (`ignore_changes = [task_definition]`).
- `aws_iam_role.ecs_task` itself unchanged; it keeps no inline policy on the `db` default.
- Before applying, confirm no running code reads attachment bytes from the bucket: on a `db`
  stack the app never does, so losing `ecs_s3_access` changes nothing it uses.
- Show the retention task's new container definitions and confirm no `environment` key and the
  secrets list `["RETENTION_GC_DATABASE_URL"]`:

  ```bash
  terraform show -json default.tfplan | jq -r '.resource_changes[]
    | select(.address == "aws_ecs_task_definition.retention_gc_worker")
    | .change.after.container_definitions | fromjson | .[0] | {env: has("environment"), secrets: [.secrets[].name]}'
  # expect: {"env": false, "secrets": ["RETENTION_GC_DATABASE_URL"]}
  ```

**Then** run `scripts/deploy.sh` with `$TF_VAR_FILE` unchanged (its apply is the apply).
Expected: the retention service runs a task with the new role, the outbox service a task with
no task role, and the retention worker logs `retention-gc.sweep_done` as before (no
`attachment_objects` count: the sweep is off):

```bash
TASK=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$RG_SVC" --region "$REGION" --query 'taskArns[0]' --output text)
TD=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --region "$REGION" --query 'tasks[0].taskDefinitionArn' --output text)
aws ecs describe-task-definition --task-definition "$TD" --region "$REGION" --query 'taskDefinition.taskRoleArn' --output text
# expect: the value of `terraform output -raw retention_gc_worker_task_role_arn`
aws logs tail "$RG_LOG" --since 30m --region "$REGION" --filter-pattern '{ $.msg = "retention-gc.sweep_done" }'
# expect: sweep_done lines, no "attachment_objects" key in counts
OB_TD=$(aws ecs describe-services --cluster "$CLUSTER" --region "$REGION" \
  --services "$(terraform output -raw ecs_audit_outbox_worker_service_name)" --query 'services[0].taskDefinition' --output text)
aws ecs describe-task-definition --task-definition "$OB_TD" --region "$REGION" --query 'taskDefinition.taskRoleArn' --output text
# expect: None
aws iam list-role-policies --role-name "$NP-ecs-task" --query 'PolicyNames' --output text
# expect: empty (no ecs-s3 on the db default)
```

The rule replacement leaves a gap of seconds between the old rule's deletion and the new one's
creation; a publisher-family task started in that window notifies nobody (alerts.md).

## M2 — Switching a new stack to s3 + report (blocked-deferred, VE2)

**Steps.**

1. `run_retention_once --count-db-blobs` as in `docs/operations/deployment.md` "Running the
   worker's one-off commands". Expected: exit `0`, log
   `{"msg":"count-db-blobs","total":0,"db_stored":0}` on a new stack.
2. Plan without the acknowledgement:
   `terraform plan $TFV -var attachments_blob_backend=s3`. Expected: the plan fails with the
   precondition message naming `attachments_blob_backend_empty_db_ack` and `--count-db-blobs`.
3. Plan (`terraform plan $TFV`) with `-var attachments_blob_backend=s3 -var attachments_blob_backend_empty_db_ack=true
   -var retention_gc_blob_sweep_mode=report`. Expected additions to M1's list:
   - create `aws_iam_role_policy.ecs_retention_gc_task_s3[0]` and `aws_iam_role_policy.ecs_s3_access[0]`;
   - replace `aws_ecs_task_definition.app` (env gains `BLOB_BACKEND=s3`,
     `S3_ATTACHMENTS_BUCKET=<the attachments bucket>`, `AWS_REGION`);
   - the retention task's container gains the same three keys, `RETENTION_GC_BLOB_SWEEP_MODE=report`
     and the secret `DEPLOYMENT_ID` (from the app secret's existing key).
4. Set the three variables in `$TF_VAR_FILE` and run `scripts/deploy.sh`. Then
   `--count-db-blobs` again: `db_stored: 0`.
5. `run_retention_once --init-blob-marker`. Expected: `failures[]` empty, exit `0`, log
   `"result":"created"`; a second run logs `"exists"`. The object:
   `aws s3api get-object --bucket <attachments-bucket> --key .passwd-sso-deployment /dev/stdout`
   prints the app secret's `DEPLOYMENT_ID`.
6. Upload an attachment in the app, then download it. Expected: works; the object exists under
   `personal/<entryId>/<attachmentId>/<generation>.bin`, and the database row holds the JSON ref.
7. Watch one tick: `retention-gc.sweep_done` with `counts.attachment_objects = 0`, and a
   `retention-gc.blob_sweep_report` line. No `blob_sweep_refused`.

**Expected results.** As in each step. A `blob_sweep_refused` with `marker_missing` before step 5 is
expected; after it, none.

## M3 — IAM scope of the retention role (blocked-deferred, VE2; adversarial, Tier-2)

**Steps.** With the stack from M2 (`s3` + `report`):

```bash
ROLE=$(terraform output -raw retention_gc_worker_task_role_arn)
B=$(terraform output -raw attachments_bucket_name)
A=$(terraform output -raw audit_anchors_bucket_name)
sim() { aws iam simulate-principal-policy --policy-source-arn "$ROLE" --action-names "$1" \
  --resource-arns "$2" --query 'EvaluationResults[0].EvalDecision' --output text; }
```

| # | Call | Expected |
|---|---|---|
| 1 | `sim s3:ListBucket arn:aws:s3:::$B` | `allowed` |
| 2 | `sim s3:DeleteObject arn:aws:s3:::$B/personal/x/y.bin` | `allowed` |
| 3 | `sim s3:GetObject arn:aws:s3:::$B/.passwd-sso-deployment` | `allowed` |
| 4 | `sim s3:PutObject arn:aws:s3:::$B/.passwd-sso-deployment` | `allowed` |
| 5 | `sim s3:GetObject arn:aws:s3:::$B/personal/x/y.bin` — read an attachment | `implicitDeny` |
| 6 | `sim s3:PutObject arn:aws:s3:::$B/personal/x/y.bin` — plant an object | `implicitDeny` |
| 7 | `sim s3:PutObject arn:aws:s3:::$B/x/.passwd-sso-deployment` — a marker under another prefix | `implicitDeny` |
| 8 | `sim s3:DeleteObjectVersion arn:aws:s3:::$B/personal/x/y.bin` — permanent delete | `implicitDeny` |
| 9 | `sim s3:PutObjectRetention`, `s3:BypassGovernanceRetention` on `$B/*` | `implicitDeny` |
| 10 | `sim s3:PutLifecycleConfiguration`, `s3:PutBucketPolicy`, `s3:PutBucketVersioning` on `arn:aws:s3:::$B` | `implicitDeny` |
| 11 | `sim s3:ListBucket arn:aws:s3:::$A`, `sim s3:DeleteObject arn:aws:s3:::$A/x` — the anchors bucket | `implicitDeny` |
| 12 | `sim kms:Decrypt '*'` | `implicitDeny` |
| 13 | `aws iam get-role --role-name "${ROLE##*/}" --query 'Role.AssumeRolePolicyDocument'` | one statement: service `ecs-tasks.amazonaws.com`, `aws:SourceAccount` = this account |
| 14 | `aws iam list-role-policies --role-name "$NP-ecs-task"` / `list-attached-role-policies` | inline `$NP-ecs-s3` only (it exists with `s3`), nothing attached |
| 15 | the outbox service's task definition `taskRoleArn` (as in M1) | `None` |

Recovery of a wrong delete (the reason for #8), on a **disposable** stack only — never switch a
production stack to `delete` for this:

1. Set `retention_gc_blob_sweep_mode = "delete"` with `retention_gc_blob_orphan_grace_ms =
   3600000`, and `db_backup_retention_days = 0` with `enable_backup = false` so precondition 4
   allows that grace; apply and `deploy.sh`.
2. As an operator, put an object `personal/<uuid>/<uuid>/<32 lowercase hex>.bin` that no row
   references, and wait past the grace for a tick that deletes it
   (`retention-gc.blob_sweep_done` with `deleted >= 1`).
3. `aws s3api list-object-versions --bucket "$B" --prefix <key> --region "$REGION"` — expected: the
   object's version is still there, under a delete marker.
4. As the operator with `s3:DeleteObjectVersion`, delete the delete marker
   (`aws s3api delete-object --bucket "$B" --key <key> --version-id <the marker's VersionId>`).
   Expected: `aws s3api head-object --bucket "$B" --key <key>` succeeds again.

**Expected results.** Rows 1–4 allowed and nothing else; the deleted object recoverable.

## M4 — Precondition 4 against the stack's real windows (verifiable-local by the operator, VE1)

`terraform plan $TFV -var attachments_blob_backend=s3 -var attachments_blob_backend_empty_db_ack=true
-var retention_gc_blob_sweep_mode=delete` with, in turn:

- no grace → fails with the precondition 4 message (not an evaluation error);
- a grace one millisecond below `max(db_backup_retention_days, enable_backup ? backup_retention_days : 0)`
  days → fails with the same message;
- exactly that window → plans.

With prod's `backup_retention_days = 35` the only passing value is `3024000000`.

## M5 — DEPLOYMENT_ID change with the sweep on (blocked-deferred, VE2)

Follow `docs/operations/audit-anchor-rotation-runbook.md` "DEPLOYMENT_ID change recovery" on a
disposable stack with the sweep in `report`. Expected: after step 3 (new secret value) and a
restart, the worker logs `retention-gc.blob_sweep_refused` with `refused: "marker_mismatch"` each
tick; after step 6's marker delete, `--init-blob-marker` (`created`) and
`--force-new-deployment`, the refusals stop.

## Rollback

- **This change, on a `db` stack (M1):** revert the commit and run `deploy.sh`.
  The retention and outbox task definitions go back to `ecs_task` (replacements), the new role
  is destroyed, `ecs_s3_access[0]` is created again where `enable_s3_attachments` is on, and
  the rule returns to its old name — which fails every plan when
  `<name_prefix>` is longer than 13 characters, so on such a stack keep the C5 part.
- **A stack switched to `s3`:** do not go back to `db` (every S3-stored attachment becomes
  unreadable). Set `retention_gc_blob_sweep_mode = "off"` in `$TF_VAR_FILE` and run
  `deploy.sh` (no standalone apply).
- **A wrongly deleted object:** M3's recovery steps.

## Not covered here

- A migration between database-stored and S3-stored attachments (SC1).
- SSE-KMS (SC3), noncurrent-version expiration (SC4), alarms on `blob_sweep_refused` and
  `attachment_objects = -1` (SC5), a grace cap above 35 days (SC6).
