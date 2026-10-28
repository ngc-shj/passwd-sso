import { describe, it, expect, vi } from "vitest";

const { mockGetTenantRlsContext } = vi.hoisted(() => ({
  mockGetTenantRlsContext: vi.fn<() => unknown>(() => undefined),
}));

// Avoid the singleton side effects (Pool creation, signal handler registration)
// from running at import time. We only want to exercise the exported `envInt`.
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      // no-op
    }
  },
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor() {
      // no-op
    }
  },
}));

vi.mock("pg", () => ({
  default: {
    Pool: class {
      on() {
        return this;
      }
      end() {
        return Promise.resolve();
      }
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@/lib/tenant-rls", () => ({
  getTenantRlsContext: mockGetTenantRlsContext,
}));

import { envInt, prisma, prismaBase } from "./prisma";

describe("envInt", () => {
  it("returns the default when the env var is unset", () => {
    vi.stubEnv("X_INT_MISSING", "");
    expect(envInt("X_INT_MISSING", 42)).toBe(42);
  });

  it("returns the default when the env var is the empty string", () => {
    vi.stubEnv("X_INT_EMPTY", "");
    expect(envInt("X_INT_EMPTY", 7)).toBe(7);
  });

  it("returns a parsed integer within range", () => {
    vi.stubEnv("X_INT_OK", "100");
    expect(envInt("X_INT_OK", 0, { min: 0, max: 1000 })).toBe(100);
  });

  it("rejects partial-numeric strings (e.g. '20ms') in dev — returns default", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("X_INT_PARTIAL", "20ms");
    expect(envInt("X_INT_PARTIAL", 5)).toBe(5);
  });

  it("rejects floating-point values in dev — returns default", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("X_INT_FLOAT", "3.14");
    expect(envInt("X_INT_FLOAT", 1)).toBe(1);
  });

  it("returns default when value is below min in dev", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("X_INT_LOW", "0");
    expect(envInt("X_INT_LOW", 5, { min: 1 })).toBe(5);
  });

  it("returns default when value is above max in dev", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("X_INT_HIGH", "9999");
    expect(envInt("X_INT_HIGH", 5, { max: 100 })).toBe(5);
  });

  it("throws when value is invalid in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("X_INT_PROD", "abc");
    expect(() => envInt("X_INT_PROD", 5, { min: 1, max: 10 })).toThrow(
      /Invalid DB pool config/,
    );
  });

  it("throws when value is out of range in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("X_INT_OOR", "9999");
    expect(() => envInt("X_INT_OOR", 5, { max: 100 })).toThrow(
      /Invalid DB pool config/,
    );
  });

  it("accepts boundary min and max values", () => {
    vi.stubEnv("X_INT_BOUND_LOW", "1");
    expect(envInt("X_INT_BOUND_LOW", 0, { min: 1, max: 10 })).toBe(1);
    vi.stubEnv("X_INT_BOUND_HIGH", "10");
    expect(envInt("X_INT_BOUND_HIGH", 0, { min: 1, max: 10 })).toBe(10);
  });
});

describe("prisma proxy inside an RLS context", () => {
  it("runs an array $transaction one query at a time on the context's client", async () => {
    mockGetTenantRlsContext.mockReturnValueOnce({ tx: {} });
    const events: string[] = [];
    // Prisma promises are lazy: a query starts when it is awaited. One that is
    // started while another is still pending would share its connection.
    const query = (name: string, value: number) => ({
      then(resolve: (v: number) => void) {
        events.push(`start:${name}`);
        queueMicrotask(() => {
          events.push(`end:${name}`);
          resolve(value);
        });
      },
    });

    const results = await prisma.$transaction([
      query("a", 1),
      query("b", 2),
    ] as unknown as Parameters<typeof prisma.$transaction>[0]);

    expect(results).toEqual([1, 2]);
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("runs the function form on the context's client", async () => {
    const active = { marker: "tx" };
    mockGetTenantRlsContext.mockReturnValueOnce({ tx: active });
    const fn = vi.fn(async (tx: unknown) => tx);

    await expect(prisma.$transaction(fn as never)).resolves.toBe(active);
    expect(fn).toHaveBeenCalledWith(active);
  });

  it("refuses options for the function form, which the open transaction cannot apply", async () => {
    mockGetTenantRlsContext.mockReturnValueOnce({ tx: {} });
    const fn = vi.fn(async () => "never");

    await expect(prisma.$transaction(fn, { timeout: 60_000 })).rejects.toThrow(
      /options are not applied inside an RLS context/,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses options for the array form too", async () => {
    mockGetTenantRlsContext.mockReturnValueOnce({ tx: {} });

    await expect(
      prisma.$transaction([] as never, { isolationLevel: "Serializable" } as never),
    ).rejects.toThrow(/options are not applied inside an RLS context/);
  });
});

describe("prisma proxy outside an RLS context", () => {
  it("forwards $transaction and its options to the base client unchanged", async () => {
    const baseTransaction = vi.fn(async () => "base-result");
    Object.assign(prismaBase, { $transaction: baseTransaction });
    const fn = async () => "never-run-by-the-mock";

    await expect(prisma.$transaction(fn, { timeout: 60_000 })).resolves.toBe("base-result");
    expect(baseTransaction).toHaveBeenCalledWith(fn, { timeout: 60_000 });
  });
});
