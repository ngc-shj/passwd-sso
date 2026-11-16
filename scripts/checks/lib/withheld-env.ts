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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, posix, relative, resolve } from "node:path";
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

// ─── File channels ──────────────────────────────────────────

/** The one compose file whose `.:/app` mounts are the dev shape, not a file channel; every file-channel and service-key judgement skips it. */
export const DEV_OVERRIDE_FILE = "docker-compose.override.yml";

export type FileChannelEntry = {
  path: string;
  /** The only compose services that may bind this path. */
  services: readonly string[];
  /** True when the mount must be read-only. */
  readOnly: boolean;
  reason: string;
};

/**
 * The host paths a container may receive as a file outside the dev override,
 * repo-relative, each with the services that may mount it, whether the mount
 * must be read-only, and why. A default-deny list: a source that is not exactly
 * one of these (resolved against the project root) is refused, whatever it
 * spells — a path, a `~`, an absolute path, a symlink, `.` — and so is a listed
 * path from a service not named, or without `:ro` where `readOnly` is set.
 * `fileChannelAllowlistDrift` requires each entry to exist, to be free of
 * symlinks, to avoid a `.env*` basename and to be referenced by a production
 * compose file.
 *
 * sentinel.conf is read-only because the sentinel services never write it:
 * Redis Sentinel rewrites its config at runtime, so docker-compose.ha.yml's
 * entrypoint copies the template to /tmp/sentinel.conf and runs on the copy.
 */
export const FILE_CHANNEL_ALLOWLIST: ReadonlyArray<FileChannelEntry> = [
  { path: "infra/postgres/initdb", services: ["db"], readOnly: true, reason: "db runs these init scripts once, on an empty data directory" },
  { path: "infra/fluent-bit/fluent-bit.conf", services: ["fluent-bit"], readOnly: true, reason: "fluent-bit's main configuration (docker-compose.logging.yml)" },
  { path: "infra/fluent-bit/parsers.conf", services: ["fluent-bit"], readOnly: true, reason: "fluent-bit's parsers configuration (docker-compose.logging.yml)" },
  {
    path: "infra/redis/sentinel.conf",
    services: ["sentinel-1", "sentinel-2", "sentinel-3"],
    readOnly: true,
    reason: "the sentinel template the redis-sentinel services copy to /tmp before running on the copy (docker-compose.ha.yml), so the template is never written",
  },
];

const stripTrailingSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/**
 * The allowlist entry `source`, a host path as compose renders it (or as the
 * caller resolved it against the project root), is exactly `<projectRoot>/<its
 * path>` of, both in one form. A relative `source` is never resolved here, so
 * against a real (absolute) root it is refused rather than resolved: whether
 * compose resolves a relative `driver_opts.device` has varied, and
 * `driver_opts` is refused outright anyway.
 */
export function allowlistedFileEntry<E extends { path: string }>(
  source: string,
  projectRoot: string,
  allowlist: ReadonlyArray<E> = FILE_CHANNEL_ALLOWLIST as unknown as ReadonlyArray<E>,
): E | undefined {
  const s = stripTrailingSlash(posix.normalize(source));
  const root = stripTrailingSlash(posix.normalize(projectRoot));
  return allowlist.find((e) => s === posix.join(root, e.path));
}

export function isAllowlistedFileSource(
  source: string,
  projectRoot: string,
  allowlist: ReadonlyArray<{ path: string }> = FILE_CHANNEL_ALLOWLIST,
): boolean {
  return allowlistedFileEntry(source, projectRoot, allowlist) !== undefined;
}

/**
 * Why `service` may not bind `source` (`isReadOnly`: the mount says so), or
 * null: the path must be an allowlist entry, the service one that entry names,
 * and the mount read-only where the entry requires it.
 */
export function bindSourceProblem(
  source: string,
  projectRoot: string,
  service: string,
  isReadOnly: boolean,
  allowlist: ReadonlyArray<FileChannelEntry> = FILE_CHANNEL_ALLOWLIST,
): string | null {
  const entry = allowlistedFileEntry(source, projectRoot, allowlist);
  if (entry === undefined) return "is not allowlisted";
  if (!entry.services.includes(service)) return "is not allowlisted for this service";
  if (entry.readOnly && !isReadOnly) return "is allowlisted read-only and is mounted writable";
  return null;
}

/** Whether a short-syntax volume's mode (`src:target:ro`, `:ro,z`) says read-only. */
export function shortVolumeIsReadOnly(volume: string): boolean {
  return (volume.split(":")[2] ?? "").split(",").includes("ro");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Every way FILE_CHANNEL_ALLOWLIST itself falls short, against the compose
 * files under `root` (`model`: file name → parsed document; the dev override is
 * not a production file): an entry that is not a plain repo-relative path, that
 * is missing, that is or sits under a symlink (the bind check is lexical, so a
 * link would let an allowlisted name point at `.env`), whose basename starts
 * `.env`, or that no production compose file mounts (a stale entry). Every
 * failure is named; none is skipped.
 */
export function fileChannelAllowlistDrift(
  model: Record<string, unknown>,
  root: string,
  allowlist: ReadonlyArray<{ path: string }> = FILE_CHANNEL_ALLOWLIST,
): string[] {
  const drift: string[] = [];
  const mounted = new Set<string>();
  for (const [file, doc] of Object.entries(model)) {
    if (file === DEV_OVERRIDE_FILE || !isRecord(doc) || !isRecord(doc.services)) continue;
    for (const spec of Object.values(doc.services)) {
      if (!isRecord(spec) || !Array.isArray(spec.volumes)) continue;
      for (const v of spec.volumes) {
        const source = typeof v === "string" ? v.split(":")[0] : isRecord(v) && v.type === "bind" ? v.source : undefined;
        if (typeof source === "string" && !isAbsolute(source)) mounted.add(resolve(root, source));
      }
    }
  }
  for (const { path } of allowlist) {
    const at = (message: string) => drift.push(`allowlist ${path}: ${message}`);
    const abs = resolve(root, path);
    if (isAbsolute(path) || path.startsWith("..") || path !== relative(root, abs)) at("is not a normalised repo-relative path");
    else if (!existsSync(abs)) at("does not exist");
    else if (realpathSync(abs) !== join(realpathSync(root), path)) at("is, or sits under, a symlink");
    if (basename(path).startsWith(".env")) at("has a .env* basename");
    if (!mounted.has(abs)) at("is mounted by no production compose file");
  }
  return drift;
}

/** The top-level `volumes:` keys that make a named volume anything but plain and docker-managed (`external` is judged for every kind, below). */
const NAMED_VOLUME_REFUSED_KEYS = ["driver", "driver_opts"] as const;

/**
 * Why a named volume is not plain docker-managed, or null: an entry with no
 * `driver` or `driver_opts`, and no `name` but `expectedName` (`postgres_data:`
 * as written, or with the `name` compose adds, `<project>_<key>`). An explicit
 * `name:` can alias a volume that already exists on the host, bound to a file,
 * so a caller that cannot know the project name passes null and any `name` is
 * refused. `undefined` is an entry no file defines.
 */
export function namedVolumeProblem(entry: unknown, expectedName: string | null): string | null {
  if (entry === undefined) return "is not defined by any compose file";
  if (entry === null) return null;
  if (typeof entry !== "object" || Array.isArray(entry)) return "has an unmodelled definition";
  const sets: string[] = NAMED_VOLUME_REFUSED_KEYS.filter((k) => k in entry);
  if ("name" in entry && (expectedName === null || (entry as { name?: unknown }).name !== expectedName)) {
    sets.push(expectedName === null ? "name" : `name (not ${expectedName})`);
  }
  return sets.length === 0 ? null : `sets ${sets.join(", ")}`;
}

/**
 * Service keys outside the dev override are default-deny: a service may carry
 * only these top-level keys. Derived from what docker-compose.yml,
 * docker-compose.workers.yml, docker-compose.logging.yml and
 * docker-compose.ha.yml write, plus what `docker compose config` adds itself
 * (`entrypoint: null` on every service; `env_file` is folded into `environment`
 * in the render). Every other key is refused by name, so a key compose adds
 * later, or one this list never saw (`privileged`, `devices`, `cap_add`, `pid`,
 * `ipc`, `userns_mode`, `cgroup`, `volumes_from`, `extends`, `network_mode`,
 * `x-*`), is refused rather than skipped. `secrets` and `configs` are listed
 * because the file-channel check refuses every reference to one by name, with a
 * better message; an empty list is harmless. `tmpfs`, `container_name` and a
 * build `target` are dev-override keys.
 */
export const SERVICE_KEY_ALLOWLIST: readonly string[] = [
  "build",
  "cap_drop",
  "command",
  "configs",
  "depends_on",
  "entrypoint",
  "env_file",
  "environment",
  "healthcheck",
  "image",
  "logging",
  "networks",
  "ports",
  "profiles",
  "read_only",
  "restart",
  "secrets",
  "security_opt",
  "stop_grace_period",
  "volumes",
];

/** The only keys a production `build:` may carry: neither the render nor any file adds another. */
export const BUILD_KEY_ALLOWLIST: readonly string[] = ["context", "dockerfile", "args"];

/** The one `security_opt` a production service may carry. */
const SECURITY_OPT_ALLOWED = ["no-new-privileges:true"];

/** The `build.dockerfile` every production build uses. */
const BUILD_DOCKERFILE = "Dockerfile";

/** The prefix both adjudicators put on a refused service key. */
export const SERVICE_KEY_REFUSAL = "has a service key outside SERVICE_KEY_ALLOWLIST";

/**
 * Every way a production service definition carries a key SERVICE_KEY_ALLOWLIST
 * does not list, or a listed key in a shape that reaches the host: a
 * `security_opt` other than exactly `["no-new-privileges:true"]`, a `build` that
 * is not a mapping of context/dockerfile/args, a `build.context` that
 * `isProjectRoot` does not accept (an escape from .dockerignore) and a
 * `build.dockerfile` other than `Dockerfile`. The render check accepts the stub
 * path as the project root, the parity test `.`.
 */
export function serviceKeyProblems(service: unknown, isProjectRoot: (context: string) => boolean): string[] {
  if (!isRecord(service)) return ["has an unmodelled service definition"];
  const problems: string[] = [];
  const refuse = (what: string) => problems.push(`${SERVICE_KEY_REFUSAL}: ${what}`);
  for (const key of Object.keys(service)) if (!SERVICE_KEY_ALLOWLIST.includes(key)) refuse(key);
  if ("security_opt" in service && JSON.stringify(service.security_opt) !== JSON.stringify(SECURITY_OPT_ALLOWED)) {
    refuse(`security_opt is not exactly ${JSON.stringify(SECURITY_OPT_ALLOWED)}`);
  }
  if ("build" in service) {
    const build = service.build;
    if (!isRecord(build)) {
      refuse("build is not a mapping");
    } else {
      for (const key of Object.keys(build)) if (!BUILD_KEY_ALLOWLIST.includes(key)) refuse(`build.${key} is set`);
      if (typeof build.context !== "string" || !isProjectRoot(build.context)) refuse("build.context is not the project root");
      if (build.dockerfile !== BUILD_DOCKERFILE) refuse(`build.dockerfile is not ${BUILD_DOCKERFILE}`);
    }
  }
  return problems;
}

/** The prefix both adjudicators put on a refused file channel. */
export const FILE_CHANNEL_REFUSAL = "has a file channel outside FILE_CHANNEL_ALLOWLIST";

/**
 * Every top-level `volumes:`, `secrets:` or `configs:` entry that is `external`
 * — compose reads it from outside the project's files — as `<kind> entry <name>`.
 * Any `external` key counts, so `external: false` spellings are not a way round.
 */
export function externalEntryProblems(top: Partial<Record<"volumes" | "secrets" | "configs", unknown>>): string[] {
  const out: string[] = [];
  for (const kind of ["volumes", "secrets", "configs"] as const) {
    const entries = top[kind];
    if (typeof entries !== "object" || entries === null) continue;
    for (const [name, entry] of Object.entries(entries)) {
      if (typeof entry === "object" && entry !== null && "external" in entry) out.push(`${kind} entry ${name} is external`);
    }
  }
  return out;
}
