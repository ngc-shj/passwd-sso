/**
 * scripts/checks/worker-bundle-smoke.json is the env each worker bundle boots
 * with in check-worker-bundle-smoke.sh — and its set of tasks is the smoke's
 * view of what ECS runs. It is checked in rather than generated so the smoke
 * also runs where the repo's dependencies are not installed (the container-scan
 * job); this test pins it to infra/terraform/ecs.tf instead.
 *
 * A worker task is any task definition whose container runs a bundle under
 * dist/. A container shape this derivation does not model (a wrapped command,
 * env from a file, an unsupported HCL function) throws rather than being read
 * as something else.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TerraformConfig, TERRAFORM_DIR, HclUnknown } from "../helpers/hcl-subset";

const REPO_ROOT = resolve(__dirname, "../../..");
const MAP_PATH = join(REPO_ROOT, "scripts/checks/worker-bundle-smoke.json");
const ECS_TF = readFileSync(join(TERRAFORM_DIR, "ecs.tf"), "utf8");

type SmokeTask = { bundle: string; env: Record<string, string>; markers: string[]; forbiddenInputs: string[] };
type SmokeMap = { tasks: Record<string, SmokeTask> };

/** An env value Terraform resolves at apply: no literal to compare against. */
const UNKNOWN = Symbol("unknown");
type WorkerTask = { bundle: string; env: Record<string, string | typeof UNKNOWN> };

const MODELLED_CONTAINER_KEYS = new Set([
  "name",
  "image",
  "essential",
  "command",
  "stopTimeout",
  "logConfiguration",
  "environment",
  "secrets",
  "portMappings",
  "healthCheck",
  "linuxParameters",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof HclUnknown);
}

function envValue(v: unknown): string | typeof UNKNOWN {
  if (v instanceof HclUnknown) return UNKNOWN;
  if (typeof v !== "string") throw new Error(`unmodelled env value ${String(v)}`);
  // A template over a reference evaluates to a string carrying it.
  return v.includes("<ref:") ? UNKNOWN : v;
}

function workerContainer(task: string, c: unknown): WorkerTask | null {
  if (!isObject(c)) throw new Error(`${task}: container definition is not an object`);
  const mentionsDist = JSON.stringify(c).includes("dist/");
  const command = c.command;
  if (command === undefined) {
    if (mentionsDist) throw new Error(`${task}: names dist/ without a command`);
    return null;
  }
  if (!Array.isArray(command) || !command.every((p) => typeof p === "string")) {
    throw new Error(`${task}: unmodelled command`);
  }
  if (!command.some((p) => p.includes("dist/"))) return null;
  if (command.length !== 2 || command[0] !== "node" || !/^dist\/[A-Za-z0-9_.-]+\.js$/.test(command[1])) {
    throw new Error(`${task}: unmodelled worker command ${JSON.stringify(command)}`);
  }
  for (const key of Object.keys(c)) {
    if (!MODELLED_CONTAINER_KEYS.has(key)) throw new Error(`${task}: unmodelled container key ${key}`);
  }
  const env: WorkerTask["env"] = {};
  const add = (name: unknown, value: string | typeof UNKNOWN) => {
    if (typeof name !== "string") throw new Error(`${task}: unmodelled env name`);
    if (name in env) throw new Error(`${task}: ${name} given twice`);
    env[name] = value;
  };
  for (const list of [c.environment, c.secrets]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`${task}: environment/secrets is not a list`);
    for (const e of list) {
      if (!isObject(e)) throw new Error(`${task}: unmodelled env entry`);
      add(e.name, list === c.secrets ? UNKNOWN : envValue(e.value));
    }
  }
  return { bundle: command[1], env };
}

/** task definition name → its worker container, for every task that runs a bundle. */
function workerTasks(tf: TerraformConfig): Record<string, WorkerTask> {
  const out: Record<string, WorkerTask> = {};
  for (const t of tf.resources("aws_ecs_task_definition")) {
    const name = t.labels[1];
    const defs = tf.attr(t, "container_definitions");
    if (!Array.isArray(defs)) throw new Error(`${name}: container_definitions is not a list`);
    const workers = defs.map((c) => workerContainer(name, c)).filter((w): w is WorkerTask => w !== null);
    if (workers.length > 1) throw new Error(`${name}: more than one worker container`);
    if (workers.length === 1) out[name] = workers[0];
  }
  return out;
}

/** Every way the checked-in map differs from what the task definitions give. */
function mapDrift(tf: TerraformConfig, map: SmokeMap): string[] {
  const derived = workerTasks(tf);
  const out: string[] = [];
  for (const name of Object.keys(derived)) if (!(name in map.tasks)) out.push(`${name}: missing from the map`);
  for (const [name, entry] of Object.entries(map.tasks)) {
    const task = derived[name];
    if (!task) {
      out.push(`${name}: no worker task definition`);
      continue;
    }
    if (entry.bundle !== task.bundle) out.push(`${name}: bundle ${entry.bundle} != ${task.bundle}`);
    for (const env of Object.keys(task.env)) if (!(env in entry.env)) out.push(`${name}: ${env} missing`);
    for (const [env, value] of Object.entries(entry.env)) {
      if (!(env in task.env)) out.push(`${name}: ${env} not given by the task`);
      else if (task.env[env] !== UNKNOWN && task.env[env] !== value) out.push(`${name}: ${env} != ${String(task.env[env])}`);
    }
  }
  return out;
}

function withEcs(edit: (text: string) => string): TerraformConfig {
  const edited = edit(ECS_TF);
  expect(edited).not.toBe(ECS_TF);
  return new TerraformConfig(TERRAFORM_DIR, { "ecs.tf": edited });
}

const PUBLISHER_COMMAND = 'command   = ["node", "dist/audit-anchor-publisher.js"]';

describe("worker-bundle-smoke.json vs the ECS task definitions", () => {
  const tf = new TerraformConfig(TERRAFORM_DIR);
  const map = JSON.parse(readFileSync(MAP_PATH, "utf8")) as SmokeMap;

  it("finds exactly the four worker task definitions", () => {
    expect(Object.keys(workerTasks(tf)).sort()).toEqual([
      "audit_anchor_publisher",
      "audit_chain_verify_worker",
      "audit_outbox_worker",
      "retention_gc_worker",
    ]);
  });

  it("matches the map: tasks, bundles, env names and literal values", () => {
    expect(mapDrift(tf, map)).toEqual([]);
  });

  it("gives every entry a marker, and lists forbidden inputs that exist", () => {
    for (const [name, entry] of Object.entries(map.tasks)) {
      expect(entry.markers.length, name).toBeGreaterThan(0);
      for (const f of entry.forbiddenInputs) expect(existsSync(join(REPO_ROOT, f)), `${name}: ${f}`).toBe(true);
    }
  });

  it("catches a secret added to a task but not to the map", () => {
    const anchor = '{ name = "DEPLOYMENT_ID", valueFrom = "${aws_secretsmanager_secret.app.arn}:DEPLOYMENT_ID::" },';
    const drifted = withEcs((t) =>
      t.replace(anchor, `${anchor}\n        { name = "DATABASE_URL", valueFrom = "\${aws_secretsmanager_secret.app.arn}:DATABASE_URL::" },`),
    );
    expect(mapDrift(drifted, map)).toEqual(["audit_anchor_publisher: DATABASE_URL missing"]);
  });

  it("catches a literal env value that differs from the map's", () => {
    const drifted = withEcs((t) =>
      t.replace('{ name = "AUDIT_ANCHOR_PUBLISHER_ENABLED", value = "true" },\n        { name = "AUDIT_ANCHOR_DESTINATION_S3_BUCKET"', '{ name = "AUDIT_ANCHOR_PUBLISHER_ENABLED", value = "false" },\n        { name = "AUDIT_ANCHOR_DESTINATION_S3_BUCKET"'),
    );
    expect(mapDrift(drifted, map)).toEqual(["audit_anchor_publisher: AUDIT_ANCHOR_PUBLISHER_ENABLED != false"]);
  });

  it("catches a fifth worker task the map does not have", () => {
    const drifted = withEcs((t) => t.replace('command   = ["node", "dist/retention-gc-worker.js"]', 'command   = ["node", "dist/other-worker.js"]'));
    expect(mapDrift(drifted, map)).toEqual(["retention_gc_worker: bundle dist/retention-gc-worker.js != dist/other-worker.js"]);
  });

  it("refuses a worker command wrapped in a shell", () => {
    const wrapped = withEcs((t) => t.replace(PUBLISHER_COMMAND, 'command   = ["sh", "-c", "node dist/audit-anchor-publisher.js"]'));
    expect(() => workerTasks(wrapped)).toThrow(/unmodelled worker command/);
  });

  it("refuses env read from a file the map cannot see", () => {
    const withFiles = withEcs((t) =>
      t.replace(PUBLISHER_COMMAND, `${PUBLISHER_COMMAND}\n      environmentFiles = [{ type = "s3", value = "arn:aws:s3:::b/x.env" }]`),
    );
    expect(() => workerTasks(withFiles)).toThrow(/unmodelled container key environmentFiles/);
  });

  it("refuses a command built by a function the evaluator does not model", () => {
    const computed = withEcs((t) => t.replace(PUBLISHER_COMMAND, 'command   = formatlist("%s", ["node", "dist/audit-anchor-publisher.js"])'));
    expect(() => workerTasks(computed)).toThrow(/unsupported function formatlist/);
  });
});
