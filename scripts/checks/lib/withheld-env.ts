/**
 * The withheld env set W and the role pins that go with it — derived once, from
 * the repo's own sources, so the vitest parity test, the compose parity test and
 * the compose render check read the same member set instead of each keeping a list.
 *
 * W is what a service that loads `.env` must hold as "" (docker-compose blanks
 * it), because `.env` carries it for some other principal:
 *   (a) every scripts/env-allowlist.ts entry with `secret: true`;
 *   (b) envObject's other `*_DATABASE_URL` keys (every principal's URL but the app's);
 *   (c) what the ECS publisher task receives as `secrets` and the ECS app task
 *       does not, minus (b) and DEPLOYMENT_ID (the publisher and retention-gc
 *       share it); plus the GitHub token under both names from-env.ts reads, and
 *       the publisher-only AWS pass-throughs (a region is not a credential, so
 *       it is listed by name rather than by `secret: true`).
 *
 * Everything below is pure: inputs in, values or drift lists out. The `real*`
 * readers are the only functions that touch the tree.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ALLOWLIST } from "../../env-allowlist";
import { ROLES } from "../../bootstrap-rds-roles.mjs";
import { envObject } from "@/lib/env-schema";
import { TerraformConfig, TERRAFORM_DIR, plain } from "./hcl-subset";

const REPO_ROOT = resolve(__dirname, "../../..");
export const SMOKE_MAP_PATH = join(REPO_ROOT, "scripts/checks/worker-bundle-smoke.json");
export const DB_GRANTS_MANIFEST_PATH = join(REPO_ROOT, "scripts/checks/db-grants-manifest.json");

/**
 * Names only the publisher may hold that no ECS `secrets` list gives it:
 * from-env.ts reads the GitHub token under both, and docker-compose.workers.yml
 * maps the AUDIT_ANCHOR_AWS_* names to the SDK's own names for the publisher.
 */
export const WITHHELD_PASS_THROUGH_NAMES = [
  "AUDIT_ANCHOR_DESTINATION_GH_TOKEN",
  "GITHUB_TOKEN",
  "AUDIT_ANCHOR_AWS_ACCESS_KEY_ID",
  "AUDIT_ANCHOR_AWS_SECRET_ACCESS_KEY",
  "AUDIT_ANCHOR_AWS_REGION",
] as const;

/** The ECS task definitions whose `secrets` split (c) is read from. */
const ECS_APP_TASK = "app";
const ECS_PUBLISHER_TASK = "audit_anchor_publisher";

/** The one name the publisher and retention-gc both hold. */
export const SHARED_PUBLISHER_NAME = "DEPLOYMENT_ID";

export const isDatabaseUrlKey = (k: string) => /_DATABASE_URL$/.test(k);
const isOtherDatabaseUrlKey = (k: string) => isDatabaseUrlKey(k) && k !== "DATABASE_URL";

type AllowlistLike = ReadonlyArray<{ type: string; key?: string; secret?: boolean }>;

export type WithheldInputs = {
  allowlist: AllowlistLike;
  envObjectKeys: readonly string[];
  /** Names the ECS publisher task receives as `secrets`. */
  publisherSecrets: readonly string[];
  /** Names the ECS app task receives as `secrets`. */
  appSecrets: readonly string[];
};

// ─── ECS secrets ────────────────────────────────────────────

/** The container definitions of the task definition `task`. */
export function ecsContainerDefinitions(tf: TerraformConfig, task: string): unknown[] {
  const defs = plain(tf.attr(tf.resource("aws_ecs_task_definition", task), "container_definitions"));
  if (!Array.isArray(defs)) throw new Error(`${task}: container_definitions is not a list`);
  return defs;
}

/** The `secrets` names across every container of the task definition `task`. */
export function ecsSecretNames(tf: TerraformConfig, task: string): string[] {
  const names: string[] = [];
  for (const c of ecsContainerDefinitions(tf, task)) {
    const secrets = (c as { secrets?: unknown }).secrets;
    if (secrets === undefined) continue;
    if (!Array.isArray(secrets)) throw new Error(`${task}: secrets is not a list`);
    for (const s of secrets) {
      const name = (s as { name?: unknown }).name;
      if (typeof name !== "string") throw new Error(`${task}: unmodelled secret entry`);
      names.push(name);
    }
  }
  return names;
}

export function realWithheldInputs(): WithheldInputs {
  const tf = new TerraformConfig(TERRAFORM_DIR);
  return {
    allowlist: ALLOWLIST,
    envObjectKeys: Object.keys(envObject.shape),
    publisherSecrets: ecsSecretNames(tf, ECS_PUBLISHER_TASK),
    appSecrets: ecsSecretNames(tf, ECS_APP_TASK),
  };
}

// ─── W ──────────────────────────────────────────────────────

/** Part (c) of W, sorted: the names only the publisher may hold. */
export function derivePublisherOnlyEnv(inputs: WithheldInputs = realWithheldInputs()): string[] {
  const otherDbUrls = inputs.envObjectKeys.filter(isOtherDatabaseUrlKey);
  const appSecrets = new Set(inputs.appSecrets);
  const names = new Set<string>();
  for (const name of inputs.publisherSecrets) {
    if (!appSecrets.has(name) && !otherDbUrls.includes(name) && name !== SHARED_PUBLISHER_NAME) names.add(name);
  }
  for (const name of WITHHELD_PASS_THROUGH_NAMES) names.add(name);
  return [...names].sort();
}

/** W, sorted. */
export function deriveWithheldEnv(inputs: WithheldInputs = realWithheldInputs()): string[] {
  const w = new Set<string>();
  for (const e of inputs.allowlist) {
    if (e.type === "literal" && e.secret === true && e.key !== undefined) w.add(e.key);
  }
  for (const k of inputs.envObjectKeys) {
    if (isOtherDatabaseUrlKey(k)) w.add(k);
  }
  for (const name of derivePublisherOnlyEnv(inputs)) w.add(name);
  return [...w].sort();
}

/** The W keys that are envObject fields: what APP_WITHHELD_ENV_KEYS must equal. */
export function withheldEnvObjectKeys(withheld: readonly string[], envObjectKeys: readonly string[]): string[] {
  const fields = new Set(envObjectKeys);
  return withheld.filter((k) => fields.has(k)).sort();
}

// ─── Smoke map: each worker's own URL and role ──────────────

export type SmokeTask = { bundle: string; env: Record<string, string>; markers: string[]; forbiddenInputs: string[] };
export type SmokeMap = { tasks: Record<string, SmokeTask> };

export function readSmokeMap(path: string = SMOKE_MAP_PATH): SmokeMap {
  return JSON.parse(readFileSync(path, "utf8")) as SmokeMap;
}

/**
 * The user of a compose-written Postgres URL. The raw text may hold `${…:?…}`,
 * which `new URL()` misparses, so the user is read with an anchored pattern.
 */
export function roleUserFromComposeUrl(raw: string): string {
  const m = /^postgresql:\/\/([^:@/]+):/.exec(raw);
  if (!m) throw new Error("no role user in a postgresql:// URL");
  return m[1];
}

/** The task's single env key ending `_DATABASE_URL`. */
export function ownDatabaseUrlKey(task: SmokeTask): string {
  const keys = Object.keys(task.env).filter(isDatabaseUrlKey);
  if (keys.length !== 1) throw new Error(`${task.bundle}: expected one *_DATABASE_URL key, found ${keys.length}`);
  return keys[0];
}

/** The role the task connects as: the user in its smoke-map URL. */
export function ownRoleUser(task: SmokeTask): string {
  return roleUserFromComposeUrl(task.env[ownDatabaseUrlKey(task)]);
}

/** The compose service name of a task: its bundle's basename (`dist/<name>.js`). */
export function workerServiceName(task: SmokeTask): string {
  const m = /^dist\/([A-Za-z0-9_.-]+)\.js$/.exec(task.bundle);
  if (!m) throw new Error(`unmodelled bundle path ${task.bundle}`);
  return m[1];
}

// ─── Role pins ──────────────────────────────────────────────

/** The pg_roles attributes a worker role must have, as db-grants-manifest.json ROLEATTR rows. */
const REQUIRED_ROLE_ATTRS = [
  ["rolsuper", "false"],
  ["rolbypassrls", "false"],
  ["rolcanlogin", "true"],
] as const;

export type SmokeMapRoleInputs = {
  smoke: SmokeMap;
  /** The `grants` rows of db-grants-manifest.json. */
  manifestGrants: readonly string[];
  /** The raw DATABASE_URL the app service gets in docker-compose.yml. */
  appDatabaseUrl: string;
};

/**
 * Every way the smoke map's worker roles fall short of least privilege: each
 * needs all three ROLEATTR rows in the manifest (an absent row fails), the
 * users are pairwise distinct, and none is the app's role.
 */
export function smokeMapRoleDrift(input: SmokeMapRoleInputs): string[] {
  const drift: string[] = [];
  const grants = new Set(input.manifestGrants);

  let appUser: string | null = null;
  try {
    appUser = roleUserFromComposeUrl(input.appDatabaseUrl);
  } catch {
    drift.push("app DATABASE_URL: no role user could be read");
  }

  const users: Array<[string, string]> = [];
  for (const [name, task] of Object.entries(input.smoke.tasks)) {
    let user: string;
    try {
      user = ownRoleUser(task);
    } catch {
      drift.push(`${name}: no role user could be read from its smoke-map URL`);
      continue;
    }
    users.push([name, user]);
    for (const [attr, value] of REQUIRED_ROLE_ATTRS) {
      if (!grants.has(`ROLEATTR:${user}\t${attr}\t${value}`)) {
        drift.push(`${name}: role ${user} lacks manifest row ROLEATTR ${attr}=${value}`);
      }
    }
    if (user === appUser) drift.push(`${name}: role ${user} is the app DATABASE_URL role`);
  }
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      if (users[i][1] === users[j][1]) drift.push(`${users[i][0]} and ${users[j][0]} share role ${users[i][1]}`);
    }
  }
  return drift;
}

/** The app service's DATABASE_URL from a parsed docker-compose.yml (list or map `environment`). */
export function appDatabaseUrlFromCompose(doc: unknown): string {
  const env = (doc as { services?: { app?: { environment?: unknown } } })?.services?.app?.environment;
  if (Array.isArray(env)) {
    const entry = env.find((e) => typeof e === "string" && e.startsWith("DATABASE_URL="));
    if (typeof entry === "string") return entry.slice("DATABASE_URL=".length);
  } else if (env !== null && typeof env === "object") {
    const value = (env as Record<string, unknown>).DATABASE_URL;
    if (typeof value === "string") return value;
  }
  throw new Error("services.app has no DATABASE_URL in docker-compose.yml");
}

export function realSmokeMapRoleInputs(appCompose: unknown): SmokeMapRoleInputs {
  const manifest = JSON.parse(readFileSync(DB_GRANTS_MANIFEST_PATH, "utf8")) as { grants: string[] };
  return {
    smoke: readSmokeMap(),
    manifestGrants: manifest.grants,
    appDatabaseUrl: appDatabaseUrlFromCompose(appCompose),
  };
}

/** Throws with the drift list when the smoke map's roles are not least-privilege. */
export function assertSmokeMapRolesLeastPrivilege(input: SmokeMapRoleInputs): void {
  const drift = smokeMapRoleDrift(input);
  if (drift.length > 0) throw new Error(`smoke-map roles: ${drift.join("; ")}`);
}

// ─── Role passwords per service ─────────────────────────────

export type RolePasswordInputs = {
  smoke: SmokeMap;
  roles: ReadonlyArray<{ name: string; pwEnv: string }>;
  allowlist: AllowlistLike;
};

/**
 * The role-password variables each service's values may contain (service →
 * sorted names). The worker services are derived: the role is the user in the
 * worker's smoke-map URL, its password variable the `pwEnv` the RDS bootstrap
 * (scripts/bootstrap-rds-roles.mjs) gives that role. A worker whose user the
 * bootstrap does not know throws. `db` creates every role, so it holds every
 * PASSWD_* variable.
 */
export function rolePasswordBinding(input: RolePasswordInputs): Record<string, string[]> {
  const table: Record<string, string[]> = {
    app: ["PASSWD_APP_PASSWORD"],
    jackson: ["PASSWD_JACKSON_PASSWORD"],
    migrate: ["PASSWD_SUPERUSER_PASSWORD"],
    db: input.allowlist
      .filter((e) => e.type === "literal" && e.key !== undefined && e.key.startsWith("PASSWD_"))
      .map((e) => e.key as string)
      .sort(),
  };
  for (const task of Object.values(input.smoke.tasks)) {
    const user = ownRoleUser(task);
    const role = input.roles.find((r) => r.name === user);
    if (!role) throw new Error(`${workerServiceName(task)}: role ${user} has no password variable in the bootstrap's ROLES`);
    table[workerServiceName(task)] = [role.pwEnv];
  }
  return table;
}

export function realRolePasswordInputs(): RolePasswordInputs {
  return { smoke: readSmokeMap(), roles: ROLES, allowlist: ALLOWLIST };
}

// ─── Who may hold each W key ────────────────────────────────

/** The compose services that legitimately receive a W key by name. */
export const PUBLISHER_SERVICE = "audit-anchor-publisher";
export const JACKSON_SERVICE = "jackson";
/** The one W key a non-worker service receives that is not a role password: the container reads it as JACKSON_API_KEYS. */
const JACKSON_API_KEY = "JACKSON_API_KEY";

/**
 * W key → the compose services whose values may contain it; the one table the
 * parity test and the render check both adjudicate against. A role password goes
 * to the services bound to its role; a publisher-only key to the publisher;
 * JACKSON_API_KEY to jackson. Every other key (the other principals' URLs,
 * SENTRY_AUTH_TOKEN, ...) goes to no service: compose builds each URL from its
 * password and never forwards the `.env` URL, so a value of one in any service
 * is a leak.
 */
export function withheldHolders(
  withheld: readonly string[],
  publisherOnly: readonly string[],
  binding: Record<string, readonly string[]>,
): Record<string, readonly string[]> {
  const table: Record<string, readonly string[]> = {};
  for (const key of withheld) {
    if (publisherOnly.includes(key)) table[key] = [PUBLISHER_SERVICE];
    else if (key === JACKSON_API_KEY) table[key] = [JACKSON_SERVICE];
    else table[key] = Object.entries(binding).filter(([, vars]) => vars.includes(key)).map(([service]) => service).sort();
  }
  return table;
}
