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

import { getSettings, setSettings } from "../../lib/storage";

describe("getSettings", () => {
  it("returns defaults when storage is empty", async () => {
    const settings = await getSettings();
    expect(settings).toEqual({
      serverUrl: "https://localhost:3000",
      autoLockMinutes: 15,
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
