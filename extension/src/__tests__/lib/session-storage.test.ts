import { describe, it, expect, vi, beforeEach } from "vitest";
import { SESSION_KEY } from "../../lib/constants";

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
      mockStorage[SESSION_KEY] = {
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
      mockStorage[SESSION_KEY] = { expiresAt: 123, userId: "u-1" };
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null for malformed data (wrong types)", async () => {
      mockStorage[SESSION_KEY] = {
        token: 123,
        expiresAt: "not-a-number",
        userId: "u-1",
      };
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns null for non-object value", async () => {
      mockStorage[SESSION_KEY] = "invalid";
      const result = await loadSession();
      expect(result).toBeNull();
    });

    it("returns state without userId (pre-unlock)", async () => {
      mockStorage[SESSION_KEY] = {
        token: "tok-1",
        expiresAt: 1700000000000,
      };
      const result = await loadSession();
      expect(result).toEqual({
        token: "tok-1",
        expiresAt: 1700000000000,
      });
    });

    it("returns null when userId is wrong type", async () => {
      mockStorage[SESSION_KEY] = {
        token: "tok-1",
        expiresAt: 1700000000000,
        userId: 123,
      };
      const result = await loadSession();
      expect(result).toBeNull();
    });
  });

  describe("clearSession", () => {
    it("removes authState key", async () => {
      await clearSession();
      expect(chrome.storage.session.remove).toHaveBeenCalledWith(SESSION_KEY);
    });
  });
});
