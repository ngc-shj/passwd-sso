import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ioredis default export is used as a constructor: `new Redis(...)`.
// The mock must use a regular function (not an arrow function) so it can be
// called with `new`. vi.fn() alone without an implementation is a no-op
// constructor that returns an instance; we override it with mockImplementation.
const mocks = vi.hoisted(() => {
  const connectFn = vi.fn().mockResolvedValue(undefined);
  const onFn = vi.fn().mockReturnThis();

  // Constructor mock — must be a regular function so `new Redis(...)` works.
  const RedisMock = vi.fn(function (this: Record<string, unknown>) {
    this.connect = connectFn;
    this.on = onFn;
  });

  return { connectFn, onFn, RedisMock };
});

vi.mock("ioredis", () => ({ default: mocks.RedisMock }));

describe("getRedis", () => {
  const globalAny = globalThis as unknown as { redisClient?: unknown };

  beforeEach(() => {
    vi.resetModules();
    delete globalAny.redisClient;
    mocks.connectFn.mockClear();
    mocks.onFn.mockClear();
    mocks.RedisMock.mockClear();
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_SENTINEL;
    delete process.env.REDIS_SENTINEL_HOSTS;
    delete process.env.REDIS_SENTINEL_MASTER_NAME;
    delete process.env.REDIS_SENTINEL_PASSWORD;
    delete process.env.REDIS_SENTINEL_TLS;
    delete globalAny.redisClient;
  });

  it("returns null when REDIS_URL is not set", async () => {
    delete process.env.REDIS_URL;
    const { getRedis } = await import("@/lib/redis");
    const result = getRedis();
    expect(result).toBeNull();
  });

  it("creates a Redis client when REDIS_URL is set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedis } = await import("@/lib/redis");
    const result = getRedis();
    expect(result).not.toBeNull();
    expect(mocks.RedisMock).toHaveBeenCalledWith("redis://localhost:6379", { lazyConnect: true });
  });

  it("returns the same singleton on repeated calls", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedis } = await import("@/lib/redis");
    const a = getRedis();
    const b = getRedis();
    expect(a).toBe(b);
    expect(mocks.RedisMock).toHaveBeenCalledTimes(1);
  });

  it("registers an error handler to suppress errors", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedis } = await import("@/lib/redis");
    getRedis();
    expect(mocks.onFn).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("calls connect after creating the client", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedis } = await import("@/lib/redis");
    getRedis();
    expect(mocks.connectFn).toHaveBeenCalled();
  });

  it("creates a sentinel-mode Redis client when REDIS_SENTINEL=true", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.REDIS_SENTINEL = "true";
    process.env.REDIS_SENTINEL_HOSTS = "sentinel1:26379,sentinel2:26380";
    process.env.REDIS_SENTINEL_MASTER_NAME = "main";
    const { getRedis } = await import("@/lib/redis");
    getRedis();
    expect(mocks.RedisMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sentinels: [
          { host: "sentinel1", port: 26379 },
          { host: "sentinel2", port: 26380 },
        ],
        name: "main",
        lazyConnect: true,
      }),
    );
  });

  it("uses default port 26379 when sentinel host has no port", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.REDIS_SENTINEL = "true";
    process.env.REDIS_SENTINEL_HOSTS = "sentinel-host";
    const { getRedis } = await import("@/lib/redis");
    getRedis();
    expect(mocks.RedisMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sentinels: [{ host: "sentinel-host", port: 26379 }],
      }),
    );
  });

  it("uses default master name 'mymaster' when REDIS_SENTINEL_MASTER_NAME is not set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.REDIS_SENTINEL = "true";
    process.env.REDIS_SENTINEL_HOSTS = "sentinel:26379";
    delete process.env.REDIS_SENTINEL_MASTER_NAME;
    const { getRedis } = await import("@/lib/redis");
    getRedis();
    expect(mocks.RedisMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mymaster" }),
    );
  });

  it("includes TLS options when REDIS_SENTINEL_TLS=true", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.REDIS_SENTINEL = "true";
    process.env.REDIS_SENTINEL_HOSTS = "sentinel:26379";
    process.env.REDIS_SENTINEL_TLS = "true";
    const { getRedis } = await import("@/lib/redis");
    getRedis();
    expect(mocks.RedisMock).toHaveBeenCalledWith(
      expect.objectContaining({ tls: {}, sentinelTLS: {} }),
    );
  });

  it("includes sentinelPassword when REDIS_SENTINEL_PASSWORD is set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.REDIS_SENTINEL = "true";
    process.env.REDIS_SENTINEL_HOSTS = "sentinel:26379";
    process.env.REDIS_SENTINEL_PASSWORD = "s3cr3t";
    const { getRedis } = await import("@/lib/redis");
    getRedis();
    expect(mocks.RedisMock).toHaveBeenCalledWith(
      expect.objectContaining({ sentinelPassword: "s3cr3t" }),
    );
  });
});

describe("validateRedisConfig", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.REDIS_URL;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.NODE_ENV;
  });

  it("throws in production when REDIS_URL is not set", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.REDIS_URL;
    const { validateRedisConfig } = await import("@/lib/redis");
    expect(() => validateRedisConfig()).toThrow("REDIS_URL is required in production");
  });

  it("does not throw in production when REDIS_URL is set", async () => {
    process.env.NODE_ENV = "production";
    process.env.REDIS_URL = "redis://localhost:6379";
    const { validateRedisConfig } = await import("@/lib/redis");
    expect(() => validateRedisConfig()).not.toThrow();
  });

  it("does not throw in development when REDIS_URL is not set", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_URL;
    const { validateRedisConfig } = await import("@/lib/redis");
    expect(() => validateRedisConfig()).not.toThrow();
  });

  it("does not throw in test environment when REDIS_URL is not set", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.REDIS_URL;
    const { validateRedisConfig } = await import("@/lib/redis");
    expect(() => validateRedisConfig()).not.toThrow();
  });
});
