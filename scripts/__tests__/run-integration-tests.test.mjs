import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { roleStateChanges, runWithScratchDatabase } from "../run-integration-tests.mjs";

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
