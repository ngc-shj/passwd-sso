import { describe, it, expect, vi, beforeEach } from "vitest";

let mockLocalStorage: Record<string, unknown>;

beforeEach(() => {
  mockLocalStorage = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (defaults: Record<string, unknown>) => ({
          ...defaults,
          ...mockLocalStorage,
        })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(mockLocalStorage, items);
        }),
      },
    },
  });
});

import { getSettings, setSettings, validateSettings, DEFAULTS } from "../../lib/storage";

describe("getSettings", () => {
  it("returns defaults when storage is empty", async () => {
    const settings = await getSettings();
    expect(settings).toEqual({
      serverUrl: "https://localhost:3000",
      autoLockMinutes: 15,
      theme: "system",
      showBadgeCount: true,
      enableInlineSuggestions: true,
      enableContextMenu: true,
      autoCopyTotp: true,
      showSavePrompt: true,
      showUpdatePrompt: true,
      clipboardClearSeconds: 30,
      vaultTimeoutAction: "lock",
    });
  });

  it("returns stored values when they exist", async () => {
    mockLocalStorage = {
      serverUrl: "https://example.com",
      autoLockMinutes: 5,
    };
    const settings = await getSettings();
    expect(settings.serverUrl).toBe("https://example.com");
    expect(settings.autoLockMinutes).toBe(5);
  });

  it("merges partial stored values with defaults", async () => {
    mockLocalStorage = { serverUrl: "https://custom.dev" };
    const settings = await getSettings();
    expect(settings.serverUrl).toBe("https://custom.dev");
    expect(settings.autoLockMinutes).toBe(15);
    expect(settings.theme).toBe("system");
  });
});

describe("setSettings", () => {
  it("stores partial settings", async () => {
    await setSettings({ serverUrl: "https://new.dev" });
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      serverUrl: "https://new.dev",
    });
  });

  it("stores full settings", async () => {
    await setSettings({ serverUrl: "https://a.com", autoLockMinutes: 30 });
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      serverUrl: "https://a.com",
      autoLockMinutes: 30,
    });
  });
});

describe("validateSettings", () => {
  it("returns valid settings unchanged", () => {
    const result = validateSettings({ ...DEFAULTS });
    expect(result).toEqual(DEFAULTS);
  });

  it("falls back invalid theme to default", () => {
    const result = validateSettings({ ...DEFAULTS, theme: "neon" as any });
    expect(result.theme).toBe("system");
  });

  it("falls back invalid clipboardClearSeconds to default", () => {
    const result = validateSettings({ ...DEFAULTS, clipboardClearSeconds: 999 });
    expect(result.clipboardClearSeconds).toBe(30);
  });

  it("falls back zero clipboardClearSeconds to default", () => {
    const result = validateSettings({ ...DEFAULTS, clipboardClearSeconds: 0 });
    expect(result.clipboardClearSeconds).toBe(30);
  });

  it("falls back invalid vaultTimeoutAction to default", () => {
    const result = validateSettings({ ...DEFAULTS, vaultTimeoutAction: "delete" as any });
    expect(result.vaultTimeoutAction).toBe("lock");
  });

  it("falls back non-boolean showBadgeCount to default", () => {
    const result = validateSettings({ ...DEFAULTS, showBadgeCount: "true" as any });
    expect(result.showBadgeCount).toBe(true);
  });

  it("clamps negative autoLockMinutes to minimum (5)", () => {
    // After the 5-min floor was introduced, negative values are clamped up
    // to the minimum rather than silently falling back to the 15-min default.
    // Rationale: never silently ignore a user's configured intent; enforce
    // the security invariant explicitly.
    const result = validateSettings({ ...DEFAULTS, autoLockMinutes: -5 });
    expect(result.autoLockMinutes).toBe(5);
  });

  it("clamps legacy 0 ('never') autoLockMinutes to minimum (5)", () => {
    const result = validateSettings({ ...DEFAULTS, autoLockMinutes: 0 });
    expect(result.autoLockMinutes).toBe(5);
  });

  it("clamps legacy 1-4 minute autoLockMinutes to minimum (5)", () => {
    const result = validateSettings({ ...DEFAULTS, autoLockMinutes: 3 });
    expect(result.autoLockMinutes).toBe(5);
  });

  it("falls back NaN autoLockMinutes to default", () => {
    const result = validateSettings({ ...DEFAULTS, autoLockMinutes: NaN });
    expect(result.autoLockMinutes).toBe(15);
  });

  it("falls back empty serverUrl to default", () => {
    const result = validateSettings({ ...DEFAULTS, serverUrl: "" });
    expect(result.serverUrl).toBe("https://localhost:3000");
  });

  it("falls back non-string serverUrl to default", () => {
    const result = validateSettings({ ...DEFAULTS, serverUrl: 123 as any });
    expect(result.serverUrl).toBe("https://localhost:3000");
  });

  it("accepts valid clipboardClearSeconds values", () => {
    for (const v of [10, 20, 30, 60, 120, 300]) {
      expect(validateSettings({ ...DEFAULTS, clipboardClearSeconds: v }).clipboardClearSeconds).toBe(v);
    }
  });
});
