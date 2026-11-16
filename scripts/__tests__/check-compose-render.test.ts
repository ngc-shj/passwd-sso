/**
 * Self-test for scripts/checks/check-compose-render.ts. The assertion logic runs
 * on a recorded render (scripts/__tests__/fixtures/compose-render/, with the
 * compose version it came from) everywhere; a real compose render of the tree
 * and of a mutated scratch copy runs where docker exists, and fails instead of
 * skipping when CI=true.
 *
 * Each deny case mutates a clone of the recorded render in one step and
 * compares the whole drift list; the allow case is the unmutated render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { load } from "js-yaml";
import {
  CANARY_TOKEN,
  COMPOSE_PROJECT_NAME,
  RENDER_SETS,
  analyzeRender,
  buildSentinels,
  composeFilesOutsideRenderSets,
  deploymentIdDrift,
  hydrateRecordedRender,
  main,
  parseRender,
  placeholderizeRender,
  publisherEnvProblems,
  requiredVariables,
  scrubbedEnv,
  stubEnvText,
  type AnalysisContext,
  type ComposeRender,
  type Sentinels,
} from "../checks/check-compose-render";
import { findComposeFiles } from "../checks/lib/compose-files.mjs";
import {
  BUILD_KEY_ALLOWLIST,
  FILE_CHANNEL_ALLOWLIST,
  NAMED_VOLUME_ALLOWLIST,
  SERVICE_KEY_ALLOWLIST,
  SERVICE_KEY_REFUSAL,
  derivePublisherOnlyEnv,
  deriveWithheldEnv,
  readSmokeMap,
  realRolePasswordInputs,
  realWithheldInputs,
  rolePasswordBinding,
} from "../checks/lib/withheld-env";

const REPO_ROOT = resolve(__dirname, "../..");
const FIXTURE_PATH = join(__dirname, "fixtures/compose-render/workers-render.json");
const SET = "base+workers";
const NOT_GIVEN = ", which is not given to this service";

type Recorded = { composeVersion: string | null; set: string; withheld: string[]; render: ComposeRender };
const recorded = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Recorded;

const withheldInputs = realWithheldInputs();
const withheld = deriveWithheldEnv(withheldInputs);
const publisherOnly = derivePublisherOnlyEnv(withheldInputs);
const placeholderKeys = [...new Set([...JSON.stringify(recorded.render).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))];
const sentinels: Sentinels = buildSentinels([...withheld, ...recorded.withheld, ...placeholderKeys, "DEPLOYMENT_ID"]);
const ctx: AnalysisContext = {
  withheld,
  publisherOnly,
  sentinels,
  binding: rolePasswordBinding(realRolePasswordInputs()),
  smoke: readSmokeMap(),
  projectRoot: "<stub>",
  projectName: COMPOSE_PROJECT_NAME,
};
const baseline = (): ComposeRender => hydrateRecordedRender(structuredClone(recorded.render), sentinels);

/** Clone the recorded render, apply one mutation, analyze. */
function drift(mutate: (r: ComposeRender) => void): string[] {
  const r = baseline();
  const before = JSON.stringify(r);
  mutate(r);
  expect(JSON.stringify(r), "mutation changed nothing").not.toBe(before);
  return analyzeRender(SET, r, ctx);
}

const env = (r: ComposeRender, service: string) => r.services[service].environment as Record<string, string | undefined>;
const sentinel = (key: string) => sentinels[key].value;
const NOT_BLANKED = "is not blanked (loads .env, so it holds the .env value)";
/** What a service that loads .env but blanks nothing is named for: every W key except its own URL, in W's order. */
const unblanked = (service: string, ownUrlKey: string): string[] =>
  withheld.filter((k) => k !== ownUrlKey).map((k) => `[${SET}] ${service}: ${k} ${NOT_BLANKED}`);

describe("recorded render", () => {
  it("records the compose version it came from", () => {
    expect(recorded.composeVersion).toMatch(/^Docker Compose version v?\d+\.\d+\.\d+/);
    expect(recorded.set).toBe(SET);
  });

  it("holds no sentinel value, so no key-shaped text is committed", () => {
    expect(placeholderKeys.length).toBeGreaterThan(0);
    const text = readFileSync(FIXTURE_PATH, "utf8");
    for (const s of Object.values(sentinels)) if (s.scannable) expect(text).not.toContain(s.token);
    expect(text).not.toContain(CANARY_TOKEN);
  });
});

describe("analyzeRender", () => {
  it("passes the recorded render", () => {
    expect(analyzeRender(SET, baseline(), ctx)).toEqual([]);
  });

  it("names a service that loads .env and does not blank a withheld key", () => {
    expect(drift((r) => (env(r, "app").SENTRY_AUTH_TOKEN = sentinel("SENTRY_AUTH_TOKEN")))).toEqual([
      `[${SET}] app: SENTRY_AUTH_TOKEN is not blanked (loads .env, so it holds the .env value)`,
      `[${SET}] app: holds withheld SENTRY_AUTH_TOKEN${NOT_GIVEN}`,
    ]);
  });

  it("names a withheld key that is missing instead of blank", () => {
    expect(drift((r) => delete env(r, "audit-outbox-worker").GITHUB_TOKEN)).toEqual([
      `[${SET}] audit-outbox-worker: GITHUB_TOKEN is not blanked (loads .env, so it holds the .env value)`,
    ]);
  });

  it("names a publisher-only value reaching a service that loads .env, on both counts", () => {
    expect(drift((r) => (env(r, "app").AUDIT_ANCHOR_SIGNING_KEY = sentinel("AUDIT_ANCHOR_SIGNING_KEY")))).toEqual([
      `[${SET}] app: AUDIT_ANCHOR_SIGNING_KEY is not blanked (loads .env, so it holds the .env value)`,
      `[${SET}] app: holds withheld AUDIT_ANCHOR_SIGNING_KEY${NOT_GIVEN}`,
    ]);
  });

  it("names a publisher-only value reaching a service that does not load .env", () => {
    expect(drift((r) => (env(r, "jackson").LEAK = sentinel("GITHUB_TOKEN")))).toEqual([
      `[${SET}] jackson: holds withheld GITHUB_TOKEN${NOT_GIVEN}`,
    ]);
  });

  it("allows the publisher to hold its own secrets (the unmutated render does)", () => {
    expect(JSON.stringify(baseline().services["audit-anchor-publisher"])).toContain(sentinels.AUDIT_ANCHOR_SIGNING_KEY.token);
  });

  it("names a role password in a service bound to another role", () => {
    expect(drift((r) => (env(r, "redis").LEAK = sentinel("PASSWD_APP_PASSWORD")))).toEqual([
      `[${SET}] redis: holds withheld PASSWD_APP_PASSWORD${NOT_GIVEN}`,
    ]);
  });

  it("names a worker whose own URL carries another role's password", () => {
    const outboxUrl = (r: ComposeRender) => env(r, "audit-outbox-worker").OUTBOX_WORKER_DATABASE_URL as string;
    expect(
      drift((r) => {
        env(r, "audit-outbox-worker").OUTBOX_WORKER_DATABASE_URL = outboxUrl(r).replace(
          sentinels.PASSWD_OUTBOX_WORKER_PASSWORD.token,
          sentinels.PASSWD_SUPERUSER_PASSWORD.token,
        );
      }),
    ).toEqual([
      `[${SET}] audit-outbox-worker: OUTBOX_WORKER_DATABASE_URL does not carry the password of its role (PASSWD_OUTBOX_WORKER_PASSWORD)`,
      `[${SET}] audit-outbox-worker: holds withheld PASSWD_SUPERUSER_PASSWORD${NOT_GIVEN}`,
    ]);
  });

  it("names another principal's DB URL forwarded to app under a new name", () => {
    expect(drift((r) => (env(r, "app").ADMIN_DB_URL = sentinel("MIGRATION_DATABASE_URL")))).toEqual([
      `[${SET}] app: holds withheld MIGRATION_DATABASE_URL${NOT_GIVEN}`,
    ]);
  });

  it("names a withheld value in a healthcheck and in a command", () => {
    expect(
      drift((r) => {
        r.services.redis.healthcheck = { test: ["CMD-SHELL", `redis-cli -a ${sentinel("AUDIT_ANCHOR_TAG_SECRET")} ping`] };
        r.services.app.command = ["sh", "-c", `echo ${sentinel("SENTRY_AUTH_TOKEN")}`];
      }),
    ).toEqual([
      `[${SET}] app: holds withheld SENTRY_AUTH_TOKEN${NOT_GIVEN}`,
      `[${SET}] redis: holds withheld AUDIT_ANCHOR_TAG_SECRET${NOT_GIVEN}`,
    ]);
  });

  it("allows jackson its API key and db its role passwords (the unmutated render holds them)", () => {
    const r = baseline();
    expect(JSON.stringify(r.services.jackson)).toContain(sentinels.JACKSON_API_KEY.token);
    for (const pw of ctx.binding.db) expect(JSON.stringify(r.services.db), pw).toContain(sentinels[pw].token);
    expect(analyzeRender(SET, r, ctx)).toEqual([]);
  });

  it("names JACKSON_API_KEY in a service other than jackson", () => {
    expect(drift((r) => (env(r, "redis").LEAK = sentinel("JACKSON_API_KEY")))).toEqual([`[${SET}] redis: holds withheld JACKSON_API_KEY${NOT_GIVEN}`]);
  });

  it("names a publisher whose own URL does not carry its role's password", () => {
    expect(drift((r) => (env(r, "audit-anchor-publisher").AUDIT_ANCHOR_PUBLISHER_DATABASE_URL = "postgresql://passwd_anchor_publisher:x@db:5432/passwd_sso"))).toEqual([
      `[${SET}] audit-anchor-publisher: AUDIT_ANCHOR_PUBLISHER_DATABASE_URL does not carry the password of its role (PASSWD_ANCHOR_PUBLISHER_PASSWORD)`,
    ]);
  });

  it("names a verify worker whose own URL does not carry its role's password", () => {
    expect(drift((r) => (env(r, "audit-chain-verify-worker").AUDIT_CHAIN_VERIFY_DATABASE_URL = "postgresql://passwd_audit_chain_verifier:x@db:5432/passwd_sso"))).toEqual([
      `[${SET}] audit-chain-verify-worker: AUDIT_CHAIN_VERIFY_DATABASE_URL does not carry the password of its role (PASSWD_AUDIT_CHAIN_VERIFIER_PASSWORD)`,
    ]);
  });

  it("names a verify worker that has gone through .env", () => {
    const found = drift((r) => (env(r, "audit-chain-verify-worker").COMPOSE_RENDER_CANARY = CANARY_TOKEN));
    expect(found).toEqual([
      ...unblanked("audit-chain-verify-worker", "AUDIT_CHAIN_VERIFY_DATABASE_URL"),
      `[${SET}] audit-chain-verify-worker: loads .env`,
      `[${SET}] audit-chain-verify-worker: env names are not exactly AUDIT_CHAIN_VERIFY_DATABASE_URL, DATABASE_URL`,
    ]);
  });

  it("names a worker whose own URL is blanked", () => {
    expect(drift((r) => (env(r, "retention-gc-worker").RETENTION_GC_DATABASE_URL = ""))).toEqual([
      `[${SET}] retention-gc-worker: RETENTION_GC_DATABASE_URL (its own DB URL) is not set`,
    ]);
  });

  it("names a publisher that has gone through .env", () => {
    const found = drift((r) => (env(r, "audit-anchor-publisher").COMPOSE_RENDER_CANARY = CANARY_TOKEN));
    expect(found).toEqual([
      ...unblanked("audit-anchor-publisher", "AUDIT_ANCHOR_PUBLISHER_DATABASE_URL"),
      `[${SET}] audit-anchor-publisher: loads .env`,
    ]);
  });

  it("names a verify worker with an extra variable", () => {
    expect(drift((r) => (env(r, "audit-chain-verify-worker").EXTRA = "x"))).toEqual([
      `[${SET}] audit-chain-verify-worker: env names are not exactly AUDIT_CHAIN_VERIFY_DATABASE_URL, DATABASE_URL`,
    ]);
  });

  it("names a publisher missing an ECS name, and the schema refusal that follows", () => {
    const found = drift((r) => delete env(r, "audit-anchor-publisher").DEPLOYMENT_ID);
    expect(found).toEqual([
      `[${SET}] audit-anchor-publisher: DEPLOYMENT_ID (an ECS name) is absent`,
      `[${SET}] audit-anchor-publisher: DEPLOYMENT_ID does not carry the .env value`,
      `[${SET}] audit-anchor-publisher: fails auditAnchorPublisherEnvSchema at DEPLOYMENT_ID: DEPLOYMENT_ID is required when AUDIT_ANCHOR_PUBLISHER_ENABLED=true`,
    ]);
  });

  it("names a publisher whose signing key is not the .env value", () => {
    expect(drift((r) => (env(r, "audit-anchor-publisher").AUDIT_ANCHOR_SIGNING_KEY = "0".repeat(64)))).toEqual([
      `[${SET}] audit-anchor-publisher: AUDIT_ANCHOR_SIGNING_KEY does not carry the .env value`,
    ]);
  });

  it("names a publisher that is not enabled", () => {
    expect(drift((r) => (env(r, "audit-anchor-publisher").AUDIT_ANCHOR_PUBLISHER_ENABLED = "false"))).toEqual([
      `[${SET}] audit-anchor-publisher: AUDIT_ANCHOR_PUBLISHER_ENABLED is not true`,
    ]);
  });

  it("names a publisher with an S3 bucket and a blank region (the schema refuses it)", () => {
    const found = drift((r) => {
      env(r, "audit-anchor-publisher").AUDIT_ANCHOR_DESTINATION_S3_BUCKET = "b";
      env(r, "audit-anchor-publisher").AWS_REGION = "";
    });
    expect(found).toEqual([
      `[${SET}] audit-anchor-publisher: fails auditAnchorPublisherEnvSchema at AWS_REGION: AWS_REGION is required when AUDIT_ANCHOR_DESTINATION_S3_BUCKET is set`,
    ]);
  });
});

describe("analyzeRender: a host file reaches a service only by FILE_CHANNEL_ALLOWLIST", () => {
  const REFUSED = "has a file channel outside FILE_CHANNEL_ALLOWLIST";
  const bind = (source: string) => ({ type: "bind", source, target: "/mnt/x", read_only: true, bind: {} });
  const notAllowlisted = (shown: string) => [`[${SET}] app: ${REFUSED}: a bind source "${shown}" is not allowlisted`];
  const onApp = (...volumes: unknown[]) => (r: ComposeRender) => void (r.services.app.volumes = volumes);

  it("names a bind source that is not exactly an allowlisted path", () => {
    const cases: Array<[string, string]> = [
      ["<stub>", "<root>"],
      ["<stub>/.env", "<root>/.env"],
      ["<stub>/infra", "<root>/infra"],
      ["<stub>/infra/postgres/initdb/../../../.env", "<root>/infra/postgres/initdb/../../../.env"],
      ["/srv/other/.env.production", "/srv/other/.env.production"],
      ["/opt", "/opt"],
      ["/home/someone/x", "/home/someone/x"],
      [".", "."],
    ];
    for (const [source, shown] of cases) expect(drift(onApp(bind(source))), source).toEqual(notAllowlisted(shown));
  });

  /** A bare service named `service` mounting `volumes` (the fluent-bit and sentinel services are not in this set's render). */
  const mountedBy = (service: string, ...volumes: unknown[]) => (r: ComposeRender) => {
    r.services[service] = { volumes };
  };
  const forService = (service: string, ...messages: string[]) => messages.map((m) => `[${SET}] ${service}: ${REFUSED}: ${m}`);

  it("allows the mounts the stack ships (initdb, fluent-bit, sentinel) read-only by their own services, and a tmpfs", () => {
    expect(baseline().services.db.volumes).toContainEqual({ ...bind("<stub>/infra/postgres/initdb"), target: "/docker-entrypoint-initdb.d" });
    for (const { path, services } of FILE_CHANNEL_ALLOWLIST) {
      for (const service of services) {
        expect(drift(mountedBy(service, bind(`<stub>/${path}`), { type: "tmpfs", target: "/tmp" })), `${service} ${path}`).toEqual([]);
      }
    }
  });

  it("names an allowlisted path mounted by a service the entry does not name", () => {
    expect(drift(onApp(bind("<stub>/infra/postgres/initdb")))).toEqual(forService("app", 'a bind source "<root>/infra/postgres/initdb" is not allowlisted for this service'));
    expect(drift(mountedBy("sentinel-1", bind("<stub>/infra/postgres/initdb")))).toEqual(
      forService("sentinel-1", 'a bind source "<root>/infra/postgres/initdb" is not allowlisted for this service'),
    );
    expect(drift(mountedBy("sentinel-1", bind("<stub>/infra/redis/sentinel.conf")))).toEqual([]);
  });

  it("names a read-only allowlisted path mounted writable, and allows it read-only", () => {
    const writable = forService("db", 'a bind source "<root>/infra/postgres/initdb" is allowlisted read-only and is mounted writable');
    const initdb = { ...bind("<stub>/infra/postgres/initdb"), target: "/docker-entrypoint-initdb.d" };
    const onDb = (volume: unknown) => (r: ComposeRender) => void (r.services.db.volumes = [volume]);
    expect(drift(onDb({ ...initdb, read_only: false }))).toEqual(writable);
    expect(drift(onDb({ type: "bind", source: "<stub>/infra/postgres/initdb", target: "/docker-entrypoint-initdb.d", bind: {} }))).toEqual(writable);
    expect(drift(onDb({ ...initdb, read_only: true }))).toEqual([]);
  });

  it("names an ancestor of the project directory and a sibling, and allows an allowlisted path under another root", () => {
    const withRoot = (source: string, service = "app") => {
      const r = JSON.parse(JSON.stringify(baseline()).split("<stub>").join("/srv/app")) as ComposeRender;
      r.services[service].volumes = [bind(source)];
      return analyzeRender(SET, r, { ...ctx, projectRoot: "/srv/app" });
    };
    expect(withRoot("/srv")).toEqual(notAllowlisted("/srv"));
    expect(withRoot("/")).toEqual(notAllowlisted("/"));
    expect(withRoot("/srv/app-data")).toEqual(notAllowlisted("/srv/app-data"));
    expect(withRoot("/srv/app/infra/postgres/initdb", "db")).toEqual([]);
  });

  it("names every referenced secrets and configs entry, whatever it is filled from, and ignores one no service references", () => {
    const entries: Array<[string, Record<string, unknown>]> = [
      ["a .env file", { name: "compose-render_x", file: "<stub>/.env" }],
      ["another file", { name: "compose-render_x", file: "<stub>/secrets/token" }],
      ["an allowlisted file", { name: "compose-render_x", file: "<stub>/infra/fluent-bit/parsers.conf" }],
      ["inline content", { name: "compose-render_x", content: "x" }],
      ["an environment variable", { name: "compose-render_x", environment: "AUDIT_ANCHOR_SIGNING_KEY" }],
    ];
    for (const kind of ["secrets", "configs"] as const) {
      for (const [what, entry] of entries) {
        const found = drift((r) => {
          r[kind] = { x: entry };
          r.services["audit-outbox-worker"][kind] = [{ source: "x" }];
        });
        expect(found, `${kind} ${what}`).toEqual([`[${SET}] audit-outbox-worker: ${REFUSED}: ${kind} entry x is referenced`]);
      }
      expect(drift((r) => void (r[kind] = { x: { file: "<stub>/.env" } })), kind).toEqual([]);
    }
  });

  it("names a secrets or configs reference the render does not define, and an external entry", () => {
    expect(drift((r) => (r.services.app.secrets = [{ source: "gone" }]))).toEqual([`[${SET}] app: ${REFUSED}: secrets entry gone is referenced`]);
    expect(
      drift((r) => {
        r.configs = { x: { name: "x", external: true } };
        r.services.app.configs = [{ source: "x" }];
      }),
    ).toEqual([`[${SET}] app: ${REFUSED}: configs entry x is referenced`, `[${SET}] (top level): ${REFUSED}: configs entry x is external`]);
  });

  it("attributes a withheld value in a referenced entry's inline content to the service that references it", () => {
    const give = (r: ComposeRender) => {
      r.configs = { cfg: { name: "compose-render_cfg", content: sentinel("AUDIT_ANCHOR_SIGNING_KEY") } };
      r.services.app.configs = [{ source: "cfg" }];
    };
    expect(drift(give)).toEqual([`[${SET}] app: ${REFUSED}: configs entry cfg is referenced`, `[${SET}] app: holds withheld AUDIT_ANCHOR_SIGNING_KEY${NOT_GIVEN}`]);
    expect(drift((r) => void (r.configs = { cfg: { name: "compose-render_cfg", content: sentinel("AUDIT_ANCHOR_SIGNING_KEY") } }))).toEqual([]);
  });

  it("names a named volume with driver_opts, as compose renders a relative device, and allows the plain ones", () => {
    const redefine = (entry: Record<string, unknown>) => (r: ComposeRender) => void (r.volumes = { ...r.volumes, redis_data: entry });
    expect(drift(redefine({ name: "compose-render_redis_data", driver_opts: { device: ".", o: "bind", type: "none" } }))).toEqual([
      `[${SET}] redis: ${REFUSED}: named volume redis_data sets driver_opts`,
    ]);
    expect(drift(redefine({ name: "compose-render_redis_data", driver: "local" }))).toEqual([`[${SET}] redis: ${REFUSED}: named volume redis_data sets driver`]);
    expect(drift(redefine({ name: "compose-render_redis_data", labels: { a: "b" } }))).toEqual([]);
    const r = baseline();
    expect(r.volumes).toEqual({ postgres_data: { name: "compose-render_postgres_data" }, redis_data: { name: "compose-render_redis_data" } });
    expect(analyzeRender(SET, r, ctx)).toEqual([]);
  });

  it("names an explicit name: that is not <project>_<key>, and allows the one compose adds", () => {
    const renamed = (key: "postgres_data" | "redis_data", name: string) => (r: ComposeRender) => void (r.volumes = { ...r.volumes, [key]: { name } });
    const named = (service: string, key: string) => [`[${SET}] ${service}: ${REFUSED}: named volume ${key} sets name (not ${COMPOSE_PROJECT_NAME}_${key})`];
    expect(drift(renamed("redis_data", "redis_data"))).toEqual(named("redis", "redis_data"));
    expect(drift(renamed("redis_data", "someone_elses_redis_data"))).toEqual(named("redis", "redis_data"));
    expect(drift(renamed("postgres_data", "compose-render_redis_data"))).toEqual(named("db", "postgres_data"));
    expect(baseline().volumes).toEqual({ postgres_data: { name: "compose-render_postgres_data" }, redis_data: { name: "compose-render_redis_data" } });
  });

  it("names an external volume, and a named volume the render does not define", () => {
    expect(drift((r) => void (r.volumes = { ...r.volumes, redis_data: { name: "compose-render_redis_data", external: true } }))).toEqual([
      `[${SET}] (top level): ${REFUSED}: volumes entry redis_data is external`,
    ]);
    expect(drift(onApp({ type: "volume", source: "nowhere", target: "/x", volume: {} }))).toEqual([`[${SET}] app: ${REFUSED}: named volume nowhere is not defined by any compose file`]);
  });

  it("names a named volume mounted by a service its allowlist entry does not name, or by no entry, and allows today's mounts", () => {
    const volume = (source: string) => ({ type: "volume", source, target: "/x", volume: {} });
    const notForService = (service: string, name: string) => [`[${SET}] ${service}: ${REFUSED}: named volume ${name} is not allowlisted for this service`];
    expect(NAMED_VOLUME_ALLOWLIST).toEqual([
      { name: "postgres_data", services: ["db"] },
      { name: "redis_data", services: ["redis"] },
    ]);
    expect(drift(onApp(volume("postgres_data")))).toEqual(notForService("app", "postgres_data"));
    expect(drift((r) => void (r.services.redis.volumes = [volume("postgres_data")]))).toEqual(notForService("redis", "postgres_data"));
    expect(drift((r) => void (r.services.db.volumes = [volume("redis_data")]))).toEqual(notForService("db", "redis_data"));
    expect(
      drift((r) => {
        r.volumes = { ...r.volumes, anchors: { name: "compose-render_anchors" } };
        r.services.app.volumes = [volume("anchors")];
      }),
    ).toEqual([`[${SET}] app: ${REFUSED}: named volume anchors is not allowlisted`]);
    expect(baseline().services.db.volumes).toContainEqual({ type: "volume", source: "postgres_data", target: "/var/lib/postgresql/data", volume: {} });
    expect(baseline().services.redis.volumes).toEqual([{ type: "volume", source: "redis_data", target: "/data", volume: {} }]);
    expect(drift((r) => void (r.services.redis.volumes = [volume("redis_data"), { type: "tmpfs", target: "/tmp" }]))).toEqual([]);
  });

  it("names a logging driver or option outside the allowlists, by name, and allows the blocks the stack ships", () => {
    const PUBLISHER = "audit-anchor-publisher";
    const onPublisher = (logging: unknown) => (r: ComposeRender) => void (r.services[PUBLISHER].logging = logging);
    const refused = (what: string) => [`[${SET}] ${PUBLISHER}: ${SERVICE_KEY_REFUSAL}: ${what}`];
    const capped = { "max-file": "5", "max-size": "20m" };
    for (const key of ["env", "env-regex", "labels", "labels-regex"]) {
      expect(drift(onPublisher({ driver: "json-file", options: { ...capped, [key]: "AUDIT_ANCHOR_SIGNING_KEY" } })), key).toEqual(
        refused(`logging.options.${key} is not in LOGGING_OPTION_ALLOWLIST`),
      );
    }
    const tagRefusal = "logging.options.tag contains a template, which can expose the container's environment (every template is refused)";
    for (const tag of ["{{.ContainerEnv}}", "{{ .ContainerEnv }}", "{{index .ContainerEnv 0}}", "{{.Name}}"]) {
      expect(drift(onPublisher({ driver: "json-file", options: { ...capped, tag } })), tag).toEqual(refused(tagRefusal));
    }
    expect(drift(onPublisher({ driver: "json-file", options: { ...capped, tag: "app.passwd-sso" } }))).toEqual([]);
    const awslogs = { "awslogs-region": "ap-northeast-1", "awslogs-group": "/passwd-sso/audit", "awslogs-stream": "app", "awslogs-create-group": "true" };
    expect(drift(onPublisher({ driver: "awslogs", options: awslogs }))).toEqual([]);
    expect(drift(onPublisher({ driver: "awslogs", options: { ...awslogs, env: "AUDIT_ANCHOR_SIGNING_KEY" } }))).toEqual(refused("logging.options.env is not in LOGGING_OPTION_ALLOWLIST"));
    expect(drift(onPublisher({ driver: "gelf", options: capped }))).toEqual(refused("logging.driver gelf is not in LOGGING_DRIVER_ALLOWLIST"));
    expect(drift(onPublisher({ driver: "json-file", options: "env=X" }))).toEqual(refused("logging.options is not a mapping"));
    expect(baseline().services[PUBLISHER].logging).toEqual({ driver: "json-file", options: capped });
    const fluentd = {
      driver: "fluentd",
      options: { "fluentd-address": "localhost:24224", "fluentd-async": "true", "fluentd-retry-wait": "1s", "fluentd-max-retries": "30", tag: "app.passwd-sso" },
    };
    expect(drift(onPublisher(fluentd))).toEqual([]);
  });

  it("names build.secrets, build.ssh and build.additional_contexts, and allows the build the stack ships", () => {
    for (const [key, value] of [["secrets", [{ source: "envf" }]], ["ssh", [{ id: "default" }]], ["additional_contexts", { x: "<stub>" }]] as const) {
      const found = drift((r) => {
        r.secrets = { envf: { name: "compose-render_envf", file: "<stub>/.env" } };
        r.services.app.build = { ...(r.services.app.build as object), [key]: value };
      });
      expect(found, key).toEqual([`[${SET}] app: ${SERVICE_KEY_REFUSAL}: build.${key} is set`]);
    }
    expect(Object.keys(baseline().services.app.build as object)).toEqual(BUILD_KEY_ALLOWLIST);
  });

  it("names a service key outside SERVICE_KEY_ALLOWLIST, by name, and allows the keys the render has", () => {
    const refusedKey = (what: string) => [`[${SET}] app: ${SERVICE_KEY_REFUSAL}: ${what}`];
    const cases: Array<[string, unknown]> = [
      ["privileged", true],
      ["devices", ["/dev/sda:/dev/sda"]],
      ["device_cgroup_rules", ["c 1:3 mr"]],
      ["cap_add", ["SYS_ADMIN"]],
      ["pid", "service:audit-anchor-publisher"],
      ["pid", "host"],
      ["ipc", "host"],
      ["cgroup", "host"],
      ["userns_mode", "host"],
      ["volumes_from", ["audit-anchor-publisher"]],
      ["network_mode", "host"],
      ["x-anything", 1],
      ["a_future_key", 1],
    ];
    for (const [key, value] of cases) expect(drift((r) => void (r.services.app[key] = value)), `${key}: ${JSON.stringify(value)}`).toEqual(refusedKey(key));
    expect(Object.keys(baseline().services["audit-anchor-publisher"]).sort()).toContain("security_opt");
    expect(analyzeRender(SET, baseline(), ctx)).toEqual([]);
  });

  it("names a service key that is neither written in a production file nor in SERVICE_KEY_ALLOWLIST, so a render-time key from a newer compose is refused by name", () => {
    expect(SERVICE_KEY_ALLOWLIST).not.toContain("render_time_key");
    expect(drift((r) => void (r.services.app.render_time_key = true))).toEqual([`[${SET}] app: ${SERVICE_KEY_REFUSAL}: render_time_key`]);
  });

  it("names a security_opt that is not exactly no-new-privileges:true, and allows the publisher's and the verifier's", () => {
    const notExact = [`[${SET}] app: ${SERVICE_KEY_REFUSAL}: security_opt is not exactly ["no-new-privileges:true"]`];
    for (const value of [["seccomp=unconfined"], ["no-new-privileges:true", "apparmor=unconfined"], []]) {
      expect(drift((r) => void (r.services.app.security_opt = value)), JSON.stringify(value)).toEqual(notExact);
    }
    for (const service of ["audit-anchor-publisher", "audit-chain-verify-worker"]) expect(baseline().services[service].security_opt).toEqual(["no-new-privileges:true"]);
    expect(drift((r) => void (r.services.app.security_opt = ["no-new-privileges:true"]))).toEqual([]);
  });

  it("names a build whose context is not the project root, a dockerfile_inline, another dockerfile, and a build that is not a mapping", () => {
    const refusedBuild = (what: string) => [`[${SET}] app: ${SERVICE_KEY_REFUSAL}: ${what}`];
    const withBuild = (edit: Record<string, unknown>) => (r: ComposeRender) => void (r.services.app.build = { ...(r.services.app.build as object), ...edit });
    expect(baseline().services.app.build).toMatchObject({ context: "<stub>", dockerfile: "Dockerfile" });
    expect(drift(withBuild({ context: "<stub>/.." }))).toEqual(refusedBuild("build.context is not the project root"));
    expect(drift(withBuild({ context: "/srv/other" }))).toEqual(refusedBuild("build.context is not the project root"));
    expect(drift(withBuild({ context: "<stub>/infra" }))).toEqual(refusedBuild("build.context is not the project root"));
    expect(drift(withBuild({ dockerfile_inline: "FROM scratch" }))).toEqual(refusedBuild("build.dockerfile_inline is set"));
    expect(drift(withBuild({ dockerfile: "Dockerfile.dev" }))).toEqual(refusedBuild("build.dockerfile is not Dockerfile"));
    expect(drift(withBuild({ target: "deps" }))).toEqual(refusedBuild("build.target is set"));
    expect(drift((r) => void (r.services.app.build = "<stub>"))).toEqual(refusedBuild("build is not a mapping"));
    expect(drift(withBuild({ args: { X: "y" } }))).toEqual([]);
  });

  it("names a shape it does not model instead of skipping it", () => {
    expect(drift(onApp("<stub>:/x"))).toEqual([`[${SET}] app: has an unmodelled volume entry`]);
    expect(drift(onApp({ type: "bind", target: "/x" }))).toEqual([`[${SET}] app: has a bind volume without a source`]);
    expect(drift(onApp({ type: "npipe", source: "a", target: "b" }))).toEqual([`[${SET}] app: has a volume of unmodelled type npipe`]);
    expect(drift(onApp({ type: "image", source: "a", target: "b" }))).toEqual([`[${SET}] app: has a volume of unmodelled type image`]);
    expect(drift(onApp({ type: "tmpfs", target: "/x", extra: 1 }))).toEqual([`[${SET}] app: has a volume with unmodelled key extra`]);
    expect(drift((r) => (r.services.app.volumes = { x: 1 }))).toEqual([`[${SET}] app: has an unmodelled volumes value`]);
    expect(drift((r) => (r.services.app.secrets = [42]))).toEqual([`[${SET}] app: has an unmodelled secrets entry`]);
    expect(drift((r) => (r.services.app.configs = "cfg"))).toEqual([`[${SET}] app: has an unmodelled configs value`]);
  });

  it("does not judge the dev set, whose workers mount the project directory", () => {
    const r = baseline();
    r.services.app.volumes = [bind("<stub>")];
    r.services.app.privileged = true;
    r.volumes = { ...r.volumes, redis_data: { name: "compose-render_redis_data", external: true } };
    expect(analyzeRender("base+override", r, ctx)).toEqual([]);
    expect(analyzeRender("base+workers+logging", r, ctx)).toEqual([
      `[base+workers+logging] app: ${SERVICE_KEY_REFUSAL}: privileged`,
      `[base+workers+logging] app: ${REFUSED}: a bind source "<root>" is not allowlisted`,
      `[base+workers+logging] (top level): ${REFUSED}: volumes entry redis_data is external`,
    ]);
  });
});

describe("publisherEnvProblems", () => {
  const stubPublisherEnv = (): Record<string, string> => ({
    AUDIT_ANCHOR_PUBLISHER_ENABLED: "true",
    AUDIT_ANCHOR_PUBLISHER_DATABASE_URL: `postgresql://passwd_anchor_publisher:${sentinels.PASSWD_ANCHOR_PUBLISHER_PASSWORD.token}@db:5432/passwd_sso`,
    AUDIT_ANCHOR_SIGNING_KEY: sentinel("AUDIT_ANCHOR_SIGNING_KEY"),
    AUDIT_ANCHOR_TAG_SECRET: sentinel("AUDIT_ANCHOR_TAG_SECRET"),
    DEPLOYMENT_ID: sentinel("DEPLOYMENT_ID"),
    AUDIT_ANCHOR_DESTINATION_S3_BUCKET: "stub-audit-anchors",
    AUDIT_ANCHOR_DESTINATION_S3_PREFIX: "stub-prefix",
    AUDIT_ANCHOR_DESTINATION_GH_REPO: "",
    AUDIT_ANCHOR_DESTINATION_GH_TOKEN: "",
    AUDIT_ANCHOR_DESTINATION_FS_PATH: "",
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
    AWS_REGION: sentinel("AUDIT_ANCHOR_AWS_REGION"),
    DATABASE_URL: "",
  });

  it("accepts the stub-shaped publisher env: the stub passes the validator", () => {
    expect(publisherEnvProblems(stubPublisherEnv())).toEqual([]);
  });

  it("refuses an env with no destination", () => {
    const e = stubPublisherEnv();
    e.AUDIT_ANCHOR_DESTINATION_S3_BUCKET = "";
    expect(publisherEnvProblems(e)).toEqual(["buildDestinationsFromEnv refused the env (NO_DESTINATION_CONFIGURED)"]);
  });

  it("refuses a key that is not hex64", () => {
    const e = stubPublisherEnv();
    e.AUDIT_ANCHOR_SIGNING_KEY = "not-hex";
    const problems = publisherEnvProblems(e);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("fails auditAnchorPublisherEnvSchema at AUDIT_ANCHOR_SIGNING_KEY");
  });
});

describe("placeholderizeRender and hydrateRecordedRender", () => {
  const STUB = "/tmp/compose-render-AbCd12";
  const keys = ["AUDIT_ANCHOR_SIGNING_KEY", "PASSWD_APP_PASSWORD", "DEPLOYMENT_ID"];
  const sents = buildSentinels(keys);
  const live = (): ComposeRender => ({
    services: {
      app: {
        environment: { COMPOSE_RENDER_CANARY: CANARY_TOKEN, AUDIT_ANCHOR_SIGNING_KEY: sents.AUDIT_ANCHOR_SIGNING_KEY.value, DEPLOYMENT_ID: "" },
        volumes: [{ type: "bind", source: `${STUB}/infra/postgres/initdb`, target: "/x" }],
        command: ["sh", "-c", `psql postgresql://u:${sents.PASSWD_APP_PASSWORD.token}@db/x`],
      },
    },
  });

  it("holds neither the stub path nor a sentinel once placeholderized", () => {
    const text = JSON.stringify(placeholderizeRender(live(), sents, STUB));
    expect(text).not.toContain(STUB);
    for (const s of Object.values(sents)) expect(text).not.toContain(s.token);
    expect(text).not.toContain(CANARY_TOKEN);
    for (const k of ["AUDIT_ANCHOR_SIGNING_KEY", "PASSWD_APP_PASSWORD", "COMPOSE_RENDER_CANARY"]) expect(text).toContain(`{{${k}}}`);
    expect(text).toContain("<stub>/infra/postgres/initdb");
  });

  it("hydrates back to the live render, but for the stub path", () => {
    const back = hydrateRecordedRender(placeholderizeRender(live(), sents, STUB), sents);
    const expected = live();
    (expected.services.app.volumes as Array<{ source: string }>)[0].source = "<stub>/infra/postgres/initdb";
    expect(back).toEqual(expected);
  });
});

describe("parseRender", () => {
  it("returns a render with a services mapping", () => {
    expect(parseRender('{"services":{"app":{}}}')).toEqual({ services: { app: {} } });
  });

  it("names output that is not JSON, by size, without quoting it", () => {
    const stdout = "services: {AUDIT_ANCHOR_SIGNING_KEY: topsecretvalue";
    let message = "";
    try {
      parseRender(stdout);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(`compose config printed output that is not valid JSON (${stdout.length} bytes, not shown)`);
    expect(message).not.toContain("topsecretvalue");
  });

  it("names JSON with no services mapping", () => {
    for (const bad of ["null", "[]", '{"name":"x"}', '{"services":[]}', '{"services":null}']) {
      expect(() => parseRender(bad), bad).toThrow("compose config printed JSON with no services mapping (output not shown)");
    }
  });
});

describe("composeFilesOutsideRenderSets", () => {
  const sets = [{ files: ["docker-compose.yml", "docker-compose.a.yml"] }, { files: ["docker-compose.yml", "docker-compose.b.yml"] }];

  it("is empty when every file is in some set", () => {
    expect(composeFilesOutsideRenderSets(["docker-compose.a.yml", "docker-compose.b.yml", "docker-compose.yml"], sets)).toEqual([]);
  });

  it("names a file no set renders", () => {
    expect(composeFilesOutsideRenderSets(["docker-compose.yml", "docker-compose.z.yml", "deploy/docker-compose.yml"], sets)).toEqual([
      "deploy/docker-compose.yml",
      "docker-compose.z.yml",
    ]);
  });

  it("refuses an empty list instead of reporting it clean", () => {
    expect(() => composeFilesOutsideRenderSets([], sets)).toThrow("no compose files were found");
  });

  it("renders every non-fixture compose file of the tree", () => {
    const found = findComposeFiles(REPO_ROOT).map((f) => relative(REPO_ROOT, f));
    expect(found.length).toBeGreaterThan(0);
    expect(composeFilesOutsideRenderSets(found)).toEqual([]);
    expect(composeFilesOutsideRenderSets([...found, "docker-compose.extra.yml"])).toEqual(["docker-compose.extra.yml"]);
  });
});

describe("deploymentIdDrift", () => {
  const id = sentinels.DEPLOYMENT_ID.value;
  const other = "11111111-1111-4111-8111-111111111111";

  it("passes when the publisher and retention-gc hold the expected id", () => {
    expect(deploymentIdDrift(SET, baseline(), id)).toEqual([]);
  });

  it("names the service that holds a different id", () => {
    const r = baseline();
    env(r, "retention-gc-worker").DEPLOYMENT_ID = other;
    expect(deploymentIdDrift(SET, r, id)).toEqual([
      `[${SET}] retention-gc-worker: DEPLOYMENT_ID is not the one the publisher and the shell gave`,
    ]);
  });

  it("names a missing service", () => {
    const r = baseline();
    delete r.services["retention-gc-worker"];
    expect(deploymentIdDrift(SET, r, id)).toEqual([`[${SET}] retention-gc-worker: absent from the render`]);
  });
});

describe("the stub", () => {
  it("gives every key a distinct sentinel of its type, none inside another", () => {
    const tokens = Object.values(sentinels).filter((s) => s.scannable).map((s) => s.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const a of tokens) for (const b of tokens) if (a !== b) expect(a.includes(b), `${b} in ${a}`).toBe(false);
    expect(sentinels.AUDIT_ANCHOR_SIGNING_KEY.value).toMatch(/^[0-9a-f]{64}$/);
    expect(sentinels.AUDIT_ANCHOR_TAG_SECRET.value).toMatch(/^[0-9a-f]{64}$/);
    expect(sentinels.DEPLOYMENT_ID.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sentinels.PASSWD_APP_PASSWORD.value).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(sentinels.OUTBOX_WORKER_DATABASE_URL.value).toMatch(/^postgresql:\/\/[a-z0-9_]+:[A-Za-z0-9]{24}@/);
  });

  it("writes the canary and every sentinel, and omits a named variable", () => {
    const text = stubEnvText(sentinels);
    expect(text).toContain(`COMPOSE_RENDER_CANARY=${CANARY_TOKEN}`);
    expect(text).toContain(`DEPLOYMENT_ID=${sentinels.DEPLOYMENT_ID.value}`);
    const without = stubEnvText(sentinels, ["DEPLOYMENT_ID"]);
    expect(without).not.toContain("DEPLOYMENT_ID=");
    expect(without).toContain("AUDIT_ANCHOR_SIGNING_KEY=");
  });
});

describe("requiredVariables", () => {
  it("finds each ${VAR:?...} once, and not ${VAR:-} or ${VAR}", () => {
    const text = "a: ${A:?A is required} b: ${A:?again} c: ${B:-} d: ${C} e: ${D_1:?x}";
    expect(requiredVariables([text])).toEqual(["A", "D_1"]);
  });

  it("finds the ones the real compose files declare, including the publisher's", () => {
    const texts = RENDER_SETS.flatMap((s) => s.files).map((f) => readFileSync(join(REPO_ROOT, f), "utf8"));
    expect(requiredVariables(texts)).toEqual(
      expect.arrayContaining(["AUDIT_ANCHOR_SIGNING_KEY", "AUDIT_ANCHOR_TAG_SECRET", "DEPLOYMENT_ID", "PASSWD_ANCHOR_PUBLISHER_PASSWORD", "PASSWD_AUDIT_CHAIN_VERIFIER_PASSWORD"]),
    );
  });
});

describe("scrubbedEnv", () => {
  it("keeps what finding docker needs and drops shell values and COMPOSE_*", () => {
    const out = scrubbedEnv({ PATH: "/bin", HOME: "/h", DOCKER_HOST: "unix:///x", COMPOSE_FILE: "evil.yml", DEPLOYMENT_ID: "shell", AUDIT_ANCHOR_SIGNING_KEY: "k" });
    expect(out).toEqual({ PATH: "/bin", HOME: "/h", DOCKER_HOST: "unix:///x" });
  });

  it("adds a deliberate override on top", () => {
    expect(scrubbedEnv({ PATH: "/bin" }, { DEPLOYMENT_ID: "x" })).toEqual({ PATH: "/bin", DEPLOYMENT_ID: "x" });
  });
});

describe("docker availability", () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());

  const noDocker = { ...process.env, COMPOSE_RENDER_DOCKER_BIN: "/nonexistent/docker" };

  it("fails without docker when CI=true", () => {
    expect(main([], { ...noDocker, CI: "true" })).toBe(1);
    expect(err.join("\n")).toContain("docker compose is not available and CI=true");
  });

  it("prints a visible SKIPPED line without docker when CI is not true", () => {
    expect(main([], { ...noDocker, CI: "" })).toBe(0);
    expect(out.join("\n")).toContain("SKIPPED");
  });

  it("names a compose that prints output that is not JSON, without printing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-render-fake-docker-"));
    try {
      const fake = join(dir, "docker");
      writeFileSync(fake, '#!/bin/sh\nif [ "$2" = "version" ]; then echo "Docker Compose version v0.0.0"; exit 0; fi\necho "AUDIT_ANCHOR_SIGNING_KEY=topsecretvalue"\n');
      chmodSync(fake, 0o755);
      expect(main([], { ...process.env, COMPOSE_RENDER_DOCKER_BIN: fake, CI: "true" })).toBe(1);
      const text = err.join("\n");
      for (const set of RENDER_SETS) expect(text).toContain(`[${set.name}] compose config printed output that is not valid JSON (`);
      expect(text).toContain("[base+workers] under a DEPLOYMENT_ID override: compose config printed output that is not valid JSON (");
      expect(text).not.toContain("topsecretvalue");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Real compose ───────────────────────────────────────────

const dockerAvailable = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

/**
 * What the fixture pins, with the compose version left out: the service-name set,
 * each service's environment, volumes, secrets and configs, and the top-level
 * volumes, secrets and configs.
 */
function renderProjection(render: ComposeRender) {
  const names = Object.keys(render.services).sort();
  return {
    services: names,
    environment: Object.fromEntries(names.map((n) => [n, render.services[n].environment ?? {}])),
    fileChannels: Object.fromEntries(names.map((n) => [n, { volumes: render.services[n].volumes ?? [], secrets: render.services[n].secrets ?? [], configs: render.services[n].configs ?? [] }])),
    volumes: render.volumes ?? {},
    secrets: render.secrets ?? {},
    configs: render.configs ?? {},
  };
}

/** A recorded file, hydrated with sentinels covering every key it was recorded with. */
function recordedProjection(path: string) {
  const file = JSON.parse(readFileSync(path, "utf8")) as Recorded;
  const keys = [...new Set([...JSON.stringify(file.render).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))];
  return renderProjection(hydrateRecordedRender(file.render, buildSentinels([...withheld, ...file.withheld, ...keys, "DEPLOYMENT_ID"])));
}

const RE_RECORD_COMMAND = "npx tsx scripts/checks/check-compose-render.ts --record scripts/__tests__/fixtures/compose-render/workers-render.json";

/**
 * How a re-record of the tree is compared to the committed fixture. Under
 * CI=true a compose version other than the fixture's (or none) fails: the full
 * comparison would otherwise silently degrade to the projection for good.
 * Locally it warns and compares the projection.
 */
function fixtureComparison(running: string | null, recordedVersion: string | null, ci: boolean): { mode: "full" } | { mode: "projection"; warning: string } | { mode: "fail"; message: string } {
  if (running !== null && running === recordedVersion) return { mode: "full" };
  const note = `compose-render fixture: recorded under "${recordedVersion}", running "${running}"`;
  if (ci) return { mode: "fail", message: `${note}: CI must run the fixture's compose version for the full comparison; re-record with: ${RE_RECORD_COMMAND}` };
  return { mode: "projection", warning: `${note}: comparing the projection only, not the full render` };
}

/**
 * The whole recorded file but its compose version: the set, W, and every service
 * and top-level key of the render, hydrated.
 */
function recordedFull(path: string) {
  const { composeVersion: _version, ...file } = JSON.parse(readFileSync(path, "utf8")) as Recorded;
  const keys = [...new Set([...JSON.stringify(file.render).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))];
  return { ...file, render: hydrateRecordedRender(file.render, buildSentinels([...withheld, ...file.withheld, ...keys, "DEPLOYMENT_ID"])) };
}

describe("fixtureComparison", () => {
  const V = "Docker Compose version v5.0.2";
  it("runs the full comparison on the fixture's version, in CI or not", () => {
    expect(fixtureComparison(V, V, true)).toEqual({ mode: "full" });
    expect(fixtureComparison(V, V, false)).toEqual({ mode: "full" });
  });

  it("fails in CI, naming both versions and the re-record command, on a different or null version", () => {
    for (const running of ["Docker Compose version v9.9.9", null]) {
      expect(fixtureComparison(running, V, true)).toEqual({
        mode: "fail",
        message: `compose-render fixture: recorded under "${V}", running "${running}": CI must run the fixture's compose version for the full comparison; re-record with: ${RE_RECORD_COMMAND}`,
      });
    }
  });

  it("warns and compares the projection locally on a different or null version", () => {
    for (const running of ["Docker Compose version v9.9.9", null]) {
      expect(fixtureComparison(running, V, false)).toEqual({
        mode: "projection",
        warning: `compose-render fixture: recorded under "${V}", running "${running}": comparing the projection only, not the full render`,
      });
    }
  });
});

describe("real docker compose", () => {
  let out: string[];
  let err: string[];
  const scratches: string[] = [];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of scratches.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** The compose files and the allowlisted files they mount, copied to a scratch dir, so a mutation never touches the tree. */
  function scratchCopy(): string {
    const dir = mkdtempSync(join(tmpdir(), "compose-render-test-"));
    scratches.push(dir);
    for (const f of readdirSync(REPO_ROOT).filter((n) => /^docker-compose.*\.yml$/.test(n))) cpSync(join(REPO_ROOT, f), join(dir, f));
    for (const { path } of FILE_CHANNEL_ALLOWLIST) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      cpSync(join(REPO_ROOT, path), join(dir, path), { recursive: true });
    }
    return dir;
  }

  function requireDocker(skip: () => void): boolean {
    if (dockerAvailable) return true;
    if (process.env.CI === "true") throw new Error("docker compose is not available and CI=true: the real-render cases cannot be skipped in CI");
    skip();
    return false;
  }

  it("renders the tree's four sets clean", (t) => {
    if (!requireDocker(() => t.skip())) return;
    expect(main([]), err.join("\n")).toBe(0);
    expect(out.join("\n")).toMatch(/Docker Compose version/);
    for (const set of RENDER_SETS) expect(out.join("\n")).toContain(`${set.name}:`);
  }, 120_000);

  /** Re-records the tree under `env` and compares it to the committed fixture as fixtureComparison says. */
  function compareToFixture(env: NodeJS.ProcessEnv): void {
    const record = join(scratchCopy(), "record.json");
    expect(main(["--record", record], env), err.join("\n")).toBe(0);
    const running = (JSON.parse(readFileSync(record, "utf8")) as Recorded).composeVersion;
    const verdict = fixtureComparison(running, recorded.composeVersion, env.CI === "true");
    if (verdict.mode === "fail") throw new Error(verdict.message);
    if (verdict.mode === "full") {
      // Same compose: every service, every key and the top-level keys, so a key the projection does not list is compared too.
      expect(recordedFull(record)).toEqual(recordedFull(FIXTURE_PATH));
    } else {
      console.warn(verdict.warning);
      expect(recordedProjection(record)).toEqual(recordedProjection(FIXTURE_PATH));
    }
  }

  it("re-records the render of the tree as the committed fixture holds it", (t) => {
    if (!requireDocker(() => t.skip())) return;
    compareToFixture(process.env);
  }, 120_000);

  it("fails under CI=true and only warns locally when the compose in use is not the fixture's version", (t) => {
    if (!requireDocker(() => t.skip())) return;
    const real = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "compose-render-fake-docker-"));
    try {
      const fake = join(dir, "docker");
      writeFileSync(fake, `#!/bin/sh\nif [ "$2" = "version" ]; then echo "Docker Compose version v0.0.0"; exit 0; fi\nexec ${real} "$@"\n`);
      chmodSync(fake, 0o755);
      expect(recorded.composeVersion).not.toBe("Docker Compose version v0.0.0");
      const env = { ...process.env, COMPOSE_RENDER_DOCKER_BIN: fake };
      expect(() => compareToFixture({ ...env, CI: "true" })).toThrow(
        `recorded under "${recorded.composeVersion}", running "Docker Compose version v0.0.0": CI must run the fixture's compose version for the full comparison; re-record with: ${RE_RECORD_COMMAND}`,
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      compareToFixture({ ...env, CI: "" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`running "Docker Compose version v0.0.0": comparing the projection only`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it("finds the committed fixture stale under the full comparison against a scratch copy whose app gains read_only, which the projection does not list", (t) => {
    if (!requireDocker(() => t.skip())) return;
    const dir = scratchCopy();
    const path = join(dir, "docker-compose.yml");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("services:\n  app:\n");
    writeFileSync(path, text.replace("services:\n  app:\n", "services:\n  app:\n    read_only: true\n"));
    const record = join(dir, "record.json");
    expect(main(["--root", dir, "--record", record]), err.join("\n")).toBe(0);
    expect(recordedFull(record).render.services.app).toHaveProperty("read_only", true);
    expect(recordedProjection(record)).toEqual(recordedProjection(FIXTURE_PATH));
    expect(recordedFull(record)).not.toEqual(recordedFull(FIXTURE_PATH));
  }, 120_000);

  it("fails, naming the key, when the compose in use renders a service key no production file writes and SERVICE_KEY_ALLOWLIST does not list", (t) => {
    if (!requireDocker(() => t.skip())) return;
    const real = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim();
    const dir = mkdtempSync(join(tmpdir(), "compose-render-fake-docker-"));
    try {
      const inject = 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); j.services.app.render_time_key = true; process.stdout.write(JSON.stringify(j));';
      const fake = join(dir, "docker");
      writeFileSync(
        fake,
        `#!/bin/sh\nif [ "$2" = "version" ]; then exec ${real} "$@"; fi\nout=$(${real} "$@"); rc=$?\nif [ $rc -eq 0 ]; then printf '%s' "$out" | ${process.execPath} -e '${inject}'; else printf '%s' "$out"; fi\nexit $rc\n`,
      );
      chmodSync(fake, 0o755);
      expect(SERVICE_KEY_ALLOWLIST).not.toContain("render_time_key");
      expect(main([], { ...process.env, COMPOSE_RENDER_DOCKER_BIN: fake, CI: "true" })).toBe(1);
      const text = err.join("\n");
      for (const set of RENDER_SETS.filter((s) => s.name !== "base+override")) expect(text).toContain(`[${set.name}] app: ${SERVICE_KEY_REFUSAL}: render_time_key`);
      expect(text).not.toContain("[base+override] app");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("finds the committed fixture stale against a scratch copy whose app gains an env entry", (t) => {
    if (!requireDocker(() => t.skip())) return;
    const dir = scratchCopy();
    const path = join(dir, "docker-compose.yml");
    const text = readFileSync(path, "utf8");
    const anchor = "      - AUDIT_ANCHOR_SIGNING_KEY=\n";
    expect(text).toContain(anchor);
    writeFileSync(path, text.replace(anchor, `${anchor}      - COMPOSE_RENDER_EXTRA=1\n`));
    const record = join(dir, "record.json");
    expect(main(["--root", dir, "--record", record]), err.join("\n")).toBe(0);
    const fresh = recordedProjection(record);
    expect(fresh.environment.app).toHaveProperty("COMPOSE_RENDER_EXTRA", "1");
    expect(fresh).not.toEqual(recordedProjection(FIXTURE_PATH));
  }, 120_000);

  it("finds the committed fixture stale against a scratch copy whose db gains a second allowlisted bind", (t) => {
    if (!requireDocker(() => t.skip())) return;
    const dir = scratchCopy();
    const path = join(dir, "docker-compose.yml");
    const text = readFileSync(path, "utf8");
    const anchor = "      - ./infra/postgres/initdb:/docker-entrypoint-initdb.d:ro\n";
    expect(text).toContain(anchor);
    writeFileSync(path, text.replace(anchor, `${anchor}      - ./infra/postgres/initdb:/mnt/initdb:ro\n`));
    const record = join(dir, "record.json");
    expect(main(["--root", dir, "--record", record]), err.join("\n")).toBe(0);
    const fresh = recordedProjection(record);
    expect(fresh.fileChannels.db.volumes).toContainEqual({ type: "bind", source: "<stub>/infra/postgres/initdb", target: "/mnt/initdb", read_only: true, bind: {} });
    expect(recordedProjection(FIXTURE_PATH).fileChannels.db.volumes).not.toContainEqual(expect.objectContaining({ target: "/mnt/initdb" }));
    expect(fresh).not.toEqual(recordedProjection(FIXTURE_PATH));
  }, 120_000);

  it("fails a scratch copy with a compose file no render set renders, and passes the copy without it", (t) => {
    if (!requireDocker(() => t.skip())) return;
    const dir = scratchCopy();
    expect(main(["--root", dir]), err.join("\n")).toBe(0);
    mkdirSync(join(dir, "deploy"));
    writeFileSync(join(dir, "deploy/compose.yaml"), "services: {}\n");
    err.length = 0;
    expect(main(["--root", dir])).toBe(1);
    expect(err.join("\n")).toContain("1 failure(s):\n  - deploy/compose.yaml: a compose file no render set renders");
  }, 120_000);

  /** The tree's compose files with `edit` applied to docker-compose.yml; main() must fail, naming `expected` among its failures. */
  function expectChannelRefused(edit: (text: string) => string, expected: string) {
    const dir = scratchCopy();
    const path = join(dir, "docker-compose.yml");
    const text = readFileSync(path, "utf8");
    writeFileSync(path, edit(text));
    err.length = 0;
    expect(main(["--root", dir])).toBe(1);
    expect(err.join("\n")).toContain(expected);
  }
  const onApp = (extra: string) => (text: string) => text.replace("services:\n  app:\n", `services:\n  app:\n${extra}`);
  const REFUSED = "has a file channel outside FILE_CHANNEL_ALLOWLIST";

  it("fails scratch copies of the tree that open each file channel the allowlist closes", (t) => {
    if (!requireDocker(() => t.skip())) return;
    expectChannelRefused(
      (x) => onApp("    configs:\n      - cfg\n")(x) + "\nconfigs:\n  cfg:\n    content: ${AUDIT_ANCHOR_SIGNING_KEY}\n",
      `[base+workers] app: holds withheld AUDIT_ANCHOR_SIGNING_KEY, which is not given to this service`,
    );
    expectChannelRefused(onApp("    volumes:\n      - /opt:/mnt/x:ro\n"), `[base+workers] app: ${REFUSED}: a bind source "/opt" is not allowlisted`);
    expectChannelRefused(onApp("    volumes:\n      - ~/x:/mnt/x:ro\n"), `[base+workers] app: ${REFUSED}: a bind source "`);
    expectChannelRefused(
      (x) => x.replace("  redis_data:\n", "  redis_data:\n    driver_opts:\n      type: none\n      o: bind\n      device: .\n"),
      `[base+workers] redis: ${REFUSED}: named volume redis_data sets driver_opts`,
    );
    expectChannelRefused(
      (x) => x.replace("  app:\n    build:\n      context: .\n", "  app:\n    build:\n      context: .\n      secrets:\n        - envf\n") + "\nsecrets:\n  envf:\n    file: ./.env\n",
      `[base+workers] app: ${SERVICE_KEY_REFUSAL}: build.secrets is set`,
    );
    expectChannelRefused((x) => x.replace("  redis_data:\n", "  redis_data:\n    external: true\n"), `[base+workers] (top level): ${REFUSED}: volumes entry redis_data is external`);
    expectChannelRefused(onApp("    volumes:\n      - ./infra/postgres/initdb:/mnt/x:ro\n"), `[base+workers] app: ${REFUSED}: a bind source "<root>/infra/postgres/initdb" is not allowlisted for this service`);
    expectChannelRefused((x) => x.replace("./infra/postgres/initdb:/docker-entrypoint-initdb.d:ro", "./infra/postgres/initdb:/docker-entrypoint-initdb.d"), `[base+workers] db: ${REFUSED}: a bind source "<root>/infra/postgres/initdb" is allowlisted read-only and is mounted writable`);
    expectChannelRefused((x) => x.replace("  redis_data:\n", "  redis_data:\n    name: postgres_data\n"), `[base+workers] redis: ${REFUSED}: named volume redis_data sets name (not compose-render_redis_data)`);
  }, 600_000);

  it("fails scratch copies of the tree whose app gains a service key outside SERVICE_KEY_ALLOWLIST", (t) => {
    if (!requireDocker(() => t.skip())) return;
    const refusedKey = (what: string) => `[base+workers] app: ${SERVICE_KEY_REFUSAL}: ${what}`;
    expectChannelRefused(onApp("    privileged: true\n"), refusedKey("privileged"));
    expectChannelRefused(onApp("    pid: service:audit-anchor-publisher\n"), refusedKey("pid"));
    expectChannelRefused(onApp("    pid: host\n"), refusedKey("pid"));
    expectChannelRefused(onApp("    volumes_from:\n      - redis\n"), refusedKey("volumes_from"));
    expectChannelRefused(onApp("    cap_add:\n      - SYS_ADMIN\n"), refusedKey("cap_add"));
    expectChannelRefused(onApp("    security_opt:\n      - seccomp=unconfined\n"), refusedKey('security_opt is not exactly ["no-new-privileges:true"]'));
    expectChannelRefused((x) => x.replace("  app:\n    build:\n      context: .\n", "  app:\n    build:\n      context: ..\n"), refusedKey("build.context is not the project root"));
    expectChannelRefused(
      (x) => x.replace("  app:\n    build:\n      context: .\n      dockerfile: Dockerfile\n", "  app:\n    build:\n      context: .\n      dockerfile_inline: FROM scratch\n"),
      refusedKey("build.dockerfile_inline is set"),
    );
  }, 600_000);

  it("fails a scratch root whose allowlisted file is a symlink to .env, or is gone, and passes the intact copy", (t) => {
    if (!requireDocker(() => t.skip())) return;
    const fluent = "infra/fluent-bit/parsers.conf";
    const linked = scratchCopy();
    expect(main(["--root", linked]), err.join("\n")).toBe(0);
    writeFileSync(join(linked, ".env"), "");
    rmSync(join(linked, fluent));
    symlinkSync(join(linked, ".env"), join(linked, fluent));
    err.length = 0;
    expect(main(["--root", linked])).toBe(1);
    expect(err.join("\n")).toContain(`allowlist ${fluent}: is, or sits under, a symlink`);
    const gone = scratchCopy();
    rmSync(join(gone, fluent));
    err.length = 0;
    expect(main(["--root", gone])).toBe(1);
    expect(err.join("\n")).toContain(`allowlist ${fluent}: does not exist`);
  }, 600_000);

  it("fails a scratch copy of the tree that stops blanking a withheld key in app", (t) => {
    if (!requireDocker(() => t.skip())) return;
    const dir = scratchCopy();
    const path = join(dir, "docker-compose.yml");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("      - AUDIT_ANCHOR_SIGNING_KEY=\n");
    writeFileSync(path, text.replace("      - AUDIT_ANCHOR_SIGNING_KEY=\n", ""));
    expect(main(["--root", dir])).toBe(1);
    expect(err.join("\n")).toContain("app: AUDIT_ANCHOR_SIGNING_KEY is not blanked");
  }, 120_000);

  it("fails a scratch copy whose required variable no longer fails the render", (t) => {
    if (!requireDocker(() => t.skip())) return;
    const dir = scratchCopy();
    const path = join(dir, "docker-compose.workers.yml");
    const text = readFileSync(path, "utf8");
    const strong = "${DEPLOYMENT_ID:?DEPLOYMENT_ID is required}";
    expect(text).toContain(strong);
    writeFileSync(path, text.replace(strong, "${DEPLOYMENT_ID:-}"));
    expect(main(["--root", dir])).toBe(1);
    expect(err.join("\n")).toContain("removing DEPLOYMENT_ID did not fail the render");
  }, 120_000);

  it("fails a scratch copy where retention-gc stops reading DEPLOYMENT_ID the way the publisher does", (t) => {
    if (!requireDocker(() => t.skip())) return;
    const dir = scratchCopy();
    const path = join(dir, "docker-compose.workers.yml");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("      - DEPLOYMENT_ID=${DEPLOYMENT_ID:-}\n");
    writeFileSync(path, text.replace("      - DEPLOYMENT_ID=${DEPLOYMENT_ID:-}\n", "      - DEPLOYMENT_ID=00000000-0000-4000-8000-000000000000\n"));
    expect(main(["--root", dir])).toBe(1);
    expect(err.join("\n")).toContain("retention-gc-worker: DEPLOYMENT_ID is not the one");
  }, 120_000);
});

/**
 * fixtureComparison hard-fails under CI=true when the runner's compose differs
 * from the fixture's, so the workflow installs one pinned version. These pin
 * that version, per job, to the fixture's.
 */
const COMPOSE_PIN_JOBS = ["static-checks", "app-test"];
const COMPOSE_PIN_STEP = "Install docker compose (pinned)";
const realCiText = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

/** Problems with the compose pin in a ci.yml text, against the fixture's recorded version line. */
function composePinProblems(ciText: string, fixtureVersion: string | null): string[] {
  const jobs = (load(ciText) as { jobs: Record<string, { steps: { name?: string; run?: string }[] }> }).jobs;
  const problems: string[] = [];
  const pins: Record<string, { version: string; sha: string }> = {};
  for (const job of COMPOSE_PIN_JOBS) {
    const steps = (jobs[job]?.steps ?? []).filter((s) => s.name === COMPOSE_PIN_STEP);
    if (steps.length !== 1) {
      problems.push(`${job} has ${steps.length} "${COMPOSE_PIN_STEP}" steps, not 1`);
      continue;
    }
    const version = /^\s*COMPOSE_VERSION=(\S+)$/m.exec(steps[0].run ?? "")?.[1];
    const sha = /^\s*COMPOSE_SHA256=([0-9a-f]{64})$/m.exec(steps[0].run ?? "")?.[1];
    if (!version || !sha) problems.push(`${job} does not set COMPOSE_VERSION and a 64-hex COMPOSE_SHA256`);
    else pins[job] = { version, sha };
  }
  const found = Object.values(pins);
  if (new Set(found.map((p) => `${p.version} ${p.sha}`)).size > 1) problems.push("the jobs pin different compose versions or checksums");
  for (const [job, pin] of Object.entries(pins)) {
    if (fixtureVersion !== `Docker Compose version ${pin.version}`) problems.push(`${job} pins ${pin.version}, the fixture was recorded under "${fixtureVersion}"`);
  }
  return problems;
}

describe("CI compose pin", () => {
  it("matches the fixture's composeVersion in both jobs, with one version and checksum", () => {
    expect(composePinProblems(realCiText, recorded.composeVersion)).toEqual([]);
  });

  it("is refused when ci.yml alone moves to another version", () => {
    const text = realCiText.replaceAll("COMPOSE_VERSION=v5.0.2", "COMPOSE_VERSION=v5.0.3");
    expect(text).not.toBe(realCiText);
    expect(composePinProblems(text, recorded.composeVersion)).toEqual([
      `static-checks pins v5.0.3, the fixture was recorded under "${recorded.composeVersion}"`,
      `app-test pins v5.0.3, the fixture was recorded under "${recorded.composeVersion}"`,
    ]);
  });

  it("is refused when only the fixture's version changes", () => {
    expect(composePinProblems(realCiText, "Docker Compose version v5.0.3")).toEqual([
      'static-checks pins v5.0.2, the fixture was recorded under "Docker Compose version v5.0.3"',
      'app-test pins v5.0.2, the fixture was recorded under "Docker Compose version v5.0.3"',
    ]);
  });

  it("is refused when the two jobs disagree on the version or the checksum", () => {
    const first = realCiText.indexOf("COMPOSE_VERSION=v5.0.2");
    const second = realCiText.indexOf("COMPOSE_VERSION=v5.0.2", first + 1);
    expect(second).toBeGreaterThan(first);
    const versionSkew = realCiText.slice(0, second) + "COMPOSE_VERSION=v5.0.3" + realCiText.slice(second + "COMPOSE_VERSION=v5.0.2".length);
    expect(composePinProblems(versionSkew, recorded.composeVersion)).toEqual([
      "the jobs pin different compose versions or checksums",
      `app-test pins v5.0.3, the fixture was recorded under "${recorded.composeVersion}"`,
    ]);
    const sha = /COMPOSE_SHA256=([0-9a-f]{64})/.exec(realCiText)![1];
    const at = realCiText.lastIndexOf(sha);
    const shaSkew = realCiText.slice(0, at) + "0".repeat(64) + realCiText.slice(at + 64);
    expect(composePinProblems(shaSkew, recorded.composeVersion)).toEqual(["the jobs pin different compose versions or checksums"]);
  });

  it("is refused when a job loses the step", () => {
    const text = realCiText.replace(`- name: ${COMPOSE_PIN_STEP}`, "- name: Something else");
    expect(composePinProblems(text, recorded.composeVersion)).toEqual([`static-checks has 0 "${COMPOSE_PIN_STEP}" steps, not 1`]);
  });
});
