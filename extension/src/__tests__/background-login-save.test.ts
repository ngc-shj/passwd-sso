import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DecryptedEntry } from "../types/messages";
import {
  encryptData,
  decryptData,
  buildPersonalEntryAAD,
} from "../lib/crypto";

// Must stub chrome before importing login-save
vi.stubGlobal("chrome", { runtime: { id: "test-ext" } });
// Must stub crypto.randomUUID — preserve subtle by reference
const originalCrypto = globalThis.crypto;
vi.stubGlobal("crypto", {
  subtle: originalCrypto.subtle,
  getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
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

const TEST_UUID_1 = "a0000000-0000-0000-0000-000000000001";
const TEST_UUID_2 = "b0000000-0000-0000-0000-000000000002";

const mockEntries: DecryptedEntry[] = [
  { id: TEST_UUID_1, title: "GitHub", username: "alice", urlHost: "github.com", entryType: "LOGIN" },
  { id: TEST_UUID_2, title: "GitLab", username: "bob", urlHost: "gitlab.com", entryType: "LOGIN" },
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
      const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1);
      const blob = JSON.stringify({ password: "same-password" });
      const encBlob = await encryptData(blob, testKey, aad);

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({
            id: TEST_UUID_1,
            encryptedBlob: encBlob,
            aadVersion: 1,
          })),
        ),
      });
      initLoginSave(deps);

      const result = await handleLoginDetected("https://github.com", "alice", "same-password");
      expect(result.action).toBe("none");
    });

    it("returns 'update' when existing entry has null password", async () => {
      const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1);
      const blob = JSON.stringify({ password: null });
      const encBlob = await encryptData(blob, testKey, aad);

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({
            id: TEST_UUID_1,
            encryptedBlob: encBlob,
            aadVersion: 1,
          })),
        ),
      });
      initLoginSave(deps);

      const result = await handleLoginDetected("https://github.com", "alice", "new-password");
      expect(result.action).toBe("update");
      expect(result.existingEntryId).toBe(TEST_UUID_1);
    });

    it("returns 'update' when existing entry has undefined password", async () => {
      const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1);
      const blob = JSON.stringify({ username: "alice" }); // no password field
      const encBlob = await encryptData(blob, testKey, aad);

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({
            id: TEST_UUID_1,
            encryptedBlob: encBlob,
            aadVersion: 1,
          })),
        ),
      });
      initLoginSave(deps);

      const result = await handleLoginDetected("https://github.com", "alice", "new-password");
      expect(result.action).toBe("update");
      expect(result.existingEntryId).toBe(TEST_UUID_1);
    });

    it("returns 'update' when password differs from existing entry", async () => {
      const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1);
      const blob = JSON.stringify({ password: "old-password" });
      const encBlob = await encryptData(blob, testKey, aad);

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({
            id: TEST_UUID_1,
            encryptedBlob: encBlob,
            aadVersion: 1,
          })),
        ),
      });
      initLoginSave(deps);

      const result = await handleLoginDetected("https://github.com", "alice", "new-password");
      expect(result.action).toBe("update");
      expect(result.existingEntryId).toBe(TEST_UUID_1);
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

      // Verify encrypted blobs decrypt to correct content
      const aad = buildPersonalEntryAAD("user-1", "new-uuid-1234");
      const fullPlain = JSON.parse(await decryptData(callBody.encryptedBlob, testKey, aad));
      expect(fullPlain.username).toBe("alice");
      expect(fullPlain.password).toBe("password123");
      expect(fullPlain.title).toBe("example.com");
      expect(fullPlain.url).toBe("https://example.com/login");

      const overviewPlain = JSON.parse(await decryptData(callBody.encryptedOverview, testKey, aad));
      expect(overviewPlain.title).toBe("example.com");
      expect(overviewPlain.username).toBe("alice");
      expect(overviewPlain.urlHost).toBe("example.com");
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

    it("returns error with INVALID_URL for malformed URL", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initLoginSave(deps);

      const result = await handleSaveLogin("not-a-valid-url", "example.com", "alice", "pw");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("INVALID_URL");
    });

    it("handles non-JSON error response from server", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockResolvedValue(
          new Response("Internal Server Error", { status: 500, headers: { "Content-Type": "text/plain" } }),
        ),
      });
      initLoginSave(deps);

      const result = await handleSaveLogin("https://example.com", "example.com", "alice", "pw");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("SAVE_FAILED");
    });
  });

  describe("handleUpdateLogin", () => {
    it("updates password while preserving other fields", async () => {
      const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1);
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
            id: TEST_UUID_1,
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

      const result = await handleUpdateLogin(TEST_UUID_1, "new-password");

      expect(result.ok).toBe(true);
      expect(deps.invalidateCache).toHaveBeenCalled();

      // Verify PUT was called
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const putCall = mockFetch.mock.calls[1];
      expect(putCall[0]).toBe(`/api/passwords/${TEST_UUID_1}`);
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

      const result = await handleUpdateLogin(TEST_UUID_1, "new-pw");
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

      const result = await handleUpdateLogin(TEST_UUID_1, "new-pw");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("FETCH_FAILED");
    });

    it("returns error for invalid entryId format", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initLoginSave(deps);

      const result = await handleUpdateLogin("not-a-uuid", "new-pw");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("INVALID_ENTRY_ID");
    });

    it("handles non-JSON error response from PUT", async () => {
      const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1);
      const blob = JSON.stringify({ password: "old" });
      const encBlob = await encryptData(blob, testKey, aad);
      const overviewBlob = JSON.stringify({ title: "GitHub", username: "alice", urlHost: "github.com" });
      const encOverview = await encryptData(overviewBlob, testKey, aad);

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            id: TEST_UUID_1,
            encryptedBlob: encBlob,
            encryptedOverview: encOverview,
            aadVersion: 1,
          })),
        )
        .mockResolvedValueOnce(
          new Response("Bad Gateway", { status: 502, headers: { "Content-Type": "text/plain" } }),
        );

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: mockFetch,
      });
      initLoginSave(deps);

      const result = await handleUpdateLogin(TEST_UUID_1, "new-pw");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("UPDATE_FAILED");
    });
  });

  describe("handleLoginDetected (multiple matches)", () => {
    it("uses first matching entry when multiple entries match same host+username", async () => {
      const multiMatchEntries: DecryptedEntry[] = [
        { id: TEST_UUID_1, title: "GitHub (work)", username: "alice", urlHost: "github.com", entryType: "LOGIN" },
        { id: TEST_UUID_2, title: "GitHub (personal)", username: "alice", urlHost: "github.com", entryType: "LOGIN" },
      ];

      const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1);
      const blob = JSON.stringify({ password: "old-password" });
      const encBlob = await encryptData(blob, testKey, aad);

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockResolvedValue(multiMatchEntries),
        isHostMatch: vi.fn().mockReturnValue(true),
        swFetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({
            id: TEST_UUID_1,
            encryptedBlob: encBlob,
            aadVersion: 1,
          })),
        ),
      });
      initLoginSave(deps);

      const result = await handleLoginDetected("https://github.com", "alice", "new-password");
      expect(result.action).toBe("update");
      // Should match the first entry (TEST_UUID_1)
      expect(result.existingEntryId).toBe(TEST_UUID_1);
      expect(result.existingTitle).toBe("GitHub (work)");
    });
  });

  describe("handleLoginDetected (error paths)", () => {
    it("returns 'none' when getCachedEntries throws", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockRejectedValue(new Error("network error")),
      });
      initLoginSave(deps);

      const result = await handleLoginDetected("https://github.com", "alice", "pw");
      expect(result.action).toBe("none");
    });
  });
});
