import { describe, it, expect } from "vitest";
import { computeBackoffMs, withFullJitter } from "@/lib/http/backoff";

describe("computeBackoffMs", () => {
  it("returns baseMs (1000) for attempt 0", () => {
    expect(computeBackoffMs(0)).toBe(1000);
  });

  it("returns 2000 for attempt 1", () => {
    expect(computeBackoffMs(1)).toBe(2000);
  });

  it("returns 4000 for attempt 2", () => {
    expect(computeBackoffMs(2)).toBe(4000);
  });

  it("is capped at capMs (3600000) for very large attempts", () => {
    // 1000 * 2^32 would exceed 3600000, so the cap kicks in
    expect(computeBackoffMs(32)).toBe(3_600_000);
  });

  it("respects custom baseMs option", () => {
    expect(computeBackoffMs(0, { baseMs: 500 })).toBe(500);
  });

  it("respects custom capMs option", () => {
    expect(computeBackoffMs(10, { capMs: 5000 })).toBe(5000);
  });

  it("custom baseMs and capMs interact correctly", () => {
    // attempt=2: 500 * 2^2 = 2000, capped at 1500
    expect(computeBackoffMs(2, { baseMs: 500, capMs: 1500 })).toBe(1500);
  });
});

describe("withFullJitter", () => {
  it("returns a value in [0, ms)", () => {
    for (let i = 0; i < 50; i++) {
      const result = withFullJitter(1000);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(1000);
    }
  });

  it("returns 0 for ms=0", () => {
    expect(withFullJitter(0)).toBe(0);
  });
});
