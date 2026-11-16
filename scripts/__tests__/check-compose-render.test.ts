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
import { chmodSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  CANARY_TOKEN,
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
import { findComposeFiles } from "../checks/check-compose-log-caps.mjs";
import {
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

describe("analyzeRender: .env delivered as a file", () => {
  const MOUNT = "holds .env by file mount";
  const bind = (source: string) => ({ type: "bind", source, target: "/mnt/x", read_only: true, bind: {} });

  it("names a bind mount of the project directory on app", () => {
    expect(drift((r) => (r.services.app.volumes = [bind("<stub>")]))).toEqual([`[${SET}] app: ${MOUNT}: a bind source is the project directory`]);
  });

  it("names a bind mount of the project's .env and of any .env* file, and allows the mounts the stack ships", () => {
    expect(drift((r) => (r.services.app.volumes = [bind("<stub>/.env")]))).toEqual([`[${SET}] app: ${MOUNT}: a bind source is a .env file`]);
    expect(drift((r) => (r.services.app.volumes = [bind("/srv/other/.env.production")]))).toEqual([`[${SET}] app: ${MOUNT}: a bind source is a .env file`]);
    // The fluent-bit config mounts, the db initdb mount (already in the render) and a tmpfs.
    expect(
      drift((r) => {
        r.services.app.volumes = [bind("<stub>/infra/fluent-bit/fluent-bit.conf"), bind("<stub>/infra/fluent-bit/parsers.conf"), { type: "tmpfs", target: "/tmp" }];
      }),
    ).toEqual([]);
  });

  it("names a bind mount of an ancestor of the project directory, and allows a sibling directory", () => {
    const withRoot = (source: string) => {
      const r = baseline();
      r.services.app.volumes = [bind(source)];
      return analyzeRender(SET, r, { ...ctx, projectRoot: "/srv/app" });
    };
    expect(withRoot("/srv")).toEqual([`[${SET}] app: ${MOUNT}: a bind source is an ancestor of the project directory`]);
    expect(withRoot("/")).toEqual([`[${SET}] app: ${MOUNT}: a bind source is an ancestor of the project directory`]);
    expect(withRoot("/srv/app-data")).toEqual([]);
  });

  it("names a secrets entry whose file is the .env, on the outbox worker, and allows a file beside it", () => {
    const give = (file: string) => (r: ComposeRender) => {
      r.secrets = { signing: { file } };
      r.services["audit-outbox-worker"].secrets = [{ source: "signing", target: "signing" }];
    };
    expect(drift(give("<stub>/.env"))).toEqual([`[${SET}] audit-outbox-worker: ${MOUNT}: the file of secrets entry signing is a .env file`]);
    expect(drift(give("<stub>/secrets/token"))).toEqual([]);
  });

  it("names a configs entry whose file is the project directory, and ignores an entry no service references", () => {
    expect(
      drift((r) => {
        r.configs = { cfg: { file: "<stub>" } };
        r.services.app.configs = [{ source: "cfg" }];
      }),
    ).toEqual([`[${SET}] app: ${MOUNT}: the file of configs entry cfg is the project directory`]);
    expect(drift((r) => (r.configs = { cfg: { file: "<stub>" } }))).toEqual([]);
  });

  it("names a named volume backed by a bind of the project directory, and allows one backed by another path", () => {
    const back = (device: string) => (r: ComposeRender) => {
      r.volumes = { ...r.volumes, postgres_data: { driver_opts: { type: "none", o: "bind", device } } };
    };
    expect(drift(back("<stub>"))).toEqual([`[${SET}] db: ${MOUNT}: the device of named volume postgres_data is the project directory`]);
    expect(drift(back("<stub>/data"))).toEqual([]);
  });

  it("names a shape it does not model instead of skipping it", () => {
    expect(drift((r) => (r.services.app.volumes = ["<stub>:/x"]))).toEqual([`[${SET}] app: has an unmodelled volume entry`]);
    expect(drift((r) => (r.services.app.volumes = [{ type: "bind", target: "/x" }]))).toEqual([`[${SET}] app: has a bind volume without a source`]);
    expect(drift((r) => (r.services.app.volumes = [{ type: "npipe", source: "a", target: "b" }]))).toEqual([`[${SET}] app: has a volume of unmodelled type npipe`]);
    expect(drift((r) => (r.services.app.volumes = { x: 1 }))).toEqual([`[${SET}] app: has an unmodelled volumes value`]);
    expect(drift((r) => (r.services.app.secrets = [{ source: "gone" }]))).toEqual([`[${SET}] app: references a secrets entry the render does not define`]);
    expect(
      drift((r) => {
        r.secrets = { fromEnv: { environment: "AUDIT_ANCHOR_SIGNING_KEY" } };
        r.services.app.secrets = [{ source: "fromEnv" }];
      }),
    ).toEqual([`[${SET}] app: ${MOUNT}: secrets entry fromEnv is filled from an environment variable`]);
  });

  it("does not judge the dev set, whose workers mount the project directory", () => {
    const r = baseline();
    r.services.app.volumes = [bind("<stub>")];
    expect(analyzeRender("base+override", r, ctx)).toEqual([]);
    expect(analyzeRender("base+workers+logging", r, ctx)).toEqual([`[base+workers+logging] app: ${MOUNT}: a bind source is the project directory`]);
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

/** Each service's environment and the service-name set: what the fixture pins, with the compose version left out. */
function renderProjection(render: ComposeRender) {
  const names = Object.keys(render.services).sort();
  return { services: names, environment: Object.fromEntries(names.map((n) => [n, render.services[n].environment ?? {}])) };
}

/** A recorded file, hydrated with sentinels covering every key it was recorded with. */
function recordedProjection(path: string) {
  const file = JSON.parse(readFileSync(path, "utf8")) as Recorded;
  const keys = [...new Set([...JSON.stringify(file.render).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))];
  return renderProjection(hydrateRecordedRender(file.render, buildSentinels([...withheld, ...file.withheld, ...keys, "DEPLOYMENT_ID"])));
}

describe("real docker compose", () => {
  let out: string[];
  let err: string[];
  let scratch: string | undefined;
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  /** The compose files copied to a scratch dir, so a mutation never touches the tree. */
  function scratchCopy(): string {
    scratch = mkdtempSync(join(tmpdir(), "compose-render-test-"));
    for (const f of readdirSync(REPO_ROOT).filter((n) => /^docker-compose.*\.yml$/.test(n))) cpSync(join(REPO_ROOT, f), join(scratch, f));
    return scratch;
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

  it("re-records the render of the tree as the committed fixture holds it", (t) => {
    if (!requireDocker(() => t.skip())) return;
    const record = join(scratchCopy(), "record.json");
    expect(main(["--record", record]), err.join("\n")).toBe(0);
    expect(recordedProjection(record)).toEqual(recordedProjection(FIXTURE_PATH));
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
