import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { roleStateChanges, runWithScratchDatabase, scratchDatabaseLifecycle, sweepStale } from "../run-integration-tests.mjs";
import { scratchDatabaseName, scratchMarker } from "../lib/integration-scratch-db.mjs";

const NODE = process.execPath;

/** A drop that records it ran, and what the signal handlers looked like then. */
function recordingDrop(signals, result = true) {
  const drop = async () => {
    drop.calls += 1;
    drop.listenersDuring = signals.listenerCount("SIGINT");
    return result;
  };
  drop.calls = 0;
  return drop;
}

function harness() {
  const signals = new EventEmitter();
  const logs = [];
  return { signals, logs, log: (m) => logs.push(m) };
}

describe("runWithScratchDatabase", () => {
  it("returns the test run's status and drops the database", async () => {
    const { signals, log } = harness();
    const drop = recordingDrop(signals);
    const status = await runWithScratchDatabase({
      main: ({ run }) => run(NODE, ["-e", "process.exit(3)"], process.env),
      drop,
      signals,
      log,
    });
    expect(status).toBe(3);
    expect(drop.calls).toBe(1);
  });

  it("drops the database when setup throws, and exits 1", async () => {
    const { signals, logs, log } = harness();
    const drop = recordingDrop(signals);
    const status = await runWithScratchDatabase({
      main: async () => {
        throw new Error("migrate failed");
      },
      drop,
      signals,
      log,
    });
    expect(status).toBe(1);
    expect(drop.calls).toBe(1);
    expect(logs.join("\n")).toContain("setup failed: migrate failed");
  });

  it("exits nonzero and says so when the drop reports the database still present, even after green tests", async () => {
    const { signals, logs, log } = harness();
    const status = await runWithScratchDatabase({
      main: async () => 0,
      drop: recordingDrop(signals, false),
      signals,
      log,
    });
    expect(status).toBe(1);
    expect(logs.join("\n")).toContain("INTEGRATION_CLEANUP_INCOMPLETE");
  });

  it("exits nonzero when the drop throws", async () => {
    const { signals, logs, log } = harness();
    const status = await runWithScratchDatabase({
      main: async () => 0,
      drop: async () => {
        throw new Error("connection refused");
      },
      signals,
      log,
    });
    expect(status).toBe(1);
    expect(logs.join("\n")).toContain("INTEGRATION_CLEANUP_INCOMPLETE");
  });

  it("keeps a failed run's own status when the drop also fails", async () => {
    const { signals, log } = harness();
    const status = await runWithScratchDatabase({ main: async () => 2, drop: recordingDrop(signals, false), signals, log });
    expect(status).toBe(2);
  });

  it("forwards a signal to the running child, then drops and exits 128+n", async () => {
    const { signals, log } = harness();
    const drop = recordingDrop(signals);
    const started = Date.now();
    const status = await runWithScratchDatabase({
      main: ({ run }) => {
        const p = run(NODE, ["-e", "setTimeout(() => {}, 60000)"], process.env);
        setTimeout(() => signals.emit("SIGTERM"), 200);
        return p;
      },
      drop,
      signals,
      log,
    });
    expect(status).toBe(143);
    expect(drop.calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("starts no further step once a signal arrived", async () => {
    const { signals, log } = harness();
    const drop = recordingDrop(signals);
    let spawned = false;
    const status = await runWithScratchDatabase({
      main: async ({ run }) => {
        signals.emit("SIGINT");
        spawned = true;
        await run(NODE, ["-e", ""], process.env).then(() => {
          spawned = "ran";
        });
        return 0;
      },
      drop,
      signals,
      log,
    });
    expect(status).toBe(130);
    expect(spawned).toBe(true);
    expect(drop.calls).toBe(1);
  });

  it("keeps its signal handlers installed while dropping, and ignores a signal sent then", async () => {
    const { signals, log } = harness();
    let finished = false;
    const drop = async () => {
      drop.listenersDuring = signals.listenerCount("SIGINT");
      signals.emit("SIGINT");
      await new Promise((r) => setTimeout(r, 20));
      finished = true;
      return true;
    };
    const status = await runWithScratchDatabase({ main: async () => 0, drop, signals, log });
    expect(drop.listenersDuring).toBe(1);
    expect(finished).toBe(true);
    expect(status).toBe(0);
  });

  it("names the database in the cleanup-incomplete line", async () => {
    const { signals, logs, log } = harness();
    await runWithScratchDatabase({ main: async () => 0, drop: recordingDrop(signals, false), name: "passwd_it_x", signals, log });
    expect(logs.join("\n")).toMatch(/INTEGRATION_CLEANUP_INCOMPLETE passwd_it_x /);
  });

  it("removes its signal handlers afterwards", async () => {
    const { signals, log } = harness();
    await runWithScratchDatabase({ main: async () => 0, drop: recordingDrop(signals), signals, log });
    expect(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => signals.listenerCount(s))).toEqual([0, 0, 0]);
  });
});

describe("roleStateChanges", () => {
  const role = (rolname, extra = {}) => ({ rolname, rolcanlogin: true, rolconnlimit: -1, password_digest: "d1", member_of: [], ...extra });

  it("names the role and the changed columns, never their values", () => {
    const changes = roleStateChanges(
      [role("passwd_app"), role("passwd_audit_chain_verifier")],
      [role("passwd_app", { password_digest: "d2" }), role("passwd_audit_chain_verifier", { rolconnlimit: 10 })],
    );
    expect(changes).toEqual(["passwd_app: password_digest", "passwd_audit_chain_verifier: rolconnlimit"]);
    expect(changes.join("")).not.toContain("d2");
  });

  it("compares array columns by content", () => {
    expect(roleStateChanges([role("passwd_app", { member_of: ["x:fft"] })], [role("passwd_app", { member_of: ["x:fft"] })])).toEqual([]);
    expect(roleStateChanges([role("passwd_app")], [role("passwd_app", { member_of: ["pg_read_all_data:fft"] })])).toEqual([
      "passwd_app: member_of",
    ]);
  });

  it("ignores a role present in only one snapshot", () => {
    expect(roleStateChanges([role("passwd_gone")], [role("passwd_new")])).toEqual([]);
  });
});

/**
 * A fake cluster: databases by name with owner, comment and connection count;
 * every statement the runner sends is recorded. `self` is the role connected as.
 */
function fakeCluster({ self = "passwd_user", dbs = {} } = {}) {
  const databases = new Map(Object.entries(dbs));
  const statements = [];
  const client = {
    escapeLiteral: (v) => `'${v.replaceAll("'", "''")}'`,
    async query(sql, params = []) {
      statements.push(sql);
      let m;
      if ((m = /^CREATE DATABASE "([^"]+)" TEMPLATE template0$/.exec(sql))) {
        if (databases.has(m[1])) throw new Error(`database "${m[1]}" already exists`);
        databases.set(m[1], { owner: self, comment: null, connections: 0 });
        return { rows: [], rowCount: null };
      }
      if ((m = /^COMMENT ON DATABASE "([^"]+)" IS '(.*)'$/s.exec(sql))) {
        if (client.failComment) throw new Error("connection reset");
        databases.get(m[1]).comment = m[2].replaceAll("''", "'");
        return { rows: [], rowCount: null };
      }
      if (sql.startsWith("SELECT pg_get_userbyid")) {
        const d = databases.get(params[0]);
        return { rows: d ? [{ owner: d.owner, self, comment: d.comment }] : [], rowCount: d ? 1 : 0 };
      }
      if (/FROM pg_database d WHERE d\.datname LIKE/.test(sql)) {
        const rows = [...databases].map(([name, d]) => ({ name, owner: d.owner, role: self, comment: d.comment, connections: d.connections }));
        client.afterList?.(databases);
        return { rows, rowCount: rows.length };
      }
      if ((m = /^DROP DATABASE IF EXISTS "([^"]+)" WITH \(FORCE\)$/.exec(sql))) {
        databases.delete(m[1]);
        return { rows: [], rowCount: null };
      }
      if (sql.startsWith("SELECT 1 FROM pg_database")) return { rows: [], rowCount: databases.has(params[0]) ? 1 : 0 };
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
  return {
    client,
    databases,
    connect: (fn) => fn(client),
    drops: () => statements.filter((q) => q.startsWith("DROP")),
  };
}

const NOW = new Date("2026-11-23T12:34:56.789Z");
const NAME = scratchDatabaseName(NOW, 4242, "0a1b2c3d");
const MARKER = scratchMarker({ host: "devbox", pid: 4242, createdAt: NOW });

describe("scratchDatabaseLifecycle", () => {
  it("drops the database a normal run created and marked", async () => {
    const c = fakeCluster();
    const scratch = scratchDatabaseLifecycle({ name: NAME, marker: MARKER, connect: c.connect, log: () => {} });
    await scratch.create();
    expect(c.databases.get(NAME).comment).toBe(MARKER);
    await expect(scratch.drop()).resolves.toBe(true);
    expect(c.databases.has(NAME)).toBe(false);
  });

  it("issues no DROP when CREATE failed because a database of that name already existed", async () => {
    const c = fakeCluster({ dbs: { [NAME]: { owner: "passwd_user", comment: null, connections: 0 } } });
    const logs = [];
    const scratch = scratchDatabaseLifecycle({ name: NAME, marker: MARKER, connect: c.connect, log: (m) => logs.push(m) });
    await expect(scratch.create()).rejects.toThrow(/already exists/);
    await expect(scratch.drop()).resolves.toBe(true);
    expect(c.drops()).toEqual([]);
    expect(c.databases.has(NAME)).toBe(true);
    expect(logs.join("\n")).toContain("not created by this run");
  });

  it("drops a database it created whose COMMENT failed, expecting no comment", async () => {
    const c = fakeCluster();
    c.client.failComment = true;
    const scratch = scratchDatabaseLifecycle({ name: NAME, marker: MARKER, connect: c.connect, log: () => {} });
    await expect(scratch.create()).rejects.toThrow(/connection reset/);
    await expect(scratch.drop()).resolves.toBe(true);
    expect(c.databases.has(NAME)).toBe(false);
  });

  it("refuses to drop when the database's comment was replaced after create", async () => {
    const c = fakeCluster();
    const scratch = scratchDatabaseLifecycle({ name: NAME, marker: MARKER, connect: c.connect, log: () => {} });
    await scratch.create();
    c.databases.get(NAME).comment = scratchMarker({ host: "devbox", pid: 4242, createdAt: NOW });
    await expect(scratch.drop()).rejects.toThrow(/comment is not this run's marker/);
    expect(c.drops()).toEqual([]);
  });

  it("refuses to drop when the database's owner changed after create", async () => {
    const c = fakeCluster();
    const scratch = scratchDatabaseLifecycle({ name: NAME, marker: MARKER, connect: c.connect, log: () => {} });
    await scratch.create();
    c.databases.get(NAME).owner = "mallory";
    await expect(scratch.drop()).rejects.toThrow(/owned by another role/);
    expect(c.drops()).toEqual([]);
  });

  it("through runWithScratchDatabase: a CREATE failure exits 1 with no DROP and no cleanup-incomplete", async () => {
    const c = fakeCluster({ dbs: { [NAME]: { owner: "mallory", comment: MARKER, connections: 0 } } });
    const { signals, logs, log } = harness();
    const scratch = scratchDatabaseLifecycle({ name: NAME, marker: MARKER, connect: c.connect, log });
    const status = await runWithScratchDatabase({ name: NAME, main: () => scratch.create().then(() => 0), drop: scratch.drop, signals, log });
    expect(status).toBe(1);
    expect(c.drops()).toEqual([]);
    expect(logs.join("\n")).not.toContain("INTEGRATION_CLEANUP_INCOMPLETE");
  });

  it("through runWithScratchDatabase: a refused drop reports cleanup-incomplete naming the database and exits nonzero", async () => {
    const c = fakeCluster();
    const { signals, logs, log } = harness();
    const scratch = scratchDatabaseLifecycle({ name: NAME, marker: MARKER, connect: c.connect, log });
    const status = await runWithScratchDatabase({
      name: NAME,
      main: async () => {
        await scratch.create();
        c.databases.get(NAME).owner = "mallory";
        return 0;
      },
      drop: scratch.drop,
      signals,
      log,
    });
    expect(status).toBe(1);
    expect(c.drops()).toEqual([]);
    expect(logs.join("\n")).toContain(`INTEGRATION_CLEANUP_INCOMPLETE ${NAME}`);
  });
});

describe("sweepStale", () => {
  const deadName = scratchDatabaseName(NOW, 100, "00000001");
  const deadMarker = scratchMarker({ host: "devbox", pid: 100, createdAt: NOW });
  const opts = { host: "devbox", isAlive: () => false, log: () => {} };

  it("drops the database a SIGKILLed run on this host left behind", async () => {
    const c = fakeCluster({ dbs: { [deadName]: { owner: "passwd_user", comment: deadMarker, connections: 0 } } });
    await sweepStale(c.connect, opts);
    expect(c.databases.has(deadName)).toBe(false);
  });

  it("leaves a forged marker on a database another role owns", async () => {
    const c = fakeCluster({ dbs: { [deadName]: { owner: "mallory", comment: deadMarker, connections: 0 } } });
    await sweepStale(c.connect, opts);
    expect(c.drops()).toEqual([]);
    expect(c.databases.has(deadName)).toBe(true);
  });

  it("re-verifies at drop time, leaving a database whose comment changed after it was listed", async () => {
    const c = fakeCluster({ dbs: { [deadName]: { owner: "passwd_user", comment: deadMarker, connections: 0 } } });
    c.client.afterList = (dbs) => {
      dbs.get(deadName).comment = scratchMarker({ host: "devbox", pid: 100, createdAt: NOW });
    };
    const logs = [];
    await sweepStale(c.connect, { ...opts, log: (m) => logs.push(m) });
    expect(c.drops()).toEqual([]);
    expect(logs.join("\n")).toMatch(/WARNING: refusing to drop/);
  });
});
