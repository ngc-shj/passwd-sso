# Plan: aws-orphan-blob-sweep-wiring

Issue `#1020` (follow-up of `#1018` / `#1010`). Revision 5. The review record is in
`aws-orphan-blob-sweep-wiring-review.md`.

## Project context

- Type: infrastructure (Terraform, AWS ECS Fargate) in a web-app repo
- Test infrastructure: the CI terraform job (Terraform 1.15.8) runs `fmt -check`, `validate` and
  `terraform test` on `modules/anchor-prefix` with a count check. The root module has no
  `terraform test` yet; C4 adds one. Vitest covers rendered task definitions through the
  `hcl-subset` harness (`src/__tests__/infra/`).
- Verification environment constraints:
  - VE1: `terraform plan`/`apply` against the deployed account needs the operator's credentials.
    Classification: `verifiable-local` by the operator. Claude runs neither without confirmation
    (user instruction for this issue). C4's mocked tests cover the logic in CI.
  - VE2: a sweep pass on a deployed stack. Classification: `blocked-deferred` until an operator
    opts a stack into S3. The manual test records it.

## Finding that changes the issue's premise

The issue says the worker "runs on the default (`db`) backend". So does the **app**:
- No AWS task receives `BLOB_BACKEND`, `S3_ATTACHMENTS_BUCKET` or the app's `AWS_REGION`.
  Secrets are mapped key by key, and `deploy.sh`, `put-terraform-secrets.sh` and the tfvars
  examples carry none of them.
- The AWS app therefore stores attachment bytes in the database, and the attachments bucket is
  unused.

**App and worker must use the same backend.**
- With an `s3` app and a `db` worker, the retention purge collects no object refs (`cleanup.ts`),
  so every purged attachment leaves an orphan object.
- With a `db` app and an `s3` worker, nothing breaks: refs fail to decode and are skipped, and
  the sweep lists an empty bucket. But it achieves nothing.

**Switching an existing stack strands data.** In either direction the attachments already
stored stop being readable: `getAttachmentBlobStore()` picks one backend for every read, and no
migration tool exists.

## Objective

Make the orphan sweep usable on AWS. No running stack changes until an operator opts in, and the
retention worker gets least-privilege AWS access of its own.

## Contracts

### C1 — One switch for the attachment backend

- **Variables:**
  - `attachments_blob_backend`: `"db"` (default) or `"s3"`, enforced by validation.
  - `attachments_blob_backend_empty_db_ack`: bool, default `false`. It is required to be `true`
    for `s3`. The operator confirms the database holds no attachments, by running the C6
    `--count-db-blobs` check and seeing 0. It guards the `db`→`s3` switch at plan time only; the reverse direction and the rolling-deploy overlap are covered
    in C3 (rollback and post-rollout check).
  - `retention_gc_blob_sweep_mode`: `"off"` (default), `"report"` or `"delete"`.
  - `retention_gc_blob_orphan_grace_ms`: number or null. Validation mirrors the env schema: an
    integer between 3600000 and 3024000000 (1 h to 35 d), or null.
- **Bucket references** use `one(aws_s3_bucket.attachments[*].id)` / `.arn`. Every templated use
  of the bucket sits behind a guard that is evaluated first: the env local is conditional on the
  backend, and the C2 policy resource has its own `count`. A template interpolating a null
  `one()` errors before any precondition can report (round 2, N1).
- **`local.attachment_blob_env`** is the list `BLOB_BACKEND=s3`, `S3_ATTACHMENTS_BUCKET`,
  `AWS_REGION` when the backend is `s3`, and empty otherwise. It goes into both the app container
  and the retention-gc worker.
  - The worker additionally gets `RETENTION_GC_BLOB_SWEEP_MODE` and the grace (when non-null),
    both only when the mode is not `off`.
  - It gets the existing `DEPLOYMENT_ID` key of the app secret, mapped as a secret, also only
    when the mode is not `off`.
  - A container whose list is empty gets **no `environment` key** (conditional `merge`), so with
    every default the rendered container definitions equal today's.
- **Preconditions** on the retention-gc task definition:
  1. backend `s3` requires `enable_s3_attachments` and the acknowledgement;
  2. backend `s3` requires `s3_kms_key_arn == ""`. No role has KMS permissions, and wiring KMS is
     SC3;
  3. a mode other than `off` requires backend `s3`;
  4. mode `delete` requires `grace != null && grace >= window * 86400000`, where
     `window = max(db_backup_retention_days, enable_backup ? backup_retention_days : 0)`.
     The `!= null` arm comes first so a null grace reports this precondition's message instead of
     an evaluation error (N6).
     - **What it guarantees, and what it does not (N7).** A grace only delays deletion. After a
       restore to a point of age `t`, objects uploaded after that point stay unreferenced and
       become deletable `grace - t` later. The control is the C3 restore procedure (mode `off`
       or `report` before the restore and until reconciled). Precondition 4 is a floor that
       keeps a forgotten procedure from deleting immediately; at `t = window = grace` the margin
       is zero, which the docs state.
     - A `window` above 35 days (AWS Backup up to 120 with Vault Lock) makes `delete`
       unreachable, because the env schema caps the grace at 35 days. Such a stack runs `report`.
       Raising the cap is SC6.
- **Acceptance:**
  - C4: with the defaults, the app and worker container definitions have no `environment` key
    and the worker's `task_role_arn` is the new role.
  - C4: with `s3` + `report`, both containers carry the three keys, and the worker also gets the
    mode and the `DEPLOYMENT_ID` secret.
  - C4: each precondition fails with its own message and passes in its paired allow case,
    including the no-bucket arm of precondition 1 and the null-grace arm of precondition 4.
  - C4 (R3-2): with the defaults the **retention** container has no `environment` key; the app
    container's env names equal today's list and contain no `BLOB_BACKEND`.
  - Vitest (N4, R3-2, N10): the default env and secret name lists per container equal a frozen
    fixture. It is rendered with hcl-subset's default vars before any HCL edit and committed in
    the first implementation commit, with no regenerate flag (N4-5); the
    `s3` + `report` retention env, with placeholder `RETENTION_GC_DATABASE_URL` and
    `DEPLOYMENT_ID`, parses through the worker's env schema.

### C2 — The retention worker gets its own task role

- **`aws_iam_role.ecs_retention_gc_task`**, with the publisher's trust policy (ECS tasks,
  `aws:SourceAccount`). Only the retention-gc task definition uses it. The app and outbox worker
  keep `ecs_task`, whose policies are unchanged.
- **Policy `aws_iam_role_policy.ecs_retention_gc_task_s3`**, with
  `count = backend == "s3" && enable_s3_attachments ? 1 : 0` (N1):
  - `s3:ListBucket` on the bucket. It is load-bearing: without it a missing marker is a 403, not a
    404.
  - `s3:DeleteObject` on `<bucket>/*`, for the purge and the sweep.
  - `s3:GetObject` and `s3:PutObject` on `<bucket>/<local.blob_marker_key>` only.
  - Never `DeleteObjectVersion`, `PutObjectRetention`, `BypassGovernanceRetention`,
    `PutLifecycleConfiguration` or `PutBucket*`. With versioning always on, `DeleteObject` without
    a version only adds a delete marker, which keeps a wrong sweep recoverable by an operator.
- **`local.blob_marker_key = ".passwd-sso-deployment"`**, with a comment: it equals `MARKER_NAME`
  in `src/lib/blob-store/object-ref.ts` with `BLOB_OBJECT_PREFIX` deliberately unset on AWS.
  - A contract test pins it to `blobMarkerKey()`, after the pattern of
    `src/__tests__/infra/audit-anchor-key-contract.test.ts`.
- **No override detection is needed.** Unlike the publisher, this role holds no exclusive
  authority that a bucket policy reserves to it. Its powers are a subset of `ecs_task`'s plus
  `ListBucket`. This is recorded in a comment.
- **Acceptance (C4):** the policy's `GetObject`/`PutObject` resources are exactly the marker ARN,
  and no forbidden action appears.

### C3 — Documentation

- `docs/operations/deployment.md` gains an "Orphan attachment sweep on AWS" section:
  - **Preconditions:** a new stack, or one with no attachments in the database (the
    acknowledgement variable), and SSE-S3 (no CMK).
  - **Rollout:**
    1. Quiesce uploads, set `s3` + `report`, then `terraform apply`, then **`scripts/deploy.sh`**.
       Services ignore task-definition changes, so the deploy is what moves both services. Old
       `db` app tasks can write database-stored attachments during the rolling update (N8).
    2. After the rollout, run the C6 `--count-db-blobs` check (same run-task shape as step 3).
       It must report `total >= 0` and `db_stored = 0`. If `db_stored > 0`: those attachments
       are unreadable under `s3`; the owners delete and re-upload them, or the stack goes back
       to `db` before any S3 upload exists (SC1 is the migration tool).
    3. Run the marker once, with the command shape of `infra/terraform/README.md` and
       `deploy.sh` (`--cluster`, `--launch-type FARGATE`, `--region`, `--network-configuration`,
       and the `--init-blob-marker` command override). Read the result: `failures[]` empty, the
       task's exit code 0, and the logged `created` or `exists` line, not
       `init-blob-marker refused` (N5).
    4. Watch the per-tick counts (`attachment_objects >= 0`), `retention-gc.blob_sweep_report`,
       and the refusal and failure types `retention-gc.blob_sweep_refused`,
       `blob_sweep_list_failed` and `blob_sweep_delete_failed`.
    5. Switch to `delete` with a grace of at least the backup windows (precondition 4), then
       `deploy.sh` again.
  - **Rollback:** keep `s3` and set the sweep mode `off`. Going back to `db` strands every
    S3-stored attachment (N8).
  - **Before a database restore:** set the mode to `off` or `report`, and keep it there until the
    restored references are reconciled. This, not the grace, is the control (N7). State the zero
    margin at `grace = window`, and that a window above 35 days keeps the stack on `report`.
  - **Recovery of wrongly deleted objects:** an operator with `s3:DeleteObjectVersion` removes the
    delete markers. The worker never holds that permission.
  - **Storage is not reclaimed:** versioning keeps noncurrent versions. A noncurrent-expiration
    lifecycle is SC4.
  - **CloudFront:** with `enable_cloudfront`, the marker (the deployment id) is readable through
    the distribution. Accepted: the id also appears in anchor manifests and is not a secret.
- `docs/operations/audit-anchor-rotation-runbook.md` "DEPLOYMENT_ID change recovery" gains a
  conditional marker step (N3):
  - Inside this module the attachments bucket is 1:1 with its stack: Terraform creates it, S3
    names are global, and C1 sets `S3_ATTACHMENTS_BUCKET` only from that resource. A clone or
    restore made with this module therefore has its own bucket (N4-4).
  - **When no deployment outside this module reads or writes the bucket** — an inventory
    question: a Docker or restored copy given `S3_ATTACHMENTS_BUCKET` and S3 credentials
    directly. Check with IAM Access Analyzer or the policy simulator on the bucket ARN, and the
    operator's own records. Then delete the marker (as an operator), re-run
    `--init-blob-marker`, and force a new deployment of the retention-gc service. Secrets are
    injected at task start, so the running task keeps the old id and refuses with
    `marker_mismatch` until restarted.
  - **Otherwise**, or when that cannot be ruled out: never touch the marker, and keep the sweep
    `off`. Re-initialising would make this deployment the owner, and every object the other
    deployment uploads would look orphaned.
- **Docs made stale:**
  - the `infra/terraform/README.md` and `README.ja.md` statements that `DEPLOYMENT_ID` is mapped
    into the publisher only, plus their variable tables;
  - the same statement in `deployment.md`;
  - the comment at `iam.tf` saying workers run as `ecs_task`;
  - `envs/prod/terraform.tfvars.example` and the root `terraform.tfvars.example`;
  - `docs/setup/aws/en.md` (R3-5): `BLOB_BACKEND` listed as an app secret, `DEPLOYMENT_ID` as
    publisher-only, and `AWS_REGION`/`S3_ATTACHMENTS_BUCKET` as operator-set secrets. The
    backend comes from `attachments_blob_backend`; secret keys with these names are ignored.
- An output `retention_gc_worker_task_role_arn`.

### C4 — A root-module `terraform test` with a mocked provider

- `infra/terraform/tests/blob_sweep.tftest.hcl` with `mock_provider "aws"`. The round-2 spike
  established the recipe (N2):
  - `project_name`/`env` from the shipped example tfvars, so the test also catches name-length
    limits (N9);
  - `create_acm_certificate = false` (the `dns.tf` `for_each` keys are unknown under the mock);
  - `mock_resource` ARN defaults for `aws_iam_role`, `aws_lb`, `aws_lb_target_group`,
    `aws_lb_listener` and `aws_sns_topic` (random mock strings fail the ARN validators), and
    `aws_elasticache_cluster.cache_nodes` for `locals.tf`;
  - `init -backend=false`, as in the existing CI step.
- Run blocks:
  1. defaults, `command = apply` (mocked; content asserts need known values);
  2. `s3` + `report`, `command = apply`;
  3. the IAM policy resources, `command = apply`;
  4. `expect_failures` per precondition, each paired with an allow case. These **must** be
     `command = plan`: an `expect_failures` run under `apply` fails and skips later runs.
- **CI:** a step in the terraform job next to the anchor-prefix test. The expected runs live
  outside the test file (R3-4): `infra/terraform/tests/blob_sweep.runs.json` lists the run
  names. `check-terraform-test-count` accepts it as the expected source and compares the set of
  passed `test_run` names in the `-json` output against it, not only the count. The mode is
  chosen by the file's top-level key (`runs` vs `vectors`). Records counted:
  `type == "test_run" && progress == "complete" && status == "pass"`, keyed by path and run
  (teardown records carry no status). Set equality plus `test_summary.passed == runs.length`.
  The vitest `changes` filter in `ci.yml` gains `infra/terraform/tests/**` (N4-6). A vitest test
  pins the `.tftest.hcl` run blocks to the manifest, as `anchor-prefix-vectors.test.ts` does for
  `prefix-vectors.json`, which stays anchor-prefix's source.
- The module-extraction fallback is dropped: the spike planned the root module successfully.

### C6 — `--count-db-blobs`: the one check for database-stored attachments (R3-1)

- A plain `SELECT count(*) FROM attachments` returns 0 on RDS: the table has FORCE RLS, and the
  RDS master is not a superuser. A check tried on Docker (superuser) returns the true count, so
  the failure would only show on AWS. The AWS image has no `psql` either.
- No column says where the bytes live: `encrypted_data` holds ciphertext for `db` and the JSON
  object ref for `s3`.
- **A retention-worker subcommand** `--count-db-blobs`, next to `--init-blob-marker` (its own
  argv branch and its own pool; not exempted from the env refines). It runs in any backend and
  mode, so it serves both the pre-switch acknowledgement and the post-rollout check.
- **Where it lives (N4-2):** an exported function in `src/workers/retention-gc-worker/sweep.ts`
  that uses the module's `inSweepTx` with the existing
  `BYPASS_GRANT.RETENTION_BLOB_ORPHAN_SWEEP` and asserts the bypass, like `readAttachmentRefs`.
  The entrypoint only builds the pool and calls it. No new grant, no new self-setting file.
- **Bounded reads (N4-1):** a `db` stack holds up to 10 MB of ciphertext per row, so the check
  never loads all bytes.
  - `object-ref.ts` exports `MAX_OBJECT_REF_BYTES` (the S3 key limit plus the JSON wrapper), and
    `encodeObjectRef` throws above it, so the writer enforces the bound.
  - SQL counts `count(*)` and `count(*) FILTER (WHERE octet_length(encrypted_data) > bound)`;
    rows over the bound are database-stored by construction.
  - Rows within the bound are fetched in keyset pages (`id > $last ORDER BY id LIMIT n`), each
    page in its own `inSweepTx`, and judged by `decodeObjectRef`. `decodeObjectRef` stays the
    only judge of what a ref is; no JSON-prefix match in SQL.
  - It logs `{ total, db_stored }` and exits 0.
- **Acceptance:**
  - Real-DB integration as the retention-gc role (principal asserted, no bypassrls), on the
    shared database: deltas measured by the function before and after seeding (N4-3) — a
    ciphertext row, an object-ref row and a row just over the bound, in two tenants, give
    `total +3, db_stored +2`. Without the bypass the count is 0 (the RLS positive control).
  - Unit: `encodeObjectRef` of a maximal key fits the bound; one byte over throws.

### C5 — Pre-existing: an EventBridge rule name exceeds 64 characters (N9)

- `"${local.name_prefix}-audit-anchor-publisher-family-task-outside-service"`
  (`monitoring.tf`) is 66 characters with the shipped `prod` tfvars, and AWS allows 64. Any plan
  with `enable_monitoring` (the default) fails.
- Add a precondition on an existing resource (the C5 rule) that `length(local.name_prefix) <= 20`.
  Not a variable validation: one referencing both `project_name` and `env` needs Terraform 1.9,
  and `required_version` is `>= 1.5.0`. Not `terraform_data`: it would add a resource the manual
  test's expected plan does not list (N4-7). It carries a message (R3-6). The existing budget is already set by
  `-audit-anchor-publisher-role-task-definition` (44 chars, 64 limit) and `-jackson-tg`
  (32-char target-group limit).
- Shorten the suffix so it fits under that 20-character bound (e.g.
  `-anchor-publisher-family-outside-svc`), and update `deployment.md`,
  `alerts.md` and the threat model where the name appears. The name forces replacement, so a
  stack that deployed with a shorter prefix gets the rule recreated; the docs note the brief gap.
- C4's example-tfvars names keep it from regressing.

## Testing strategy

- C4 in CI.
- Real-DB integration: C6.
- Vitest: the marker-key contract test, the frozen-fixture rendering test, the run-manifest pin,
  and the
  `s3` + `report` env parsed through the worker schema (`hcl-subset` gains `one()`).
- `fmt -check` and `validate`.
- A manual test for the operator's plan and apply on a real stack, defaults first (expected:
  only the new role, the retention task-definition role change, and the C5 rule replacement).

## Considerations & constraints

- **Scope contract:**
  - SC1: a migration tool between database-stored and S3-stored attachments. Owner: a follow-up
    issue.
  - SC2: GCP and Azure equivalents.
  - SC3: SSE-KMS CMK support (KMS grants for the app and worker roles). Owner: a follow-up issue.
    Precondition 2 blocks `s3` with a CMK until then.
  - SC4: a noncurrent-version lifecycle rule (storage reclaim, erasure). Owner: a follow-up issue.
    Expiring versions permanently deletes data, so it is a decision of its own.
  - SC5: alarms on `blob_sweep_refused` and `attachment_objects = -1`. Owner: the same follow-up.
  - SC6: a grace cap above 35 days for stacks with longer backup retention. Owner: the SC4
    follow-up; until then such stacks run `report`.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | One backend switch with acknowledgement and preconditions | pending |
| C2 | Retention worker's own least-privilege role | pending |
| C3 | Documentation (rollout, rollback, restore, recovery, `DEPLOYMENT_ID` change) | pending |
| C4 | Root `terraform test` with a mocked provider | pending |
| C5 | EventBridge rule name within 64 characters; `name_prefix` bound | pending |
| C6 | `--count-db-blobs` check under the bypass grant | pending |
