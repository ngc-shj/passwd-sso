import { describe, expect, it } from "vitest";
import { shouldAutoCheck, hasNewBreaches } from "./auto-monitor";

describe("shouldAutoCheck", () => {
  const now = Date.now();

  it("returns true when enabled, unlocked, and 25h since last check", () => {
    expect(
      shouldAutoCheck({
        enabled: true,
        vaultUnlocked: true,
        lastCheckAt: now - 25 * 60 * 60 * 1000,
        now,
      }),
    ).toBe(true);
  });

  it("returns true when enabled, unlocked, and never checked before", () => {
    expect(
      shouldAutoCheck({
        enabled: true,
        vaultUnlocked: true,
        lastCheckAt: null,
        now,
      }),
    ).toBe(true);
  });

  it("returns false when disabled", () => {
    expect(
      shouldAutoCheck({
        enabled: false,
        vaultUnlocked: true,
        lastCheckAt: now - 25 * 60 * 60 * 1000,
        now,
      }),
    ).toBe(false);
  });

  it("returns false when vault is locked", () => {
    expect(
      shouldAutoCheck({
        enabled: true,
        vaultUnlocked: false,
        lastCheckAt: now - 25 * 60 * 60 * 1000,
        now,
      }),
    ).toBe(false);
  });

  it("returns false when only 1h since last check", () => {
    expect(
      shouldAutoCheck({
        enabled: true,
        vaultUnlocked: true,
        lastCheckAt: now - 1 * 60 * 60 * 1000,
        now,
      }),
    ).toBe(false);
  });

  it("returns true when checked exactly 24h ago (boundary, >= triggers)", () => {
    expect(
      shouldAutoCheck({
        enabled: true,
        vaultUnlocked: true,
        lastCheckAt: now - 24 * 60 * 60 * 1000,
        now,
      }),
    ).toBe(true);
  });

  it("returns false when checked 23h 59m ago (just under threshold)", () => {
    expect(
      shouldAutoCheck({
        enabled: true,
        vaultUnlocked: true,
        lastCheckAt: now - (24 * 60 * 60 * 1000 - 60_000),
        now,
      }),
    ).toBe(false);
  });
});

describe("hasNewBreaches", () => {
  it("returns true when current count exceeds last known", () => {
    expect(hasNewBreaches(5, 3)).toBe(true);
  });

  it("returns false when counts are equal", () => {
    expect(hasNewBreaches(3, 3)).toBe(false);
  });

  it("returns false when current count is lower (breaches fixed)", () => {
    expect(hasNewBreaches(2, 3)).toBe(false);
  });

  it("returns true when last known is zero", () => {
    expect(hasNewBreaches(1, 0)).toBe(true);
  });

  it("returns false when both are zero", () => {
    expect(hasNewBreaches(0, 0)).toBe(false);
  });
});
