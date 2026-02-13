import { describe, it, expect, vi, beforeEach } from "vitest";

let mockStorage: Record<string, unknown>;

beforeEach(() => {
  mockStorage = {};
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async (key: string) => {
          return { [key]: mockStorage[key] ?? undefined };
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(mockStorage, obj);
        }),
        remove: vi.fn(async (key: string) => {
          delete mockStorage[key];
        }),
      },
    },
  });
});

// Import after chrome is stubbed
const { persistSession, loadSession, clearSession } = await import(
  "../../lib/session-storage"
);

describe("session-storage", () => {
  describe("persistSession", () => {
    it("stores state under authState key", async () => {
      await persistSession({
        token: "tok-1",
        expiresAt: 1700000000000,
        userId: "u-1",
      });
      expect(chrome.storage.session.set).toHaveBeenCalledWith({
        authState: {
          token: "tok-1",
          expiresAt: 1700000000000,
          userId: "u-1",
        },
      });
    });
  });

  describe("loadSession", () => {
    it("returns state when valid data exists", async () => {
      mockStorage.authState = {
        token: "tok-1",
        expiresAt: 1700000000000,
        userId: "u-1",
      };
      const result = await loadSession();
      expect(result).toEqual({
        token: "tok-1",
        expiresAt: 1700000000000,
        userId: "u-1",
      });
    });

    it("returns null when no data exists", async () => {
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null for malformed data (missing token)", async () => {
      mockStorage.authState = { expiresAt: 123, userId: "u-1" };
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null for malformed data (wrong types)", async () => {
      mockStorage.authState = {
        token: 123,
        expiresAt: "not-a-number",
        userId: "u-1",
      };
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null for non-object value", async () => {
      mockStorage.authState = "invalid";
      const result = await loadSession();
      expect(result).toBeNull();
    });
  });

  describe("clearSession", () => {
    it("removes authState key", async () => {
      await clearSession();
      expect(chrome.storage.session.remove).toHaveBeenCalledWith("authState");
    });
  });
});
