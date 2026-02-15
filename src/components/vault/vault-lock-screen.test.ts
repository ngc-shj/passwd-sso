import { describe, it, expect, vi } from "vitest";
import { formatLockedUntil } from "./vault-lock-screen";

/**
 * Minimal t() mock that mirrors next-intl interpolation.
 * Returns "key:value1,value2" format for easy assertion.
 */
function mockT(key: string, values?: Record<string, string>): string {
  if (values) {
    const pairs = Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return `${key}(${pairs})`;
  }
  return key;
}

describe("formatLockedUntil", () => {
  it("returns accountLocked when lockedUntil is null", () => {
    expect(formatLockedUntil(null, mockT)).toBe("accountLocked");
  });

  it("returns accountLocked when lockedUntil is undefined", () => {
    expect(formatLockedUntil(undefined, mockT)).toBe("accountLocked");
  });

  it("returns accountLocked when lockedUntil is in the past", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(formatLockedUntil(past, mockT)).toBe("accountLocked");
  });

  it("returns minutes for short locks (< 60 min)", () => {
    vi.useFakeTimers({ now: new Date("2026-02-16T00:00:00Z") });
    const inFifteenMin = new Date(Date.now() + 15 * 60_000).toISOString();
    const result = formatLockedUntil(inFifteenMin, mockT);
    // t("accountLockedWithTime", { time: t("minutes", { count: "15" }) })
    // → "accountLockedWithTime(time=minutes(count=15))"
    expect(result).toContain("accountLockedWithTime");
    expect(result).toContain("minutes");
    expect(result).toContain("count=15");
    vi.useRealTimers();
  });

  it("returns minutes for 59 min (boundary before hours)", () => {
    vi.useFakeTimers({ now: new Date("2026-02-16T00:00:00Z") });
    const in59Min = new Date(Date.now() + 59 * 60_000).toISOString();
    const result = formatLockedUntil(in59Min, mockT);
    expect(result).toContain("minutes");
    expect(result).not.toContain("hours");
    expect(result).toContain("count=59");
    vi.useRealTimers();
  });

  it("returns hours for long locks (>= 60 min)", () => {
    vi.useFakeTimers({ now: new Date("2026-02-16T00:00:00Z") });
    const inTwoHours = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const result = formatLockedUntil(inTwoHours, mockT);
    expect(result).toContain("accountLockedWithTime");
    expect(result).toContain("hours");
    expect(result).toContain("count=2");
    vi.useRealTimers();
  });

  it("returns hours=1 for exactly 60 min", () => {
    vi.useFakeTimers({ now: new Date("2026-02-16T00:00:00Z") });
    const inOneHour = new Date(Date.now() + 60 * 60_000).toISOString();
    const result = formatLockedUntil(inOneHour, mockT);
    expect(result).toContain("hours");
    expect(result).toContain("count=1");
    vi.useRealTimers();
  });

  it("returns hours for 24h lock", () => {
    vi.useFakeTimers({ now: new Date("2026-02-16T00:00:00Z") });
    const in24Hours = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const result = formatLockedUntil(in24Hours, mockT);
    expect(result).toContain("hours");
    expect(result).toContain("count=24");
    vi.useRealTimers();
  });
});
