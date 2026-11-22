import { describe, it, expect, vi } from "vitest";

vi.mock("@/i18n/navigation", () => ({
  Link: "a",
}));

import { formatLockedUntil, resolveUnlockError } from "./vault-lock-screen";
import { VaultUnlockError } from "@/lib/vault/vault-context";
import { API_ERROR } from "@/lib/http/api-error-codes";

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

describe("resolveUnlockError", () => {
  const SENTINEL = "SENTINEL-7f3a-do-not-render";
  const msgs = {
    lockedUntil: (lockedUntil: string | null | undefined) => `locked:${lockedUntil ?? "none"}`,
    rateLimited: "rate-limited",
    unavailable: "unavailable",
    fallback: "fallback",
  };

  it("reports an expired session for UNAUTHORIZED", () => {
    expect(resolveUnlockError(new VaultUnlockError(API_ERROR.UNAUTHORIZED), msgs)).toEqual({
      kind: "sessionExpired",
    });
  });

  it("passes the lockout date to lockedUntil for ACCOUNT_LOCKED", () => {
    const until = "2026-02-16T01:00:00.000Z";
    expect(resolveUnlockError(new VaultUnlockError(API_ERROR.ACCOUNT_LOCKED, until), msgs)).toEqual({
      kind: "message",
      message: `locked:${until}`,
    });
  });

  it("calls lockedUntil without a date for ACCOUNT_LOCKED with no date", () => {
    expect(resolveUnlockError(new VaultUnlockError(API_ERROR.ACCOUNT_LOCKED), msgs)).toEqual({
      kind: "message",
      message: "locked:none",
    });
  });

  it("returns the rate-limited message for RATE_LIMIT_EXCEEDED", () => {
    expect(resolveUnlockError(new VaultUnlockError(API_ERROR.RATE_LIMIT_EXCEEDED), msgs)).toEqual({
      kind: "message",
      message: "rate-limited",
    });
  });

  it("returns the unavailable message for SERVICE_UNAVAILABLE", () => {
    expect(resolveUnlockError(new VaultUnlockError(API_ERROR.SERVICE_UNAVAILABLE), msgs)).toEqual({
      kind: "message",
      message: "unavailable",
    });
  });

  it("returns the fallback for an unknown code", () => {
    expect(resolveUnlockError(new VaultUnlockError("SOMETHING_ELSE"), msgs)).toEqual({
      kind: "message",
      message: "fallback",
    });
  });

  it("returns the fallback for an error that is not a VaultUnlockError", () => {
    expect(resolveUnlockError(new TypeError("boom"), msgs)).toEqual({
      kind: "message",
      message: "fallback",
    });
  });

  it("does not surface an unknown code's text", () => {
    const resolved = resolveUnlockError(new VaultUnlockError(`UNKNOWN_${SENTINEL}`), msgs);
    expect(resolved).toEqual({ kind: "message", message: "fallback" });
    expect(JSON.stringify(resolved)).not.toContain(SENTINEL);
  });

  it("does not surface a plain Error's message", () => {
    const resolved = resolveUnlockError(new Error(SENTINEL), msgs);
    expect(resolved).toEqual({ kind: "message", message: "fallback" });
    expect(JSON.stringify(resolved)).not.toContain(SENTINEL);
  });
});
