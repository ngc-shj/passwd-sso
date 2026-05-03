import { describe, it, expect, vi } from "vitest";

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
  getTenantRlsContext: () => undefined,
}));

import { envInt } from "./prisma";

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
