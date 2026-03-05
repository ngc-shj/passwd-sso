import { describe, it, expect, afterEach, vi } from "vitest";
import { createRateLimiter } from "@/lib/rate-limit";
import { validateRedisConfig } from "@/lib/redis";

describe("createRateLimiter", () => {
  it("allows requests within the limit", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });

    expect((await limiter.check("key1")).allowed).toBe(true);
    expect((await limiter.check("key1")).allowed).toBe(true);
    expect((await limiter.check("key1")).allowed).toBe(true);
  });

  it("blocks requests exceeding the limit", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

    expect((await limiter.check("key2")).allowed).toBe(true);
    expect((await limiter.check("key2")).allowed).toBe(true);
    expect((await limiter.check("key2")).allowed).toBe(false);
  });

  it("tracks different keys independently", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });

    expect((await limiter.check("keyA")).allowed).toBe(true);
    expect((await limiter.check("keyB")).allowed).toBe(true);
    expect((await limiter.check("keyA")).allowed).toBe(false);
    expect((await limiter.check("keyB")).allowed).toBe(false);
  });

  it("clears a specific key counter", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });

    expect((await limiter.check("key3")).allowed).toBe(true);
    expect((await limiter.check("key3")).allowed).toBe(false);

    await limiter.clear("key3");
    expect((await limiter.check("key3")).allowed).toBe(true);
  });

  it("resets counter after window expires", async () => {
    const limiter = createRateLimiter({ windowMs: 50, max: 1 });

    expect((await limiter.check("key4")).allowed).toBe(true);
    expect((await limiter.check("key4")).allowed).toBe(false);

    // Wait for the window to expire
    await new Promise((r) => setTimeout(r, 60));

    expect((await limiter.check("key4")).allowed).toBe(true);
  });
});

describe("validateRedisConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws in production when REDIS_URL is not set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("REDIS_URL", "");

    expect(() => validateRedisConfig()).toThrow("REDIS_URL is required");
  });

  it("does not throw in production when REDIS_URL is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    expect(() => validateRedisConfig()).not.toThrow();
  });

  it("does not throw in development when REDIS_URL is not set", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("REDIS_URL", "");

    expect(() => validateRedisConfig()).not.toThrow();
  });

  it("does not throw in test when REDIS_URL is not set", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("REDIS_URL", "");

    expect(() => validateRedisConfig()).not.toThrow();
  });
});
