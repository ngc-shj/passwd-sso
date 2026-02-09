import { describe, it, expect } from "vitest";
import { createRateLimiter } from "@/lib/rate-limit";

describe("createRateLimiter", () => {
  it("allows requests within the limit", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });

    expect(await limiter.check("key1")).toBe(true);
    expect(await limiter.check("key1")).toBe(true);
    expect(await limiter.check("key1")).toBe(true);
  });

  it("blocks requests exceeding the limit", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

    expect(await limiter.check("key2")).toBe(true);
    expect(await limiter.check("key2")).toBe(true);
    expect(await limiter.check("key2")).toBe(false);
  });

  it("tracks different keys independently", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });

    expect(await limiter.check("keyA")).toBe(true);
    expect(await limiter.check("keyB")).toBe(true);
    expect(await limiter.check("keyA")).toBe(false);
    expect(await limiter.check("keyB")).toBe(false);
  });

  it("clears a specific key counter", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });

    expect(await limiter.check("key3")).toBe(true);
    expect(await limiter.check("key3")).toBe(false);

    await limiter.clear("key3");
    expect(await limiter.check("key3")).toBe(true);
  });

  it("resets counter after window expires", async () => {
    const limiter = createRateLimiter({ windowMs: 50, max: 1 });

    expect(await limiter.check("key4")).toBe(true);
    expect(await limiter.check("key4")).toBe(false);

    // Wait for the window to expire
    await new Promise((r) => setTimeout(r, 60));

    expect(await limiter.check("key4")).toBe(true);
  });
});
