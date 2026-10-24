# Manual test: aws-anchor-publisher-verify-worker

Deployment artifacts in the diff: two new ECS services and task definitions (`ecs.tf`), the
publisher's own task role (`iam.tf`), the anchors bucket's Object Lock, encryption and policy
(`storage.tf`, `modules/anchor-prefix`), new alarms and EventBridge rules (`monitoring.tf`),
`scripts/deploy.sh` (six services), the Dockerfile's four worker bundles. Tier-2: it changes IAM,
a bucket policy and the signing path.

Everything in the publisher's own behaviour is tested locally (unit, real-PostgreSQL
integration, MinIO); see M0. Every other scenario is `blocked-deferred` (plan E1: no AWS
environment runs) to the next AWS bootstrap, and lists the command and the expected
observation. Commands run from `infra/terraform` after this setup:

```bash
REGION=<region>
CLUSTER=$(terraform output -raw ecs_cluster_name)
PUB_SVC=$(terraform output -raw ecs_audit_anchor_publisher_service_name)
VER_SVC=$(terraform output -raw ecs_audit_chain_verify_worker_service_name)
PUB_TD=$(terraform output -raw audit_anchor_publisher_task_definition_arn)
PUB_ROLE=$(terraform output -raw audit_anchor_publisher_task_role_arn)
B=$(terraform output -raw audit_anchors_bucket_name)
P=$(terraform output -raw audit_anchor_s3_prefix)
TOPIC=$(terraform output -raw sns_alarms_topic_arn)
NP=${PUB_SVC%-audit-anchor-publisher}          # the name_prefix
PUB_LOG=/ecs/$NP/audit-anchor-publisher
```

Pre-conditions for all of M1–M8: `enable_monitoring = true` with a confirmed SNS email
subscription (`aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" --region "$REGION"`), the
app secret holding `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`, `AUDIT_ANCHOR_SIGNING_KEY`,
`AUDIT_ANCHOR_TAG_SECRET` and `DEPLOYMENT_ID`, and `audit_anchor_break_glass_role_arn` set to a
role you can act as through a CLI profile `anchor-break-glass`.

## M0 — Local verification (verifiable-local, executed)

Run for batch 4 (2026-10-24), exit codes in the batch report: `terraform fmt -check -recursive`,
`init -backend=false` + `validate` (root, clean `TF_DATA_DIR`), `terraform test -json` in
`modules/anchor-prefix` (15 passed) and `check-terraform-test-count.mjs` (15/15); the documented
local commands — `generate:audit-anchor-signing-key -- --out`, the runbook's openssl kid
derivation (compared with the publisher's own derivation), the retain-until computation, the
`DEPLOYMENT_ID` merge filter (allow and every refusal), the manifest-sha256 recipe (compared with
`manifestSha256` from `canonicalize`), and the verification doc's openssl quick check against a
manifest signed by `sign()`.

## M1 — First bootstrap and first publish (blocked-deferred, E1)

Pre-conditions: a new environment bootstrapped per `infra/terraform/README.md` "First-time
bootstrap", services scaled up (Phase D); no tenant chain-enabled.

Steps:
1. `aws ecs describe-services --cluster "$CLUSTER" --services "$PUB_SVC" "$VER_SVC" --region "$REGION" --query 'services[].[serviceName,runningCount,desiredCount]'`
2. `aws logs tail "$PUB_LOG" --since 1h --region "$REGION"`
3. Enable the chain on one test tenant (owner role):
   `BEGIN; SET LOCAL app.tenant_id = '<tenant-uuid>'; UPDATE tenants SET audit_chain_enabled = true WHERE id = '<tenant-uuid>'; COMMIT;`
   then generate one audit event in that tenant (e.g. sign in) and restart the publisher for a
   boot run: `aws ecs update-service --cluster "$CLUSTER" --service "$PUB_SVC" --force-new-deployment --region "$REGION"`.
4. `aws logs tail "$PUB_LOG" --since 15m --region "$REGION" --filter-pattern '{ $._logType = "audit-anchor-publisher.cadence" }'`
5. `aws s3api list-object-versions --bucket "$B" --prefix "$P/" --region "$REGION"`
6. `aws s3api get-object-retention --bucket "$B" --key "$P/<date>.kid-<kid>.jws" --region "$REGION"`
7. The next day: step 4 again with `--since 26h`.
8. `aws logs tail /ecs/$NP/audit-chain-verify-worker --since 3h --region "$REGION" --filter-pattern '{ $._logType = "audit-chain-verify-heartbeat" }'`

Expected:
1. both services `runningCount 1`.
2. `destinations ready`
   (`s3-object-lock`), `audit-anchor-publisher: cadence=24h` with the kid, a cadence line
   `kind: "skipped_no_tenants"`, `everChainEnabled: false`, and a `cadence_healthy` line.
4. `kind: "published"`, plus one `audit-anchor-publisher.missing_prior_cadence` warn line.
5. one key `<P>/<YYYY-MM-DD>.kid-audit-anchor-<16 hex>.jws` (the UTC boundary date), one version.
6. `"Mode": "COMPLIANCE"`, `RetainUntilDate` 2555 days after the PUT.
7. one `published` for the new boundary and no `missing_prior_cadence`.
8. one heartbeat per hour, `erroredTenantCount: 0`, `failedTenantCount: 0`.

Rollback: set the test tenant's `audit_chain_enabled` back to `false` (this leaves an
`audit_chain_anchors` row, so `<NP>-audit-anchor-chain-enabled-fell-to-zero` then fires each run
— expected, M7). Published anchors cannot and must not be removed.

## M2 — ECS deployment across a boundary (blocked-deferred, E1)

Pre-conditions: M1 done; a new image to deploy (or none: `--force-new-deployment` exercises the
same deployment configuration).

Steps:
1. At 00:03 UTC: `./scripts/deploy.sh` (or `aws ecs update-service --cluster "$CLUSTER" --service "$PUB_SVC" --force-new-deployment --region "$REGION"`).
2. Every 15 s until stable: `aws ecs list-tasks --cluster "$CLUSTER" --service-name "$PUB_SVC" --desired-status RUNNING --region "$REGION"`
3. `aws ecs describe-tasks --cluster "$CLUSTER" --tasks <old-task> <new-task> --region "$REGION" --query 'tasks[].[taskArn,startedAt,stoppingAt,stoppedAt,lastStatus]'`
   (the old task from `--desired-status STOPPED`).
4. `aws logs tail "$PUB_LOG" --since 30m --region "$REGION"`

Expected: step 2 never lists two tasks; the old task's `stoppedAt` precedes the new one's
`startedAt`; the old task logs `audit-anchor-publisher.shutdown` (`SIGTERM`) and exits 0 within
`stopTimeout` (120 s); the new task's boot run logs `published` for the 00:05 boundary if the old
one had not published it, otherwise `skipped_already_published` — exactly one `published` for
that boundary across both tasks. `<NP>-audit-anchor-publisher-down` stays OK (the gap is under 10
minutes). `deploy.sh` reports all six services on the new revision.

Rollback: `deploy.sh`'s compensating rollback restores every service to its pre-deploy revision
on failure; nothing else to undo.

## M3 — IAM and bucket-policy evaluation (blocked-deferred, E1; adversarial, Tier-2)

The publisher's positive case — it can write a manifest key — is M1's `published`. The probes
below must not create objects: every expected outcome is a refusal, and a probe that is wrongly
allowed leaves a locked object that no verifier should mistake for an anchor, so probe keys carry
`probe` and a one-day retain-until.

**Probe as the publisher's task role.** The publisher's image has no AWS CLI, so register a
throwaway task definition with the publisher's task role and the AWS CLI image (pin a digest):

```bash
EXEC_ROLE=$(aws ecs describe-task-definition --task-definition "$PUB_TD" --region "$REGION" \
  --query 'taskDefinition.executionRoleArn' --output text)
cat > probe.sh <<EOF
k() { if "\$@" >/tmp/o 2>&1; then echo "ALLOWED: \$*"; else echo "DENIED: \$* :: \$(tail -1 /tmp/o)"; fi; }
echo probe > /tmp/x
RU=\$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)
L="--object-lock-mode COMPLIANCE --object-lock-retain-until-date \$RU --server-side-encryption AES256 --checksum-algorithm SHA256"
k aws s3api put-object --bucket $B --key $P/other-probe --body /tmp/x \$L
k aws s3api put-object --bucket $B --key $P/key-rotation-probe.jws --body /tmp/x \$L
k aws s3api put-object --bucket $B --key $P/public-keys/probe.pub --body /tmp/x \$L
k aws s3api put-object --bucket $B --key other-probe --body /tmp/x \$L
k aws s3api put-object --bucket $B --key $P/1999-01-01.kid-audit-anchor-probe00000000.jws --body /tmp/x
k aws s3api put-object --bucket $B --key $P/1999-01-02.kid-audit-anchor-probe00000000.jws --body /tmp/x --object-lock-mode COMPLIANCE --object-lock-retain-until-date \$RU --server-side-encryption aws:kms --checksum-algorithm SHA256
k aws s3api put-object --bucket $B --key $P/1999-01-03.kid-audit-anchor-probe00000000.jws --body /tmp/x --object-lock-mode COMPLIANCE --object-lock-retain-until-date \$(date -u -d '+3000 days' +%Y-%m-%dT%H:%M:%SZ) --server-side-encryption AES256 --checksum-algorithm SHA256
k aws s3api delete-object --bucket $B --key $P/delete-probe
k aws s3api put-bucket-lifecycle-configuration --bucket $B --lifecycle-configuration '{"Rules":[{"ID":"probe","Status":"Enabled","Filter":{"Prefix":"probe/"},"Expiration":{"Days":1}}]}'
EOF
jq -n --arg role "$PUB_ROLE" --arg exec "$EXEC_ROLE" --arg log "$PUB_LOG" --arg region "$REGION" \
  --rawfile script probe.sh '{
  family: "anchor-policy-probe", requiresCompatibilities: ["FARGATE"], networkMode: "awsvpc",
  cpu: "256", memory: "512", taskRoleArn: $role, executionRoleArn: $exec,
  containerDefinitions: [{ name: "probe", image: "public.ecr.aws/aws-cli/aws-cli@sha256:<digest>",
    essential: true, entryPoint: ["/bin/sh", "-c"], command: [$script],
    logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": $log,
      "awslogs-region": $region, "awslogs-stream-prefix": "probe" } } }] }' > probe-td.json
aws ecs register-task-definition --cli-input-json file://probe-td.json --region "$REGION"
aws ecs run-task --cluster "$CLUSTER" --task-definition anchor-policy-probe --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$(terraform output -json private_subnet_ids | jq -r 'join(",")')],securityGroups=[$(terraform output -raw ecs_security_group_id)]}" \
  --region "$REGION"
aws logs tail "$PUB_LOG" --log-stream-name-prefix probe/ --since 15m --region "$REGION"
```

Expected: every line `DENIED … AccessDenied` — `<P>/other-probe` and `other-probe`
(`DenyPutOutsideAnchorPaths`), both break-glass paths (`DenyBreakGlassPathWriteExceptOperator`),
the manifest key without lock headers (`DenyNonComplianceLockMode`), with `aws:kms`
(`DenyNonSseS3`), with a 3000-day retention (`DenyRetentionAboveCap`), the delete (no IAM
permission and `DenyDelete`), the lifecycle rule (no IAM permission and
`DenyLifecycleConfiguration`).

Repeat with `taskRoleArn` set to the shared `*-ecs-task` role (what the app and the outbox and
retention-GC workers run as) and a correctly-headed manifest-shaped probe key
(`$P/1999-01-04.kid-audit-anchor-probe00000000.jws` with `$L`): expected `DENIED`
(`DenyManifestWriteExceptPublisher`) — a compromised app task cannot write an anchor. Repeat with no
task role, as the verify worker runs: expected `Unable to locate credentials`.

**Probe as the break-glass role** (from the operator host):

```bash
RU=$(node -e 'console.log(new Date(Date.now()+864e5).toISOString().replace(/\.\d{3}Z$/,"Z"))')
L=(--object-lock-mode COMPLIANCE --object-lock-retain-until-date "$RU" --server-side-encryption AES256 --checksum-algorithm SHA256)
echo probe > x
aws s3api put-object --profile anchor-break-glass --region "$REGION" --bucket "$B" --key "$P/key-rotation-probe-$(date -u +%Y%m%d%H%M).jws" --body x "${L[@]}"
aws s3api put-object --profile anchor-break-glass --region "$REGION" --bucket "$B" --key "$P/public-keys/probe-$(date -u +%Y%m%d%H%M).pub" --body x "${L[@]}"
aws s3api put-object --profile anchor-break-glass --region "$REGION" --bucket "$B" --key "$P/key-rotation-probe-nolock.jws" --body x
aws s3api put-object --profile anchor-break-glass --region "$REGION" --bucket "$B" --key "$P/1999-01-05.kid-audit-anchor-probe00000000.jws" --body x "${L[@]}"
aws s3api put-object --profile anchor-break-glass --region "$REGION" --bucket "$B" --key "$P/other-probe" --body x "${L[@]}"
aws s3api delete-object --profile anchor-break-glass --region "$REGION" --bucket "$B" --key "$P/delete-probe"
aws s3api put-object --region "$REGION" --bucket "$B" --key "$P/key-rotation-probe-admin.jws" --body x "${L[@]}"   # your own admin identity
```

Expected: the first two succeed with a `VersionId` (the Step 4–5 writes work with the lock
headers); every other one fails with `AccessDenied` (no lock headers; the manifest path; outside
the anchor paths; delete; a principal other than the break-glass role, even an administrator).
Then `aws s3api get-object-retention --profile anchor-break-glass --region "$REGION" --bucket "$B" --key <first key>`:
`COMPLIANCE`, the one-day `RetainUntilDate`. With `audit_anchor_break_glass_role_arn = ""` applied,
the first two fail too (unconditional Deny).

Rollback: `aws ecs deregister-task-definition --task-definition anchor-policy-probe:<rev> --region "$REGION"`;
`rm probe.sh probe-td.json x`. The two allowed probe objects stay (deletes are refused to
everyone); they lie outside the manifest pattern, so no verifier reads them as anchors. A probe
that was wrongly allowed is a finding: record its key and version, and fix the policy before
going on.

**Probe a replication write.** A replica lands under `s3:ReplicateObject` (and `ReplicateDelete`,
`ReplicateTags`), not `s3:PutObject`, so none of the statements above refuse it;
`DenyReplicationWrite` does, for everyone. From the operator host, with a scratch source bucket
and a scratch replication role (trusted by `s3.amazonaws.com`; `s3:GetReplicationConfiguration`
and `s3:ListBucket` on the source, `s3:GetObjectVersionForReplication`, `s3:GetObjectVersionAcl`,
`s3:GetObjectVersionTagging` and `s3:GetObjectRetention` on its objects, and `s3:ReplicateObject`,
`s3:ReplicateDelete`, `s3:ReplicateTags` on `arn:aws:s3:::$B/*` — the grant a replication
setup would give it):

```bash
SRC=<name_prefix>-anchor-replication-probe-src
KEY="$P/1999-01-06.kid-audit-anchor-probe00000000.jws"
aws s3api create-bucket --bucket "$SRC" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION"
aws s3api put-bucket-versioning --bucket "$SRC" --region "$REGION" --versioning-configuration Status=Enabled
aws s3api put-bucket-replication --bucket "$SRC" --region "$REGION" --replication-configuration \
  "{\"Role\":\"$REPL_ROLE\",\"Rules\":[{\"ID\":\"probe\",\"Status\":\"Enabled\",\"Priority\":1,\"Filter\":{},\"DeleteMarkerReplication\":{\"Status\":\"Disabled\"},\"Destination\":{\"Bucket\":\"arn:aws:s3:::$B\"}}]}"
echo probe > x
aws s3api put-object --bucket "$SRC" --region "$REGION" --key "$KEY" --body x
# a few minutes later:
aws s3api head-object --bucket "$SRC" --region "$REGION" --key "$KEY" --query ReplicationStatus
aws s3api head-object --bucket "$B" --region "$REGION" --key "$KEY"
```

Expected: `"FAILED"` on the source, and `404` on the anchors bucket — the replica was refused.
`COMPLETED`, or an object at `$KEY` in `$B`, is a finding: record its version and fix the policy.
Rollback: `aws s3api delete-bucket-replication --bucket "$SRC"`, delete the source's object
versions and the bucket, and the scratch role.

## M4 — Object Lock retention on real S3 (blocked-deferred, E1/E2)

Steps:
1. `aws s3api get-object-lock-configuration --bucket "$B" --region "$REGION"`
2. `aws s3api get-object-retention --bucket "$B" --key "$P/<date>.kid-<kid>.jws" --region "$REGION"` (M1's manifest)
3. As the break-glass role, try to shorten it:
   `aws s3api put-object-retention --profile anchor-break-glass --region "$REGION" --bucket "$B" --key "$P/<date>.kid-<kid>.jws" --retention "Mode=COMPLIANCE,RetainUntilDate=$(node -e 'console.log(new Date(Date.now()+864e5).toISOString())')"`
4. As your administrator identity, delete the version outright:
   `aws s3api delete-object --bucket "$B" --key "$P/<date>.kid-<kid>.jws" --version-id <version-id> --region "$REGION"`

Expected: 1. `"ObjectLockEnabled": "Enabled"`, `DefaultRetention` `COMPLIANCE`, `Days: 2557`.
2. `COMPLIANCE`, 2555 days after the PUT. 3. refused (`AccessDenied`: COMPLIANCE retention cannot
be shortened). 4. refused (`AccessDenied`, by the policy and by the lock).

Rollback: none — every expected outcome is a refusal.

## M5 — Existing anchors bucket without Object Lock (blocked-deferred, E1)

Pre-conditions: an environment whose anchors bucket was created before this release with
`enable_s3_object_lock = false`.

Steps: `docs/operations/deployment.md` "Existing anchors bucket without Object Lock", steps 1–4.
Also, before step 3: `terraform plan` — expected to FAIL with `Instance cannot be destroyed`
(`prevent_destroy`), which proves the guard.

Expected: step 1 `ObjectLockConfigurationNotFoundError`; step 2 `"Status": "Enabled"`; step 3
succeeds; step 4 plans no replacement of `aws_s3_bucket.audit_anchors` (the provider reads the
enabled state back on refresh), and creates `aws_s3_bucket_object_lock_configuration` and the
bucket policy in place. If step 4 still plans a replacement, the documented procedure is wrong for
this provider version: stop, record it, do not apply.

Rollback: none possible for step 3 (Object Lock cannot be disabled) and none needed.

## M6 — CloudTrail prerequisite and the EventBridge rules (blocked-deferred, E1)

Pre-conditions: a trail per `docs/operations/deployment.md` "CloudTrail prerequisite".

Steps:
1. `aws cloudtrail get-trail-status --name <trail> --region "$REGION"` and
   `aws cloudtrail get-event-selectors --trail-name <trail> --region "$REGION"`.
2. Open an exec session (the migrate task, as in `infra/terraform/README.md` "Creating the DB roles
   on RDS"), then exit.
3. A no-op bucket-configuration change: `aws s3api put-bucket-versioning --bucket "$B" --versioning-configuration Status=Enabled --region "$REGION"`.
4. After M3's break-glass probe: look up its data event in the trail's S3 log (or CloudTrail Lake /
   Athena over the trail bucket) for `PutObject` on `$P/key-rotation-probe-*`.
5. The publisher role as a task-role override: after M3, run the probe task definition with the
   shared role registered and the publisher role passed as an override (probe.sh refuses every
   write either way):
   `aws ecs run-task --cluster "$CLUSTER" --task-definition anchor-policy-probe --launch-type FARGATE --overrides "{\"taskRoleArn\":\"$PUB_ROLE\"}" --network-configuration "<as in M3>" --region "$REGION"`.
6. The trust condition: `aws iam get-role --role-name "${PUB_ROLE##*/}" --query 'Role.AssumeRolePolicyDocument'`.
7. A task of the publisher's own family started outside its service, its command replaced so it
   exits at once and publishes nothing (a container override, not a role override):
   `aws ecs run-task --cluster "$CLUSTER" --task-definition "$NP-audit-anchor-publisher" --launch-type FARGATE --overrides '{"containerOverrides":[{"name":"audit-anchor-publisher","command":["node","-e","0"]}]}' --network-configuration "<as in M3>" --region "$REGION"`;
   then the same with `--group "service:$NP-audit-anchor-publisher"`; then a publisher deploy
   (`aws ecs update-service --cluster "$CLUSTER" --service "$NP-audit-anchor-publisher" --force-new-deployment --region "$REGION"`).

Expected: 1. `IsLogging: true`; management events included; a data-event selector for
`arn:aws:s3:::$B/`. 2. within minutes, an SNS email for `<NP>-ecs-execute-command` with
`detail.eventName: ExecuteCommand`, the principal and the task. 3. an SNS email for
`<NP>-audit-anchor-bucket-config-change` with `eventName: PutBucketVersioning`. 4. the data event
names the break-glass role's session. 5. an SNS email for `<NP>-audit-anchor-publisher-role-override`
with `eventName: RunTask` and `requestParameters.overrides.taskRoleArn` the publisher role; and,
from M3's `register-task-definition` of family `anchor-policy-probe` with the publisher role, an SNS
email for `<NP>-audit-anchor-publisher-role-task-definition` with `eventName:
RegisterTaskDefinition`. A publisher deploy (its own family, `<NP>-audit-anchor-publisher`) raises
neither. 6. one statement with `Condition.StringEquals."aws:SourceAccount"` this account's id.
7. the first run: SNS emails for `<NP>-audit-anchor-publisher-family-task-outside-service` (one per
state change, `detail.group` `family:<NP>-audit-anchor-publisher`, `detail.taskDefinitionArn` the
family's ARN with its revision) and one for `<NP>-audit-anchor-publisher-family-run-task`
(`eventName: RunTask`); the second run: the run-task email only (its state changes carry the
claimed group); the deploy: neither — its tasks' state changes carry
`group: service:<NP>-audit-anchor-publisher` and the trail records no `RunTask` / `StartTask` for
them. If the deploy raises the run-task rule, the service scheduler's launches are recorded as such
calls: record it, the rule is then a false positive on every deploy.

Not covered, by design (the residual in `docs/operations/alerts.md` "Publisher task role passed
to another task"): IAM events on the publisher role (`UpdateAssumeRolePolicy`, `PutRolePolicy`,
`AttachRolePolicy`, `DeleteRole` + `CreateRole`) reach EventBridge only in `us-east-1`, where this
stack has no provider; and the deploy path itself — an `UpdateService` / `CreateService` pointing
the publisher service at a revision of its family registered outside a deploy runs as the
service's own task and raises nothing; the same ECS calls in another region; another AWS service
launching ECS tasks with the role (e.g. a Batch job definition's `jobRoleArn`). Check who holds
`iam:PassRole` on the publisher role (`aws iam simulate-principal-policy` for each operator role,
or the organisation's SCPs) — that is the control for this class. Optionally try binding the
role's trust policy to this cluster (`aws:SourceArn` `ArnLike`
`arn:aws:ecs:<region>:<account>:task/<cluster>/*`) on a non-production deploy: if the publisher
service still assumes the role and a task in another cluster is refused, it can replace part of
this residual (not adopted here because its value could not be verified without AWS). Confirm the operator's own rule (organisation trail or
`us-east-1`) exists if one is claimed; otherwise record the residual as accepted.

Rollback: none (step 3 changes nothing). Stop the migrate task if it is still running:
`aws ecs stop-task --cluster "$CLUSTER" --task <task> --region "$REGION"`.

## M7 — The alarms (blocked-deferred, E1)

Steps:
1. Delivery of every new alarm: for each name in
   `aws cloudwatch describe-alarms --alarm-name-prefix "$NP-audit-" --region "$REGION" --query 'MetricAlarms[].AlarmName'`,
   `aws cloudwatch set-alarm-state --alarm-name <name> --state-value ALARM --state-reason "manual test" --region "$REGION"`.
2. The patterns as CloudWatch evaluates them, on lines the code emits:
   `aws logs test-metric-filter --filter-pattern '{ $._logType = "audit-anchor-publisher.cadence" && $.kind = "skipped_no_tenants" && $.chainEnabledTenantCount = 0 && $.everChainEnabled IS TRUE }' --log-event-messages '{"level":30,"kind":"skipped_no_tenants","reason":"NO_CHAIN_ENABLED_TENANTS","everChainEnabled":true,"chainEnabledTenantCount":0,"boundary":"2026-10-24T00:05:00.000Z","_logType":"audit-anchor-publisher.cadence"}' '{"level":30,"kind":"skipped_no_tenants","reason":"NO_CHAIN_ENABLED_TENANTS","everChainEnabled":false,"chainEnabledTenantCount":0,"boundary":"2026-10-24T00:05:00.000Z","_logType":"audit-anchor-publisher.cadence"}' --region "$REGION"`
   and the same for `{ $._logType = "audit-anchor-publisher.cadence_healthy" }` and the heartbeat
   count patterns, with lines copied from M1's real logs.
3. A real firing: scale the publisher to 0 outside the 00:05 window —
   `aws ecs update-service --cluster "$CLUSTER" --service "$PUB_SVC" --desired-count 0 --region "$REGION"` —
   wait 11 minutes, then `--desired-count 1`.
4. After M1: `aws cloudwatch describe-alarms --alarm-names "$NP-audit-anchor-cadence-absent" "$NP-audit-chain-verify-heartbeat-absent" --region "$REGION" --query 'MetricAlarms[].[AlarmName,StateValue]'`.
5. After M1's rollback (chain disabled again): watch the next boundary.

Expected: 1. one SNS email per alarm; each returns to its real state at its next evaluation.
2. the first message matches, the second does not; the healthy pattern matches `published` and
never-enabled `skipped_no_tenants` lines and no other cadence line. 3.
`<NP>-audit-anchor-publisher-down` ALARM after 10 minutes of no task, OK after the task returns.
4. both `OK`. 5. `<NP>-audit-anchor-chain-enabled-fell-to-zero` fires at the boundary, and
`<NP>-audit-anchor-cadence-absent` goes to ALARM a day later and stays there — the documented
state for a full disable.

Rollback: step 3's `--desired-count 1`; re-enable the test tenant's chain or accept M7.5's
alarms on a test environment.

## M8 — Signing and verification (blocked-deferred, E1; adversarial, Tier-2)

Steps:
1. Download M1's manifest (`aws s3api get-object --bucket "$B" --key "$P/<date>.kid-<kid>.jws" --region "$REGION" manifest.jws`),
   write the public key to `anchor.pub` (runbook Step 1's `$PUB`), and run
   `docs/security/audit-anchor-verification.md` "Quick check via openssl".
2. Flip one character of the payload segment and repeat.
3. Verify with another key's public key (any other `generate:audit-anchor-signing-key` output).
4. After M7's next-day publish: the "Object versions" checks — list versions, compute the
   previous day's sha256 and compare with today's `previousManifest.sha256`.

Expected: 1. `Signature Verified Successfully`, `kid` equal to the key's. 2. and 3.
`Signature Verification Failure`. 4. one version per key; the sha256 equals
`previousManifest.sha256`; `previousManifest.uri` is `s3-object-lock://<date>.kid-<kid>.jws`.

Rollback: none.

## Not covered here

Protocol hardening — a compromised publisher writing a second version of the same day's key, a
database writer planting the marker, the pointer or the attempt count — is SC5 and has no test
in this PR beyond the alarms of M7.
