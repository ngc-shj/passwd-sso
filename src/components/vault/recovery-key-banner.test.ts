import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Minimal localStorage mock for Node environment
const storageMap = new Map<string, string>();
const mockLocalStorage = {
  getItem: vi.fn((key: string) => storageMap.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => storageMap.set(key, value)),
  removeItem: vi.fn((key: string) => storageMap.delete(key)),
  clear: vi.fn(() => storageMap.clear()),
};
vi.stubGlobal("localStorage", mockLocalStorage);

// Mock dependencies that isDismissedInStorage's parent module imports
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/lib/vault-context", () => ({
  useVault: () => ({
    status: "LOCKED",
    hasRecoveryKey: false,
  }),
}));
vi.mock("@/lib/constants", () => ({
  VAULT_STATUS: { UNLOCKED: "UNLOCKED", LOCKED: "LOCKED" },
}));
vi.mock("./recovery-key-dialog", () => ({
  RecoveryKeyDialog: () => null,
}));

import { isDismissedInStorage } from "./recovery-key-banner";

const DISMISS_KEY = "psso:recovery-key-banner-dismissed";
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

describe("isDismissedInStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-02-16T12:00:00Z") });
    storageMap.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when no dismiss timestamp exists", () => {
    expect(isDismissedInStorage()).toBe(false);
  });

  it("returns true when dismissed less than 24h ago", () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    storageMap.set(DISMISS_KEY, String(oneHourAgo));
    expect(isDismissedInStorage()).toBe(true);
  });

  it("returns true when dismissed exactly at boundary (23h59m)", () => {
    const justUnder = Date.now() - (TWENTY_FOUR_HOURS - 60_000);
    storageMap.set(DISMISS_KEY, String(justUnder));
    expect(isDismissedInStorage()).toBe(true);
  });

  it("returns false when dismissed 24h or more ago", () => {
    const exactlyExpired = Date.now() - TWENTY_FOUR_HOURS;
    storageMap.set(DISMISS_KEY, String(exactlyExpired));
    expect(isDismissedInStorage()).toBe(false);
  });

  it("returns false when dismissed over 24h ago", () => {
    const longAgo = Date.now() - TWENTY_FOUR_HOURS - 60_000;
    storageMap.set(DISMISS_KEY, String(longAgo));
    expect(isDismissedInStorage()).toBe(false);
  });

  it("returns false when localStorage value is non-numeric", () => {
    storageMap.set(DISMISS_KEY, "not-a-number");
    // NaN arithmetic → elapsed is NaN → NaN < DURATION is false → returns false
    expect(isDismissedInStorage()).toBe(false);
  });

  it("returns false when localStorage has a future timestamp", () => {
    storageMap.set(DISMISS_KEY, String(Date.now() + TWENTY_FOUR_HOURS));
    expect(isDismissedInStorage()).toBe(false);
  });

  it("returns false when localStorage throws", () => {
    mockLocalStorage.getItem.mockImplementationOnce(() => {
      throw new Error("storage access denied");
    });
    expect(isDismissedInStorage()).toBe(false);
  });
});
