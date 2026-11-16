/**
 * The four background workers are run three ways: ECS (infra/terraform/ecs.tf),
 * compose (docker-compose.workers.yml) and k8s (infra/k8s/). This pins the two
 * hand-written ones to ECS and to each other, and pins the secret isolation the
 * compose side claims:
 *
 *   I1.x  compose: what each service loads, receives and blanks (the withheld
 *         env set W comes from scripts/checks/lib/withheld-env.ts, not from a list here);
 *   I2.x  k8s: command, probes, env names, hardening, rollout shape.
 *
 * No service outside the dev override gets `.env` as a file either (a bind mount
 * of the project directory, an ancestor or a `.env*` file; a `secrets:`/`configs:`
 * entry with such a `file:`); a volume shape it does not model is reported.
 *
 * Every check is a pure function over parsed YAML plus a context read from
 * ecs.tf, so each invariant has a single-step red case on a cloned model and the
 * exact drift list is compared whole. A form the model does not cover (a string
 * command, `envFrom`-less env from a file, an unknown workload kind) throws
 * rather than being read as something else.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix, relative, resolve } from "node:path";
import { CORE_SCHEMA, load, loadAll } from "js-yaml";
import { ALLOWLIST } from "../../../scripts/env-allowlist";
import { createComposeYamlLoader, findComposeFiles } from "../../../scripts/checks/check-compose-log-caps.mjs";
import { DOCKER_HARDENING_ARGS } from "../../../scripts/checks/lib/worker-bundle-smoke.mjs";
import { ROLES } from "../../../scripts/bootstrap-rds-roles.mjs";
import { TerraformConfig, TERRAFORM_DIR, type HclExpr } from "../../../scripts/checks/lib/hcl-subset";
import {
  SHARED_PUBLISHER_NAME,
  deriveWithheldEnv,
  envFileSourceKind,
  derivePublisherOnlyEnv,
  ecsContainerDefinitions,
  ecsSecretNames,
  ownDatabaseUrlKey,
  ownRoleUser,
  readSmokeMap,
  realWithheldInputs,
  rolePasswordBinding,
  roleUserFromComposeUrl,
  withheldHolders,
  workerServiceName,
  type SmokeMap,
  type SmokeTask,
} from "../../../scripts/checks/lib/withheld-env";

// picomatch ships no types; it is the matcher dorny/paths-filter applies to ci.yml's filters.
const picomatch = createRequire(__filename)("picomatch") as (globs: string[], options: { dot: boolean }) => (path: string) => boolean;

const REPO_ROOT = resolve(__dirname, "../../..");
const WORKERS_FILE = "docker-compose.workers.yml";
const K8S_DIR = "infra/k8s";
const IMAGE_PLACEHOLDER = "REPLACE_WITH_IMMUTABLE_IMAGE_REF";
/** The one compose file whose `.:/app` mounts are the dev shape, not a file channel (C1). */
const DEV_OVERRIDE_FILE = "docker-compose.override.yml";

/** Compose services that carry the signing material or read the chain, and so load no `.env` (C1). */
const ISOLATED_SERVICES = ["audit-anchor-publisher", "audit-chain-verify-worker"];
/** Names an isolated service may hold beyond its ECS set (C1, I1.3). */
const COMPOSE_PASS_THROUGH: Record<string, string[]> = {
  "audit-anchor-publisher": [
    "DATABASE_URL",
    "AUDIT_ANCHOR_DESTINATION_GH_REPO",
    "AUDIT_ANCHOR_DESTINATION_GH_TOKEN",
    "AUDIT_ANCHOR_DESTINATION_FS_PATH",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ],
  "audit-chain-verify-worker": ["DATABASE_URL"],
};
/** Keys whose value must be `${NAME:?message}` on the isolated services (I1.2); a role URL is added per service. */
const REQUIRED_INTERPOLATION_KEYS = ["AUDIT_ANCHOR_SIGNING_KEY", "AUDIT_ANCHOR_TAG_SECRET", SHARED_PUBLISHER_NAME];
const FORBIDDEN_OPTIONAL_INTERPOLATION = /(SIGNING_KEY|TAG_SECRET|_PASSWORD)(:-|\?)[^:]/;
const SIGNING_ENV_NAMES = ["AUDIT_ANCHOR_SIGNING_KEY", "AUDIT_ANCHOR_TAG_SECRET"];

const sortStrings = (xs: Iterable<string>): string[] => [...xs].sort();

// ─── Compose normalisation ──────────────────────────────────

type EnvState = { kind: "blank" } | { kind: "passthrough" } | { kind: "value"; value: string };
type Fragment = {
  file: string;
  loadsDotEnv: boolean;
  env: Record<string, EnvState>;
  command: string[] | undefined;
  stopGraceSeconds: number | undefined;
  readOnly: unknown;
  capDrop: unknown;
  securityOpt: unknown;
};
type ComposeModel = Record<string, unknown>; // file name → parsed document

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every `env_file` spelling, as the list of paths; only `.env` is modelled. */
function normaliseEnvFile(where: string, v: unknown): string[] {
  if (v === undefined) return [];
  const items = Array.isArray(v) ? v : [v];
  return items.map((item) => {
    let path: unknown = item;
    if (isRecord(item)) {
      for (const k of Object.keys(item)) {
        if (k !== "path" && k !== "required") throw new Error(`${where}: unmodelled env_file key ${k}`);
      }
      path = item.path;
    }
    if (typeof path !== "string") throw new Error(`${where}: unmodelled env_file entry`);
    const norm = posix.normalize(path);
    if (norm !== ".env") throw new Error(`${where}: unmodelled env_file ${path}`);
    return norm;
  });
}

/** `environment` as a list (`K=V`, `K=`, bare `K`) or a map (`K: v`, `K: ""`, `K:` null). */
function normaliseEnvironment(where: string, v: unknown): Record<string, EnvState> {
  const out: Record<string, EnvState> = {};
  const add = (key: string, state: EnvState) => {
    if (key in out) throw new Error(`${where}: ${key} given twice`);
    out[key] = state;
  };
  if (v === undefined) return out;
  if (Array.isArray(v)) {
    for (const e of v) {
      if (typeof e !== "string") throw new Error(`${where}: unmodelled environment entry`);
      const eq = e.indexOf("=");
      if (eq === -1) add(e, { kind: "passthrough" });
      else add(e.slice(0, eq), e.length === eq + 1 ? { kind: "blank" } : { kind: "value", value: e.slice(eq + 1) });
    }
    return out;
  }
  if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (val === null) add(k, { kind: "passthrough" });
      else if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        add(k, val === "" ? { kind: "blank" } : { kind: "value", value: String(val) });
      } else throw new Error(`${where}: unmodelled environment value for ${k}`);
    }
    return out;
  }
  throw new Error(`${where}: unmodelled environment`);
}

/** A Go duration (`120s`, `2m`, `2m0s`, `1h`) in seconds. */
function parseGoDuration(where: string, v: unknown): number {
  if (typeof v !== "string" || !/^(\d+(\.\d+)?(h|m|s|ms))+$/.test(v)) throw new Error(`${where}: unmodelled duration ${String(v)}`);
  const unit: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001 };
  let total = 0;
  for (const m of v.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) total += Number(m[1]) * unit[m[2]];
  return total;
}

function normaliseCommand(where: string, service: Record<string, unknown>): string[] | undefined {
  const entrypoint = service.entrypoint;
  if (entrypoint !== undefined && JSON.stringify(entrypoint).includes("dist/")) {
    throw new Error(`${where}: entrypoint names a dist/ bundle`);
  }
  const command = service.command;
  if (command === undefined) return undefined;
  if (!Array.isArray(command) || !command.every((p) => typeof p === "string")) {
    throw new Error(`${where}: command must be an exec array`);
  }
  return command as string[];
}

/** service name → its fragments, one per compose file that defines it. */
function composeServices(model: ComposeModel): Map<string, Fragment[]> {
  const services = new Map<string, Fragment[]>();
  for (const file of sortStrings(Object.keys(model))) {
    const doc = model[file];
    if (!isRecord(doc)) throw new Error(`${file}: not a mapping`);
    if (doc.include !== undefined) throw new Error(`${file}: include is not modelled`);
    if (doc.services === undefined) continue;
    if (!isRecord(doc.services)) throw new Error(`${file}: services is not a mapping`);
    for (const [name, spec] of Object.entries(doc.services)) {
      const where = `${file}: ${name}`;
      if (!isRecord(spec)) throw new Error(`${where}: not a mapping`);
      if (spec.extends !== undefined) throw new Error(`${where}: extends is not modelled`);
      const fragment: Fragment = {
        file,
        loadsDotEnv: normaliseEnvFile(where, spec.env_file).length > 0,
        env: normaliseEnvironment(where, spec.environment),
        command: normaliseCommand(where, spec),
        stopGraceSeconds: spec.stop_grace_period === undefined ? undefined : parseGoDuration(where, spec.stop_grace_period),
        readOnly: spec.read_only,
        capDrop: spec.cap_drop,
        securityOpt: spec.security_opt,
      };
      services.set(name, [...(services.get(name) ?? []), fragment]);
    }
  }
  return services;
}

// ─── Context from ecs.tf and the repo ───────────────────────

type Ctx = {
  withheld: string[];
  smoke: SmokeMap;
  /** Names only the publisher may reference (W (c)). */
  publisherOnly: string[];
  /** compose service → the role-password variables its values may reference. */
  passwordBinding: Record<string, string[]>;
  /** smoke task → ECS stopTimeout seconds, where the container sets one. */
  stopTimeout: Record<string, number>;
  /** smoke tasks whose ECS service stops the old task before starting the new one. */
  stopBeforeStart: string[];
  /** smoke task → ECS `secrets` names. */
  ecsSecrets: Record<string, string[]>;
  /** smoke task → ECS env entries given as a string literal. */
  ecsLiterals: Record<string, Record<string, string>>;
};

function ecsContainer(tf: TerraformConfig, taskLabel: string, task: SmokeTask): Record<string, unknown> {
  const found = ecsContainerDefinitions(tf, taskLabel).filter((c) => isRecord(c) && Array.isArray(c.command) && c.command.includes(task.bundle));
  if (found.length !== 1) throw new Error(`${taskLabel}: expected one container running ${task.bundle}`);
  return found[0] as Record<string, unknown>;
}

/** A string written out in full: a quoted literal, or a template with no interpolation. */
function hclString(e: HclExpr | undefined): string | undefined {
  if (e?.t === "lit" && typeof e.v === "string") return e.v;
  if (e?.t === "tmpl" && e.parts.every((p) => typeof p === "string")) return e.parts.join("");
  return undefined;
}

/** An object key as written: a bare name or a quoted string. */
function hclKey(e: HclExpr): string | undefined {
  return e.t === "name" ? e.name : hclString(e);
}

/**
 * The env entries of a task whose `value` is written as a string literal in
 * ecs.tf. Read from the syntax, not the evaluation: `local.audit_anchor_prefix`
 * evaluates to a string too, but it is a deployment choice, not a fixed value.
 */
function ecsLiteralEnv(tf: TerraformConfig, taskLabel: string): Record<string, string> {
  const expr = tf.resource("aws_ecs_task_definition", taskLabel).body.attrs.container_definitions;
  const list = expr?.t === "call" && expr.fn === "jsonencode" ? expr.args[0] : undefined;
  if (list?.t !== "list") throw new Error(`${taskLabel}: container_definitions is not jsonencode([...])`);
  const out: Record<string, string> = {};
  for (const item of list.items) {
    // merge({...}, extra) adds only computed keys; its literal entries are the first argument's.
    const container = item.t === "call" && item.fn === "merge" ? item.args[0] : item;
    if (container?.t !== "obj") throw new Error(`${taskLabel}: container is not an object`);
    const env = container.items.find((i) => hclKey(i.key) === "environment")?.value;
    if (env === undefined) continue;
    if (env.t !== "list") throw new Error(`${taskLabel}: environment is not a list`);
    for (const entry of env.items) {
      if (entry.t !== "obj") throw new Error(`${taskLabel}: unmodelled env entry`);
      const name = entry.items.find((i) => hclKey(i.key) === "name")?.value;
      const value = entry.items.find((i) => hclKey(i.key) === "value")?.value;
      const envName = hclString(name);
      if (envName === undefined) throw new Error(`${taskLabel}: unmodelled env name`);
      const literal = hclString(value);
      if (literal !== undefined) out[envName] = literal;
    }
  }
  return out;
}

function buildCtx(tf: TerraformConfig, smoke: SmokeMap = readSmokeMap()): Ctx {
  const withheldInputs = realWithheldInputs();
  const stopTimeout: Record<string, number> = {};
  const ecsSecrets: Record<string, string[]> = {};
  const ecsLiterals: Record<string, Record<string, string>> = {};
  for (const [label, task] of Object.entries(smoke.tasks)) {
    const timeout = ecsContainer(tf, label, task).stopTimeout;
    if (timeout !== undefined) {
      if (typeof timeout !== "number") throw new Error(`${label}: stopTimeout is not a number`);
      stopTimeout[label] = timeout;
    }
    ecsSecrets[label] = ecsSecretNames(tf, label);
    ecsLiterals[label] = ecsLiteralEnv(tf, label);
  }
  const stopBeforeStart: string[] = [];
  for (const svc of tf.resources("aws_ecs_service")) {
    const label = svc.labels[1];
    if (!(label in smoke.tasks)) continue;
    const max = svc.body.attrs.deployment_maximum_percent;
    const min = svc.body.attrs.deployment_minimum_healthy_percent;
    if (max === undefined || min === undefined) continue;
    if (tf.attr(svc, "deployment_maximum_percent") === 100 && tf.attr(svc, "deployment_minimum_healthy_percent") === 0) {
      stopBeforeStart.push(label);
    }
  }
  return {
    withheld: deriveWithheldEnv(withheldInputs),
    smoke,
    publisherOnly: derivePublisherOnlyEnv(withheldInputs),
    passwordBinding: rolePasswordBinding({ smoke, roles: ROLES, allowlist: ALLOWLIST }),
    stopTimeout,
    stopBeforeStart: sortStrings(stopBeforeStart),
    ecsSecrets,
    ecsLiterals,
  };
}

// ─── Compose invariants ─────────────────────────────────────

/** `${NAME<rest>}` and bare `$NAME` references in a value. */
function references(value: string): Array<{ name: string; rest: string | null }> {
  return [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) =>
    m[1] !== undefined ? { name: m[1], rest: m[2] } : { name: m[3], rest: null },
  );
}

/** Every string under `node`, at any depth. */
function stringValues(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(stringValues);
  if (isRecord(node)) return Object.values(node).flatMap(stringValues);
  return [];
}

function mergedEnv(fragments: Fragment[]): Record<string, EnvState> {
  return Object.assign({}, ...fragments.map((f) => f.env));
}

function composeDrift(model: ComposeModel, ctx: Ctx, workersText: string): string[] {
  const drift: string[] = [];
  const services = composeServices(model);
  const tasks = Object.entries(ctx.smoke.tasks).map(([label, task]) => ({ label, task, service: workerServiceName(task) }));
  const bundles = new Set(tasks.map((t) => t.task.bundle));
  const byService = new Map(tasks.map((t) => [t.service, t]));

  // Member set: each smoke task has one workers-file service running its bundle; no service runs another bundle.
  for (const { task, service } of tasks) {
    const own = (services.get(service) ?? []).filter((f) => f.file === WORKERS_FILE);
    if (own.length !== 1) {
      drift.push(`${service}: expected exactly one definition in ${WORKERS_FILE}, found ${own.length}`);
      continue;
    }
    if (JSON.stringify(own[0].command) !== JSON.stringify(["node", task.bundle])) {
      drift.push(`${service}: command is not ["node", "${task.bundle}"]`);
    }
  }
  for (const [service, fragments] of services) {
    for (const f of fragments) {
      const bundle = f.command?.find((p) => p.includes("dist/"));
      if (bundle !== undefined && (!bundles.has(bundle) || f.command?.length !== 2 || f.command[0] !== "node")) {
        drift.push(`${service}: ${f.file} runs unmodelled ${JSON.stringify(f.command)}`);
      }
    }
  }

  // I1.1 / I1.6 / I1.3 / I1.2 / I1.5 on the isolated services.
  for (const service of ISOLATED_SERVICES) {
    const t = byService.get(service);
    if (!t) {
      drift.push(`${service}: not a smoke-map worker`);
      continue;
    }
    const fragments = services.get(service) ?? [];
    for (const f of fragments) {
      if (f.loadsDotEnv) drift.push(`${service}: ${f.file} loads .env`);
      if (f.file !== WORKERS_FILE) drift.push(`${service}: also defined in ${f.file}`);
    }
    const env = mergedEnv(fragments);
    const expected = sortStrings(new Set([...Object.keys(t.task.env), ...COMPOSE_PASS_THROUGH[service]]));
    const actual = sortStrings(Object.keys(env));
    for (const k of expected) if (!actual.includes(k)) drift.push(`${service}: env ${k} missing`);
    for (const k of actual) if (!expected.includes(k)) drift.push(`${service}: env ${k} is not in the ECS set or the declared pass-throughs`);
    for (const [k, literal] of Object.entries(ctx.ecsLiterals[t.label])) {
      const state = env[k];
      if (!state || state.kind !== "value" || state.value !== literal) drift.push(`${service}: ${k} must be the literal ${literal}`);
    }
    if (env.DATABASE_URL?.kind !== "blank") drift.push(`${service}: DATABASE_URL must be blank`);

    const ownKey = ownDatabaseUrlKey(t.task);
    const passwordVar = ctx.passwordBinding[service][0];
    const required: Array<[string, string]> = [
      [ownKey, passwordVar],
      ...REQUIRED_INTERPOLATION_KEYS.filter((k) => k in t.task.env).map((k): [string, string] => [k, k]),
    ];
    for (const [key, variable] of required) {
      const state = env[key];
      const ref = state?.kind === "value" ? references(state.value).find((r) => r.name === variable) : undefined;
      if (!ref || ref.rest === null || !/^:\?.+/.test(ref.rest)) drift.push(`${service}: ${key} must use \${${variable}:?message}`);
    }
    const guarded = new Set(required.map(([, v]) => v));
    for (const [key, state] of Object.entries(env)) {
      if (state.kind !== "value") continue;
      for (const r of references(state.value)) {
        if (!guarded.has(r.name)) continue;
        if (r.rest === null || !/^:\?.+/.test(r.rest)) drift.push(`${service}: ${key} references ${r.name} without :?`);
      }
    }

    // The k8s pod's hardening (I2.5), as compose spells it.
    const own = fragments.find((f) => f.file === WORKERS_FILE);
    if (own?.readOnly !== true) drift.push(`${service}: read_only must be true`);
    if (JSON.stringify(own?.capDrop) !== JSON.stringify(["ALL"])) drift.push(`${service}: cap_drop must be ["ALL"]`);
    if (JSON.stringify(own?.securityOpt) !== JSON.stringify(["no-new-privileges:true"])) drift.push(`${service}: security_opt must be ["no-new-privileges:true"]`);

    const floor = ctx.stopTimeout[t.label];
    if (floor !== undefined) {
      const grace = fragments.find((f) => f.file === WORKERS_FILE)?.stopGraceSeconds;
      if (grace === undefined || grace < floor) drift.push(`${service}: stop_grace_period ${grace === undefined ? "unset" : `${grace}s`} is below the ECS stopTimeout ${floor}s`);
    }
  }

  // `:?` messages stay plain text for the compose-env-scan anchor regex.
  for (const [service, fragments] of services) {
    for (const f of fragments.filter((x) => x.file === WORKERS_FILE)) {
      for (const [key, state] of Object.entries(f.env)) {
        if (state.kind !== "value") continue;
        for (const r of references(state.value)) {
          if (r.rest !== null && /^:\?/.test(r.rest) && /[*&]/.test(r.rest)) drift.push(`${service}: ${key} has a :? message with * or &`);
        }
      }
    }
  }
  const forbidden = FORBIDDEN_OPTIONAL_INTERPOLATION.exec(workersText);
  if (forbidden) drift.push(`${WORKERS_FILE}: optional interpolation of a secret near "${forbidden[0]}"`);

  // I1.7: retention-gc gets DEPLOYMENT_ID by the same interpolation as the publisher, in the workers file only.
  const retention = tasks.find((t) => t.label === "retention_gc_worker");
  if (retention) {
    const frags = services.get(retention.service) ?? [];
    for (const f of frags) {
      const state = f.env.DEPLOYMENT_ID;
      if (f.file === WORKERS_FILE) {
        if (state?.kind !== "value" || state.value !== "${DEPLOYMENT_ID:-}") drift.push(`${retention.service}: DEPLOYMENT_ID must be \${DEPLOYMENT_ID:-} in ${f.file}`);
      } else if (state !== undefined) drift.push(`${retention.service}: ${f.file} must not set DEPLOYMENT_ID`);
    }
  }

  // I1.4: a service that loads .env anywhere blanks every withheld key (its own URL excepted).
  for (const [service, fragments] of services) {
    if (!fragments.some((f) => f.loadsDotEnv)) continue;
    // The isolated services are judged by I1.1, which reports the env_file itself.
    if (ISOLATED_SERVICES.includes(service)) continue;
    const t = byService.get(service);
    const ownKey = t ? ownDatabaseUrlKey(t.task) : undefined;
    for (const key of ctx.withheld) {
      for (const f of fragments) {
        const state = f.env[key];
        if (state === undefined || state.kind === "blank") continue;
        if (key === ownKey && state.kind === "value") continue;
        drift.push(`${service}: ${f.file} ${state.kind === "value" ? "gives" : "passes through"} withheld ${key}`);
      }
      if (key === ownKey) {
        if (!fragments.some((f) => f.env[key]?.kind === "value")) drift.push(`${service}: own URL ${key} has no value`);
      } else if (!fragments.some((f) => f.env[key]?.kind === "blank")) {
        drift.push(`${service}: withheld ${key} is not blanked`);
      }
    }
  }

  // A worker's own URL connects as the role its smoke-map URL names (P1).
  for (const { task, service } of tasks) {
    const ownKey = ownDatabaseUrlKey(task);
    for (const f of services.get(service) ?? []) {
      const state = f.env[ownKey];
      if (state?.kind !== "value") continue;
      let user: string;
      try {
        user = roleUserFromComposeUrl(state.value);
      } catch {
        drift.push(`${service}: ${ownKey} has no role user`);
        continue;
      }
      if (user !== ownRoleUser(task)) drift.push(`${service}: ${ownKey} connects as ${user}, the smoke map says ${ownRoleUser(task)}`);
    }
  }

  // A W key is referenced only by the services withheldHolders() names for it, in any
  // string of the service (environment, command, healthcheck, labels, ...), by any
  // interpolation form.
  const holders = withheldHolders(ctx.withheld, ctx.publisherOnly, ctx.passwordBinding);
  for (const file of sortStrings(Object.keys(model))) {
    const doc = model[file] as { services?: Record<string, unknown> };
    for (const [service, spec] of Object.entries(doc.services ?? {})) {
      for (const [field, value] of Object.entries(spec as Record<string, unknown>)) {
        for (const text of stringValues(value)) {
          for (const r of references(text)) {
            if (Object.hasOwn(holders, r.name) && !holders[r.name].includes(service)) {
              drift.push(`${service}: ${file} ${field} references withheld ${r.name}, which is not given to this service`);
            }
          }
        }
      }
    }
  }
  drift.push(...fileChannelDrift(model));
  return sortStrings(new Set(drift));
}

// ─── Compose file channels ──────────────────────────────────

/** A volume source with no path separator and no leading `.`/`~`: compose reads it as a named volume. */
const isNamedVolume = (source: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source);

/**
 * Every way `.env` could reach a service as a file, in every compose file but
 * the dev override: a bind source that is the project directory, an ancestor of
 * it or a `.env*` file; a named volume backed by such a bind; a referenced
 * top-level `secrets:`/`configs:` entry with such a `file:`. A form the model
 * does not cover (a variable in a source, a `~` source, a volume or secret
 * shape it does not know) is reported rather than skipped.
 */
function fileChannelDrift(model: ComposeModel): string[] {
  const drift: string[] = [];
  const docs = sortStrings(Object.keys(model)).map((file) => ({ file, doc: model[file] as Record<string, unknown> }));
  const topLevel = (kind: "volumes" | "secrets" | "configs"): Record<string, unknown> =>
    Object.assign({}, ...docs.map(({ doc }) => (isRecord(doc[kind]) ? doc[kind] : {})));
  const named = topLevel("volumes");

  for (const { file, doc } of docs) {
    if (file === DEV_OVERRIDE_FILE || !isRecord(doc.services)) continue;
    for (const [service, spec] of Object.entries(doc.services)) {
      if (!isRecord(spec)) continue;
      const at = (message: string) => drift.push(`${service}: ${file} ${message}`);
      /** A path source, as the service's file would resolve it. */
      const path = (source: string, via: string) => {
        if (source.includes("$") || source.startsWith("~")) return at(`${via} "${source}" is not modelled (variable or home path)`);
        const kind = envFileSourceKind(resolve(REPO_ROOT, source), REPO_ROOT);
        if (kind !== null) at(`holds .env by file mount: ${via} "${source}" is ${kind}`);
      };
      const volume = (name: string) => {
        const opts = isRecord(named[name]) && isRecord(named[name].driver_opts) ? named[name].driver_opts : undefined;
        if (typeof opts?.device === "string") path(opts.device, `the device of named volume ${name}`);
      };

      if (spec.volumes !== undefined && !Array.isArray(spec.volumes)) at("has an unmodelled volumes value");
      for (const v of Array.isArray(spec.volumes) ? spec.volumes : []) {
        if (typeof v === "string") {
          const source = v.split(":")[0];
          if (!v.includes(":")) continue; // an anonymous volume: a target only
          if (isNamedVolume(source)) volume(source);
          else path(source, "a bind source");
        } else if (isRecord(v) && typeof v.type === "string") {
          if (v.type === "bind") {
            if (typeof v.source === "string" && v.source !== "") path(v.source, "a bind source");
            else at("has a bind volume without a source");
          } else if (v.type === "volume") {
            if (typeof v.source === "string") volume(v.source);
          } else if (v.type !== "tmpfs" && v.type !== "image") at(`has a volume of unmodelled type ${v.type}`);
        } else at("has an unmodelled volume entry");
      }

      for (const kind of ["secrets", "configs"] as const) {
        if (spec[kind] !== undefined && !Array.isArray(spec[kind])) at(`has an unmodelled ${kind} value`);
        for (const ref of Array.isArray(spec[kind]) ? (spec[kind] as unknown[]) : []) {
          const name = typeof ref === "string" ? ref : isRecord(ref) ? ref.source : undefined;
          const entry = typeof name === "string" ? topLevel(kind)[name] : undefined;
          if (typeof name !== "string" || !isRecord(entry)) at(`references a ${kind} entry no compose file defines`);
          else if (typeof entry.file === "string") path(entry.file, `the file of ${kind} entry ${name}`);
          else if ("environment" in entry) at(`holds .env by file mount: ${kind} entry ${name} is filled from an environment variable`);
        }
      }
    }
  }
  return drift;
}

// ─── k8s normalisation ──────────────────────────────────────

type K8sInput = { files: string[]; docs: Record<string, unknown[]> }; // repo-relative paths under infra/k8s

type EnvEntry = { name: string; value?: unknown; from?: { kind: "secret" | "configMap"; name: string; key: string } };
type Deployment = {
  file: string;
  name: string;
  command: string[];
  image: unknown;
  env: EnvEntry[];
  hasEnvFrom: boolean;
  liveness: string[] | undefined;
  startup: string[] | undefined;
  replicas: unknown;
  strategyType: unknown;
  grace: number;
  serviceAccountName: unknown;
  podAutomount: unknown;
  podRunAsNonRoot: unknown;
  podRunAsUser: unknown;
  podRunAsGroup: unknown;
  container: { allowPrivilegeEscalation: unknown; readOnlyRootFilesystem: unknown; capsDrop: unknown };
  selector: Record<string, string>;
  labels: Record<string, string>;
  secretRefs: string[];
};

const POD_KEYS = new Set(["terminationGracePeriodSeconds", "serviceAccountName", "automountServiceAccountToken", "securityContext", "containers", "volumes"]);
const CONTAINER_KEYS = new Set(["name", "image", "command", "securityContext", "env", "envFrom", "resources", "livenessProbe", "readinessProbe", "startupProbe", "volumeMounts"]);
const PROBE_KEYS = new Set(["exec", "initialDelaySeconds", "periodSeconds", "failureThreshold"]);

/** Every Secret name a manifest refers to, by any of the ways a pod can read one. */
function secretReferences(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => secretReferences(n, out));
  else if (isRecord(node)) {
    for (const [k, v] of Object.entries(node)) {
      if ((k === "secretKeyRef" || k === "secretRef") && isRecord(v) && typeof v.name === "string") out.push(v.name);
      else if (k === "secret" && isRecord(v)) {
        const name = v.secretName ?? v.name;
        if (typeof name === "string") out.push(name);
      }
      secretReferences(v, out);
    }
  }
  return out;
}

function stringMap(where: string, v: unknown): Record<string, string> {
  if (!isRecord(v) || !Object.values(v).every((x) => typeof x === "string")) throw new Error(`${where}: unmodelled label map`);
  return v as Record<string, string>;
}

function probeCommand(where: string, v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw new Error(`${where}: probe is not a mapping`);
  for (const k of Object.keys(v)) if (!PROBE_KEYS.has(k)) throw new Error(`${where}: unmodelled probe key ${k}`);
  const cmd = isRecord(v.exec) ? v.exec.command : undefined;
  if (!Array.isArray(cmd) || !cmd.every((p) => typeof p === "string")) throw new Error(`${where}: probe must be an exec command`);
  return cmd as string[];
}

function normaliseDeployment(file: string, doc: Record<string, unknown>): Deployment {
  const name = isRecord(doc.metadata) && typeof doc.metadata.name === "string" ? doc.metadata.name : "<unnamed>";
  const where = `${file}: Deployment ${name}`;
  for (const k of Object.keys(doc)) if (!["apiVersion", "kind", "metadata", "spec"].includes(k)) throw new Error(`${where}: unmodelled key ${k}`);
  const spec = doc.spec;
  if (!isRecord(spec)) throw new Error(`${where}: no spec`);
  for (const k of Object.keys(spec)) if (!["replicas", "strategy", "selector", "template"].includes(k)) throw new Error(`${where}: unmodelled spec key ${k}`);
  const strategy = spec.strategy;
  if (strategy !== undefined && !isRecord(strategy)) throw new Error(`${where}: unmodelled strategy`);
  const selector = isRecord(spec.selector) ? spec.selector : {};
  for (const k of Object.keys(selector)) if (k !== "matchLabels") throw new Error(`${where}: unmodelled selector key ${k}`);
  const template = spec.template;
  if (!isRecord(template) || !isRecord(template.spec)) throw new Error(`${where}: no pod template`);
  const pod = template.spec;
  for (const k of Object.keys(pod)) if (!POD_KEYS.has(k)) throw new Error(`${where}: unmodelled pod key ${k}`);
  if (!Array.isArray(pod.containers) || pod.containers.length !== 1) throw new Error(`${where}: expected exactly one container`);
  const c = pod.containers[0];
  if (!isRecord(c)) throw new Error(`${where}: container is not a mapping`);
  for (const k of Object.keys(c)) if (!CONTAINER_KEYS.has(k)) throw new Error(`${where}: unmodelled container key ${k}`);
  if (!Array.isArray(c.command) || !c.command.every((p) => typeof p === "string")) throw new Error(`${where}: command must be an exec array`);

  const env: EnvEntry[] = [];
  for (const e of Array.isArray(c.env) ? c.env : []) {
    if (!isRecord(e) || typeof e.name !== "string") throw new Error(`${where}: unmodelled env entry`);
    if ("value" in e && "valueFrom" in e) throw new Error(`${where}: ${e.name} has both value and valueFrom`);
    if ("valueFrom" in e) {
      const vf = e.valueFrom;
      const secret = isRecord(vf) ? vf.secretKeyRef : undefined;
      const cm = isRecord(vf) ? vf.configMapKeyRef : undefined;
      const ref = secret ?? cm;
      if (!isRecord(vf) || Object.keys(vf).length !== 1 || !isRecord(ref) || typeof ref.name !== "string" || typeof ref.key !== "string") {
        throw new Error(`${where}: ${e.name} has an unmodelled valueFrom`);
      }
      env.push({ name: e.name, from: { kind: secret ? "secret" : "configMap", name: ref.name, key: ref.key } });
    } else {
      env.push({ name: e.name, value: e.value });
    }
  }
  const sec = isRecord(c.securityContext) ? c.securityContext : {};
  const podSec = isRecord(pod.securityContext) ? pod.securityContext : {};
  const caps = isRecord(sec.capabilities) ? sec.capabilities : {};
  const meta = template.metadata;
  return {
    file,
    name,
    command: c.command as string[],
    image: c.image,
    env,
    hasEnvFrom: c.envFrom !== undefined,
    liveness: probeCommand(`${where} livenessProbe`, c.livenessProbe),
    startup: probeCommand(`${where} startupProbe`, c.startupProbe),
    replicas: spec.replicas,
    strategyType: isRecord(strategy) ? strategy.type : undefined,
    grace: typeof pod.terminationGracePeriodSeconds === "number" ? pod.terminationGracePeriodSeconds : 30,
    serviceAccountName: pod.serviceAccountName,
    podAutomount: pod.automountServiceAccountToken,
    podRunAsNonRoot: podSec.runAsNonRoot,
    podRunAsUser: podSec.runAsUser,
    podRunAsGroup: podSec.runAsGroup,
    container: { allowPrivilegeEscalation: sec.allowPrivilegeEscalation, readOnlyRootFilesystem: sec.readOnlyRootFilesystem, capsDrop: caps.drop },
    selector: stringMap(where, selector.matchLabels ?? {}),
    labels: stringMap(where, isRecord(meta) ? meta.labels ?? {} : {}),
    secretRefs: secretReferences(doc),
  };
}

type K8sModel = { deployments: Deployment[]; serviceAccounts: Array<{ file: string; name: string; automount: unknown }>; nonYaml: string[] };

function k8sModel(input: K8sInput): K8sModel {
  const model: K8sModel = { deployments: [], serviceAccounts: [], nonYaml: [] };
  for (const file of sortStrings(input.files)) {
    if (!file.endsWith(".yaml")) {
      model.nonYaml.push(file);
      continue;
    }
    for (const doc of input.docs[file] ?? []) {
      if (doc === null || doc === undefined) continue;
      if (!isRecord(doc) || typeof doc.kind !== "string") throw new Error(`${file}: a document without a kind`);
      if (doc.kind === "Deployment") model.deployments.push(normaliseDeployment(file, doc));
      else if (doc.kind === "ServiceAccount") {
        const name = isRecord(doc.metadata) ? doc.metadata.name : undefined;
        if (typeof name !== "string") throw new Error(`${file}: a ServiceAccount without a name`);
        model.serviceAccounts.push({ file, name, automount: doc.automountServiceAccountToken });
      } else if (doc.kind === "Secret" || doc.kind === "ConfigMap") {
        if (JSON.stringify(doc).includes("dist/")) throw new Error(`${file}: ${doc.kind} names a dist/ bundle`);
      } else throw new Error(`${file}: unmodelled kind ${doc.kind}`);
    }
  }
  return model;
}

// ─── k8s invariants ─────────────────────────────────────────

/** The uid:gid of the docker smoke's `--user`, which the pod securityContext must equal. Unparseable throws. */
function smokeUser(args: readonly string[] = DOCKER_HARDENING_ARGS): { uid: number; gid: number } {
  const at = args.indexOf("--user");
  const m = at === -1 ? null : /^(\d+):(\d+)$/.exec(args[at + 1] ?? "");
  if (!m) throw new Error("DOCKER_HARDENING_ARGS has no parseable --user <uid>:<gid>");
  return { uid: Number(m[1]), gid: Number(m[2]) };
}

function k8sDrift(input: K8sInput, ctx: Ctx): string[] {
  const drift: string[] = [];
  const model = k8sModel(input);
  for (const f of model.nonYaml) drift.push(`${f}: not a .yaml file`);
  const user = smokeUser();
  const bundleToTask = new Map(Object.entries(ctx.smoke.tasks).map(([label, t]) => [t.bundle, { label, task: t }]));

  for (const [bundle, { task }] of bundleToTask) {
    const n = model.deployments.filter((d) => d.command[1] === bundle).length;
    if (n !== 1) drift.push(`${bundle}: expected exactly one Deployment, found ${n} (${workerServiceName(task)})`);
  }

  for (const d of model.deployments) {
    const hit = bundleToTask.get(d.command[1]);
    if (!hit || d.command.length !== 2 || d.command[0] !== "node") {
      drift.push(`${d.name}: runs unmodelled command ${JSON.stringify(d.command)}`);
      continue;
    }
    const { label, task } = hit;

    // I2.1
    const probe = [...d.command, "--validate-env-only"];
    if (JSON.stringify(d.liveness) !== JSON.stringify(probe)) drift.push(`${d.name}: livenessProbe must exec ${JSON.stringify(probe)}`);
    if (JSON.stringify(d.startup) !== JSON.stringify(probe)) drift.push(`${d.name}: startupProbe must exec ${JSON.stringify(probe)}`);

    // I2.2: the ECS env set, secrets by secretKeyRef, literals as strings.
    const wanted = Object.keys(task.env);
    const given = d.env.map((e) => e.name);
    for (const k of sortStrings(wanted)) if (!given.includes(k)) drift.push(`${d.name}: env ${k} missing`);
    for (const k of sortStrings(given)) if (!wanted.includes(k)) drift.push(`${d.name}: env ${k} is not in the ECS set`);
    if (d.hasEnvFrom) drift.push(`${d.name}: envFrom is not allowed`);
    for (const e of d.env) {
      if (!wanted.includes(e.name)) continue;
      const literal = ctx.ecsLiterals[label][e.name];
      if (ctx.ecsSecrets[label].includes(e.name)) {
        if (e.from?.kind !== "secret") drift.push(`${d.name}: ${e.name} must come from a secretKeyRef`);
      } else if (literal !== undefined) {
        if (e.value !== literal) drift.push(`${d.name}: ${e.name} must be the string ${JSON.stringify(literal)}`);
      } else if (e.from === undefined) drift.push(`${d.name}: ${e.name} must come from a ConfigMap or Secret`);
    }

    // I2.4
    if (ctx.stopBeforeStart.includes(label)) {
      if (d.replicas !== 1) drift.push(`${d.name}: replicas must be 1`);
      if (d.strategyType !== "Recreate") drift.push(`${d.name}: strategy.type must be Recreate`);
      const floor = ctx.stopTimeout[label];
      if (floor !== undefined && d.grace < floor) drift.push(`${d.name}: terminationGracePeriodSeconds ${d.grace} is below the ECS stopTimeout ${floor}`);
    }

    // I2.5
    if (d.podRunAsNonRoot !== true) drift.push(`${d.name}: pod runAsNonRoot must be true`);
    if (d.podRunAsUser !== user.uid || d.podRunAsGroup !== user.gid) {
      drift.push(`${d.name}: pod runAsUser:runAsGroup must be ${user.uid}:${user.gid}, the docker smoke's --user`);
    }
    if (d.container.readOnlyRootFilesystem !== true) drift.push(`${d.name}: readOnlyRootFilesystem must be true`);
    if (d.container.allowPrivilegeEscalation !== false) drift.push(`${d.name}: allowPrivilegeEscalation must be false`);
    if (JSON.stringify(d.container.capsDrop) !== JSON.stringify(["ALL"])) drift.push(`${d.name}: capabilities.drop must be ["ALL"]`);
    if (d.podAutomount !== false) drift.push(`${d.name}: pod automountServiceAccountToken must be false`);
    if (d.image !== IMAGE_PLACEHOLDER) drift.push(`${d.name}: image must be the ${IMAGE_PLACEHOLDER} placeholder`);

    // I2.6
    for (const [k, v] of Object.entries(d.selector)) {
      if (d.labels[k] !== v) drift.push(`${d.name}: selector ${k}=${v} is not in the template labels`);
    }
    if (d.serviceAccountName !== undefined) {
      const sa = model.serviceAccounts.find((s) => s.file === d.file && s.name === d.serviceAccountName);
      if (!sa) drift.push(`${d.name}: serviceAccountName ${String(d.serviceAccountName)} is not a ServiceAccount in ${d.file}`);
      else if (sa.automount !== false) drift.push(`${d.name}: ServiceAccount ${sa.name} automountServiceAccountToken must be false`);
    }
  }

  // I2.3 (repo hygiene): the Secret holding the signing key is read by no other workload.
  const holders = new Set(model.deployments.filter((d) => d.env.some((e) => SIGNING_ENV_NAMES.includes(e.name))).map((d) => d.name));
  const signingSecrets = new Set(
    model.deployments.flatMap((d) => d.env.filter((e) => SIGNING_ENV_NAMES.includes(e.name) && e.from?.kind === "secret").map((e) => e.from!.name)),
  );
  for (const d of model.deployments) {
    if (holders.has(d.name)) continue;
    for (const s of sortStrings(new Set(d.secretRefs))) if (signingSecrets.has(s)) drift.push(`${d.name}: references Secret ${s}, which holds the signing key`);
  }
  return sortStrings(new Set(drift));
}

// ─── Loading the real tree ──────────────────────────────────

const loadCompose = (await createComposeYamlLoader()) as (text: string) => unknown;
const loadK8sDocs = (text: string): unknown[] => loadAll(text, { schema: CORE_SCHEMA }) as unknown[];

function realComposeModel(): { model: ComposeModel; workersText: string } {
  const model: ComposeModel = {};
  for (const abs of findComposeFiles(REPO_ROOT)) {
    model[relative(REPO_ROOT, abs)] = loadCompose(readFileSync(abs, "utf8"));
  }
  return { model, workersText: readFileSync(join(REPO_ROOT, WORKERS_FILE), "utf8") };
}

function walk(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(REPO_ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

function realK8sInput(): K8sInput {
  const files = walk(K8S_DIR);
  const docs: Record<string, unknown[]> = {};
  for (const f of files) if (f.endsWith(".yaml")) docs[f] = loadK8sDocs(readFileSync(join(REPO_ROOT, f), "utf8"));
  return { files, docs };
}

/** A clone, edited, that must differ from the original — a mutation that changed nothing proves nothing. */
function mutated<T>(base: T, edit: (copy: T) => void): T {
  const copy = structuredClone(base);
  edit(copy);
  expect(JSON.stringify(copy)).not.toBe(JSON.stringify(base));
  return copy;
}

function withEcs(edit: (text: string) => string): TerraformConfig {
  const text = readFileSync(join(TERRAFORM_DIR, "ecs.tf"), "utf8");
  const edited = edit(text);
  expect(edited).not.toBe(text);
  return new TerraformConfig(TERRAFORM_DIR, { "ecs.tf": edited });
}

// ─── Tests ──────────────────────────────────────────────────

const tf = new TerraformConfig(TERRAFORM_DIR);
const ctx = buildCtx(tf);
const compose = realComposeModel();
const k8s = realK8sInput();

type ServiceSpec = { environment?: unknown; env_file?: unknown; stop_grace_period?: unknown; command?: unknown; [k: string]: unknown };
const svc = (model: ComposeModel, file: string, name: string): ServiceSpec =>
  ((model[file] as { services: Record<string, ServiceSpec> }).services[name]);
const asList = (s: ServiceSpec): string[] => s.environment as string[];
type ContainerDoc = {
  image: string;
  command: string[];
  args?: string[];
  env: Array<Record<string, unknown>>;
  envFrom?: unknown[];
  securityContext: { allowPrivilegeEscalation: boolean; readOnlyRootFilesystem: boolean; capabilities: { drop: string[] } };
  livenessProbe: { exec: { command: string[] } };
};
type DeploymentDoc = {
  spec: {
    replicas?: number;
    strategy?: { type: string };
    selector: { matchLabels: Record<string, string> };
    template: {
      spec: {
        terminationGracePeriodSeconds?: number;
        serviceAccountName?: string;
        automountServiceAccountToken?: boolean;
        securityContext: { runAsNonRoot: boolean; runAsUser?: number; runAsGroup?: number };
        containers: ContainerDoc[];
        volumes?: unknown[];
      };
    };
  };
};
const dep = (input: K8sInput, name: string): DeploymentDoc =>
  Object.values(input.docs)
    .flat()
    .find((d) => isRecord(d) && d.kind === "Deployment" && (d.metadata as { name: string }).name === name) as unknown as DeploymentDoc;
const container = (d: DeploymentDoc): ContainerDoc => d.spec.template.spec.containers[0];
const PUBLISHER = "audit-anchor-publisher";
const VERIFY = "audit-chain-verify-worker";
const K8S_PUBLISHER = `${K8S_DIR}/audit-anchor-publisher.yaml`;

describe("worker parity: the real tree", () => {
  it("has no compose drift", () => {
    expect(composeDrift(compose.model, ctx, compose.workersText)).toEqual([]);
  });

  it("has no k8s drift", () => {
    expect(k8sDrift(k8s, ctx)).toEqual([]);
  });

  it("covers the four workers of the smoke map", () => {
    expect(Object.keys(ctx.smoke.tasks).sort()).toEqual(["audit_anchor_publisher", "audit_chain_verify_worker", "audit_outbox_worker", "retention_gc_worker"]);
    expect(ISOLATED_SERVICES.map((s) => Object.values(ctx.smoke.tasks).some((t) => workerServiceName(t) === s))).toEqual([true, true]);
  });

  it("reads the stop timeout and the stop-before-start services from ecs.tf", () => {
    expect(ctx.stopTimeout).toEqual({ audit_anchor_publisher: 120 });
    expect(ctx.stopBeforeStart).toEqual(["audit_anchor_publisher"]);
    expect(ctx.ecsLiterals.audit_anchor_publisher).toEqual({ AUDIT_ANCHOR_PUBLISHER_ENABLED: "true" });
  });
});

describe("compose: I1.1 the isolated services load no .env", () => {
  for (const [name, form] of [
    ["string", ".env"],
    ["./.env", "./.env"],
    ["list", [".env"]],
    ["object", [{ path: ".env", required: false }]],
  ] as const) {
    it(`flags env_file ${name} on the publisher`, () => {
      const m = mutated(compose.model, (c) => {
        svc(c, WORKERS_FILE, PUBLISHER).env_file = form;
      });
      expect(composeDrift(m, ctx, compose.workersText)).toEqual([`${PUBLISHER}: ${WORKERS_FILE} loads .env`]);
    });
  }

  it("refuses an env_file other than .env", () => {
    const m = mutated(compose.model, (c) => {
      svc(c, WORKERS_FILE, VERIFY).env_file = "other.env";
    });
    expect(() => composeDrift(m, ctx, compose.workersText)).toThrow(/unmodelled env_file other\.env/);
  });
});

describe("compose: I1.2 secrets use only ${NAME:?message}", () => {
  const swap = (from: string, to: string) => (c: ComposeModel) => {
    const list = asList(svc(c, WORKERS_FILE, PUBLISHER));
    const i = list.findIndex((e) => e.startsWith(from));
    list[i] = list[i].replace(":?", to);
  };
  // The last column is the text-level hit of the forbidden optional-interpolation pattern, if the name is one it covers.
  for (const [label, key, operator, textHit] of [
    ["signing key with :-", "AUDIT_ANCHOR_SIGNING_KEY=", ":-", "SIGNING_KEY:-A"],
    ["tag secret with ?", "AUDIT_ANCHOR_TAG_SECRET=", "?", "TAG_SECRET?A"],
    ["DEPLOYMENT_ID with :-", "DEPLOYMENT_ID=", ":-", null],
    ["role URL password with :-", "AUDIT_ANCHOR_PUBLISHER_DATABASE_URL=", ":-", "_PASSWORD:-P"],
  ] as const) {
    it(`flags the ${label}`, () => {
      const name = key.slice(0, -1);
      const variable = name === "AUDIT_ANCHOR_PUBLISHER_DATABASE_URL" ? "PASSWD_ANCHOR_PUBLISHER_PASSWORD" : name;
      const m = mutated(compose.model, swap(key, operator));
      const text = compose.workersText.replace(`\${${variable}:?`, `\${${variable}${operator}`);
      expect(text).not.toBe(compose.workersText);
      expect(composeDrift(m, ctx, text)).toEqual(
        sortStrings([
          `${PUBLISHER}: ${name} must use \${${variable}:?message}`,
          `${PUBLISHER}: ${name} references ${variable} without :?`,
          ...(textHit === null ? [] : [`${WORKERS_FILE}: optional interpolation of a secret near "${textHit}"`]),
        ]),
      );
    });
  }

  it("flags a bare $NAME reference to the signing key", () => {
    const m = mutated(compose.model, (c) => {
      const list = asList(svc(c, WORKERS_FILE, PUBLISHER));
      list[list.findIndex((e) => e.startsWith("AUDIT_ANCHOR_SIGNING_KEY="))] = "AUDIT_ANCHOR_SIGNING_KEY=$AUDIT_ANCHOR_SIGNING_KEY";
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([
      `${PUBLISHER}: AUDIT_ANCHOR_SIGNING_KEY must use \${AUDIT_ANCHOR_SIGNING_KEY:?message}`,
      `${PUBLISHER}: AUDIT_ANCHOR_SIGNING_KEY references AUDIT_ANCHOR_SIGNING_KEY without :?`,
    ]);
  });

  it("flags a :? message holding * or &", () => {
    const m = mutated(compose.model, (c) => {
      const list = asList(svc(c, WORKERS_FILE, VERIFY));
      list[0] = list[0].replace("is required", "is *required*");
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([`${VERIFY}: AUDIT_CHAIN_VERIFY_DATABASE_URL has a :? message with * or &`]);
  });

  it("flags DATABASE_URL carried with a value, and allows both blank spellings", () => {
    const valued = mutated(compose.model, (c) => {
      asList(svc(c, WORKERS_FILE, VERIFY))[1] = "DATABASE_URL=postgresql://x";
    });
    expect(composeDrift(valued, ctx, compose.workersText)).toEqual([`${VERIFY}: DATABASE_URL must be blank`]);
    const asMap = mutated(compose.model, (c) => {
      const s = svc(c, WORKERS_FILE, VERIFY);
      s.environment = { AUDIT_CHAIN_VERIFY_DATABASE_URL: (s.environment as string[])[0].split("=").slice(1).join("="), DATABASE_URL: "" };
    });
    expect(composeDrift(asMap, ctx, compose.workersText)).toEqual([]);
  });

  it("flags the forbidden optional-interpolation pattern in the file text", () => {
    const text = `${compose.workersText}\n# X_PASSWORD:-y\n`;
    expect(composeDrift(compose.model, ctx, text)).toEqual([`${WORKERS_FILE}: optional interpolation of a secret near "_PASSWORD:-y"`]);
    expect(composeDrift(compose.model, ctx, `${compose.workersText}\n# X_PASSWORD:?y\n`)).toEqual([]);
  });
});

describe("compose: I1.3 env names", () => {
  it("flags GITHUB_TOKEN added to the publisher (the alias is excluded, not omitted)", () => {
    const m = mutated(compose.model, (c) => {
      asList(svc(c, WORKERS_FILE, PUBLISHER)).push("GITHUB_TOKEN=${GITHUB_TOKEN:-}");
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([`${PUBLISHER}: env GITHUB_TOKEN is not in the ECS set or the declared pass-throughs`]);
  });

  it("flags a missing ECS name on the publisher", () => {
    const missing = mutated(compose.model, (c) => {
      const list = asList(svc(c, WORKERS_FILE, PUBLISHER));
      list.splice(list.findIndex((e) => e.startsWith("AUDIT_ANCHOR_TAG_SECRET=")), 1);
    });
    expect(composeDrift(missing, ctx, compose.workersText)).toEqual([
      `${PUBLISHER}: AUDIT_ANCHOR_TAG_SECRET must use \${AUDIT_ANCHOR_TAG_SECRET:?message}`,
      `${PUBLISHER}: env AUDIT_ANCHOR_TAG_SECRET missing`,
    ]);
  });

  it("flags an extra name on the verify worker", () => {
    const extra = mutated(compose.model, (c) => {
      asList(svc(c, WORKERS_FILE, VERIFY)).push("EXTRA=1");
    });
    expect(composeDrift(extra, ctx, compose.workersText)).toEqual([`${VERIFY}: env EXTRA is not in the ECS set or the declared pass-throughs`]);
  });

  it("flags AUDIT_ANCHOR_PUBLISHER_ENABLED other than the ECS literal", () => {
    const m = mutated(compose.model, (c) => {
      const list = asList(svc(c, WORKERS_FILE, PUBLISHER));
      list[list.indexOf("AUDIT_ANCHOR_PUBLISHER_ENABLED=true")] = "AUDIT_ANCHOR_PUBLISHER_ENABLED=false";
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([`${PUBLISHER}: AUDIT_ANCHOR_PUBLISHER_ENABLED must be the literal true`]);
  });

  it("flags a worker URL rewritten to the superuser (P1)", () => {
    const m = mutated(compose.model, (c) => {
      const list = asList(svc(c, WORKERS_FILE, VERIFY));
      list[0] = list[0].replace("passwd_audit_chain_verifier:", "passwd_user:");
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([
      `${VERIFY}: AUDIT_CHAIN_VERIFY_DATABASE_URL connects as passwd_user, the smoke map says passwd_audit_chain_verifier`,
    ]);
  });
});

describe("compose: I1.4 services loading .env blank the withheld set", () => {
  it("flags a key left unblanked, passed through bare, and given a value", () => {
    const dropped = mutated(compose.model, (c) => {
      const list = asList(svc(c, "docker-compose.yml", "app"));
      list.splice(list.indexOf("AUDIT_ANCHOR_SIGNING_KEY="), 1);
    });
    expect(composeDrift(dropped, ctx, compose.workersText)).toEqual(["app: withheld AUDIT_ANCHOR_SIGNING_KEY is not blanked"]);

    const bare = mutated(compose.model, (c) => {
      const list = asList(svc(c, "docker-compose.yml", "app"));
      list[list.indexOf("SENTRY_AUTH_TOKEN=")] = "SENTRY_AUTH_TOKEN";
    });
    expect(composeDrift(bare, ctx, compose.workersText)).toEqual([
      "app: docker-compose.yml passes through withheld SENTRY_AUTH_TOKEN",
      "app: withheld SENTRY_AUTH_TOKEN is not blanked",
    ]);

    const valued = mutated(compose.model, (c) => {
      const list = asList(svc(c, WORKERS_FILE, "audit-outbox-worker"));
      list[list.indexOf("MIGRATION_DATABASE_URL=")] = "MIGRATION_DATABASE_URL=postgresql://passwd_user:x@db/x";
    });
    // The dev override still blanks it, so only the valued fragment is reported.
    expect(composeDrift(valued, ctx, compose.workersText)).toEqual([`audit-outbox-worker: ${WORKERS_FILE} gives withheld MIGRATION_DATABASE_URL`]);
  });

  it("judges by service name across files: a dev-override fragment cannot give back a withheld key", () => {
    const m = mutated(compose.model, (c) => {
      const list = asList(svc(c, "docker-compose.override.yml", "retention-gc-worker"));
      list[list.indexOf("GITHUB_TOKEN=")] = "GITHUB_TOKEN=x";
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual(["retention-gc-worker: docker-compose.override.yml gives withheld GITHUB_TOKEN"]);
  });

  it("allows the service's own URL with a value, and flags it blank", () => {
    const blank = mutated(compose.model, (c) => {
      for (const file of [WORKERS_FILE, "docker-compose.override.yml"]) {
        const s = svc(c, file, "retention-gc-worker");
        s.environment = asList(s).map((e) => (e.startsWith("RETENTION_GC_DATABASE_URL=") ? "RETENTION_GC_DATABASE_URL=" : e));
      }
    });
    expect(composeDrift(blank, ctx, compose.workersText)).toEqual(["retention-gc-worker: own URL RETENTION_GC_DATABASE_URL has no value"]);
  });

  it("allows the object-form env_file and the map-form environment", () => {
    const m = mutated(compose.model, (c) => {
      const s = svc(c, "docker-compose.yml", "app");
      s.env_file = [{ path: "./.env", required: true }];
      s.environment = Object.fromEntries(asList(s).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([]);
  });

  it("a new secret allowlist entry enters W and fails every service that does not blank it (W derivation)", () => {
    const inputs = realWithheldInputs();
    const withheld = deriveWithheldEnv({ ...inputs, allowlist: [...inputs.allowlist, { type: "literal", key: "NEW_PRINCIPAL_SECRET", secret: true }] });
    expect(withheld).toContain("NEW_PRINCIPAL_SECRET");
    expect(composeDrift(compose.model, { ...ctx, withheld }, compose.workersText)).toEqual([
      "app: withheld NEW_PRINCIPAL_SECRET is not blanked",
      "audit-outbox-worker: withheld NEW_PRINCIPAL_SECRET is not blanked",
      "retention-gc-worker: withheld NEW_PRINCIPAL_SECRET is not blanked",
    ]);
  });

  const NOT_GIVEN = "which is not given to this service";

  it("flags a publisher-only name and an unbound role password in another service's value", () => {
    const m = mutated(compose.model, (c) => {
      asList(svc(c, "docker-compose.yml", "app")).push("X=${AUDIT_ANCHOR_TAG_SECRET}");
      (svc(c, "docker-compose.yml", "jackson").environment as Record<string, string>).Y = "${PASSWD_APP_PASSWORD}";
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([
      `app: docker-compose.yml environment references withheld AUDIT_ANCHOR_TAG_SECRET, ${NOT_GIVEN}`,
      `jackson: docker-compose.yml environment references withheld PASSWD_APP_PASSWORD, ${NOT_GIVEN}`,
    ]);
  });

  it("flags another principal's DB URL forwarded under a new name, whichever the interpolation form", () => {
    for (const ref of ["${MIGRATION_DATABASE_URL}", "$MIGRATION_DATABASE_URL", "${MIGRATION_DATABASE_URL:-x}", "${MIGRATION_DATABASE_URL:?m}"]) {
      const m = mutated(compose.model, (c) => asList(svc(c, "docker-compose.yml", "app")).push(`ADMIN_DB_URL=${ref}`));
      expect(composeDrift(m, ctx, compose.workersText), ref).toEqual([
        `app: docker-compose.yml environment references withheld MIGRATION_DATABASE_URL, ${NOT_GIVEN}`,
      ]);
    }
  });

  it("flags a withheld reference in a command and in a healthcheck", () => {
    const m = mutated(compose.model, (c) => {
      svc(c, "docker-compose.yml", "app").command = ["sh", "-c", "echo ${SENTRY_AUTH_TOKEN}"];
      svc(c, "docker-compose.yml", "redis").healthcheck = { test: ["CMD-SHELL", "redis-cli -a ${AUDIT_ANCHOR_SIGNING_KEY} ping"] };
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([
      `app: docker-compose.yml command references withheld SENTRY_AUTH_TOKEN, ${NOT_GIVEN}`,
      `redis: docker-compose.yml healthcheck references withheld AUDIT_ANCHOR_SIGNING_KEY, ${NOT_GIVEN}`,
    ]);
  });

  it("allows jackson its API key and db every role password", () => {
    const m = mutated(compose.model, (c) => {
      (svc(c, "docker-compose.yml", "jackson").environment as Record<string, string>).Z = "${JACKSON_API_KEY}";
      for (const pw of ctx.passwordBinding.db) (svc(c, "docker-compose.yml", "db").environment as Record<string, string>)[`COPY_${pw}`] = `\${${pw}}`;
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([]);
  });

  it("flags JACKSON_API_KEY given to a service other than jackson", () => {
    const m = mutated(compose.model, (c) => asList(svc(c, "docker-compose.yml", "app")).push("K=${JACKSON_API_KEY}"));
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([`app: docker-compose.yml environment references withheld JACKSON_API_KEY, ${NOT_GIVEN}`]);
  });
});

describe("compose: the isolated services keep the k8s hardening", () => {
  const keys: Array<[string, (s: ServiceSpec) => void, string]> = [
    ["read_only", (s) => (s.read_only = false), "read_only must be true"],
    ["cap_drop", (s) => (s.cap_drop = ["NET_RAW"]), 'cap_drop must be ["ALL"]'],
    ["security_opt", (s) => delete s.security_opt, 'security_opt must be ["no-new-privileges:true"]'],
  ];
  for (const service of ISOLATED_SERVICES) {
    for (const [key, edit, message] of keys) {
      it(`flags ${key} changed on ${service}`, () => {
        const m = mutated(compose.model, (c) => edit(svc(c, WORKERS_FILE, service)));
        expect(composeDrift(m, ctx, compose.workersText)).toEqual([`${service}: ${message}`]);
      });
    }
  }

  it("allows the shipped hardening on both", () => {
    for (const service of ISOLATED_SERVICES) {
      const spec = svc(compose.model, WORKERS_FILE, service);
      expect([spec.read_only, spec.cap_drop, spec.security_opt]).toEqual([true, ["ALL"], ["no-new-privileges:true"]]);
    }
    expect(composeDrift(compose.model, ctx, compose.workersText)).toEqual([]);
  });
});

describe("compose: .env as a file reaches no service outside the dev override", () => {
  const MOUNT = "holds .env by file mount";
  const topLevel = (c: ComposeModel, file: string) => c[file] as Record<string, unknown>;

  it("flags a bind mount of the project directory, an ancestor and a .env file on app, in short and long syntax", () => {
    const cases: Array<[unknown, string]> = [
      [".:/x", `a bind source "." is the project directory`],
      ["./:/x:ro", `a bind source "./" is the project directory`],
      ["..:/x", `a bind source ".." is an ancestor of the project directory`],
      ["./.env:/x", `a bind source "./.env" is a .env file`],
      ["./infra/.env.production:/x", `a bind source "./infra/.env.production" is a .env file`],
      [{ type: "bind", source: ".", target: "/x" }, `a bind source "." is the project directory`],
    ];
    for (const [volume, kind] of cases) {
      const m = mutated(compose.model, (c) => {
        svc(c, "docker-compose.yml", "app").volumes = [volume];
      });
      expect(composeDrift(m, ctx, compose.workersText), JSON.stringify(volume)).toEqual([`app: docker-compose.yml ${MOUNT}: ${kind}`]);
    }
  });

  it("allows the mounts the stack ships: the db initdb directory and the fluent-bit config files", () => {
    expect(svc(compose.model, "docker-compose.yml", "db").volumes).toContain("./infra/postgres/initdb:/docker-entrypoint-initdb.d:ro");
    expect(svc(compose.model, "docker-compose.logging.yml", "fluent-bit").volumes).toEqual([
      "./infra/fluent-bit/fluent-bit.conf:/fluent-bit/etc/fluent-bit.conf:ro",
      "./infra/fluent-bit/parsers.conf:/fluent-bit/etc/parsers.conf:ro",
    ]);
    expect(composeDrift(compose.model, ctx, compose.workersText)).toEqual([]);
  });

  it("allows the dev override's project mount, and flags the same mount anywhere else", () => {
    expect(svc(compose.model, DEV_OVERRIDE_FILE, "audit-outbox-worker").volumes).toEqual([".:/app", "/app/node_modules"]);
    const prod = mutated(compose.model, (c) => {
      svc(c, WORKERS_FILE, "audit-outbox-worker").volumes = [".:/app"];
    });
    expect(composeDrift(prod, ctx, compose.workersText)).toEqual([`audit-outbox-worker: ${WORKERS_FILE} ${MOUNT}: a bind source "." is the project directory`]);
  });

  it("flags a top-level secrets entry whose file is .env, referenced by the outbox worker, in short and long syntax", () => {
    for (const ref of ["signing", { source: "signing", target: "signing" }]) {
      const m = mutated(compose.model, (c) => {
        topLevel(c, WORKERS_FILE).secrets = { signing: { file: "./.env" } };
        svc(c, WORKERS_FILE, "audit-outbox-worker").secrets = [ref];
      });
      expect(composeDrift(m, ctx, compose.workersText), JSON.stringify(ref)).toEqual([
        `audit-outbox-worker: ${WORKERS_FILE} ${MOUNT}: the file of secrets entry signing "./.env" is a .env file`,
      ]);
    }
  });

  it("allows a secrets entry whose file is elsewhere, and ignores an entry no service references", () => {
    const elsewhere = mutated(compose.model, (c) => {
      topLevel(c, WORKERS_FILE).secrets = { token: { file: "./secrets/token" } };
      svc(c, WORKERS_FILE, "audit-outbox-worker").secrets = ["token"];
    });
    expect(composeDrift(elsewhere, ctx, compose.workersText)).toEqual([]);
    const unreferenced = mutated(compose.model, (c) => {
      topLevel(c, WORKERS_FILE).secrets = { signing: { file: "./.env" } };
    });
    expect(composeDrift(unreferenced, ctx, compose.workersText)).toEqual([]);
  });

  it("flags a top-level configs entry whose file is the project directory", () => {
    const m = mutated(compose.model, (c) => {
      topLevel(c, WORKERS_FILE).configs = { cfg: { file: "." } };
      svc(c, WORKERS_FILE, "retention-gc-worker").configs = [{ source: "cfg" }];
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([
      `retention-gc-worker: ${WORKERS_FILE} ${MOUNT}: the file of configs entry cfg "." is the project directory`,
    ]);
    const elsewhere = mutated(m, (c) => {
      topLevel(c, WORKERS_FILE).configs = { cfg: { file: "./infra/fluent-bit/parsers.conf" } };
    });
    expect(composeDrift(elsewhere, ctx, compose.workersText)).toEqual([]);
  });

  it("flags a named volume backed by a bind of the project directory, and allows one backed elsewhere", () => {
    const back = (device: string) =>
      mutated(compose.model, (c) => {
        topLevel(c, "docker-compose.yml").volumes = { ...(topLevel(c, "docker-compose.yml").volumes as object), redis_data: { driver_opts: { type: "none", o: "bind", device } } };
      });
    expect(composeDrift(back("."), ctx, compose.workersText)).toEqual([
      `redis: docker-compose.yml ${MOUNT}: the device of named volume redis_data "." is the project directory`,
    ]);
    expect(composeDrift(back("./data/redis"), ctx, compose.workersText)).toEqual([]);
  });

  it("flags a volume or entry shape it does not model instead of skipping it", () => {
    const flagged = (edit: (c: ComposeModel) => void) => composeDrift(mutated(compose.model, edit), ctx, compose.workersText);
    expect(flagged((c) => (svc(c, "docker-compose.yml", "app").volumes = [42]))).toEqual(["app: docker-compose.yml has an unmodelled volume entry"]);
    expect(flagged((c) => (svc(c, "docker-compose.yml", "app").volumes = "./x:/x"))).toEqual(["app: docker-compose.yml has an unmodelled volumes value"]);
    expect(flagged((c) => (svc(c, "docker-compose.yml", "app").volumes = ["${DATA_DIR}:/x"]))).toEqual([
      'app: docker-compose.yml a bind source "${DATA_DIR}" is not modelled (variable or home path)',
    ]);
    expect(flagged((c) => (svc(c, "docker-compose.yml", "app").volumes = ["~/x:/x"]))).toEqual([
      'app: docker-compose.yml a bind source "~/x" is not modelled (variable or home path)',
    ]);
    expect(flagged((c) => (svc(c, "docker-compose.yml", "app").volumes = [{ type: "bind", target: "/x" }]))).toEqual(["app: docker-compose.yml has a bind volume without a source"]);
    expect(flagged((c) => (svc(c, "docker-compose.yml", "app").volumes = [{ type: "npipe", source: "a", target: "b" }]))).toEqual([
      "app: docker-compose.yml has a volume of unmodelled type npipe",
    ]);
    expect(flagged((c) => (svc(c, "docker-compose.yml", "app").secrets = ["nowhere"]))).toEqual(["app: docker-compose.yml references a secrets entry no compose file defines"]);
    expect(
      flagged((c) => {
        topLevel(c, WORKERS_FILE).secrets = { fromEnv: { environment: "AUDIT_ANCHOR_SIGNING_KEY" } };
        svc(c, WORKERS_FILE, "audit-outbox-worker").secrets = ["fromEnv"];
      }),
    ).toEqual([`audit-outbox-worker: ${WORKERS_FILE} ${MOUNT}: secrets entry fromEnv is filled from an environment variable`]);
  });

  it("allows an anonymous volume, a named volume, a tmpfs and an image mount", () => {
    const m = mutated(compose.model, (c) => {
      svc(c, "docker-compose.yml", "app").volumes = ["/cache", "redis_data:/data", { type: "tmpfs", target: "/tmp" }, { type: "image", source: "x", target: "/y" }];
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([]);
  });
});

describe("compose: I1.5 stop_grace_period", () => {
  it("flags a grace below the ECS stopTimeout, allows the floor in any Go duration spelling", () => {
    const set = (v: string) =>
      mutated(compose.model, (c) => {
        svc(c, WORKERS_FILE, PUBLISHER).stop_grace_period = v;
      });
    expect(composeDrift(set("119s"), ctx, compose.workersText)).toEqual([`${PUBLISHER}: stop_grace_period 119s is below the ECS stopTimeout 120s`]);
    for (const ok of ["2m", "2m0s", "3m"]) expect(composeDrift(set(ok), ctx, compose.workersText)).toEqual([]);
  });

  it("flags an unset grace", () => {
    const m = mutated(compose.model, (c) => {
      delete svc(c, WORKERS_FILE, PUBLISHER).stop_grace_period;
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([`${PUBLISHER}: stop_grace_period unset is below the ECS stopTimeout 120s`]);
  });

  it("follows the ECS stopTimeout rather than a constant", () => {
    const raised = buildCtx(withEcs((t) => t.replace("stopTimeout = 120", "stopTimeout = 240")));
    expect(raised.stopTimeout).toEqual({ audit_anchor_publisher: 240 });
    expect(composeDrift(compose.model, raised, compose.workersText)).toEqual([`${PUBLISHER}: stop_grace_period 120s is below the ECS stopTimeout 240s`]);
  });
});

describe("compose: I1.6 the isolated services are defined in one file only", () => {
  it("flags a second definition", () => {
    const m = mutated(compose.model, (c) => {
      (c["docker-compose.override.yml"] as { services: Record<string, unknown> }).services[VERIFY] = { restart: "no" };
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([`${VERIFY}: also defined in docker-compose.override.yml`]);
  });
});

describe("compose: I1.7 retention-gc gets DEPLOYMENT_ID by interpolation", () => {
  it("flags a missing or differently spelled value, and one set in the dev override", () => {
    const missing = mutated(compose.model, (c) => {
      const list = asList(svc(c, WORKERS_FILE, "retention-gc-worker"));
      list.splice(list.indexOf("DEPLOYMENT_ID=${DEPLOYMENT_ID:-}"), 1);
    });
    expect(composeDrift(missing, ctx, compose.workersText)).toEqual([`retention-gc-worker: DEPLOYMENT_ID must be \${DEPLOYMENT_ID:-} in ${WORKERS_FILE}`]);
    const dev = mutated(compose.model, (c) => {
      asList(svc(c, "docker-compose.override.yml", "retention-gc-worker")).push("DEPLOYMENT_ID=${DEPLOYMENT_ID:-}");
    });
    expect(composeDrift(dev, ctx, compose.workersText)).toEqual(["retention-gc-worker: docker-compose.override.yml must not set DEPLOYMENT_ID"]);
  });
});

describe("compose: the member set", () => {
  it("flags a worker service missing from the workers file", () => {
    const m = mutated(compose.model, (c) => {
      delete (c[WORKERS_FILE] as { services: Record<string, unknown> }).services["audit-outbox-worker"];
    });
    expect(composeDrift(m, ctx, compose.workersText)).toEqual([`audit-outbox-worker: expected exactly one definition in ${WORKERS_FILE}, found 0`]);
  });

  it("flags a service running a bundle the smoke map does not have, and refuses a string command", () => {
    const other = mutated(compose.model, (c) => {
      svc(c, WORKERS_FILE, VERIFY).command = ["node", "dist/other-worker.js"];
    });
    expect(composeDrift(other, ctx, compose.workersText)).toEqual([
      `${VERIFY}: command is not ["node", "dist/audit-chain-verify-worker.js"]`,
      `${VERIFY}: ${WORKERS_FILE} runs unmodelled ["node","dist/other-worker.js"]`,
    ]);
    const shell = mutated(compose.model, (c) => {
      svc(c, WORKERS_FILE, VERIFY).command = "node dist/audit-chain-verify-worker.js";
    });
    expect(() => composeDrift(shell, ctx, compose.workersText)).toThrow(/command must be an exec array/);
  });
});

describe("k8s: the model refuses what it does not cover", () => {
  it("refuses an unknown kind, an args key and a non-document", () => {
    const kind = mutated(k8s, (k) => {
      k.docs[`${K8S_DIR}/audit-chain-verify-worker.yaml`].push({ kind: "CronJob" });
    });
    expect(() => k8sDrift(kind, ctx)).toThrow(/unmodelled kind CronJob/);
    const args = mutated(k8s, (k) => {
      container(dep(k, VERIFY)).args = ["dist/x.js"];
    });
    expect(() => k8sDrift(args, ctx)).toThrow(/unmodelled container key args/);
    const bare = mutated(k8s, (k) => {
      k.docs[K8S_PUBLISHER].push("text");
    });
    expect(() => k8sDrift(bare, ctx)).toThrow(/a document without a kind/);
  });

  it("flags a non-.yaml file under infra/k8s", () => {
    const m = mutated(k8s, (k) => {
      k.files.push(`${K8S_DIR}/audit-anchor-publisher.yml`);
    });
    expect(k8sDrift(m, ctx)).toEqual([`${K8S_DIR}/audit-anchor-publisher.yml: not a .yaml file`]);
  });

  it("parses the publisher file as two documents", () => {
    expect(k8s.docs[K8S_PUBLISHER].map((d) => (d as { kind: string }).kind)).toEqual(["ServiceAccount", "Deployment"]);
  });
});

describe("k8s: I2.1 command and probes", () => {
  it("flags a shell-wrapped command, and a probe without --validate-env-only", () => {
    const cmd = mutated(k8s, (k) => {
      container(dep(k, VERIFY)).command = ["sh", "-c", "node dist/audit-chain-verify-worker.js"];
    });
    expect(k8sDrift(cmd, ctx)).toEqual([
      `${VERIFY}: runs unmodelled command ["sh","-c","node dist/audit-chain-verify-worker.js"]`,
      "dist/audit-chain-verify-worker.js: expected exactly one Deployment, found 0 (audit-chain-verify-worker)",
    ]);
    const probe = mutated(k8s, (k) => {
      container(dep(k, PUBLISHER)).livenessProbe.exec.command = ["node", "dist/audit-anchor-publisher.js"];
    });
    expect(k8sDrift(probe, ctx)).toEqual([`${PUBLISHER}: livenessProbe must exec ["node","dist/audit-anchor-publisher.js","--validate-env-only"]`]);
  });
});

describe("k8s: I2.2 env set", () => {
  it("flags a missing name, an extra name and DATABASE_URL", () => {
    const missing = mutated(k8s, (k) => {
      const env = container(dep(k, PUBLISHER)).env as Array<{ name: string }>;
      env.splice(env.findIndex((e) => e.name === "AUDIT_ANCHOR_TAG_SECRET"), 1);
    });
    expect(k8sDrift(missing, ctx)).toEqual([`${PUBLISHER}: env AUDIT_ANCHOR_TAG_SECRET missing`]);
    const extra = mutated(k8s, (k) => {
      container(dep(k, VERIFY)).env.push({ name: "DATABASE_URL", value: "x" });
    });
    expect(k8sDrift(extra, ctx)).toEqual([`${VERIFY}: env DATABASE_URL is not in the ECS set`]);
  });

  it("flags a secret given as a literal and envFrom", () => {
    const literal = mutated(k8s, (k) => {
      const e = (container(dep(k, PUBLISHER)).env as Array<Record<string, unknown>>).find((x) => x.name === "AUDIT_ANCHOR_SIGNING_KEY")!;
      delete e.valueFrom;
      e.value = "x";
    });
    expect(k8sDrift(literal, ctx)).toEqual([`${PUBLISHER}: AUDIT_ANCHOR_SIGNING_KEY must come from a secretKeyRef`]);
    const envFrom = mutated(k8s, (k) => {
      container(dep(k, VERIFY)).envFrom = [{ secretRef: { name: "x" } }];
    });
    expect(k8sDrift(envFrom, ctx)).toEqual([`${VERIFY}: envFrom is not allowed`]);
  });

  it("flags the literal ENABLED as a boolean or another string", () => {
    const set = (v: unknown) =>
      mutated(k8s, (k) => {
        (container(dep(k, PUBLISHER)).env as Array<Record<string, unknown>>).find((x) => x.name === "AUDIT_ANCHOR_PUBLISHER_ENABLED")!.value = v;
      });
    expect(k8sDrift(set(true), ctx)).toEqual([`${PUBLISHER}: AUDIT_ANCHOR_PUBLISHER_ENABLED must be the string "true"`]);
    expect(k8sDrift(set("yes"), ctx)).toEqual([`${PUBLISHER}: AUDIT_ANCHOR_PUBLISHER_ENABLED must be the string "true"`]);
  });

  it("flags a Terraform-derived value given as a literal", () => {
    const m = mutated(k8s, (k) => {
      const e = (container(dep(k, PUBLISHER)).env as Array<Record<string, unknown>>).find((x) => x.name === "AWS_REGION")!;
      delete e.valueFrom;
      e.value = "us-east-1";
    });
    expect(k8sDrift(m, ctx)).toEqual([`${PUBLISHER}: AWS_REGION must come from a ConfigMap or Secret`]);
  });
});

describe("k8s: I2.3 the signing-key Secret is read by the publisher only", () => {
  const SECRET = "audit-anchor-publisher";
  it("flags another workload reading it by secretKeyRef, envFrom or a volume", () => {
    const viaKey = mutated(k8s, (k) => {
      container(dep(k, VERIFY)).env.push({ name: "X", valueFrom: { secretKeyRef: { name: SECRET, key: "signing-key" } } });
    });
    expect(k8sDrift(viaKey, ctx)).toEqual([
      `${VERIFY}: env X is not in the ECS set`,
      `${VERIFY}: references Secret ${SECRET}, which holds the signing key`,
    ]);
    const viaEnvFrom = mutated(k8s, (k) => {
      container(dep(k, "audit-outbox-worker")).envFrom = [{ secretRef: { name: SECRET } }];
    });
    expect(k8sDrift(viaEnvFrom, ctx)).toEqual([
      "audit-outbox-worker: envFrom is not allowed",
      `audit-outbox-worker: references Secret ${SECRET}, which holds the signing key`,
    ]);
    const viaVolume = mutated(k8s, (k) => {
      dep(k, "retention-gc-worker").spec.template.spec.volumes = [{ name: "s", projected: { sources: [{ secret: { name: SECRET } }] } }];
    });
    expect(k8sDrift(viaVolume, ctx)).toEqual([`retention-gc-worker: references Secret ${SECRET}, which holds the signing key`]);
  });

  it("allows the publisher itself to reference it again", () => {
    const m = mutated(k8s, (k) => {
      dep(k, PUBLISHER).spec.template.spec.volumes = [{ name: "s", secret: { secretName: SECRET } }];
    });
    expect(k8sDrift(m, ctx)).toEqual([]);
  });
});

describe("k8s: I2.4 stop-before-start rollout", () => {
  it("flags the wrong replicas, strategy and grace on the publisher", () => {
    const m = mutated(k8s, (k) => {
      const d = dep(k, PUBLISHER);
      d.spec.replicas = 2;
      d.spec.strategy = { type: "RollingUpdate" };
      d.spec.template.spec.terminationGracePeriodSeconds = 30;
    });
    expect(k8sDrift(m, ctx)).toEqual([
      `${PUBLISHER}: replicas must be 1`,
      `${PUBLISHER}: strategy.type must be Recreate`,
      `${PUBLISHER}: terminationGracePeriodSeconds 30 is below the ECS stopTimeout 120`,
    ]);
  });

  it("allows a grace above the floor, and a rolling verify worker with no strategy", () => {
    const m = mutated(k8s, (k) => {
      dep(k, PUBLISHER).spec.template.spec.terminationGracePeriodSeconds = 300;
    });
    expect(k8sDrift(m, ctx)).toEqual([]);
    expect(dep(k8s, VERIFY).spec.strategy).toBeUndefined();
  });

  it("applies to whatever ECS stops before it starts", () => {
    const noLongerStopBeforeStart = buildCtx(withEcs((t) => t.replace("deployment_maximum_percent         = 100", "deployment_maximum_percent         = 200")));
    expect(noLongerStopBeforeStart.stopBeforeStart).toEqual([]);
    const outbox = buildCtx(
      withEcs((t) =>
        t.replace(
          /(resource "aws_ecs_service" "audit_outbox_worker" \{\n)/,
          "$1  deployment_maximum_percent         = 100\n  deployment_minimum_healthy_percent = 0\n",
        ),
      ),
    );
    expect(outbox.stopBeforeStart).toEqual(["audit_anchor_publisher", "audit_outbox_worker"]);
    expect(k8sDrift(k8s, outbox)).toEqual([
      "audit-outbox-worker: strategy.type must be Recreate",
    ]);
  });
});

describe("k8s: I2.5 hardening", () => {
  const cases: Array<[string, (d: DeploymentDoc) => void, string]> = [
    ["runAsNonRoot", (d) => (d.spec.template.spec.securityContext.runAsNonRoot = false), "pod runAsNonRoot must be true"],
    ["readOnlyRootFilesystem", (d) => (container(d).securityContext.readOnlyRootFilesystem = false), "readOnlyRootFilesystem must be true"],
    ["allowPrivilegeEscalation", (d) => (container(d).securityContext.allowPrivilegeEscalation = true), "allowPrivilegeEscalation must be false"],
    ["capabilities.drop", (d) => (container(d).securityContext.capabilities.drop = ["NET_RAW"]), 'capabilities.drop must be ["ALL"]'],
    ["pod automount", (d) => (d.spec.template.spec.automountServiceAccountToken = true), "pod automountServiceAccountToken must be false"],
    ["image placeholder", (d) => (container(d).image = "app:latest"), "image must be the REPLACE_WITH_IMMUTABLE_IMAGE_REF placeholder"],
  ];
  for (const [label, edit, message] of cases) {
    it(`flags ${label}`, () => {
      const m = mutated(k8s, (k) => edit(dep(k, VERIFY)));
      expect(k8sDrift(m, ctx)).toEqual([`${VERIFY}: ${message}`]);
    });
  }

  it("flags a pod uid:gid other than the docker smoke's --user, and allows the same pair", () => {
    expect(smokeUser()).toEqual({ uid: 1001, gid: 1001 });
    for (const d of [dep(k8s, VERIFY), dep(k8s, PUBLISHER)]) {
      expect(d.spec.template.spec.securityContext).toMatchObject({ runAsUser: 1001, runAsGroup: 1001 });
    }
    const uid = mutated(k8s, (k) => {
      (dep(k, VERIFY).spec.template.spec.securityContext as Record<string, unknown>).runAsUser = 2000;
    });
    expect(k8sDrift(uid, ctx)).toEqual([`${VERIFY}: pod runAsUser:runAsGroup must be 1001:1001, the docker smoke's --user`]);
    const gid = mutated(k8s, (k) => {
      (dep(k, VERIFY).spec.template.spec.securityContext as Record<string, unknown>).runAsGroup = 2000;
    });
    expect(k8sDrift(gid, ctx)).toEqual([`${VERIFY}: pod runAsUser:runAsGroup must be 1001:1001, the docker smoke's --user`]);
  });

  it("fails loudly when the smoke's --user cannot be read", () => {
    for (const args of [["--read-only"], ["--user"], ["--user", "root"], ["--user", "1001"], ["--user", "a:b"]]) {
      expect(() => smokeUser(args), args.join(" ")).toThrow("DOCKER_HARDENING_ARGS has no parseable --user <uid>:<gid>");
    }
    expect(smokeUser(["--user", "2000:3000"])).toEqual({ uid: 2000, gid: 3000 });
  });

  it("flags a ServiceAccount that mounts its token", () => {
    const m = mutated(k8s, (k) => {
      (k.docs[K8S_PUBLISHER][0] as Record<string, unknown>).automountServiceAccountToken = true;
    });
    expect(k8sDrift(m, ctx)).toEqual([`${PUBLISHER}: ServiceAccount ${PUBLISHER} automountServiceAccountToken must be false`]);
  });
});

describe("k8s: I2.6 selector and ServiceAccount", () => {
  it("flags a selector label the template lacks", () => {
    const m = mutated(k8s, (k) => {
      dep(k, VERIFY).spec.selector.matchLabels.tier = "worker";
    });
    expect(k8sDrift(m, ctx)).toEqual([`${VERIFY}: selector tier=worker is not in the template labels`]);
  });

  it("flags a ServiceAccount defined in another file, and one that does not exist", () => {
    const moved = mutated(k8s, (k) => {
      const sa = k.docs[K8S_PUBLISHER].shift();
      k.docs[`${K8S_DIR}/audit-chain-verify-worker.yaml`].push(sa);
    });
    expect(k8sDrift(moved, ctx)).toEqual([`${PUBLISHER}: serviceAccountName ${PUBLISHER} is not a ServiceAccount in ${K8S_PUBLISHER}`]);
    const absent = mutated(k8s, (k) => {
      dep(k, VERIFY).spec.template.spec.serviceAccountName = "nope";
    });
    expect(k8sDrift(absent, ctx)).toEqual([`${VERIFY}: serviceAccountName nope is not a ServiceAccount in ${K8S_DIR}/audit-chain-verify-worker.yaml`]);
  });
});

describe("k8s: the member set", () => {
  it("flags a worker without a Deployment and a Deployment running an unknown bundle", () => {
    const gone = mutated(k8s, (k) => {
      k.docs[`${K8S_DIR}/audit-chain-verify-worker.yaml`] = [];
    });
    expect(k8sDrift(gone, ctx)).toEqual(["dist/audit-chain-verify-worker.js: expected exactly one Deployment, found 0 (audit-chain-verify-worker)"]);
    const other = mutated(k8s, (k) => {
      dep(k, "audit-outbox-worker").spec.template.spec.containers[0].command = ["node", "dist/other-worker.js"];
    });
    expect(k8sDrift(other, ctx)).toEqual([
      "audit-outbox-worker: runs unmodelled command [\"node\",\"dist/other-worker.js\"]",
      "dist/audit-outbox-worker.js: expected exactly one Deployment, found 0 (audit-outbox-worker)",
    ]);
  });
});

// ─── C4: the CI filters reach these files ───────────────────

describe("C4: CI reaches the deployment files", () => {
  const ciDoc = load(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: { changes: { steps: Array<{ id?: string; with?: { filters?: string } }> } };
  };
  const filters = load(ciDoc.jobs.changes.steps.find((s) => s.id === "filter")!.with!.filters!) as Record<string, string[]>;
  const appPaths = /^\s*local app_paths='(.+)'$/m.exec(readFileSync(join(REPO_ROOT, "scripts/pre-pr.sh"), "utf8"))?.[1];
  const reached = [...k8s.files, WORKERS_FILE];

  const reachesAll = (globs: string[], files: string[]): string[] => {
    const match = picomatch(globs, { dot: true });
    return files.filter((f) => !match(f));
  };
  const pathsMiss = (pattern: string, files: string[]): string[] => files.filter((f) => !new RegExp(pattern).test(f));

  it("has deployment files to reach", () => {
    expect(reached.length).toBeGreaterThan(1);
    expect(appPaths).toBeDefined();
  });

  it("ci.yml's app filter matches every file under infra/k8s/ and the workers overlay", () => {
    expect(reachesAll(filters.app, reached)).toEqual([]);
  });

  it("pre-pr.sh's app_paths matches the same files, and infra/terraform/", () => {
    expect(pathsMiss(appPaths!, [...reached, "infra/terraform/ecs.tf"])).toEqual([]);
  });

  it("the filters are not catch-alls", () => {
    expect(reachesAll(filters.app, ["ios/project.yml"])).toEqual(["ios/project.yml"]);
    expect(pathsMiss(appPaths!, ["ios/project.yml"])).toEqual(["ios/project.yml"]);
  });

  it("fails when infra/k8s/ is dropped from either filter", () => {
    expect(reachesAll(filters.app.filter((g) => g !== "infra/k8s/**"), k8s.files)).toEqual(k8s.files);
    const pruned = appPaths!.replace("infra/k8s/|", "");
    expect(pruned).not.toBe(appPaths);
    expect(pathsMiss(pruned, k8s.files)).toEqual(k8s.files);
  });
});
