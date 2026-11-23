import { describe, it, expect } from "vitest";
import {
  SCRATCH_DB_MARKER,
  isScratchDatabaseName,
  parseScratchMarker,
  scratchDatabaseEnv,
  scratchDatabaseName,
  scratchDatabaseRefusal,
  scratchMarker,
  staleScratchDatabases,
} from "../lib/integration-scratch-db.mjs";

const NOW = new Date("2026-11-23T12:34:56.789Z");
const NAME = scratchDatabaseName(NOW, 4242, "0a1b2c3d");
const MARKER = scratchMarker({ host: "devbox", pid: 4242, createdAt: NOW });

describe("scratchDatabaseName", () => {
  it("encodes the UTC stamp, pid and suffix under the prefix", () => {
    expect(NAME).toBe("passwd_it_20261123123456_4242_0a1b2c3d");
  });

  it("produces a distinct name per call by default", () => {
    expect(scratchDatabaseName()).not.toBe(scratchDatabaseName());
  });

  it("stays within PostgreSQL's 63-byte identifier limit for a large pid", () => {
    expect(scratchDatabaseName(NOW, 4_194_304).length).toBeLessThanOrEqual(63);
  });
});

describe("scratchDatabaseRefusal", () => {
  it("accepts a scratch name carrying the marker", () => {
    expect(scratchDatabaseRefusal(NAME, MARKER)).toBeNull();
  });

  it("refuses the dev database even when someone marked it", () => {
    expect(scratchDatabaseRefusal("passwd_sso", MARKER)).toMatch(/passwd_sso.*not a scratch/);
  });

  it("refuses a scratch-shaped name without the marker", () => {
    expect(scratchDatabaseRefusal(NAME, null)).toMatch(/marker/);
    expect(scratchDatabaseRefusal(NAME, "some other comment")).toMatch(/marker/);
  });

  it("refuses a marker prefix with a malformed tail", () => {
    expect(scratchDatabaseRefusal(NAME, `${SCRATCH_DB_MARKER} (host=x)`)).toMatch(/marker/);
  });

  it("refuses a missing name", () => {
    expect(scratchDatabaseRefusal(undefined, MARKER)).not.toBeNull();
  });
});

describe("parseScratchMarker / isScratchDatabaseName", () => {
  it("round-trips host and pid", () => {
    expect(parseScratchMarker(MARKER)).toEqual({ host: "devbox", pid: 4242 });
  });

  it("rejects a name with a suffix appended", () => {
    expect(isScratchDatabaseName(`${NAME}x`)).toBe(false);
  });
});

describe("scratchDatabaseEnv", () => {
  it("points every DATABASE_URL key at the scratch database, keeping credentials and options", () => {
    const out = scratchDatabaseEnv(
      {
        DATABASE_URL: "postgresql://passwd_app:a@localhost:5432/passwd_sso",
        MIGRATION_DATABASE_URL: "postgresql://passwd_user:b@localhost:5432/passwd_sso?sslmode=disable",
        OUTBOX_WORKER_DATABASE_URL: "postgres://passwd_outbox_worker:c@db:5433/passwd_sso",
        SOME_FUTURE_ROLE_DATABASE_URL: "postgresql://r:d@localhost/passwd_sso",
        REDIS_URL: "redis://localhost:6379",
        DATABASE_URL_NOTE: "not a url key",
      },
      NAME,
    );
    expect(out).toEqual({
      DATABASE_URL: `postgresql://passwd_app:a@localhost:5432/${NAME}`,
      MIGRATION_DATABASE_URL: `postgresql://passwd_user:b@localhost:5432/${NAME}?sslmode=disable`,
      OUTBOX_WORKER_DATABASE_URL: `postgres://passwd_outbox_worker:c@db:5433/${NAME}`,
      SOME_FUTURE_ROLE_DATABASE_URL: `postgresql://r:d@localhost/${NAME}`,
    });
  });

  it("skips an empty value", () => {
    expect(scratchDatabaseEnv({ APP_DATABASE_URL: "" }, NAME)).toEqual({});
  });

  it("refuses a value that is not a postgres URL, without echoing it", () => {
    expect(() => scratchDatabaseEnv({ DATABASE_URL: "mysql://u:secret@h/db" }, NAME)).toThrow(/^DATABASE_URL is not a postgres/);
    expect(() => scratchDatabaseEnv({ DATABASE_URL: "secret garbage" }, NAME)).toThrow(/^DATABASE_URL is not a connection URL$/);
  });
});

describe("staleScratchDatabases", () => {
  const dead = scratchDatabaseName(NOW, 100, "00000001");
  const live = scratchDatabaseName(NOW, 200, "00000002");
  const row = (name, pid, extra = {}) => ({
    name,
    comment: scratchMarker({ host: "devbox", pid, createdAt: NOW }),
    connections: 0,
    ...extra,
  });
  const self = { host: "devbox", isAlive: (pid) => pid === 200 };

  it("selects a marked database whose creator on this host is gone", () => {
    expect(staleScratchDatabases([row(dead, 100), row(live, 200)], self)).toEqual([dead]);
  });

  it("keeps one with a connection, one from another host, and anything unmarked", () => {
    expect(
      staleScratchDatabases(
        [
          row(dead, 100, { connections: 1 }),
          { ...row(dead, 100), comment: scratchMarker({ host: "otherbox", pid: 100, createdAt: NOW }) },
          { name: dead, comment: null, connections: 0 },
          { name: "passwd_sso", comment: row(dead, 100).comment, connections: 0 },
        ],
        self,
      ),
    ).toEqual([]);
  });
});
