/**
 * The runner's Redis claim and release scripts (CLAIM_SCRIPT, RELEASE_SCRIPT)
 * evaluated by a real Redis server. The runner's unit tests drive a fake that
 * matches the scripts by text, so their refusal branches run on real Lua
 * semantics only here: a claim on a database that is not empty, a release
 * whose marker is not the claim, a release whose claim key is missing.
 *
 * Runs on the database the runner claimed for this run, which already holds
 * the run's claim key. Every script call names a key this file owns as
 * KEYS[1], never the run's claim key, so a script that wrongly writes writes
 * only here; a release that wrongly flushes cannot be confined that way, and
 * fails the run's own release (INTEGRATION_CLEANUP_INCOMPLETE) as well as
 * these cases. afterEach deletes only the keys this file wrote.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import IORedis from "ioredis";
import {
  CLAIM_SCRIPT,
  REDIS_CLAIM_KEY,
  RELEASE_SCRIPT,
  scratchMarker,
} from "../../../scripts/lib/integration-scratch-db.mjs";

const PREFIX = `passwd-sso:integration-claim-script-test:${randomBytes(4).toString("hex")}`;
const OWN = scratchMarker({ host: "claim-script-test", pid: 1, createdAt: new Date(0) });
const FOREIGN = scratchMarker({ host: "claim-script-test", pid: 2, createdAt: new Date(0) });

describe.skipIf(!process.env.REDIS_URL)("Redis claim scripts on a real server", () => {
  let redis: IORedis;
  let runClaim: string | null;
  const written: string[] = [];

  async function write(suffix: string, value: string): Promise<string> {
    const key = `${PREFIX}:${suffix}`;
    written.push(key);
    await redis.set(key, value);
    return key;
  }

  async function evalScript(script: string, key: string, marker: string): Promise<number> {
    return Number(await redis.eval(script, 1, key, marker));
  }

  beforeAll(async () => {
    redis = new IORedis(process.env.REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    runClaim = await redis.get(REDIS_CLAIM_KEY);
  });

  afterEach(async () => {
    if (written.length > 0) await redis.del(...written.splice(0));
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("runs on this run's claimed database", () => {
    // setup.ts admitted it, so the claim is there; the cases below rely on
    // the database being non-empty and on comparing the claim afterwards.
    expect(runClaim).not.toBeNull();
  });

  it("CLAIM on a non-empty database returns 0 and leaves the existing claim unchanged", async () => {
    const key = await write("claim", OWN);
    expect(await redis.dbsize()).toBeGreaterThan(0);
    expect(await evalScript(CLAIM_SCRIPT, key, FOREIGN)).toBe(0);
    expect(await redis.get(key)).toBe(OWN);
    expect(await redis.get(REDIS_CLAIM_KEY)).toBe(runClaim);
  });

  it("RELEASE with a foreign marker returns 0 and flushes nothing", async () => {
    const key = await write("release-claim", OWN);
    const sentinel = await write("sentinel", "1");
    expect(await evalScript(RELEASE_SCRIPT, key, FOREIGN)).toBe(0);
    expect(await redis.get(sentinel)).toBe("1");
    expect(await redis.get(key)).toBe(OWN);
    expect(await redis.get(REDIS_CLAIM_KEY)).toBe(runClaim);
  });

  it("RELEASE on a missing claim key returns 0 and flushes nothing", async () => {
    const sentinel = await write("sentinel", "1");
    const missing = `${PREFIX}:missing`;
    expect(await redis.exists(missing)).toBe(0);
    expect(await evalScript(RELEASE_SCRIPT, missing, OWN)).toBe(0);
    expect(await redis.get(sentinel)).toBe("1");
    expect(await redis.get(REDIS_CLAIM_KEY)).toBe(runClaim);
  });
});
