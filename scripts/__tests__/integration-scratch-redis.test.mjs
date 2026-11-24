import { describe, it, expect } from "vitest";
import {
  claimScratchRedis,
  parseClientList,
  redisDatabaseIndex,
  redisUrlForIndex,
  releaseScratchRedis,
  sweepStaleRedis,
} from "../run-integration-tests.mjs";
import { REDIS_CLAIM_KEY, scratchMarker, scratchRedisRefusal } from "../lib/integration-scratch-db.mjs";
import { FakeRedis } from "./fake-redis.mjs";

const NOW = new Date("2026-11-23T12:34:56.789Z");
const MARKER = scratchMarker({ host: "devbox", pid: 4242, createdAt: NOW });
const DEAD = scratchMarker({ host: "devbox", pid: 100, createdAt: NOW });
const quiet = { host: "devbox", isAlive: () => false, log: () => {} };

describe("redisDatabaseIndex / redisUrlForIndex", () => {
  it("reads the index from the path, 0 when there is none", () => {
    expect(redisDatabaseIndex("redis://:pw@localhost:6379")).toBe(0);
    expect(redisDatabaseIndex("redis://localhost:6379/")).toBe(0);
    expect(redisDatabaseIndex("redis://localhost:6379/7")).toBe(7);
  });

  it("refuses a path that is not an index", () => {
    expect(() => redisDatabaseIndex("redis://localhost:6379/x")).toThrow(/not a database index/);
  });

  it("replaces the index, keeping the credentials", () => {
    expect(redisUrlForIndex("redis://:pw@localhost:6379/0", 3)).toBe("redis://:pw@localhost:6379/3");
  });
});

describe("parseClientList", () => {
  it("reads each client's id and selected database", () => {
    expect(parseClientList("id=7 addr=127.0.0.1:1 name= db=0 cmd=x\nid=9 addr=a name=k db=3\n")).toEqual([
      { id: 7, db: 0 },
      { id: 9, db: 3 },
    ]);
  });
});

describe("scratchRedisRefusal", () => {
  it("accepts a database carrying a scratch claim", () => {
    expect(scratchRedisRefusal(MARKER)).toBeNull();
  });

  it("refuses a database without the claim (the live instance's)", () => {
    expect(scratchRedisRefusal(null)).toMatch(/does not carry the scratch claim/);
    expect(scratchRedisRefusal("something else")).toMatch(/does not carry the scratch claim/);
  });

  it("refuses Sentinel mode whatever the claim", () => {
    expect(scratchRedisRefusal(MARKER, { sentinel: true })).toMatch(/REDIS_SENTINEL/);
  });
});

describe("claimScratchRedis", () => {
  it("never claims the index REDIS_URL names, even when it is empty", async () => {
    const server = new FakeRedis();
    const keeper = server.connect();
    expect(await claimScratchRedis(keeper, { devIndex: 0, marker: MARKER })).toBe(1);
    expect(server.db(0).size).toBe(0);
    expect(server.db(1).get(REDIS_CLAIM_KEY)).toBe(MARKER);
  });

  it("skips a non-empty database and one another client has selected", async () => {
    const server = new FakeRedis();
    server.db(1).set("live", "1");
    server.attach(2);
    expect(await claimScratchRedis(server.connect(), { devIndex: 0, marker: MARKER })).toBe(3);
  });

  it("gives two concurrent runs different databases", async () => {
    const server = new FakeRedis();
    const a = await claimScratchRedis(server.connect(), { devIndex: 0, marker: MARKER });
    const b = await claimScratchRedis(server.connect(), { devIndex: 0, marker: DEAD });
    expect(a).not.toBe(b);
  });

  it("fails when no database is free", async () => {
    const server = new FakeRedis({ databases: 2 });
    server.db(1).set("live", "1");
    await expect(claimScratchRedis(server.connect(), { devIndex: 0, marker: MARKER })).rejects.toThrow(/no Redis logical database is free/);
  });
});

describe("releaseScratchRedis", () => {
  it("flushes only while the claim is this run's", async () => {
    const server = new FakeRedis();
    const keeper = server.connect();
    await claimScratchRedis(keeper, { devIndex: 0, marker: MARKER });
    server.db(1).set("rl:k", "1");
    await expect(releaseScratchRedis(keeper, DEAD)).resolves.toBe(false);
    expect(server.db(1).size).toBe(2);
    await expect(releaseScratchRedis(keeper, MARKER)).resolves.toBe(true);
    expect(server.db(1).size).toBe(0);
  });
});

describe("sweepStaleRedis", () => {
  it("flushes a dead run's claimed database that no client has selected", async () => {
    const server = new FakeRedis();
    server.db(4).set(REDIS_CLAIM_KEY, DEAD);
    server.db(4).set("rl:k", "1");
    await sweepStaleRedis(server.connect(), { devIndex: 0, ...quiet });
    expect(server.db(4).size).toBe(0);
  });

  it("leaves a claimed database a client (a live run's keeper) has selected, however dead its pid looks", async () => {
    const server = new FakeRedis();
    const live = server.connect();
    await claimScratchRedis(live, { devIndex: 0, marker: DEAD });
    await sweepStaleRedis(server.connect(), { devIndex: 0, ...quiet });
    expect(server.db(1).get(REDIS_CLAIM_KEY)).toBe(DEAD);
  });

  it("leaves unclaimed databases, other hosts' claims, live pids' claims, and the dev index", async () => {
    const server = new FakeRedis();
    server.db(0).set(REDIS_CLAIM_KEY, DEAD);
    server.db(1).set("live", "1");
    server.db(2).set(REDIS_CLAIM_KEY, scratchMarker({ host: "other", pid: 100, createdAt: NOW }));
    server.db(3).set(REDIS_CLAIM_KEY, MARKER);
    await sweepStaleRedis(server.connect(), { devIndex: 0, ...quiet, isAlive: (pid) => pid === 4242 });
    expect([0, 1, 2, 3].map((i) => server.db(i).size)).toEqual([1, 1, 1, 1]);
  });
});
