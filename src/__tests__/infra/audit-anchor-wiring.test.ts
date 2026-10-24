/**
 * The anchors bucket, its policy, and the publisher / verify-worker ECS wiring,
 * read from infra/terraform as the values Terraform would render (no AWS
 * account runs these: E1). Each pin is a check that returns violations; the
 * real configuration must return none, and each red fixture — the real file
 * with one edit — must return the violation it exists to catch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidAnchorS3Prefix } from "@/lib/env-schema";
import { TerraformConfig, TERRAFORM_DIR, nested, plain, type EvalOptions, type HclExpr } from "../helpers/hcl-subset";

const BUCKET_ARN = "<ref:aws_s3_bucket.audit_anchors[0].arn>";
const BUCKET_ID = "<ref:aws_s3_bucket.audit_anchors[0].id>";
const PUBLISHER_ROLE_ARN = "<ref:aws_iam_role.ecs_audit_anchor_publisher_task.arn>";
const BREAK_GLASS_ARN = "arn:aws:iam::111122223333:role/anchor-break-glass";
const ACCOUNT_ID = "<ref:data.aws_caller_identity.current.account_id>";
const ALARM_TOPIC_ARN = "<ref:aws_sns_topic.alarms[0].arn>";
const PUBLISHER_ROLE_NAME = "<ref:aws_iam_role.ecs_audit_anchor_publisher_task.name>";
const PUBLISHER_FAMILY = "<ref:aws_ecs_task_definition.audit_anchor_publisher.family>";
const ROLE_OVERRIDE_RULE = "aws_cloudwatch_event_rule.audit_anchor_publisher_role_override[0]";
const ROLE_TASK_DEFINITION_RULE = "aws_cloudwatch_event_rule.audit_anchor_publisher_role_task_definition[0]";
const FAMILY_TASK_RULE = "aws_cloudwatch_event_rule.audit_anchor_publisher_family_task_outside_service[0]";
const FAMILY_RUN_TASK_RULE = "aws_cloudwatch_event_rule.audit_anchor_publisher_family_run_task[0]";
const PUBLISHER_TASK_DEFINITION = "<ref:aws_ecs_task_definition.audit_anchor_publisher.arn_without_revision>";
const PUBLISHER_SERVICE_GROUP = "service:<ref:aws_ecs_service.audit_anchor_publisher.name>";
const CLUSTER_ARN = "<ref:aws_ecs_cluster.main.arn>";
const OTHER_CLUSTER_ARN = "arn:aws:ecs:ap-northeast-1:111122223333:cluster/other";
const RETENTION_CAP_MARGIN_DAYS = 31;

type Statement = Record<string, unknown>;

function asSortedList(v: unknown): string[] {
  return (Array.isArray(v) ? v : [v]).map(String).sort();
}

/** Condition operators → keys → sorted value lists; undefined when absent. */
function normalizeCondition(c: unknown): Record<string, Record<string, string[]>> | undefined {
  if (c === undefined) return undefined;
  const out: Record<string, Record<string, string[]>> = {};
  for (const [op, keys] of Object.entries(c as Record<string, Record<string, unknown>>)) {
    out[op] = {};
    for (const [k, v] of Object.entries(keys)) out[op][k] = asSortedList(v);
  }
  return out;
}

function anchorPrefix(tf: TerraformConfig, opts: EvalOptions): string {
  return tf.evalText("module.anchor_prefix.prefix", opts) as string;
}

type Expected = { action: string[]; resource?: string[]; notResource?: string[]; condition?: Record<string, Record<string, string[]>> };

function expectedStatements(prefix: string, breakGlass: string): Record<string, Expected> {
  const manifest = `${BUCKET_ARN}/${prefix}/????-??-??.kid-*.jws`;
  const breakGlassPaths = [`${BUCKET_ARN}/${prefix}/key-rotation-*`, `${BUCKET_ARN}/${prefix}/public-keys/*`];
  const objects = [`${BUCKET_ARN}/*`];
  const principalNot = (arns: string[]) => ({ ArnNotEquals: { "aws:PrincipalArn": arns.sort() } });
  return {
    DenyManifestWriteExceptPublisher: { action: ["s3:PutObject"], resource: [manifest], condition: principalNot([PUBLISHER_ROLE_ARN]) },
    DenyBreakGlassPathWriteExceptOperator: {
      action: ["s3:PutObject"],
      resource: [...breakGlassPaths].sort(),
      // Empty → unconditional, never a condition with an empty value list.
      condition: breakGlass ? principalNot([breakGlass]) : undefined,
    },
    DenyPutOutsideAnchorPaths: { action: ["s3:PutObject"], notResource: [manifest, ...breakGlassPaths].sort() },
    DenyRetentionChangeExceptWriters: {
      action: ["s3:PutObjectRetention"],
      resource: objects,
      condition: principalNot(breakGlass ? [PUBLISHER_ROLE_ARN, breakGlass] : [PUBLISHER_ROLE_ARN]),
    },
    DenyDelete: { action: ["s3:DeleteObject", "s3:DeleteObjectVersion"], resource: objects },
    // Unconditional: the bucket is never a replication destination.
    DenyReplicationWrite: { action: ["s3:ReplicateDelete", "s3:ReplicateObject", "s3:ReplicateTags"], resource: objects },
    DenyLifecycleConfiguration: { action: ["s3:PutLifecycleConfiguration"], resource: [BUCKET_ARN] },
    DenyNonComplianceLockMode: {
      action: ["s3:PutObject"],
      resource: objects,
      condition: { StringNotEquals: { "s3:object-lock-mode": ["COMPLIANCE"] } },
    },
    DenyRetentionAboveCap: {
      action: ["s3:PutObject", "s3:PutObjectRetention"],
      resource: objects,
      condition: { NumericGreaterThan: { "s3:object-lock-remaining-retention-days": ["<cap>"] } },
    },
    DenyNonSseS3: {
      action: ["s3:PutObject"],
      resource: objects,
      condition: { StringNotEqualsIfExists: { "s3:x-amz-server-side-encryption": ["AES256"] } },
    },
  };
}

function policyViolations(tf: TerraformConfig, opts: EvalOptions = {}): string[] {
  const out: string[] = [];
  let prefix: string;
  try {
    prefix = anchorPrefix(tf, opts);
  } catch (err) {
    return [`prefix: module.anchor_prefix.prefix does not evaluate (${(err as Error).message})`];
  }
  if (!isValidAnchorS3Prefix(prefix)) out.push(`prefix: ${JSON.stringify(prefix)} is not a valid anchor prefix`);
  const breakGlass = String(opts.vars?.audit_anchor_break_glass_role_arn ?? tf.eval(tf.variable("audit_anchor_break_glass_role_arn").body.attrs.default));
  const days = Number(opts.vars?.audit_anchor_object_lock_days ?? tf.eval(tf.variable("audit_anchor_object_lock_days").body.attrs.default));

  const policy = plain(tf.attr(tf.resource("aws_s3_bucket_policy", "audit_anchors"), "policy", opts)) as { Statement: Statement[] };
  const expected = expectedStatements(prefix, breakGlass);
  const sids = policy.Statement.map((s) => String(s.Sid));
  if (JSON.stringify([...sids].sort()) !== JSON.stringify(Object.keys(expected).sort())) {
    out.push(`statements: ${JSON.stringify(sids)} is not exactly ${JSON.stringify(Object.keys(expected))}`);
  }
  for (const s of policy.Statement) {
    const sid = String(s.Sid);
    const extra = Object.keys(s).filter((k) => !["Sid", "Effect", "Principal", "Action", "Resource", "NotResource", "Condition"].includes(k));
    if (extra.length > 0) out.push(`${sid}: unexpected ${extra.join(", ")}`);
    if (s.Effect !== "Deny") out.push(`${sid}: Effect is ${String(s.Effect)}, not Deny`);
    if (s.Principal !== "*") out.push(`${sid}: Principal is ${JSON.stringify(s.Principal)}, not "*"`);
    const want = expected[sid];
    if (!want) continue;
    if (JSON.stringify(asSortedList(s.Action)) !== JSON.stringify(want.action)) out.push(`${sid}: Action ${JSON.stringify(s.Action)}`);
    const resource = s.Resource === undefined ? undefined : asSortedList(s.Resource);
    const notResource = s.NotResource === undefined ? undefined : asSortedList(s.NotResource);
    if (JSON.stringify(resource) !== JSON.stringify(want.resource)) out.push(`${sid}: Resource ${JSON.stringify(s.Resource)}`);
    if (JSON.stringify(notResource) !== JSON.stringify(want.notResource)) out.push(`${sid}: NotResource ${JSON.stringify(s.NotResource)}`);
    const cond = normalizeCondition(s.Condition);
    if (want.condition && "NumericGreaterThan" in want.condition) {
      want.condition.NumericGreaterThan["s3:object-lock-remaining-retention-days"] = [String(days + RETENTION_CAP_MARGIN_DAYS)];
    }
    if (JSON.stringify(cond) !== JSON.stringify(want.condition)) out.push(`${sid}: Condition ${JSON.stringify(s.Condition)}`);
  }
  return out;
}

function bucketViolations(tf: TerraformConfig, opts: EvalOptions = {}): string[] {
  const out: string[] = [];
  const bucket = tf.resource("aws_s3_bucket", "audit_anchors");
  if (tf.attr(bucket, "object_lock_enabled", opts) !== true) out.push("bucket: object_lock_enabled is not true");
  const lifecycle = nested(bucket, "lifecycle")[0];
  if (!lifecycle || tf.attr(lifecycle, "prevent_destroy") !== true) out.push("bucket: prevent_destroy is not true");

  const lock = tf.resource("aws_s3_bucket_object_lock_configuration", "audit_anchors");
  const retention = nested(nested(lock, "rule")[0], "default_retention")[0];
  if (tf.attr(retention, "mode", opts) !== "COMPLIANCE") out.push("object lock: mode is not COMPLIANCE");
  if (tf.attr(retention, "days", opts) !== tf.attr(tf.variable("audit_anchor_object_lock_days"), "default")) {
    out.push("object lock: days is not var.audit_anchor_object_lock_days");
  }

  const versioning = nested(tf.resource("aws_s3_bucket_versioning", "audit_anchors"), "versioning_configuration")[0];
  if (tf.attr(versioning, "status", opts) !== "Enabled") out.push("versioning: not Enabled");

  const sse = nested(nested(tf.resource("aws_s3_bucket_server_side_encryption_configuration", "audit_anchors"), "rule")[0], "apply_server_side_encryption_by_default")[0];
  if (tf.attr(sse, "sse_algorithm", opts) !== "AES256") out.push(`sse: ${String(tf.attr(sse, "sse_algorithm", opts))}, not AES256`);
  if ("kms_master_key_id" in sse.body.attrs && tf.attr(sse, "kms_master_key_id", opts) !== null) out.push("sse: a KMS key is set");
  return out;
}

type Container = {
  name: string;
  command?: string[];
  stopTimeout?: number;
  environment?: Array<{ name: string; value: string }>;
  secrets?: Array<{ name: string; valueFrom: string }>;
};

function containers(tf: TerraformConfig, task: string, opts: EvalOptions = {}): Container[] {
  return plain(tf.attr(tf.resource("aws_ecs_task_definition", task), "container_definitions", opts)) as Container[];
}

const appSecret = (key: string) => `<ref:aws_secretsmanager_secret.app.arn>:${key}::`;

function publisherViolations(tf: TerraformConfig, opts: EvalOptions = {}): string[] {
  const out: string[] = [];
  const task = tf.resource("aws_ecs_task_definition", "audit_anchor_publisher");
  if (String(tf.attr(task, "task_role_arn", opts)) !== PUBLISHER_ROLE_ARN) out.push("publisher task: task_role_arn is not its own role");
  const defs = containers(tf, "audit_anchor_publisher", opts);
  if (defs.length !== 1) return [...out, "publisher task: not exactly one container"];
  const [c] = defs;
  if (JSON.stringify(c.command) !== JSON.stringify(["node", "dist/audit-anchor-publisher.js"])) out.push(`publisher task: command ${JSON.stringify(c.command)}`);
  if (c.stopTimeout !== 120) out.push(`publisher task: stopTimeout ${String(c.stopTimeout)}, not 120`);
  let prefix = "<unresolved>";
  try {
    prefix = anchorPrefix(tf, opts);
  } catch {
    out.push("publisher task: prefix module output does not evaluate");
  }
  const env = Object.fromEntries((c.environment ?? []).map((e) => [e.name, e.value]));
  const wantEnv = {
    AUDIT_ANCHOR_PUBLISHER_ENABLED: "true",
    AUDIT_ANCHOR_DESTINATION_S3_BUCKET: BUCKET_ID,
    AUDIT_ANCHOR_DESTINATION_S3_PREFIX: prefix,
    AWS_REGION: "<ref:var.aws_region>",
  };
  if (JSON.stringify(env, Object.keys(env).sort()) !== JSON.stringify(wantEnv, Object.keys(wantEnv).sort())) {
    out.push(`publisher task: environment ${JSON.stringify(env)}`);
  }
  const secrets = Object.fromEntries((c.secrets ?? []).map((s) => [s.name, s.valueFrom]));
  const wantSecrets = Object.fromEntries(
    ["AUDIT_ANCHOR_PUBLISHER_DATABASE_URL", "AUDIT_ANCHOR_SIGNING_KEY", "AUDIT_ANCHOR_TAG_SECRET", "DEPLOYMENT_ID"].map((k) => [k, appSecret(k)]),
  );
  if (JSON.stringify(secrets, Object.keys(secrets).sort()) !== JSON.stringify(wantSecrets, Object.keys(wantSecrets).sort())) {
    out.push(`publisher task: secrets ${JSON.stringify(secrets)}`);
  }

  const service = tf.resource("aws_ecs_service", "audit_anchor_publisher");
  if (tf.attr(service, "deployment_maximum_percent", opts) !== 100) out.push("publisher service: deployment_maximum_percent is not 100");
  if (tf.attr(service, "deployment_minimum_healthy_percent", opts) !== 0) out.push("publisher service: deployment_minimum_healthy_percent is not 0");
  for (const n of [0, 1, 2, 3]) {
    const got = tf.attr(service, "desired_count", { ...opts, vars: { ...opts.vars, worker_desired_count: n } });
    if (got !== Math.min(1, n)) out.push(`publisher service: desired_count ${String(got)} for worker_desired_count=${n}`);
  }
  return out;
}

/** Role policies and attachments whose role is `role` (by .id or .name). */
function policiesOfRole(tf: TerraformConfig, role: string): { inline: string[]; attached: number } {
  const refs = [`<ref:aws_iam_role.${role}.id>`, `<ref:aws_iam_role.${role}.name>`];
  const inline = tf
    .resources("aws_iam_role_policy")
    .filter((p) => refs.includes(String(tf.attr(p, "role"))))
    .map((p) => p.labels[1]);
  const attached = tf.resources("aws_iam_role_policy_attachment").filter((p) => refs.includes(String(tf.attr(p, "role")))).length;
  return { inline, attached };
}

function roleViolations(tf: TerraformConfig, opts: EvalOptions = {}): string[] {
  const out: string[] = [];
  const own = policiesOfRole(tf, "ecs_audit_anchor_publisher_task");
  if (own.attached !== 0 || JSON.stringify(own.inline) !== JSON.stringify(["ecs_audit_anchor_publisher_s3"])) {
    out.push(`publisher role: policies ${JSON.stringify(own)}`);
  } else {
    const policy = plain(tf.attr(tf.resource("aws_iam_role_policy", "ecs_audit_anchor_publisher_s3"), "policy", opts)) as { Statement: Statement[] };
    let prefix = "<unresolved>";
    try {
      prefix = anchorPrefix(tf, opts);
    } catch {
      out.push("publisher role: prefix module output does not evaluate");
    }
    const want = [{ Effect: "Allow", Action: ["s3:PutObject", "s3:PutObjectRetention"], Resource: [`${BUCKET_ARN}/${prefix}/*`] }];
    const got = policy.Statement.map((s) => ({ Effect: s.Effect, Action: asSortedList(s.Action), Resource: asSortedList(s.Resource) }));
    if (JSON.stringify(got) !== JSON.stringify(want) || policy.Statement.some((s) => "Condition" in s || "NotAction" in s)) {
      out.push(`publisher role: statements ${JSON.stringify(policy.Statement)}`);
    }
  }
  // The anchor grant left the shared role: nothing it carries names the bucket.
  for (const name of policiesOfRole(tf, "ecs_task").inline) {
    const text = JSON.stringify(plain(tf.attr(tf.resource("aws_iam_role_policy", name), "policy", opts)));
    if (text.includes("aws_s3_bucket.audit_anchors")) out.push(`shared role: ${name} grants on the anchors bucket`);
  }
  return out;
}

/** `v` as JSON with every object's keys sorted, so key order does not count. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function trustViolations(tf: TerraformConfig, opts: EvalOptions = {}): string[] {
  const out: string[] = [];
  if (!tf.blocks("data").some((b) => b.labels[0] === "aws_caller_identity" && b.labels[1] === "current")) {
    out.push("publisher trust: no data.aws_caller_identity.current");
  }
  const policy = plain(tf.attr(tf.resource("aws_iam_role", "ecs_audit_anchor_publisher_task"), "assume_role_policy", opts)) as { Statement: Statement[] };
  const want = [
    {
      Effect: "Allow",
      Principal: { Service: "ecs-tasks.amazonaws.com" },
      Action: "sts:AssumeRole",
      Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT_ID } },
    },
  ];
  if (canonical(policy.Statement) !== canonical(want)) out.push(`publisher trust: statements ${JSON.stringify(policy.Statement)}`);
  return out;
}

function keyText(key: HclExpr): string | undefined {
  if (key.t === "lit") return String(key.v);
  if (key.t === "name") return key.name;
  if (key.t === "tmpl" && key.parts.length === 1 && typeof key.parts[0] === "string") return key.parts[0];
  return undefined;
}

/** Every reference (`trav`) anywhere under `e`, by its source text. */
function referencesIn(e: HclExpr, out: string[] = []): string[] {
  switch (e.t) {
    case "trav":
      out.push(e.src);
      break;
    case "tmpl":
      for (const p of e.parts) if (typeof p !== "string") referencesIn(p, out);
      break;
    case "call":
      for (const a of e.args) referencesIn(a, out);
      break;
    case "list":
      for (const i of e.items) referencesIn(i, out);
      break;
    case "obj":
      for (const { value } of e.items) referencesIn(value, out);
      break;
    case "cond":
      [e.c, e.a, e.b].forEach((x) => referencesIn(x, out));
      break;
    case "bin":
      [e.l, e.r].forEach((x) => referencesIn(x, out));
      break;
    case "un":
      referencesIn(e.e, out);
      break;
    case "for":
      [e.coll, e.val, ...(e.key ? [e.key] : []), ...(e.cond ? [e.cond] : [])].forEach((x) => referencesIn(x, out));
      break;
  }
  return out;
}

/** The object literal under `e` whose `Sid` is `sid`. */
function statementWithSid(e: HclExpr, sid: string): HclExpr | undefined {
  const children: HclExpr[] =
    e.t === "call" ? e.args : e.t === "list" ? e.items : e.t === "obj" ? e.items.map((i) => i.value) : [];
  if (e.t === "obj" && e.items.some(({ key, value }) => keyText(key) === "Sid" && value.t === "tmpl" && value.parts.join("") === sid)) {
    return e;
  }
  for (const c of children) {
    const found = statementWithSid(c, sid);
    if (found) return found;
  }
  return undefined;
}

/**
 * An EventBridge pattern against an event, for the matchers these rules use:
 * exact values, `anything-but` (one value or a list), `prefix`, `suffix`, and
 * `$or` (a list of patterns over the same object, any of which may match,
 * ANDed with the object's other fields). A field the pattern names must be
 * present in the event; an array field matches when any element does.
 */
function matchesEventPattern(pattern: unknown, event: unknown): boolean {
  if (typeof pattern !== "object" || pattern === null || Array.isArray(pattern)) throw new Error("pattern: not an object");
  if (typeof event !== "object" || event === null) return false;
  return Object.entries(pattern as Record<string, unknown>).every(([key, want]) => {
    if (key === "$or") {
      if (!Array.isArray(want) || want.length === 0) throw new Error("pattern: $or is not a non-empty list");
      return want.some((branch) => matchesEventPattern(branch, event));
    }
    const got = (event as Record<string, unknown>)[key];
    if (got === undefined) return false;
    if (!Array.isArray(want)) return matchesEventPattern(want, got);
    const values = Array.isArray(got) ? got : [got];
    return values.some((v) => want.some((m) => matchesValue(m, v)));
  });
}

function matchesValue(matcher: unknown, value: unknown): boolean {
  if (typeof matcher !== "object" || matcher === null) return matcher === value;
  const m = matcher as Record<string, unknown>;
  if ("anything-but" in m) {
    const excluded = m["anything-but"];
    return !(Array.isArray(excluded) ? excluded : [excluded]).includes(value);
  }
  if ("prefix" in m) return typeof value === "string" && value.startsWith(String(m.prefix));
  if ("suffix" in m) return typeof value === "string" && value.endsWith(String(m.suffix));
  throw new Error(`pattern: unsupported matcher ${JSON.stringify(matcher)}`);
}

function cloudTrailEcsEvent(eventName: string, requestParameters: Record<string, unknown>): Record<string, unknown> {
  return {
    source: "aws.ecs",
    "detail-type": "AWS API Call via CloudTrail",
    detail: { eventSource: "ecs.amazonaws.com", eventName, requestParameters },
  };
}

/** The rule `name` targets the alarm topic, and the topic policy admits it. */
function alarmWiringViolations(tf: TerraformConfig, label: string, ruleRef: string, opts: EvalOptions): string[] {
  const out: string[] = [];
  const targets = tf
    .resources("aws_cloudwatch_event_target")
    .filter((t) => String(tf.attr(t, "rule", opts)) === `<ref:${ruleRef}.name>`);
  if (targets.length !== 1 || String(tf.attr(targets[0], "arn", opts)) !== ALARM_TOPIC_ARN) {
    out.push(`${label}: not targeted at the alarm topic`);
  }

  const policy = tf.resource("aws_sns_topic_policy", "alarms").body.attrs.policy;
  const statement = policy && statementWithSid(policy, "AllowEventBridgePublish");
  if (!statement || !referencesIn(statement).includes(`${ruleRef}.arn`)) {
    out.push(`${label}: the alarm topic policy does not admit it`);
  }
  return out;
}

/**
 * The rule that surfaces a task run with the publisher's role as an override.
 * The topic policy is read as references, not evaluated: its source ARN list
 * concatenates a splat, which the evaluator does not model.
 */
function roleOverrideRuleViolations(tf: TerraformConfig, opts: EvalOptions = {}): string[] {
  const out: string[] = [];
  let rule;
  try {
    rule = tf.resource("aws_cloudwatch_event_rule", "audit_anchor_publisher_role_override");
  } catch {
    return ["role override rule: missing"];
  }
  if (tf.attr(rule, "count", { vars: { enable_monitoring: true } }) !== 1) out.push("role override rule: not created with monitoring on");
  const want = {
    source: ["aws.ecs"],
    "detail-type": ["AWS API Call via CloudTrail"],
    detail: {
      eventSource: ["ecs.amazonaws.com"],
      eventName: ["RunTask", "StartTask"],
      requestParameters: { overrides: { taskRoleArn: [PUBLISHER_ROLE_ARN, PUBLISHER_ROLE_NAME] } },
    },
  };
  const pattern = plain(tf.attr(rule, "event_pattern", opts));
  if (canonical(pattern) !== canonical(want)) out.push(`role override rule: event_pattern ${JSON.stringify(pattern)}`);
  for (const role of [PUBLISHER_ROLE_ARN, PUBLISHER_ROLE_NAME]) {
    if (!matchesEventPattern(pattern, cloudTrailEcsEvent("RunTask", { overrides: { taskRoleArn: role } }))) {
      out.push(`role override rule: misses an override naming the role as ${role}`);
    }
  }
  return [...out, ...alarmWiringViolations(tf, "role override rule", ROLE_OVERRIDE_RULE, opts)];
}

/**
 * The rule that surfaces a task definition of another family registered with
 * the publisher's role: a run of it needs no override. The publisher family's
 * own registrations — every deploy — must not match.
 */
function roleTaskDefinitionRuleViolations(tf: TerraformConfig, opts: EvalOptions = {}): string[] {
  const out: string[] = [];
  let rule;
  try {
    rule = tf.resource("aws_cloudwatch_event_rule", "audit_anchor_publisher_role_task_definition");
  } catch {
    return ["role task-definition rule: missing"];
  }
  if (tf.attr(rule, "count", { vars: { enable_monitoring: true } }) !== 1) out.push("role task-definition rule: not created with monitoring on");
  const want = {
    source: ["aws.ecs"],
    "detail-type": ["AWS API Call via CloudTrail"],
    detail: {
      eventSource: ["ecs.amazonaws.com"],
      eventName: ["RegisterTaskDefinition"],
      requestParameters: {
        taskRoleArn: [PUBLISHER_ROLE_ARN, PUBLISHER_ROLE_NAME],
        family: [{ "anything-but": PUBLISHER_FAMILY }],
      },
    },
  };
  const pattern = plain(tf.attr(rule, "event_pattern", opts));
  if (canonical(pattern) !== canonical(want)) out.push(`role task-definition rule: event_pattern ${JSON.stringify(pattern)}`);
  const register = (family: string, taskRoleArn: string) => cloudTrailEcsEvent("RegisterTaskDefinition", { family, taskRoleArn });
  for (const role of [PUBLISHER_ROLE_ARN, PUBLISHER_ROLE_NAME]) {
    if (matchesEventPattern(pattern, register(PUBLISHER_FAMILY, role))) {
      out.push(`role task-definition rule: matches the publisher family's own registration (${role})`);
    }
    if (!matchesEventPattern(pattern, register("foo", role))) {
      out.push(`role task-definition rule: misses family foo naming the role as ${role}`);
    }
  }
  if (matchesEventPattern(pattern, register("foo", "<ref:aws_iam_role.ecs_task.arn>"))) {
    out.push("role task-definition rule: matches a task definition on another role");
  }
  return [...out, ...alarmWiringViolations(tf, "role task-definition rule", ROLE_TASK_DEFINITION_RULE, opts)];
}

function ecsTaskStateChange(detail: { clusterArn: string; group: string; taskDefinitionArn: string }): Record<string, unknown> {
  return { source: "aws.ecs", "detail-type": "ECS Task State Change", detail: { ...detail, lastStatus: "RUNNING" } };
}

/** A task of the publisher's family, revision 7, as its state change carries it. */
function publisherFamilyTask(clusterArn: string, group: string): Record<string, unknown> {
  return ecsTaskStateChange({ clusterArn, group, taskDefinitionArn: `${PUBLISHER_TASK_DEFINITION}:7` });
}

/**
 * The native rule for a task of the publisher's own family the publisher
 * service did not launch: every such task matches, the service's own does not,
 * and neither does a family whose name merely starts with the publisher's.
 */
function familyTaskRuleViolations(tf: TerraformConfig, opts: EvalOptions = {}): string[] {
  const out: string[] = [];
  let rule;
  try {
    rule = tf.resource("aws_cloudwatch_event_rule", "audit_anchor_publisher_family_task_outside_service");
  } catch {
    return ["family task rule: missing"];
  }
  if (tf.attr(rule, "count", { vars: { enable_monitoring: true } }) !== 1) out.push("family task rule: not created with monitoring on");
  const want = {
    source: ["aws.ecs"],
    "detail-type": ["ECS Task State Change"],
    detail: {
      taskDefinitionArn: [{ prefix: `${PUBLISHER_TASK_DEFINITION}:` }],
      $or: [{ clusterArn: [{ "anything-but": CLUSTER_ARN }] }, { group: [{ "anything-but": PUBLISHER_SERVICE_GROUP }] }],
    },
  };
  const pattern = plain(tf.attr(rule, "event_pattern", opts));
  if (canonical(pattern) !== canonical(want)) out.push(`family task rule: event_pattern ${JSON.stringify(pattern)}`);
  if (matchesEventPattern(pattern, publisherFamilyTask(CLUSTER_ARN, PUBLISHER_SERVICE_GROUP))) {
    out.push("family task rule: matches the publisher service's own task");
  }
  const shadow = ecsTaskStateChange({
    clusterArn: CLUSTER_ARN,
    group: "family:x",
    taskDefinitionArn: `${PUBLISHER_TASK_DEFINITION}-shadow:1`,
  });
  if (matchesEventPattern(pattern, shadow)) out.push("family task rule: matches a family that only starts with the publisher's");
  return [...out, ...alarmWiringViolations(tf, "family task rule", FAMILY_TASK_RULE, opts)];
}

/**
 * The CloudTrail rule for a RunTask / StartTask of the publisher's family:
 * every spelling RunTask takes, whatever `group` the caller claims.
 */
function familyRunTaskRuleViolations(tf: TerraformConfig, opts: EvalOptions = {}): string[] {
  const out: string[] = [];
  let rule;
  try {
    rule = tf.resource("aws_cloudwatch_event_rule", "audit_anchor_publisher_family_run_task");
  } catch {
    return ["family run-task rule: missing"];
  }
  if (tf.attr(rule, "count", { vars: { enable_monitoring: true } }) !== 1) out.push("family run-task rule: not created with monitoring on");
  const want = {
    source: ["aws.ecs"],
    "detail-type": ["AWS API Call via CloudTrail"],
    detail: {
      eventSource: ["ecs.amazonaws.com"],
      eventName: ["RunTask", "StartTask"],
      requestParameters: {
        taskDefinition: [
          PUBLISHER_FAMILY,
          { prefix: `${PUBLISHER_FAMILY}:` },
          PUBLISHER_TASK_DEFINITION,
          { prefix: `${PUBLISHER_TASK_DEFINITION}:` },
        ],
      },
    },
  };
  const pattern = plain(tf.attr(rule, "event_pattern", opts));
  if (canonical(pattern) !== canonical(want)) out.push(`family run-task rule: event_pattern ${JSON.stringify(pattern)}`);
  for (const shadow of [`${PUBLISHER_FAMILY}-shadow`, `${PUBLISHER_FAMILY}-shadow:1`, `${PUBLISHER_TASK_DEFINITION}-shadow:1`]) {
    if (matchesEventPattern(pattern, cloudTrailEcsEvent("RunTask", { taskDefinition: shadow }))) {
      out.push(`family run-task rule: matches a family that only starts with the publisher's (${shadow})`);
    }
  }
  return [...out, ...alarmWiringViolations(tf, "family run-task rule", FAMILY_RUN_TASK_RULE, opts)];
}

/**
 * A task runs with the publisher's role iff (a) an override names it, or its
 * task definition does: (b1) one of another family, or (b2) one of the
 * publisher's own family, legitimate only when the publisher service launched
 * it. Each route's events must be matched by exactly the rule that covers it,
 * and the legitimate events by none. The rule set is the four rules by
 * resource name; a missing one matches nothing.
 */
const ROLE_ALARM_RULES: Record<string, string> = {
  [ROLE_OVERRIDE_RULE]: "audit_anchor_publisher_role_override",
  [ROLE_TASK_DEFINITION_RULE]: "audit_anchor_publisher_role_task_definition",
  [FAMILY_TASK_RULE]: "audit_anchor_publisher_family_task_outside_service",
  [FAMILY_RUN_TASK_RULE]: "audit_anchor_publisher_family_run_task",
};

type RoleRoute = { route: string; event: Record<string, unknown>; rule: string | null };

const ROLE_ROUTES: RoleRoute[] = [
  ...[PUBLISHER_ROLE_ARN, PUBLISHER_ROLE_NAME].flatMap((role) =>
    ["RunTask", "StartTask"].map((eventName) => ({
      route: `(a) ${eventName} override naming the role as ${role}`,
      event: cloudTrailEcsEvent(eventName, { taskDefinition: "foo:1", overrides: { taskRoleArn: role } }),
      rule: ROLE_OVERRIDE_RULE,
    })),
  ),
  ...[PUBLISHER_ROLE_ARN, PUBLISHER_ROLE_NAME].map((role) => ({
    route: `(b1) family foo registered naming the role as ${role}`,
    event: cloudTrailEcsEvent("RegisterTaskDefinition", { family: "foo", taskRoleArn: role }),
    rule: ROLE_TASK_DEFINITION_RULE,
  })),
  { route: "(b2) a RunTask task in this cluster", event: publisherFamilyTask(CLUSTER_ARN, `family:${PUBLISHER_FAMILY}`), rule: FAMILY_TASK_RULE },
  { route: "(b2) another service's task in this cluster", event: publisherFamilyTask(CLUSTER_ARN, "service:other"), rule: FAMILY_TASK_RULE },
  {
    route: "(b2) a same-named service's task in another cluster",
    event: publisherFamilyTask(OTHER_CLUSTER_ARN, PUBLISHER_SERVICE_GROUP),
    rule: FAMILY_TASK_RULE,
  },
  ...[PUBLISHER_FAMILY, `${PUBLISHER_FAMILY}:7`, PUBLISHER_TASK_DEFINITION, `${PUBLISHER_TASK_DEFINITION}:7`].flatMap((taskDefinition) =>
    ["RunTask", "StartTask"].map((eventName) => ({
      route: `(b2) ${eventName} of ${taskDefinition} claiming the publisher service's group`,
      event: cloudTrailEcsEvent(eventName, { taskDefinition, group: PUBLISHER_SERVICE_GROUP }),
      rule: FAMILY_RUN_TASK_RULE,
    })),
  ),
  // Legitimate: the publisher service's task (indistinguishable, as a state
  // change, from a RunTask that claims its group — the CloudTrail rule above
  // is what sees that one), a publisher deploy's registration, an unrelated
  // task.
  { route: "the publisher service's task", event: publisherFamilyTask(CLUSTER_ARN, PUBLISHER_SERVICE_GROUP), rule: null },
  ...[PUBLISHER_ROLE_ARN, PUBLISHER_ROLE_NAME].map((role) => ({
    route: `a publisher deploy's registration naming the role as ${role}`,
    event: cloudTrailEcsEvent("RegisterTaskDefinition", { family: PUBLISHER_FAMILY, taskRoleArn: role }),
    rule: null,
  })),
  { route: "an unrelated RunTask", event: cloudTrailEcsEvent("RunTask", { taskDefinition: "foo:1" }), rule: null },
  {
    route: "an unrelated task",
    event: ecsTaskStateChange({ clusterArn: CLUSTER_ARN, group: "family:foo", taskDefinitionArn: "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/foo:1" }),
    rule: null,
  },
];

function roleRouteViolations(tf: TerraformConfig, opts: EvalOptions = {}): string[] {
  const patterns: Array<[string, unknown]> = [];
  for (const [ref, name] of Object.entries(ROLE_ALARM_RULES)) {
    try {
      patterns.push([ref, plain(tf.attr(tf.resource("aws_cloudwatch_event_rule", name), "event_pattern", opts))]);
    } catch {
      // A missing rule matches nothing; its own check names it.
    }
  }
  const out: string[] = [];
  for (const { route, event, rule } of ROLE_ROUTES) {
    const matched = patterns.filter(([, pattern]) => matchesEventPattern(pattern, event)).map(([ref]) => ref);
    const want = rule === null ? [] : [rule];
    if (canonical(matched) !== canonical(want)) out.push(`role routes: ${route} matched by ${JSON.stringify(matched)}`);
  }
  return out;
}

function verifyWorkerViolations(tf: TerraformConfig, opts: EvalOptions = {}): string[] {
  const out: string[] = [];
  const task = tf.resource("aws_ecs_task_definition", "audit_chain_verify_worker");
  if ("task_role_arn" in task.body.attrs) out.push("verify task: has a task role");
  const defs = containers(tf, "audit_chain_verify_worker", opts);
  if (defs.length !== 1) return [...out, "verify task: not exactly one container"];
  if (JSON.stringify(defs[0].command) !== JSON.stringify(["node", "dist/audit-chain-verify-worker.js"])) out.push("verify task: command");
  if (JSON.stringify(defs[0].secrets) !== JSON.stringify([{ name: "AUDIT_CHAIN_VERIFY_DATABASE_URL", valueFrom: appSecret("DATABASE_URL") }])) {
    out.push(`verify task: secrets ${JSON.stringify(defs[0].secrets)}`);
  }
  if (tf.attr(tf.resource("aws_ecs_service", "audit_chain_verify_worker"), "desired_count", { vars: { worker_desired_count: 3 } }) !== 3) {
    out.push("verify service: desired_count is not var.worker_desired_count");
  }
  return out;
}

function clusterViolations(tf: TerraformConfig): string[] {
  const exec = nested(nested(tf.resource("aws_ecs_cluster", "main"), "configuration")[0] ?? { type: "", labels: [], body: { attrs: {}, blocks: [] } }, "execute_command_configuration")[0];
  if (!exec || !("logging" in exec.body.attrs)) return ["cluster: ECS Exec logging is not set explicitly"];
  return tf.attr(exec, "logging") === "NONE" ? [] : [`cluster: ECS Exec logging is ${String(tf.attr(exec, "logging"))}`];
}

function prefixPlumbingViolations(tf: TerraformConfig): string[] {
  const out: string[] = [];
  if (tf.attr(tf.variable("audit_anchor_s3_prefix"), "default") !== "audit-anchors") out.push("prefix variable: default is not audit-anchors");
  let call;
  try {
    call = tf.module("anchor_prefix");
  } catch {
    return [...out, "prefix module: not called"];
  }
  if (tf.attr(call, "source") !== "./modules/anchor-prefix") out.push("prefix module: source");
  // A value no configuration uses, through every consumer: a constant
  // anywhere between the variable and a consumer breaks the chain.
  const probe = { vars: { audit_anchor_s3_prefix: "zz-probe" } };
  try {
    if (anchorPrefix(tf, probe) !== "zz-probe") out.push("prefix module: output does not follow var.audit_anchor_s3_prefix");
    const policyText = JSON.stringify(plain(tf.attr(tf.resource("aws_s3_bucket_policy", "audit_anchors"), "policy", probe)));
    if ((policyText.match(/\/zz-probe\//g) ?? []).length !== 6) out.push("prefix module: bucket policy does not take the prefix from it");
    const env = containers(tf, "audit_anchor_publisher", probe)[0].environment ?? [];
    if (env.find((e) => e.name === "AUDIT_ANCHOR_DESTINATION_S3_PREFIX")?.value !== "zz-probe") out.push("prefix module: task env does not take the prefix from it");
    const role = JSON.stringify(plain(tf.attr(tf.resource("aws_iam_role_policy", "ecs_audit_anchor_publisher_s3"), "policy", probe)));
    if (!role.includes("/zz-probe/*")) out.push("prefix module: publisher role does not take the prefix from it");
  } catch (err) {
    out.push(`prefix module: ${(err as Error).message}`);
  }
  return out;
}

function anchorsEnabledValidationViolations(tf: TerraformConfig): string[] {
  const validation = nested(tf.variable("enable_s3_audit_anchors"), "validation")[0];
  if (!validation) return ["enable_s3_audit_anchors: no validation"];
  const ok = (v: boolean) => tf.attr(validation, "condition", { vars: { enable_s3_audit_anchors: v } });
  return ok(true) === true && ok(false) === false ? [] : ["enable_s3_audit_anchors: validation does not require true"];
}

function allViolations(tf: TerraformConfig, opts: EvalOptions = {}): string[] {
  return [
    ...policyViolations(tf, opts),
    ...bucketViolations(tf, opts),
    ...publisherViolations(tf, opts),
    ...roleViolations(tf, opts),
    ...trustViolations(tf, opts),
    ...roleOverrideRuleViolations(tf, opts),
    ...roleTaskDefinitionRuleViolations(tf, opts),
    ...familyTaskRuleViolations(tf, opts),
    ...familyRunTaskRuleViolations(tf, opts),
    ...roleRouteViolations(tf, opts),
    ...verifyWorkerViolations(tf, opts),
    ...clusterViolations(tf),
    ...prefixPlumbingViolations(tf),
    ...anchorsEnabledValidationViolations(tf),
  ];
}

/** The real configuration with one textual edit to `file`; the edit must apply. */
function edited(file: string, from: string, to: string): TerraformConfig {
  const text = readFileSync(join(TERRAFORM_DIR, file), "utf8");
  expect(text.split(from).length - 1, `fixture edit must match once in ${file}: ${from}`).toBe(1);
  return new TerraformConfig(TERRAFORM_DIR, { [file]: text.replace(from, to) });
}

const real = new TerraformConfig(TERRAFORM_DIR);
const withBreakGlass = { vars: { audit_anchor_break_glass_role_arn: BREAK_GLASS_ARN } };

describe("anchors bucket and publisher wiring", () => {
  it("has no violations as committed, with no break-glass role", () => {
    expect(allViolations(real)).toEqual([]);
  });

  it("has no violations with a break-glass role configured", () => {
    expect(allViolations(real, withBreakGlass)).toEqual([]);
  });

  it("keeps SSE-S3 when a KMS key is configured for the other buckets", () => {
    expect(bucketViolations(real, { vars: { s3_kms_key_arn: "arn:aws:kms:ap-northeast-1:111122223333:key/x" } })).toEqual([]);
  });

  it("keeps Object Lock on whatever var.enable_s3_object_lock says", () => {
    expect(bucketViolations(real, { vars: { enable_s3_object_lock: false } })).toEqual([]);
  });
});

const PUBLISHER_COND = '"aws:PrincipalArn" = aws_iam_role.ecs_audit_anchor_publisher_task.arn }';
const BREAK_GLASS_FOR = `        {
          for k, v in {
            Condition = { ArnNotEquals = { "aws:PrincipalArn" = var.audit_anchor_break_glass_role_arn } }
          } : k => v if var.audit_anchor_break_glass_role_arn != ""
        }`;
const PUBLISHER_ARN_HCL = "aws_iam_role.ecs_audit_anchor_publisher_task.arn";
const EXCEPTION = `ArnNotEquals = { "aws:PrincipalArn" = ${PUBLISHER_ARN_HCL} }`;

type RedFixture = { name: string; file: string; from: string; to: string; opts?: EvalOptions; violation: string };

const RED_FIXTURES: RedFixture[] = [
  {
    name: "a third principal excepted from the manifest Deny",
    file: "storage.tf",
    from: PUBLISHER_COND,
    to: `"aws:PrincipalArn" = [${PUBLISHER_ARN_HCL}, aws_iam_role.ecs_task.arn] }`,
    violation: "DenyManifestWriteExceptPublisher: Condition",
  },
  {
    name: "a wildcard principal exception",
    file: "storage.tf",
    from: `ArnNotEquals = { ${PUBLISHER_COND}`,
    to: `ArnNotLike = { "aws:PrincipalArn" = "arn:aws:iam::*:role/*" }`,
    violation: "DenyManifestWriteExceptPublisher: Condition",
  },
  {
    name: "a NotPrincipal instead of Principal \"*\" and a condition",
    file: "storage.tf",
    from: `        Sid       = "DenyManifestWriteExceptPublisher"
        Effect    = "Deny"
        Principal = "*"`,
    to: `        Sid          = "DenyManifestWriteExceptPublisher"
        Effect       = "Deny"
        NotPrincipal = { AWS = ${PUBLISHER_ARN_HCL} }`,
    violation: "DenyManifestWriteExceptPublisher: unexpected NotPrincipal",
  },
  {
    name: "an empty break-glass role rendered as an empty condition list",
    file: "storage.tf",
    from: BREAK_GLASS_FOR,
    to: `        { Condition = { ArnNotEquals = { "aws:PrincipalArn" = compact([var.audit_anchor_break_glass_role_arn]) } } }`,
    violation: "DenyBreakGlassPathWriteExceptOperator: Condition",
  },
  {
    name: "an empty prefix",
    file: "variables.tf",
    from: 'default     = "audit-anchors"',
    to: 'default     = ""',
    violation: 'prefix: "" is not a valid anchor prefix',
  },
  {
    name: "a prefix with *",
    file: "variables.tf",
    from: 'default     = "audit-anchors"',
    to: 'default     = "audit-*"',
    violation: 'prefix: "audit-*" is not a valid anchor prefix',
  },
  {
    name: "the publisher allowed on a break-glass path",
    file: "storage.tf",
    from: '"aws:PrincipalArn" = var.audit_anchor_break_glass_role_arn } }',
    to: `"aws:PrincipalArn" = [var.audit_anchor_break_glass_role_arn, ${PUBLISHER_ARN_HCL}] } }`,
    opts: withBreakGlass,
    violation: "DenyBreakGlassPathWriteExceptOperator: Condition",
  },
  {
    name: "the break-glass role allowed on the manifest path",
    file: "storage.tf",
    from: PUBLISHER_COND,
    to: `"aws:PrincipalArn" = [${PUBLISHER_ARN_HCL}, var.audit_anchor_break_glass_role_arn] }`,
    opts: withBreakGlass,
    violation: "DenyManifestWriteExceptPublisher: Condition",
  },
  {
    name: "a catch-all with a principal exception (the publisher may write <prefix>/other)",
    file: "storage.tf",
    from: '        Sid       = "DenyPutOutsideAnchorPaths"\n',
    to: `        Sid       = "DenyPutOutsideAnchorPaths"\n        Condition = { ${EXCEPTION} }\n`,
    violation: "DenyPutOutsideAnchorPaths: Condition",
  },
  {
    name: "the lifecycle Deny on bucket/* instead of the bucket ARN",
    file: "storage.tf",
    from: `Action    = "s3:PutLifecycleConfiguration"
        Resource  = aws_s3_bucket.audit_anchors[0].arn`,
    to: `Action    = "s3:PutLifecycleConfiguration"
        Resource  = "\${aws_s3_bucket.audit_anchors[0].arn}/*"`,
    violation: "DenyLifecycleConfiguration: Resource",
  },
  {
    name: "a missing delete Deny",
    file: "storage.tf",
    from: `      {
        # A delete marker would hide an anchor from a read by key. No exception.
        Sid       = "DenyDelete"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource  = "\${aws_s3_bucket.audit_anchors[0].arn}/*"
      },
`,
    to: "",
    violation: "statements:",
  },
  {
    name: "a delete Deny that leaves version deletes open",
    file: "storage.tf",
    from: 'Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion"]',
    to: 'Action    = ["s3:DeleteObject"]',
    violation: "DenyDelete: Action",
  },
  {
    name: "a missing replication Deny",
    file: "storage.tf",
    from: `      {
        # A replication role writes objects, delete markers and tags under
        # these actions, not s3:PutObject, so no statement above refuses it.
        # The bucket is never a replication destination. No exception.
        Sid       = "DenyReplicationWrite"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]
        Resource  = "\${aws_s3_bucket.audit_anchors[0].arn}/*"
      },
`,
    to: "",
    violation: "statements:",
  },
  {
    name: "a replication Deny that leaves tag replication open",
    file: "storage.tf",
    from: 'Action    = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]',
    to: 'Action    = ["s3:ReplicateObject", "s3:ReplicateDelete"]',
    violation: "DenyReplicationWrite: Action",
  },
  {
    name: "a principal exception on the replication Deny",
    file: "storage.tf",
    from: 'Action    = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]',
    to: `Action    = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]\n        Condition = { ${EXCEPTION} }`,
    violation: "DenyReplicationWrite: Condition",
  },
  {
    name: "a principal exception on the lock-mode Deny",
    file: "storage.tf",
    from: 'StringNotEquals = { "s3:object-lock-mode" = "COMPLIANCE" }',
    to: `StringNotEquals = { "s3:object-lock-mode" = "COMPLIANCE" }\n          ${EXCEPTION}`,
    violation: "DenyNonComplianceLockMode: Condition",
  },
  {
    name: "a principal exception on the retention-cap Deny",
    file: "storage.tf",
    from: 'NumericGreaterThan = { "s3:object-lock-remaining-retention-days" = tostring(local.audit_anchor_retention_cap_days) }',
    to: `NumericGreaterThan = { "s3:object-lock-remaining-retention-days" = tostring(local.audit_anchor_retention_cap_days) }\n          ${EXCEPTION}`,
    violation: "DenyRetentionAboveCap: Condition",
  },
  {
    name: "a principal exception on the SSE Deny",
    file: "storage.tf",
    from: 'StringNotEqualsIfExists = { "s3:x-amz-server-side-encryption" = "AES256" }',
    to: `StringNotEqualsIfExists = { "s3:x-amz-server-side-encryption" = "AES256" }\n          ${EXCEPTION}`,
    violation: "DenyNonSseS3: Condition",
  },
  {
    name: "a retention cap far past the default",
    file: "storage.tf",
    from: "var.audit_anchor_object_lock_days + 31",
    to: "var.audit_anchor_object_lock_days + 3650",
    violation: "DenyRetentionAboveCap: Condition",
  },
  {
    name: "Object Lock following the attachments toggle",
    file: "storage.tf",
    from: "  object_lock_enabled = true\n",
    to: "  object_lock_enabled = var.enable_s3_object_lock\n",
    violation: "bucket: object_lock_enabled is not true",
  },
  {
    name: "SSE-KMS when a KMS key is configured",
    file: "storage.tf",
    from: '      sse_algorithm = "AES256"\n    }\n\n    # See the attachments bucket',
    to: '      sse_algorithm = var.s3_kms_key_arn != "" ? "aws:kms" : "AES256"\n    }\n\n    # See the attachments bucket',
    opts: { vars: { s3_kms_key_arn: "arn:aws:kms:ap-northeast-1:111122223333:key/x" } },
    violation: "sse: aws:kms, not AES256",
  },
  {
    name: "a publisher deployment that can run two tasks",
    file: "ecs.tf",
    from: "deployment_maximum_percent         = 100",
    to: "deployment_maximum_percent         = 200",
    violation: "publisher service: deployment_maximum_percent is not 100",
  },
  {
    name: "a publisher deployment that keeps the old task up",
    file: "ecs.tf",
    from: "deployment_minimum_healthy_percent = 0",
    to: "deployment_minimum_healthy_percent = 100",
    violation: "publisher service: deployment_minimum_healthy_percent is not 0",
  },
  {
    name: "a publisher desired_count above one",
    file: "ecs.tf",
    from: "desired_count = min(1, var.worker_desired_count)",
    to: "desired_count = var.worker_desired_count",
    violation: "publisher service: desired_count 2 for worker_desired_count=2",
  },
  {
    name: "the publisher on the shared task role",
    file: "ecs.tf",
    from: "task_role_arn      = aws_iam_role.ecs_audit_anchor_publisher_task.arn",
    to: "task_role_arn      = aws_iam_role.ecs_task.arn",
    violation: "publisher task: task_role_arn is not its own role",
  },
  {
    name: "a publisher stopTimeout left at the default",
    file: "ecs.tf",
    from: "      stopTimeout = 120\n",
    to: "",
    violation: "publisher task: stopTimeout undefined, not 120",
  },
  {
    name: "a publisher role that can also read",
    file: "iam.tf",
    from: 'Action   = ["s3:PutObject", "s3:PutObjectRetention"]',
    to: 'Action   = ["s3:PutObject", "s3:PutObjectRetention", "s3:GetObject"]',
    violation: "publisher role: statements",
  },
  {
    name: "a publisher role granted outside the prefix",
    file: "iam.tf",
    from: 'Resource = "${aws_s3_bucket.audit_anchors[0].arn}/${local.audit_anchor_prefix}/*"',
    to: 'Resource = "${aws_s3_bucket.audit_anchors[0].arn}/*"',
    violation: "publisher role: statements",
  },
  {
    name: "the anchor grant back on the shared role",
    file: "iam.tf",
    from: 'resource "aws_iam_role_policy" "ecs_s3_access" {',
    to: `resource "aws_iam_role_policy" "ecs_audit_anchor_s3" {
  name = "x"
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Statement = [{ Effect = "Allow", Action = ["s3:PutObject"], Resource = "\${aws_s3_bucket.audit_anchors[0].arn}/*" }]
  })
}

resource "aws_iam_role_policy" "ecs_s3_access" {`,
    violation: "shared role: ecs_audit_anchor_s3 grants on the anchors bucket",
  },
  {
    name: "a publisher role any account's ECS tasks may assume",
    file: "iam.tf",
    from: '      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }\n',
    to: "",
    violation: "publisher trust: statements",
  },
  {
    name: "a publisher trust condition on a key ECS does not bind to the account",
    file: "iam.tf",
    from: 'Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }',
    to: 'Condition = { ArnLike = { "aws:SourceArn" = "arn:aws:ecs:*:*:*" } }',
    violation: "publisher trust: statements",
  },
  {
    name: "the role override rule watching the shared task role",
    file: "monitoring.tf",
    from: "taskRoleArn = local.audit_anchor_publisher_role_spellings\n        }",
    to: "taskRoleArn = [aws_iam_role.ecs_task.arn]\n        }",
    violation: "role override rule: event_pattern",
  },
  {
    name: "the role override rule matching the role's ARN only",
    file: "monitoring.tf",
    from: "taskRoleArn = local.audit_anchor_publisher_role_spellings\n        }",
    to: "taskRoleArn = [aws_iam_role.ecs_audit_anchor_publisher_task.arn]\n        }",
    violation: "role override rule: misses an override naming the role as <ref:aws_iam_role.ecs_audit_anchor_publisher_task.name>",
  },
  {
    name: "both role rules matching the role's ARN only",
    file: "monitoring.tf",
    from: "    aws_iam_role.ecs_audit_anchor_publisher_task.name,\n",
    to: "",
    violation: "role task-definition rule: misses family foo naming the role as <ref:aws_iam_role.ecs_audit_anchor_publisher_task.name>",
  },
  {
    name: "the task-definition rule not excluding the publisher family",
    file: "monitoring.tf",
    from: "        family      = [{ anything-but = aws_ecs_task_definition.audit_anchor_publisher.family }]\n",
    to: "",
    violation: "role task-definition rule: matches the publisher family's own registration",
  },
  {
    name: "the task-definition rule matching only the publisher family",
    file: "monitoring.tf",
    from: "family      = [{ anything-but = aws_ecs_task_definition.audit_anchor_publisher.family }]",
    to: "family      = [aws_ecs_task_definition.audit_anchor_publisher.family]",
    violation: "role task-definition rule: misses family foo",
  },
  {
    name: "the task-definition rule excluding a re-typed family name",
    file: "monitoring.tf",
    from: "anything-but = aws_ecs_task_definition.audit_anchor_publisher.family",
    to: 'anything-but = "${local.name_prefix}-audit-anchor-publisher"',
    violation: "role task-definition rule: event_pattern",
  },
  {
    name: "the task-definition rule watching the shared task role",
    file: "monitoring.tf",
    from: "taskRoleArn = local.audit_anchor_publisher_role_spellings\n        family",
    to: "taskRoleArn = [aws_iam_role.ecs_task.arn]\n        family",
    violation: "role task-definition rule: misses family foo",
  },
  {
    name: "the task-definition rule's target sent elsewhere",
    file: "monitoring.tf",
    from: "rule      = aws_cloudwatch_event_rule.audit_anchor_publisher_role_task_definition[0].name",
    to: "rule      = aws_cloudwatch_event_rule.ecs_execute_command[0].name",
    violation: "role task-definition rule: not targeted at the alarm topic",
  },
  {
    name: "the task-definition rule left out of the alarm topic policy",
    file: "monitoring.tf",
    from: "                aws_cloudwatch_event_rule.audit_anchor_publisher_role_task_definition[0].arn,\n",
    to: "",
    violation: "role task-definition rule: the alarm topic policy does not admit it",
  },
  {
    name: "the task-definition rule removed",
    file: "monitoring.tf",
    from: 'resource "aws_cloudwatch_event_rule" "audit_anchor_publisher_role_task_definition" {',
    to: 'resource "aws_cloudwatch_event_rule" "audit_anchor_publisher_role_task_definition_gone" {',
    violation: "role task-definition rule: missing",
  },
  {
    name: "the role override rule leaving StartTask unwatched",
    file: "monitoring.tf",
    from: 'eventName   = ["RunTask", "StartTask"]\n      requestParameters = {\n        overrides',
    to: 'eventName   = ["RunTask"]\n      requestParameters = {\n        overrides',
    violation: "role override rule: event_pattern",
  },
  {
    name: "the role override rule's target sent elsewhere",
    file: "monitoring.tf",
    from: "rule      = aws_cloudwatch_event_rule.audit_anchor_publisher_role_override[0].name",
    to: "rule      = aws_cloudwatch_event_rule.ecs_execute_command[0].name",
    violation: "role override rule: not targeted at the alarm topic",
  },
  {
    name: "the role override rule left out of the alarm topic policy",
    file: "monitoring.tf",
    from: "                aws_cloudwatch_event_rule.audit_anchor_publisher_role_override[0].arn,\n",
    to: "",
    violation: "role override rule: the alarm topic policy does not admit it",
  },
  {
    name: "the family task rule removed",
    file: "monitoring.tf",
    from: 'resource "aws_cloudwatch_event_rule" "audit_anchor_publisher_family_task_outside_service" {',
    to: 'resource "aws_cloudwatch_event_rule" "audit_anchor_publisher_family_task_outside_service_gone" {',
    violation: "role routes: (b2) a RunTask task in this cluster matched by []",
  },
  {
    name: "the family task rule without its service exclusion",
    file: "monitoring.tf",
    from: `      "$or" = [
        { clusterArn = [{ anything-but = aws_ecs_cluster.main.arn }] },
        { group = [{ anything-but = "service:\${aws_ecs_service.audit_anchor_publisher.name}" }] },
      ]
`,
    to: "",
    violation: "family task rule: matches the publisher service's own task",
  },
  {
    name: "the family task rule excluding the service in any cluster",
    file: "monitoring.tf",
    from: "        { clusterArn = [{ anything-but = aws_ecs_cluster.main.arn }] },\n",
    to: "",
    violation: "role routes: (b2) a same-named service's task in another cluster matched by []",
  },
  {
    name: "the family task rule's prefix without the : terminator",
    file: "monitoring.tf",
    from: 'taskDefinitionArn = [{ prefix = "${aws_ecs_task_definition.audit_anchor_publisher.arn_without_revision}:" }]',
    to: 'taskDefinitionArn = [{ prefix = aws_ecs_task_definition.audit_anchor_publisher.arn_without_revision }]',
    violation: "family task rule: matches a family that only starts with the publisher's",
  },
  {
    name: "the family task rule's prefix with a re-typed family",
    file: "monitoring.tf",
    from: 'taskDefinitionArn = [{ prefix = "${aws_ecs_task_definition.audit_anchor_publisher.arn_without_revision}:" }]',
    to: 'taskDefinitionArn = [{ prefix = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name_prefix}-audit-anchor-publisher:" }]',
    violation: "family task rule: event_pattern",
  },
  {
    name: "the family task rule excluding a re-typed service name",
    file: "monitoring.tf",
    from: 'anything-but = "service:${aws_ecs_service.audit_anchor_publisher.name}"',
    to: 'anything-but = "service:${local.name_prefix}-audit-anchor-publisher"',
    violation: "family task rule: event_pattern",
  },
  {
    name: "the family task rule's target sent elsewhere",
    file: "monitoring.tf",
    from: "rule      = aws_cloudwatch_event_rule.audit_anchor_publisher_family_task_outside_service[0].name",
    to: "rule      = aws_cloudwatch_event_rule.ecs_execute_command[0].name",
    violation: "family task rule: not targeted at the alarm topic",
  },
  {
    name: "the family task rule left out of the alarm topic policy",
    file: "monitoring.tf",
    from: "                aws_cloudwatch_event_rule.audit_anchor_publisher_family_task_outside_service[0].arn,\n",
    to: "",
    violation: "family task rule: the alarm topic policy does not admit it",
  },
  {
    name: "the family run-task rule removed",
    file: "monitoring.tf",
    from: 'resource "aws_cloudwatch_event_rule" "audit_anchor_publisher_family_run_task" {',
    to: 'resource "aws_cloudwatch_event_rule" "audit_anchor_publisher_family_run_task_gone" {',
    violation: "role routes: (b2) RunTask of <ref:aws_ecs_task_definition.audit_anchor_publisher.family> claiming the publisher service's group matched by []",
  },
  {
    name: "the family run-task rule's prefix without the : terminator",
    file: "monitoring.tf",
    from: '{ prefix = "${aws_ecs_task_definition.audit_anchor_publisher.family}:" },',
    to: "{ prefix = aws_ecs_task_definition.audit_anchor_publisher.family },",
    violation: "family run-task rule: matches a family that only starts with the publisher's",
  },
  {
    name: "the family run-task rule matching the ARN form only",
    file: "monitoring.tf",
    from: `          aws_ecs_task_definition.audit_anchor_publisher.family,
          { prefix = "\${aws_ecs_task_definition.audit_anchor_publisher.family}:" },
`,
    to: "",
    violation: "role routes: (b2) RunTask of <ref:aws_ecs_task_definition.audit_anchor_publisher.family>:7 claiming",
  },
  {
    name: "the family run-task rule with a re-typed family",
    file: "monitoring.tf",
    from: "          aws_ecs_task_definition.audit_anchor_publisher.family,\n",
    to: '          "${local.name_prefix}-audit-anchor-publisher",\n',
    violation: "family run-task rule: event_pattern",
  },
  {
    name: "the family run-task rule's target sent elsewhere",
    file: "monitoring.tf",
    from: "rule      = aws_cloudwatch_event_rule.audit_anchor_publisher_family_run_task[0].name",
    to: "rule      = aws_cloudwatch_event_rule.ecs_execute_command[0].name",
    violation: "family run-task rule: not targeted at the alarm topic",
  },
  {
    name: "the family run-task rule left out of the alarm topic policy",
    file: "monitoring.tf",
    from: "                aws_cloudwatch_event_rule.audit_anchor_publisher_family_run_task[0].arn,\n",
    to: "",
    violation: "family run-task rule: the alarm topic policy does not admit it",
  },
  {
    name: "a task role on the verify worker",
    file: "ecs.tf",
    from: "  # No task_role_arn: the worker calls no AWS API",
    to: "  task_role_arn = aws_iam_role.ecs_task.arn\n  # No task_role_arn: the worker calls no AWS API",
    violation: "verify task: has a task role",
  },
  {
    name: "ECS Exec logging left to the default",
    file: "ecs.tf",
    from: 'logging = "NONE"',
    to: 'logging = "DEFAULT"',
    violation: "cluster: ECS Exec logging is DEFAULT",
  },
  {
    name: "the prefix module given a constant",
    file: "storage.tf",
    from: "prefix = var.audit_anchor_s3_prefix",
    to: 'prefix = "audit-anchors"',
    violation: "prefix module: output does not follow var.audit_anchor_s3_prefix",
  },
  {
    name: "a consumer reading a constant instead of the module output",
    file: "storage.tf",
    from: "audit_anchor_prefix = module.anchor_prefix.prefix",
    to: 'audit_anchor_prefix = "audit-anchors"',
    violation: "prefix module: bucket policy does not take the prefix from it",
  },
  {
    name: "the anchors toggle allowed off",
    file: "variables.tf",
    from: "condition     = var.enable_s3_audit_anchors\n",
    to: "condition     = true\n",
    violation: "enable_s3_audit_anchors: validation does not require true",
  },
];

describe("the EventBridge matcher", () => {
  it("prefix matches a string that starts with it, and nothing else", () => {
    const pattern = { a: [{ prefix: "fam:" }] };
    expect(matchesEventPattern(pattern, { a: "fam:3" })).toBe(true);
    expect(matchesEventPattern(pattern, { a: "fam-x:3" })).toBe(false);
    expect(matchesEventPattern(pattern, { a: "xfam:3" })).toBe(false);
    expect(matchesEventPattern(pattern, { a: 3 })).toBe(false);
    expect(matchesEventPattern(pattern, {})).toBe(false);
  });

  it("$or matches when any branch does, ANDed with the other fields", () => {
    const pattern = { k: ["x"], $or: [{ a: ["1"] }, { b: [{ "anything-but": "2" }] }] };
    expect(matchesEventPattern(pattern, { k: "x", a: "1", b: "2" })).toBe(true);
    expect(matchesEventPattern(pattern, { k: "x", a: "0", b: "3" })).toBe(true);
    expect(matchesEventPattern(pattern, { k: "x", a: "0", b: "2" })).toBe(false);
    expect(matchesEventPattern(pattern, { k: "y", a: "1", b: "3" })).toBe(false);
  });

  it("refuses an empty $or and an unknown matcher", () => {
    expect(() => matchesEventPattern({ $or: [] }, {})).toThrow(/\$or/);
    expect(() => matchesEventPattern({ a: [{ wildcard: "*" }] }, { a: "x" })).toThrow(/unsupported matcher/);
  });
});

describe("anchors wiring red fixtures", () => {
  it.each(RED_FIXTURES)("catches $name", ({ file, from, to, opts, violation }) => {
    const violations = allViolations(edited(file, from, to), opts);
    expect(violations.some((v) => v.startsWith(violation)), JSON.stringify(violations)).toBe(true);
  });

  it("catches the prefix module call removed", () => {
    const text = readFileSync(join(TERRAFORM_DIR, "storage.tf"), "utf8");
    const call = 'module "anchor_prefix" {\n  source = "./modules/anchor-prefix"\n  prefix = var.audit_anchor_s3_prefix\n}\n';
    expect(text.split(call).length - 1).toBe(1);
    const tf = new TerraformConfig(TERRAFORM_DIR, { "storage.tf": text.replace(call, "") });
    expect(prefixPlumbingViolations(tf)).toContain("prefix module: not called");
    expect(policyViolations(tf)[0]).toMatch(/^prefix: module\.anchor_prefix\.prefix does not evaluate/);
  });
});
