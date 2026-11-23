import { describe, it, expect } from "vitest";
import {
  SCRATCH_DB_MARKER,
  ScratchDropRefused,
  dropScratchDatabase,
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
const NONCE = "0123456789abcdef0123456789abcdef";
const MARKER = scratchMarker({ host: "devbox", pid: 4242, createdAt: NOW, nonce: NONCE });

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

  it("refuses a marker without the run nonce", () => {
    expect(scratchDatabaseRefusal(NAME, `${SCRATCH_DB_MARKER} (host=devbox pid=4242 created=${NOW.toISOString()})`)).toMatch(/marker/);
  });

  it("refuses a missing name", () => {
    expect(scratchDatabaseRefusal(undefined, MARKER)).not.toBeNull();
  });
});

describe("parseScratchMarker / isScratchDatabaseName", () => {
  it("round-trips host and pid", () => {
    expect(parseScratchMarker(MARKER)).toEqual({ host: "devbox", pid: 4242 });
  });

  it("carries a fresh 128-bit nonce per marker by default", () => {
    const a = scratchMarker({ host: "devbox", pid: 1, createdAt: NOW });
    const b = scratchMarker({ host: "devbox", pid: 1, createdAt: NOW });
    expect(a).toMatch(/ nonce=[0-9a-f]{32}\)$/);
    expect(a).not.toBe(b);
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
    owner: "passwd_user",
    comment: scratchMarker({ host: "devbox", pid, createdAt: NOW, nonce: NONCE }),
    connections: 0,
    ...extra,
  });
  const self = { role: "passwd_user", host: "devbox", isAlive: (pid) => pid === 200 };

  it("selects a marked database whose creator on this host is gone, with the comment it was chosen by", () => {
    expect(staleScratchDatabases([row(dead, 100), row(live, 200)], self)).toEqual([{ name: dead, comment: row(dead, 100).comment }]);
  });

  it("skips a well-formed marker on a database another role owns", () => {
    expect(staleScratchDatabases([row(dead, 100, { owner: "mallory" })], self)).toEqual([]);
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

describe("dropScratchDatabase", () => {
  /** One database on a fake cluster, as the role passwd_user. */
  function cluster(db) {
    const dbs = new Map(db ? [[NAME, db]] : []);
    const statements = [];
    const client = {
      async query(sql, params = []) {
        statements.push(sql);
        if (sql.startsWith("SELECT pg_get_userbyid")) {
          const d = dbs.get(params[0]);
          return { rows: d ? [{ owner: d.owner, self: "passwd_user", comment: d.comment }] : [], rowCount: d ? 1 : 0 };
        }
        const drop = /^DROP DATABASE IF EXISTS "([^"]+)" WITH \(FORCE\)$/.exec(sql);
        if (drop) {
          dbs.delete(drop[1]);
          return { rows: [], rowCount: null };
        }
        if (sql.startsWith("SELECT 1 FROM pg_database")) return { rows: [], rowCount: dbs.has(params[0]) ? 1 : 0 };
        throw new Error(`unexpected statement: ${sql}`);
      },
    };
    return { client, dbs, drops: () => statements.filter((q) => q.startsWith("DROP")) };
  }

  it("drops a database this role owns that carries exactly the expected marker", async () => {
    const c = cluster({ owner: "passwd_user", comment: MARKER });
    await expect(dropScratchDatabase(c.client, NAME, MARKER)).resolves.toBe(true);
    expect(c.dbs.has(NAME)).toBe(false);
  });

  it("refuses, issuing no DROP, when the comment is another run's marker", async () => {
    const c = cluster({ owner: "passwd_user", comment: scratchMarker({ host: "devbox", pid: 4242, createdAt: NOW }) });
    await expect(dropScratchDatabase(c.client, NAME, MARKER)).rejects.toThrow(ScratchDropRefused);
    expect(c.drops()).toEqual([]);
  });

  it("refuses, issuing no DROP, when another role owns the database, naming it", async () => {
    const c = cluster({ owner: "mallory", comment: MARKER });
    await expect(dropScratchDatabase(c.client, NAME, MARKER)).rejects.toThrow(new RegExp(`"${NAME}".*owned by another role`));
    expect(c.drops()).toEqual([]);
  });

  it("refuses a marked database when the caller expected none", async () => {
    const c = cluster({ owner: "passwd_user", comment: MARKER });
    await expect(dropScratchDatabase(c.client, NAME, null)).rejects.toThrow(ScratchDropRefused);
    expect(c.drops()).toEqual([]);
  });

  it("refuses a name that is not a scratch name before any query", async () => {
    const c = cluster({ owner: "passwd_user", comment: MARKER });
    await expect(dropScratchDatabase(c.client, "passwd_sso", MARKER)).rejects.toThrow(/not a scratch database name/);
    expect(c.drops()).toEqual([]);
  });

  it("reports an absent database as gone without dropping anything", async () => {
    const c = cluster(null);
    await expect(dropScratchDatabase(c.client, NAME, MARKER)).resolves.toBe(true);
    expect(c.drops()).toEqual([]);
  });
});
