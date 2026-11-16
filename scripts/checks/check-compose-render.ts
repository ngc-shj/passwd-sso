/**
 * Compose render check (C7). docker-compose.workers.yml and its siblings keep
 * the signing material out of every service that loads `.env` by writing the
 * withheld set W (scripts/checks/lib/withheld-env.ts) as "" in that service's own
 * `environment:`. Whether that holds is a property of what compose RENDERS from
 * the merged files, not of any one file, so this check renders each documented
 * `-f` set and reads the result:
 *
 *   - a service that loads `.env` holds "" for every W key but its own DB URL
 *     (the stub `.env` carries a canary key, so loading is observed, not read
 *     from the YAML's spelling of `env_file`);
 *   - every W sentinel, in any value of any service (command and healthcheck
 *     included), appears only in the services withheldHolders() names for it:
 *     a role password where bound, a publisher-only key in the publisher,
 *     JACKSON_API_KEY in jackson, any other W key nowhere;
 *   - no service outside base+override (whose `.:/app` mount is the dev shape)
 *     gets a host file by anything but default-deny: a bind source only if it is
 *     <project>/<a FILE_CHANNEL_ALLOWLIST path> (withheld-env.ts); a named volume
 *     only if plain and docker-managed (no driver, driver_opts); a referenced
 *     top-level `secrets:`/`configs:` entry, any `external` entry,
 *     `build.secrets`, `build.ssh` and `build.additional_contexts` never; a
 *     volume type or key the check does not model fails instead of being skipped;
 *   - an inline `configs:` content or `secrets:` entry a service references is
 *     scanned for withheld values as that service's own;
 *   - every compose file findComposeFiles discovers is in some render set (an
 *     empty discovery is refused);
 *   - the publisher's rendered env passes auditAnchorPublisherEnvSchema and
 *     buildDestinationsFromEnv, the verify worker holds its URL and nothing
 *     else, and neither loads `.env`;
 *   - DEPLOYMENT_ID is the same in the publisher and retention-gc, also under a
 *     shell override;
 *   - removing any `${VAR:?...}` variable from the stub `.env` fails the render
 *     naming that variable.
 *
 * It never reads the repo `.env`: compose runs under a scrubbed environment
 * against a stub project directory whose `.env` holds sentinels. Output names
 * services and keys, never values.
 *
 * Without docker the check hard-fails when CI=true and prints a SKIPPED line
 * otherwise. Not a boundary against an operator who edits the files or runs
 * another `-f` set.
 *
 * Usage:
 *   tsx scripts/checks/check-compose-render.ts [--root <dir holding docker-compose*.yml>] [--record <file>]
 * Exit 1 on any failure.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditAnchorPublisherEnvSchema } from "@/lib/env-schema";
import { buildDestinationsFromEnv } from "@/lib/audit/anchor-destinations/from-env";
import {
  deriveWithheldEnv,
  derivePublisherOnlyEnv,
  BUILD_FILE_CHANNEL_KEYS,
  externalEntryProblems,
  FILE_CHANNEL_REFUSAL,
  isAllowlistedFileSource,
  isDatabaseUrlKey,
  namedVolumeProblem,
  ownDatabaseUrlKey,
  PUBLISHER_SERVICE,
  readSmokeMap,
  realRolePasswordInputs,
  realWithheldInputs,
  rolePasswordBinding,
  SHARED_PUBLISHER_NAME,
  withheldHolders,
  workerServiceName,
  type SmokeMap,
} from "./lib/withheld-env";
import { findComposeFiles } from "./lib/compose-files.mjs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

const PUBLISHER = PUBLISHER_SERVICE;
const VERIFY_WORKER = "audit-chain-verify-worker";
const RETENTION_GC = "retention-gc-worker";

/** The `-f` sets the docs tell an operator to use. */
export const RENDER_SETS: ReadonlyArray<{ name: string; files: readonly string[] }> = [
  { name: "base+override", files: ["docker-compose.yml", "docker-compose.override.yml"] },
  { name: "base+workers", files: ["docker-compose.yml", "docker-compose.workers.yml"] },
  { name: "base+workers+logging", files: ["docker-compose.yml", "docker-compose.workers.yml", "docker-compose.logging.yml"] },
  { name: "base+ha", files: ["docker-compose.yml", "docker-compose.ha.yml"] },
];

/** The set the DEPLOYMENT_ID shell-override case renders. */
const WORKERS_SET = RENDER_SETS[1];

/** The dev set: its workers bind-mount `.:/app`, so file channels are not judged there. */
const FILE_CHANNEL_EXEMPT_SET = RENDER_SETS[0].name;

/**
 * The compose files (root-relative, fixtures excluded) that no RENDER_SETS
 * entry renders. An empty list is refused: it means the discovery found nothing,
 * not that nothing is unrendered. The caller discovers the files, with
 * findComposeFiles (runChecks does, on every run).
 */
export function composeFilesOutsideRenderSets(found: readonly string[], sets: ReadonlyArray<{ files: readonly string[] }> = RENDER_SETS): string[] {
  if (found.length === 0) throw new Error("no compose files were found, so none can be checked against the render sets");
  const rendered = new Set(sets.flatMap((s) => s.files));
  return found.filter((f) => !rendered.has(f)).sort();
}

// ─── Sentinels ──────────────────────────────────────────────

export type Sentinel = {
  /** The text in the stub `.env`. */
  value: string;
  /** The part that identifies it inside a longer value (a URL, say). */
  token: string;
  /** False for a value that is not secret and too short to scan for (a region). */
  scannable: boolean;
};
export type Sentinels = Record<string, Sentinel>;

const CANARY_KEY = "COMPOSE_RENDER_CANARY";
const TOKEN_LENGTH = 24;
const AWS_REGION_KEY = "AUDIT_ANCHOR_AWS_REGION";
/** Destination names the stub gives so the publisher validator has a destination to build. */
const STUB_DESTINATION = {
  AUDIT_ANCHOR_DESTINATION_S3_BUCKET: "stub-audit-anchors",
  AUDIT_ANCHOR_DESTINATION_S3_PREFIX: "stub-prefix",
} as const;

function digest(seed: string): Buffer {
  return createHash("sha256").update(`compose-render-check:${seed}`).digest();
}

/** `[A-Za-z0-9]` of a fixed length (24), so it survives interpolation into a URL. */
function alnumToken(seed: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = digest(seed);
  let out = "";
  for (let i = 0; i < TOKEN_LENGTH; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function uuidFromSeed(seed: string): string {
  const h = digest(seed).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * One sentinel per key, valid for its type — a hex64 key, a UUID deployment id,
 * a URL for a DB URL, a fixed-length alphanumeric password otherwise — and
 * derived from the key name, so a re-render yields the same stub. Throws if
 * two sentinels collide or one contains another's token (the substring checks
 * below would then misattribute).
 */
export function buildSentinels(keys: readonly string[]): Sentinels {
  const out: Sentinels = {};
  for (const key of [...new Set(keys)].sort()) {
    if (key === "AUDIT_ANCHOR_SIGNING_KEY" || key === "AUDIT_ANCHOR_TAG_SECRET") {
      const value = digest(key).toString("hex");
      out[key] = { value, token: value, scannable: true };
    } else if (key === SHARED_PUBLISHER_NAME) {
      const value = uuidFromSeed(key);
      out[key] = { value, token: value, scannable: true };
    } else if (key === AWS_REGION_KEY) {
      out[key] = { value: "us-east-1", token: "us-east-1", scannable: false };
    } else if (isDatabaseUrlKey(key)) {
      const token = alnumToken(key);
      out[key] = { value: `postgresql://stub_${key.toLowerCase()}:${token}@stub-db:5432/stub`, token, scannable: true };
    } else {
      const token = alnumToken(key);
      out[key] = { value: token, token, scannable: true };
    }
  }
  const scannable = scannableSentinels(out);
  for (const [a, sa] of scannable) {
    for (const [b, sb] of scannable) {
      if (a !== b && sa.token.includes(sb.token)) throw new Error(`sentinel for ${b} is contained in the sentinel for ${a}`);
    }
  }
  return out;
}

export const CANARY_TOKEN = alnumToken(CANARY_KEY);

/** The stub `.env` text: every sentinel, the destination names and the canary. */
export function stubEnvText(sentinels: Sentinels, omit: readonly string[] = []): string {
  const lines = Object.entries(sentinels).map(([k, s]) => `${k}=${s.value}`);
  for (const [k, v] of Object.entries(STUB_DESTINATION)) lines.push(`${k}=${v}`);
  lines.push(`${CANARY_KEY}=${CANARY_TOKEN}`);
  return lines.filter((l) => !omit.includes(l.slice(0, l.indexOf("=")))).join("\n") + "\n";
}

/** Every `${VAR:?...}` variable in the compose texts. */
export function requiredVariables(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?/g)) found.add(m[1]);
  return [...found].sort();
}

// ─── Analysis of a rendered config ──────────────────────────

export type ComposeService = { environment?: Record<string, string | null | undefined> } & Record<string, unknown>;
type TopLevelEntries = Record<string, Record<string, unknown> | null | undefined>;
export type ComposeRender = {
  services: Record<string, ComposeService>;
  volumes?: TopLevelEntries;
  secrets?: TopLevelEntries;
  configs?: TopLevelEntries;
};

export type AnalysisContext = {
  withheld: readonly string[];
  publisherOnly: readonly string[];
  sentinels: Sentinels;
  /** Service → the role-password variables its values may contain. */
  binding: Record<string, readonly string[]>;
  smoke: SmokeMap;
  /** The `--project-directory` the render ran in: where `.` in a compose file resolves. */
  projectRoot: string;
};

function envOf(service: ComposeService): Record<string, string | null | undefined> {
  return service.environment ?? {};
}

/** The own-URL key and role-password variable of each smoke-map worker, by compose service name. */
function workerBindings(ctx: AnalysisContext): Record<string, { urlKey: string; passwordVar: string }> {
  const out: Record<string, { urlKey: string; passwordVar: string }> = {};
  for (const task of Object.values(ctx.smoke.tasks)) {
    const service = workerServiceName(task);
    out[service] = { urlKey: ownDatabaseUrlKey(task), passwordVar: ctx.binding[service]?.[0] ?? "" };
  }
  return out;
}

/** Whether `text` holds the sentinel of `key`. */
function holds(text: string, ctx: AnalysisContext, key: string): boolean {
  const s = ctx.sentinels[key];
  return s !== undefined && s.scannable && text.includes(s.token);
}

/**
 * The publisher's rendered env, as the validator the process runs would see it
 * (the runner image sets NODE_ENV=production), through the schema and the
 * destination builder. Messages carry paths and codes, never values.
 */
export function publisherEnvProblems(env: Record<string, string | null | undefined>): string[] {
  const input: Record<string, string> = { NODE_ENV: "production" };
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") input[k] = v;
  const parsed = auditAnchorPublisherEnvSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `fails auditAnchorPublisherEnvSchema at ${i.path.join(".") || "(root)"}: ${i.message}`);
  }
  try {
    buildDestinationsFromEnv(parsed.data);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return [`buildDestinationsFromEnv refused the env${code ? ` (${code})` : ""}`];
  }
  return [];
}

/** The keys a rendered volume entry may carry; another is a shape this check does not model. */
const VOLUME_ENTRY_KEYS = ["type", "source", "target", "read_only", "bind", "volume", "tmpfs", "consistency"];

/** The top-level `secrets:`/`configs:` entries `service` references, by name (a name the render does not define is absent). */
function referencedEntries(service: ComposeService, render: ComposeRender): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kind of ["secrets", "configs"] as const) {
    const refs = service[kind];
    for (const ref of Array.isArray(refs) ? refs : []) {
      const name = typeof ref === "string" ? ref : (ref as { source?: unknown } | null)?.source;
      const entry = typeof name === "string" ? render[kind]?.[name] : undefined;
      if (entry) out[`${kind}:${String(name)}`] = entry;
    }
  }
  return out;
}

/**
 * How a host file could reach `service`, by default-deny: a bind source only if
 * it is `<projectRoot>/<a FILE_CHANNEL_ALLOWLIST path>`; a named volume only if
 * plain and docker-managed; a referenced secrets/configs entry, `build.secrets`,
 * `build.ssh` and `build.additional_contexts` never; a tmpfs is fine. A shape
 * not modelled is reported, not skipped.
 */
function fileChannelProblems(service: ComposeService, render: ComposeRender, projectRoot: string): string[] {
  const problems: string[] = [];
  const refuse = (what: string) => problems.push(`${FILE_CHANNEL_REFUSAL}: ${what}`);
  const shown = (path: string) => (path === projectRoot ? "<root>" : path.startsWith(`${projectRoot}/`) ? `<root>${path.slice(projectRoot.length)}` : path);

  const volumes = service.volumes;
  if (volumes !== undefined && !Array.isArray(volumes)) problems.push("has an unmodelled volumes value");
  for (const v of Array.isArray(volumes) ? volumes : []) {
    const entry = v as { type?: unknown; source?: unknown } | null;
    if (typeof entry !== "object" || entry === null || typeof entry.type !== "string") {
      problems.push("has an unmodelled volume entry");
      continue;
    }
    for (const key of Object.keys(entry)) if (!VOLUME_ENTRY_KEYS.includes(key)) problems.push(`has a volume with unmodelled key ${key}`);
    if (entry.type === "bind") {
      if (typeof entry.source !== "string" || entry.source === "") problems.push("has a bind volume without a source");
      else if (!isAllowlistedFileSource(entry.source, projectRoot)) refuse(`a bind source "${shown(entry.source)}" is not allowlisted`);
    } else if (entry.type === "volume") {
      if (typeof entry.source === "string") {
        const problem = namedVolumeProblem(render.volumes?.[entry.source]);
        if (problem !== null) refuse(`named volume ${entry.source} ${problem}`);
      }
    } else if (entry.type !== "tmpfs") {
      problems.push(`has a volume of unmodelled type ${entry.type}`);
    }
  }

  for (const kind of ["secrets", "configs"] as const) {
    const refs = service[kind];
    if (refs !== undefined && !Array.isArray(refs)) problems.push(`has an unmodelled ${kind} value`);
    for (const ref of Array.isArray(refs) ? refs : []) {
      const name = typeof ref === "string" ? ref : (ref as { source?: unknown } | null)?.source;
      if (typeof name !== "string") problems.push(`has an unmodelled ${kind} entry`);
      else refuse(`${kind} entry ${name} is referenced`);
    }
  }

  const build = service.build;
  if (typeof build === "object" && build !== null) {
    for (const key of BUILD_FILE_CHANNEL_KEYS) if (key in build) refuse(`build.${key} is set`);
  }
  return problems;
}

/** Every way one rendered set falls short of the contract (C1 I1.2-I1.4 as rendered, C7). */
export function analyzeRender(setName: string, render: ComposeRender, ctx: AnalysisContext): string[] {
  const drift: string[] = [];
  const at = (service: string, message: string) => drift.push(`[${setName}] ${service}: ${message}`);
  const workers = workerBindings(ctx);
  const holders = withheldHolders(ctx.withheld, ctx.publisherOnly, ctx.binding);
  const canary = CANARY_TOKEN;
  const roleUrlDrift = (service: string, env: Record<string, string | null | undefined>) => {
    const w = workers[service];
    const s = ctx.sentinels[w.passwordVar];
    const url = env[w.urlKey];
    if (typeof url !== "string" || !s || !url.includes(s.token)) at(service, `${w.urlKey} does not carry the password of its role (${w.passwordVar})`);
  };

  for (const [name, service] of Object.entries(render.services)) {
    const env = envOf(service);
    const loadsEnv = env[CANARY_KEY] === canary;
    const own = workers[name];

    if (loadsEnv) {
      for (const key of ctx.withheld) {
        if (own && key === own.urlKey) {
          const value = env[key];
          const s = ctx.sentinels[own.passwordVar];
          if (typeof value !== "string" || value === "") at(name, `${key} (its own DB URL) is not set`);
          else if (s && !value.includes(s.token)) at(name, `${key} does not carry the password of its role (${own.passwordVar})`);
        } else if (env[key] !== "") {
          at(name, `${key} is not blanked (loads .env, so it holds the .env value)`);
        }
      }
    }
    if ((name === PUBLISHER || name === VERIFY_WORKER) && loadsEnv) at(name, "loads .env");

    if (setName !== FILE_CHANNEL_EXEMPT_SET) {
      for (const problem of fileChannelProblems(service, render, ctx.projectRoot)) at(name, problem);
    }

    // A referenced secrets/configs entry is part of what the service holds: its inline `content` is a value too.
    const text = JSON.stringify([service, referencedEntries(service, render)]);
    for (const key of ctx.withheld) {
      if (!(holders[key] ?? []).includes(name) && holds(text, ctx, key)) at(name, `holds withheld ${key}, which is not given to this service`);
    }
  }

  if (setName !== FILE_CHANNEL_EXEMPT_SET) {
    for (const problem of externalEntryProblems(render)) at("(top level)", `${FILE_CHANNEL_REFUSAL}: ${problem}`);
  }

  const publisher = render.services[PUBLISHER];
  if (publisher) {
    const env = envOf(publisher);
    for (const key of Object.keys(ctx.smoke.tasks.audit_anchor_publisher.env)) {
      if (env[key] === undefined || env[key] === null) at(PUBLISHER, `${key} (an ECS name) is absent`);
    }
    if (env.AUDIT_ANCHOR_PUBLISHER_ENABLED !== "true") at(PUBLISHER, "AUDIT_ANCHOR_PUBLISHER_ENABLED is not true");
    for (const key of ["AUDIT_ANCHOR_SIGNING_KEY", "AUDIT_ANCHOR_TAG_SECRET", SHARED_PUBLISHER_NAME]) {
      if (env[key] !== ctx.sentinels[key]?.value) at(PUBLISHER, `${key} does not carry the .env value`);
    }
    roleUrlDrift(PUBLISHER, env);
    for (const p of publisherEnvProblems(env)) at(PUBLISHER, p);
  }

  const verify = render.services[VERIFY_WORKER];
  if (verify) {
    const env = envOf(verify);
    const w = workers[VERIFY_WORKER];
    const names = Object.keys(env).sort();
    const expected = [w.urlKey, "DATABASE_URL"].sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) at(VERIFY_WORKER, `env names are not exactly ${expected.join(", ")}`);
    roleUrlDrift(VERIFY_WORKER, env);
  }

  return drift;
}

/** The publisher and retention-gc hold the same DEPLOYMENT_ID, and it is `expected`. */
export function deploymentIdDrift(setName: string, render: ComposeRender, expected: string): string[] {
  const drift: string[] = [];
  for (const name of [PUBLISHER, RETENTION_GC]) {
    const service = render.services[name];
    if (!service) {
      drift.push(`[${setName}] ${name}: absent from the render`);
    } else if (envOf(service).DEPLOYMENT_ID !== expected) {
      drift.push(`[${setName}] ${name}: DEPLOYMENT_ID is not the one ${name === PUBLISHER ? "the shell" : "the publisher and the shell"} gave`);
    }
  }
  return drift;
}

// ─── Running compose ────────────────────────────────────────

type EnvMap = Record<string, string | undefined>;

export type ComposeResult = { status: number | null; stdout: string; stderr: string; error?: Error };

/** The environment compose runs in: no shell value, no COMPOSE_*, only what finding docker needs. */
export function scrubbedEnv(source: EnvMap, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG"]) {
    const v = source[key];
    if (v !== undefined) env[key] = v;
  }
  return { ...env, ...extra };
}

function runCompose(docker: string, args: readonly string[], env: Record<string, string>): ComposeResult {
  const r = spawnSync(docker, ["compose", ...args], { encoding: "utf8", env: env as NodeJS.ProcessEnv, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

function composeArgs(stub: string, root: string, files: readonly string[]): string[] {
  return [
    "--project-directory", stub,
    "--project-name", "compose-render",
    "--env-file", join(stub, ".env"),
    "--profile", "migrate",
    ...files.flatMap((f) => ["-f", join(root, f)]),
    "config", "--format", "json",
  ];
}

function scannableSentinels(sentinels: Sentinels): Array<[string, Sentinel]> {
  return Object.entries(sentinels).filter(([, s]) => s.scannable);
}

/**
 * Swaps every scannable sentinel token, then the canary token, for its
 * placeholder; `reverse` swaps the placeholders back for the tokens.
 */
function replaceTokens(text: string, sentinels: Sentinels, placeholder: (key: string) => string, reverse = false): string {
  const pairs: Array<[token: string, key: string]> = [...scannableSentinels(sentinels).map(([key, s]): [string, string] => [s.token, key]), [CANARY_TOKEN, CANARY_KEY]];
  let out = text;
  for (const [token, key] of pairs) out = reverse ? out.split(placeholder(key)).join(token) : out.split(token).join(placeholder(key));
  return out;
}

/** Compose text with every sentinel replaced by its key, so a diagnostic cannot leak a value. */
function redact(text: string, sentinels: Sentinels): string {
  return replaceTokens(text, sentinels, (key) => `<${key}>`);
}

function dockerComposeVersion(docker: string, env: Record<string, string>): string | null {
  const r = spawnSync(docker, ["compose", "version"], { encoding: "utf8", env: env as NodeJS.ProcessEnv, timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim();
}

/**
 * The render compose printed. The stdout is never quoted: it is the whole
 * config, secrets included, so a parse failure names only its size.
 */
export function parseRender(stdout: string): ComposeRender {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`compose config printed output that is not valid JSON (${stdout.length} bytes, not shown)`);
  }
  const services = (parsed as { services?: unknown } | null)?.services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) {
    throw new Error("compose config printed JSON with no services mapping (output not shown)");
  }
  return parsed as ComposeRender;
}

export type RunOptions = { root: string; docker: string; sourceEnv: EnvMap; recordTo?: string };

/** Renders every set and returns the failures; `log` receives progress lines. */
export function runChecks(opts: RunOptions, log: (line: string) => void): string[] {
  const failures: string[] = [];
  const withheldInputs = realWithheldInputs();
  const withheld = deriveWithheldEnv(withheldInputs);
  const publisherOnly = derivePublisherOnlyEnv(withheldInputs);
  const smoke = readSmokeMap();
  const binding = rolePasswordBinding(realRolePasswordInputs());

  const fileTexts = new Map<string, string>();
  for (const set of RENDER_SETS) {
    for (const f of set.files) {
      if (fileTexts.has(f)) continue;
      const path = join(opts.root, f);
      if (!existsSync(path)) {
        failures.push(`${f}: not found under ${opts.root}`);
        continue;
      }
      fileTexts.set(f, readFileSync(path, "utf8"));
    }
  }
  if (failures.length > 0) return failures;

  // A compose file no set renders is a stack no check here has looked at.
  try {
    const found = findComposeFiles(opts.root).map((f) => relative(opts.root, f));
    for (const f of composeFilesOutsideRenderSets(found)) failures.push(`${f}: a compose file no render set renders`);
  } catch (e) {
    failures.push((e as Error).message);
  }

  const required = requiredVariables([...fileTexts.values()]);
  // Variables that must be `:?` whatever the files say now, so weakening one to
  // `:-` is caught instead of dropping out of the list being tested: what the
  // ECS publisher gets as secrets (bar its URL) and each worker's role password.
  const mustRequire = [
    ...withheldInputs.publisherSecrets.filter((n) => !isDatabaseUrlKey(n)),
    ...Object.values(smoke.tasks).map((t) => binding[workerServiceName(t)][0]),
  ];
  const sentinels = buildSentinels([...withheld, ...required, ...mustRequire, SHARED_PUBLISHER_NAME]);
  const env = scrubbedEnv(opts.sourceEnv);

  const stub = mkdtempSync(join(tmpdir(), "compose-render-"));
  const ctx: AnalysisContext = { withheld, publisherOnly, sentinels, binding, smoke, projectRoot: stub };
  try {
    writeFileSync(join(stub, ".env"), stubEnvText(sentinels), { mode: 0o600 });

    const renders = new Map<string, ComposeRender>();
    for (const set of RENDER_SETS) {
      const result = runCompose(opts.docker, composeArgs(stub, opts.root, set.files), env);
      if (result.status !== 0) {
        failures.push(`[${set.name}] compose config failed: ${redact(result.stderr.trim() || String(result.error), sentinels)}`);
        continue;
      }
      let render: ComposeRender;
      try {
        render = parseRender(result.stdout);
      } catch (e) {
        failures.push(`[${set.name}] ${(e as Error).message}`);
        continue;
      }
      renders.set(set.name, render);
      const drift = analyzeRender(set.name, render, ctx);
      failures.push(...drift);
      log(`  ${set.name}: ${Object.keys(render.services).length} services, ${drift.length === 0 ? "ok" : `${drift.length} failure(s)`}`);
    }

    const workers = renders.get(WORKERS_SET.name);
    if (workers) {
      failures.push(...deploymentIdDrift(WORKERS_SET.name, workers, sentinels.DEPLOYMENT_ID.value));
      if (opts.recordTo) {
        const version = dockerComposeVersion(opts.docker, env);
        writeFileSync(
          opts.recordTo,
          JSON.stringify({ composeVersion: version, set: WORKERS_SET.name, withheld, render: placeholderizeRender(workers, sentinels, stub) }, null, 2) + "\n",
        );
      }
    }

    // The shell wins over .env in compose, so one export would split the two services
    // if either read it by a different path.
    const shellId = uuidFromSeed("DEPLOYMENT_ID:shell");
    const overridden = runCompose(opts.docker, composeArgs(stub, opts.root, WORKERS_SET.files), scrubbedEnv(opts.sourceEnv, { DEPLOYMENT_ID: shellId }));
    if (overridden.status !== 0) {
      failures.push(`[${WORKERS_SET.name}] compose config failed under a DEPLOYMENT_ID override: ${redact(overridden.stderr.trim(), sentinels)}`);
    } else {
      try {
        const drift = deploymentIdDrift(`${WORKERS_SET.name} + shell DEPLOYMENT_ID`, parseRender(overridden.stdout), shellId);
        failures.push(...drift);
        log(`  DEPLOYMENT_ID under a shell override: ${drift.length === 0 ? "equal in publisher and retention-gc" : "split"}`);
      } catch (e) {
        failures.push(`[${WORKERS_SET.name}] under a DEPLOYMENT_ID override: ${(e as Error).message}`);
      }
    }

    // Each required variable, removed, must fail the render and be named.
    const seen = new Set<string>();
    for (const set of RENDER_SETS) {
      const declared = requiredVariables(set.files.map((f) => fileTexts.get(f) ?? ""));
      const inSet = set === WORKERS_SET ? [...new Set([...declared, ...mustRequire])] : declared;
      for (const variable of inSet) {
        if (seen.has(variable)) continue;
        seen.add(variable);
        writeFileSync(join(stub, ".env"), stubEnvText(sentinels, [variable]), { mode: 0o600 });
        const result = runCompose(opts.docker, composeArgs(stub, opts.root, set.files), env);
        if (result.status === 0) failures.push(`[${set.name}] removing ${variable} did not fail the render (its \${${variable}:?...} is gone or weakened)`);
        else if (!result.stderr.includes(variable)) failures.push(`[${set.name}] removing ${variable} failed the render without naming it`);
      }
    }
    log(`  ${seen.size} required variable(s): each removal fails the render naming it`);
  } finally {
    rmSync(stub, { recursive: true, force: true });
  }
  return failures;
}

/**
 * A recorded render holds neither the random stub path nor a sentinel: each
 * sentinel token becomes `{{KEY}}` (so no key-shaped value is committed) and
 * `hydrateRecordedRender` puts them back.
 */
export function placeholderizeRender(render: ComposeRender, sentinels: Sentinels, stub: string): ComposeRender {
  const text = JSON.stringify(render).split(stub).join("<stub>");
  return JSON.parse(replaceTokens(text, sentinels, (key) => `{{${key}}}`)) as ComposeRender;
}

export function hydrateRecordedRender(render: ComposeRender, sentinels: Sentinels): ComposeRender {
  return JSON.parse(replaceTokens(JSON.stringify(render), sentinels, (key) => `{{${key}}}`, true)) as ComposeRender;
}

// ─── Entry point ────────────────────────────────────────────

export function main(argv: readonly string[], sourceEnv: EnvMap = process.env): number {
  const rootAt = argv.indexOf("--root");
  const root = resolve(rootAt === -1 ? REPO_ROOT : (argv[rootAt + 1] ?? ""));
  const recordAt = argv.indexOf("--record");
  const recordTo = recordAt === -1 ? undefined : resolve(argv[recordAt + 1] ?? "");
  const docker = sourceEnv.COMPOSE_RENDER_DOCKER_BIN || "docker";

  const version = dockerComposeVersion(docker, scrubbedEnv(sourceEnv));
  if (version === null) {
    if (sourceEnv.CI === "true") {
      console.error("check-compose-render: docker compose is not available and CI=true: the render cannot be skipped in CI");
      return 1;
    }
    console.log("check-compose-render: SKIPPED: docker compose is not available (set CI=true to make this a failure)");
    return 0;
  }
  console.log(`check-compose-render: ${version}`);
  console.log(`check-compose-render: root ${root}`);

  const failures = runChecks({ root, docker, sourceEnv, recordTo }, (line) => console.log(line));
  if (failures.length > 0) {
    console.error(`check-compose-render: ${failures.length} failure(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    return 1;
  }
  console.log("check-compose-render: ok");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
