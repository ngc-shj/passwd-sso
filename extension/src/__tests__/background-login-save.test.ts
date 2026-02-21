import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DecryptedEntry } from "../types/messages";
import {
  encryptData,
  decryptData,
  buildPersonalEntryAAD,
} from "../lib/crypto";

// Must stub chrome before importing login-save
vi.stubGlobal("chrome", { runtime: { id: "test-ext" } });
// Must stub crypto.randomUUID
vi.stubGlobal("crypto", {
  ...globalThis.crypto,
  randomUUID: vi.fn().mockReturnValue("new-uuid-1234"),
});

import {
  initLoginSave,
  handleLoginDetected,
  handleSaveLogin,
  handleUpdateLogin,
  type LoginSaveDeps,
} from "../background/login-save";

async function makeTestKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

const mockEntries: DecryptedEntry[] = [
  { id: "e1", title: "GitHub", username: "alice", urlHost: "github.com", entryType: "LOGIN" },
  { id: "e2", title: "GitLab", username: "bob", urlHost: "gitlab.com", entryType: "LOGIN" },
];

function createDeps(overrides?: Partial<LoginSaveDeps>): LoginSaveDeps {
  return {
    getEncryptionKey: vi.fn().mockReturnValue(null),
    getCurrentUserId: vi.fn().mockReturnValue("user-1"),
    getCachedEntries: vi.fn().mockResolvedValue(mockEntries),
    isHostMatch: vi.fn((entryHost: string, tabHost: string) => entryHost === tabHost),
    extractHost: vi.fn((url: string) => {
      try { return new URL(url).hostname; } catch { return null; }
    }),
    swFetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    invalidateCache: vi.fn(),
    ...overrides,
  };
}

describe("login-save", () => {
  let testKey: CryptoKey;

  beforeEach(async () => {
    vi.clearAllMocks();
    testKey = await makeTestKey();
  });

  describe("handleLoginDetected", () => {
    it("returns 'none' when vault is locked", async () => {
      const deps = createDeps({ getEncryptionKey: vi.fn().mockReturnValue(null) });
      initLoginSave(deps);

      const result = await handleLoginDetected("https://github.com/login", "alice", "pw");
      expect(result.action).toBe("none");
    });

    it("returns 'save' when no matching entry exists", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initLoginSave(deps);

      const result = await handleLoginDetected("https://nomatch.example.com", "alice", "pw");
      expect(result.action).toBe("save");
    });

    it("returns 'save' when host matches but username does not", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initLoginSave(deps);

      const result = await handleLoginDetected("https://github.com", "unknown-user", "pw");
      expect(result.action).toBe("save");
    });

    it("returns 'none' when password matches existing entry", async () => {
      const aad = buildPersonalEntryAAD("user-1", "e1");
      const blob = JSON.stringify({ password: "same-password" });
      const encBlob = await encryptData(blob, testKey, aad);

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({
            id: "e1",
            encryptedBlob: encBlob,
            aadVersion: 1,
          })),
        ),
      });
      initLoginSave(deps);

      const result = await handleLoginDetected("https://github.com", "alice", "same-password");
      expect(result.action).toBe("none");
    });

    it("returns 'update' when password differs from existing entry", async () => {
      const aad = buildPersonalEntryAAD("user-1", "e1");
      const blob = JSON.stringify({ password: "old-password" });
      const encBlob = await encryptData(blob, testKey, aad);

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({
            id: "e1",
            encryptedBlob: encBlob,
            aadVersion: 1,
          })),
        ),
      });
      initLoginSave(deps);

      const result = await handleLoginDetected("https://github.com", "alice", "new-password");
      expect(result.action).toBe("update");
      expect(result.existingEntryId).toBe("e1");
      expect(result.existingTitle).toBe("GitHub");
    });
  });

  describe("handleSaveLogin", () => {
    it("creates new entry and invalidates cache", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "new-uuid-1234" }), { status: 201 }),
      );
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: mockFetch,
      });
      initLoginSave(deps);

      const result = await handleSaveLogin(
        "https://example.com/login",
        "example.com",
        "alice",
        "password123",
      );

      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/passwords",
        expect.objectContaining({ method: "POST" }),
      );
      // Verify the POST body contains expected fields
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.id).toBe("new-uuid-1234");
      expect(callBody.entryType).toBe("LOGIN");
      expect(callBody.aadVersion).toBe(1);
      expect(callBody.encryptedBlob).toBeDefined();
      expect(callBody.encryptedOverview).toBeDefined();
      expect(deps.invalidateCache).toHaveBeenCalled();
    });

    it("returns error when vault is locked", async () => {
      const deps = createDeps({ getEncryptionKey: vi.fn().mockReturnValue(null) });
      initLoginSave(deps);

      const result = await handleSaveLogin("https://example.com", "example.com", "alice", "pw");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("VAULT_LOCKED");
    });

    it("returns error on server failure", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
        ),
      });
      initLoginSave(deps);

      const result = await handleSaveLogin("https://example.com", "example.com", "alice", "pw");
      expect(result.ok).toBe(false);
    });
  });

  describe("handleUpdateLogin", () => {
    it("updates password while preserving other fields", async () => {
      const aad = buildPersonalEntryAAD("user-1", "e1");
      const originalBlob = {
        title: "GitHub",
        username: "alice",
        password: "old-password",
        url: "https://github.com",
        notes: "my notes",
      };
      const encBlob = await encryptData(JSON.stringify(originalBlob), testKey, aad);
      const overviewBlob = { title: "GitHub", username: "alice", urlHost: "github.com" };
      const encOverview = await encryptData(JSON.stringify(overviewBlob), testKey, aad);

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          // GET entry
          new Response(JSON.stringify({
            id: "e1",
            encryptedBlob: encBlob,
            encryptedOverview: encOverview,
            aadVersion: 1,
          })),
        )
        .mockResolvedValueOnce(
          // PUT response
          new Response(JSON.stringify({ id: "e1" }), { status: 200 }),
        );

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: mockFetch,
      });
      initLoginSave(deps);

      const result = await handleUpdateLogin("e1", "new-password");

      expect(result.ok).toBe(true);
      expect(deps.invalidateCache).toHaveBeenCalled();

      // Verify PUT was called
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const putCall = mockFetch.mock.calls[1];
      expect(putCall[0]).toBe("/api/passwords/e1");
      expect(JSON.parse(putCall[1].body).encryptedBlob).toBeDefined();

      // Verify the updated blob preserves all original fields except password
      const putBody = JSON.parse(putCall[1].body);
      const updatedBlobPlain = await decryptData(putBody.encryptedBlob, testKey, aad);
      const updatedBlob = JSON.parse(updatedBlobPlain);
      expect(updatedBlob.password).toBe("new-password");
      expect(updatedBlob.title).toBe("GitHub");
      expect(updatedBlob.username).toBe("alice");
      expect(updatedBlob.url).toBe("https://github.com");
      expect(updatedBlob.notes).toBe("my notes");
    });

    it("returns error when vault is locked", async () => {
      const deps = createDeps({ getEncryptionKey: vi.fn().mockReturnValue(null) });
      initLoginSave(deps);

      const result = await handleUpdateLogin("e1", "new-pw");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("VAULT_LOCKED");
    });

    it("returns error when entry fetch fails", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockResolvedValue(
          new Response("", { status: 404 }),
        ),
      });
      initLoginSave(deps);

      const result = await handleUpdateLogin("e1", "new-pw");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("FETCH_FAILED");
    });
  });
});
