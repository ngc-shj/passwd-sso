/**
 * The wiring of setup.ts's scratch refusal: the integration harness, started
 * the way a developer would start it by hand (vitest with the integration
 * config, no runner), exits nonzero with "Refusing to run integration tests"
 * on a database scripts/run-integration-tests.mjs did not create, and on a
 * Redis database it did not claim for this run (unclaimed, or claimed under
 * another run's marker). The pure predicates are unit-tested in
 * scripts/__tests__; this holds that setup.ts calls them and that a refusal
 * stops the run.
 *
 * Each case runs this file in a child vitest pointed at a target. The targets
 * are throwaway databases this file creates on the scratch database's cluster
 * and drops itself — never the dev database — and, for Redis, the run's own
 * Redis server at a database index carrying no claim (setup.ts only reads
 * the claim key there). In the child, INTEGRATION_REFUSAL_PROBE_CHILD skips
 * the cases, so a harness that wrongly admits the target exits 0 with nothing
 * run, which fails the case here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { createClient } from "@/lib/db/pool-factory";
import { superuserConnectionString } from "./helpers";
import {
  REDIS_CLAIM_ENV,
  REDIS_CLAIM_KEY,
  scratchDatabaseEnv,
  scratchDatabaseName,
  scratchMarker,
} from "../../../scripts/lib/integration-scratch-db.mjs";

const isChild = process.env.INTEGRATION_REFUSAL_PROBE_CHILD === "1";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);
const CHILD_TIMEOUT_MS = 120_000;

type ChildResult = { code: number; output: string };

function runHarness(env: NodeJS.ProcessEnv): Promise<ChildResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [`${ROOT}/node_modules/vitest/vitest.mjs`, "run", "--config", "vitest.integration.config.ts", THIS_FILE],
      { cwd: ROOT, env, timeout: CHILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

/** The parent's environment with every *_DATABASE_URL on `database`, for the child. */
function childEnv(database: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...scratchDatabaseEnv(process.env, database), ...overrides };
  env.INTEGRATION_REFUSAL_PROBE_CHILD = "1";
  // The child must not append to this run's grant-evidence record.
  delete env.RLS_GRANT_EVIDENCE_FILE;
  return env;
}

describe.skipIf(isChild)("integration harness scratch refusal", () => {
  const suffix = randomBytes(4).toString("hex");
  // (a) A name the runner never produces.
  const unmatchedName = `passwd_refusal_probe_${suffix}`;
  // (b) A name the runner could produce, without the marker comment.
  const unmarkedName = scratchDatabaseName(new Date(0), 0, suffix);
  let admin: Client;
  let currentDatabase: string;

  beforeAll(async () => {
    admin = createClient({ connectionString: superuserConnectionString() });
    await admin.connect();
    currentDatabase = (await admin.query<{ db: string }>("SELECT current_database() AS db")).rows[0].db;
    for (const name of [unmatchedName, unmarkedName]) {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    }
  });

  afterAll(async () => {
    for (const name of [unmatchedName, unmarkedName]) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await admin.end();
  });

  it("refuses a database whose name is not a scratch name", async () => {
    const { code, output } = await runHarness(childEnv(unmatchedName, { REDIS_URL: "" }));
    expect(code).not.toBe(0);
    expect(output).toContain(`Refusing to run integration tests: database "${unmatchedName}" is not a scratch integration database`);
  }, CHILD_TIMEOUT_MS);

  it("refuses a scratch-named database without the marker comment", async () => {
    const { code, output } = await runHarness(childEnv(unmarkedName, { REDIS_URL: "" }));
    expect(code).not.toBe(0);
    expect(output).toContain(`Refusing to run integration tests: database "${unmarkedName}" does not carry the scratch marker comment`);
  }, CHILD_TIMEOUT_MS);

  it.skipIf(!process.env.REDIS_URL)("refuses a Redis database that carries no scratch claim", async () => {
    const claimed = process.env.REDIS_URL as string;
    // Any index but the claimed one carries no claim of this run; find one
    // that carries none at all (the dev index among them).
    const { default: IORedis } = await import("ioredis");
    let unclaimed: string | null = null;
    for (let index = 0; index < 16 && unclaimed === null; index++) {
      const candidate = new URL(claimed);
      candidate.pathname = `/${index}`;
      const url = candidate.toString();
      if (url === claimed) continue;
      const r = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
      try {
        await r.connect();
        if ((await r.get(REDIS_CLAIM_KEY)) === null) unclaimed = url;
      } finally {
        r.disconnect();
      }
    }
    expect(unclaimed).not.toBeNull();
    // The Postgres half passes on this run's own scratch database, so the
    // refusal is the Redis one.
    const { code, output } = await runHarness(childEnv(currentDatabase, { REDIS_URL: unclaimed as string }));
    expect(code).not.toBe(0);
    expect(output).toContain("Refusing to run integration tests: the Redis database REDIS_URL selects does not carry the scratch claim");
  }, CHILD_TIMEOUT_MS);

  // The run's own claimed database, read by a child holding another run's
  // marker: what a child of run B pointed at run A's database sees. Nothing
  // is written to any Redis database.
  it.skipIf(!process.env.REDIS_URL)("refuses a Redis database claimed by another run", async () => {
    const foreign = scratchMarker({ host: "another-host", pid: 1, createdAt: new Date(0) });
    const { code, output } = await runHarness(childEnv(currentDatabase, { [REDIS_CLAIM_ENV]: foreign }));
    expect(code).not.toBe(0);
    expect(output).toContain(
      "Refusing to run integration tests: the Redis database REDIS_URL selects carries another run's scratch claim, not this run's",
    );
  }, CHILD_TIMEOUT_MS);

  // Positive control for the case above: the same child with this run's own
  // marker is admitted, so the refusal is the marker's doing.
  it.skipIf(!process.env.REDIS_URL)("admits this run's claimed Redis database under this run's marker", async () => {
    const { code, output } = await runHarness(childEnv(currentDatabase));
    expect(output).not.toContain("Refusing to run integration tests");
    expect(code).toBe(0);
  }, CHILD_TIMEOUT_MS);
});
