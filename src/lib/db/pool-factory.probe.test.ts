/**
 * The factory's lazy fail-closed probe: it refuses to build a pool or client
 * when pg.Client no longer exposes `connection`, where the refusal listener
 * attaches. The probe's state lives in the module, so each cell loads a fresh
 * copy against the pg it needs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type * as PoolFactory from "@/lib/db/pool-factory";

const URL = "postgresql://u:p@localhost:5432/db";
const PROBE_FAILURE = "pg.Client exposes no connection event emitter";

vi.mock("@/lib/logger", () => {
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { default: logger, getLogger: () => logger };
});

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("pg");
});

async function loadWithDeficientPg(): Promise<typeof PoolFactory> {
  vi.doMock("pg", () => {
    class Client {}
    class Pool {
      on() {
        return this;
      }
      end() {
        return Promise.resolve();
      }
    }
    return { default: { Client, Pool } };
  });
  return import("@/lib/db/pool-factory");
}

describe("listener support probe", () => {
  it("makes createPool throw when pg.Client has no connection", async () => {
    const { createPool } = await loadWithDeficientPg();
    expect(() => createPool({ connectionString: URL })).toThrow(PROBE_FAILURE);
  });

  it("makes createClient throw when pg.Client has no connection", async () => {
    const { createClient } = await loadWithDeficientPg();
    expect(() => createClient({ connectionString: URL })).toThrow(PROBE_FAILURE);
  });

  it("throws again on a second createPool call: only a pass is remembered", async () => {
    const { createPool } = await loadWithDeficientPg();
    expect(() => createPool({ connectionString: URL })).toThrow(PROBE_FAILURE);
    expect(() => createPool({ connectionString: URL })).toThrow(PROBE_FAILURE);
  });

  it("throws when connection has no prependListener", async () => {
    vi.doMock("pg", () => ({
      default: {
        Client: class {
          connection = { on() {} };
        },
        Pool: class {},
      },
    }));
    const { createClient } = await import("@/lib/db/pool-factory");
    expect(() => createClient({ connectionString: URL })).toThrow(PROBE_FAILURE);
  });

  it("builds a pool and a client with the real pg", async () => {
    const { createPool, createClient } = await import("@/lib/db/pool-factory");
    const pool = createPool({ connectionString: URL });
    await pool.end();
    expect(createClient({ connectionString: URL })).toBeDefined();
  });

  it("runs the probe once across two createPool calls", async () => {
    const constructed = vi.fn();
    vi.doMock("pg", async (importOriginal) => {
      const actual = await importOriginal<{ default: typeof import("pg").default }>();
      class Client extends actual.default.Client {
        constructor(...args: ConstructorParameters<typeof actual.default.Client>) {
          super(...args);
          constructed();
        }
      }
      return { default: { ...actual.default, Client } };
    });
    const { createPool } = await import("@/lib/db/pool-factory");
    const first = createPool({ connectionString: URL });
    const second = createPool({ connectionString: URL });
    await Promise.all([first.end(), second.end()]);
    expect(constructed).toHaveBeenCalledTimes(1);
  });
});

describe("checkedConfig refuses a Client, native or onConnect override", () => {
  it.each([
    ["Client", { Client: class extends EventEmitter {} }],
    ["native", { native: true }],
    // pg-pool runs onConnect before it emits `connect`, so before the listeners attach.
    ["onConnect", { onConnect: async () => {} }],
  ])("%s, in createPool and createClient", async (name, extra) => {
    const { createPool, createClient } = await import("@/lib/db/pool-factory");
    const config = { connectionString: URL, ...extra } as never;
    expect(() => createPool(config)).toThrow(`must not set ${name}`);
    expect(() => createClient(config)).toThrow(`must not set ${name}`);
  });

  it("accepts the keys when undefined", async () => {
    const { createPool } = await import("@/lib/db/pool-factory");
    const pool = createPool({ connectionString: URL, Client: undefined, onConnect: undefined } as never);
    await pool.end();
  });
});
