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
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CANARY_TOKEN,
  RENDER_SETS,
  analyzeRender,
  buildSentinels,
  deploymentIdDrift,
  hydrateRecordedRender,
  main,
  publisherEnvProblems,
  requiredVariables,
  scrubbedEnv,
  stubEnvText,
  type AnalysisContext,
  type ComposeRender,
  type Sentinels,
} from "../checks/check-compose-render";
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
      `[${SET}] app: holds the publisher-only AUDIT_ANCHOR_SIGNING_KEY`,
    ]);
  });

  it("names a publisher-only value reaching a service that does not load .env", () => {
    expect(drift((r) => (env(r, "jackson").LEAK = sentinel("GITHUB_TOKEN")))).toEqual([
      `[${SET}] jackson: holds the publisher-only GITHUB_TOKEN`,
    ]);
  });

  it("allows the publisher to hold its own secrets (the unmutated render does)", () => {
    expect(JSON.stringify(baseline().services["audit-anchor-publisher"])).toContain(sentinels.AUDIT_ANCHOR_SIGNING_KEY.token);
  });

  it("names a role password in a service bound to another role", () => {
    expect(drift((r) => (env(r, "redis").LEAK = sentinel("PASSWD_APP_PASSWORD")))).toEqual([
      `[${SET}] redis: holds PASSWD_APP_PASSWORD, bound to another service`,
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
      `[${SET}] audit-outbox-worker: holds PASSWD_SUPERUSER_PASSWORD, bound to another service`,
    ]);
  });

  it("names a worker whose own URL is blanked", () => {
    expect(drift((r) => (env(r, "retention-gc-worker").RETENTION_GC_DATABASE_URL = ""))).toEqual([
      `[${SET}] retention-gc-worker: RETENTION_GC_DATABASE_URL (its own DB URL) is not set`,
    ]);
  });

  it("names a publisher that has gone through .env", () => {
    const found = drift((r) => (env(r, "audit-anchor-publisher").COMPOSE_RENDER_CANARY = CANARY_TOKEN));
    expect(found).toContain(`[${SET}] audit-anchor-publisher: loads .env`);
    expect(found).toContain(`[${SET}] audit-anchor-publisher: SENTRY_AUTH_TOKEN is not blanked (loads .env, so it holds the .env value)`);
  });

  it("names a verify worker with an extra variable", () => {
    expect(drift((r) => (env(r, "audit-chain-verify-worker").EXTRA = "x"))).toEqual([
      `[${SET}] audit-chain-verify-worker: env names are not exactly AUDIT_CHAIN_VERIFY_DATABASE_URL, DATABASE_URL`,
    ]);
  });

  it("names a publisher missing an ECS name, and the schema refusal that follows", () => {
    const found = drift((r) => delete env(r, "audit-anchor-publisher").DEPLOYMENT_ID);
    expect(found.slice(0, 2)).toEqual([
      `[${SET}] audit-anchor-publisher: DEPLOYMENT_ID (an ECS name) is absent`,
      `[${SET}] audit-anchor-publisher: DEPLOYMENT_ID does not carry the .env value`,
    ]);
    expect(found.some((f) => f.startsWith(`[${SET}] audit-anchor-publisher: fails auditAnchorPublisherEnvSchema at DEPLOYMENT_ID`))).toBe(true);
  });

  it("names a publisher whose signing key is not the .env value", () => {
    expect(drift((r) => (env(r, "audit-anchor-publisher").AUDIT_ANCHOR_SIGNING_KEY = "0".repeat(64)))).toEqual([
      `[${SET}] audit-anchor-publisher: AUDIT_ANCHOR_SIGNING_KEY does not carry the .env value`,
    ]);
  });

  it("names a publisher that is not enabled", () => {
    const found = drift((r) => (env(r, "audit-anchor-publisher").AUDIT_ANCHOR_PUBLISHER_ENABLED = "false"));
    expect(found[0]).toBe(`[${SET}] audit-anchor-publisher: AUDIT_ANCHOR_PUBLISHER_ENABLED is not true`);
  });

  it("names a publisher with an S3 bucket and a blank region (the schema refuses it)", () => {
    const found = drift((r) => {
      env(r, "audit-anchor-publisher").AUDIT_ANCHOR_DESTINATION_S3_BUCKET = "b";
      env(r, "audit-anchor-publisher").AWS_REGION = "";
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("fails auditAnchorPublisherEnvSchema at AWS_REGION");
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
});

// ─── Real compose ───────────────────────────────────────────

const dockerAvailable = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

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
