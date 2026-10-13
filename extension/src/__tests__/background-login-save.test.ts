import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DecryptedEntry } from "../types/messages";
import { deferred, holdNextCall } from "./helpers/deferred";
import { assertVaultEpoch, bumpVaultEpoch, currentVaultEpoch } from "../background/vault-epoch";

// encryptData stays the real implementation; wrapping it lets a test hold one
// call (#885) while the vault epoch moves.
vi.mock("../lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/crypto")>();
  return { ...actual, encryptData: vi.fn(actual.encryptData) };
});
import {
  encryptData,
  decryptData,
  buildPersonalEntryAAD,
  VAULT_TYPE,
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
    getKeyVersion: vi.fn().mockReturnValue(1),
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
      const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.BLOB);
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
      const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.BLOB);
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
      const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.BLOB);
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
      const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.BLOB);
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
        { epoch: currentVaultEpoch() },
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
      const blobAad = buildPersonalEntryAAD("user-1", "new-uuid-1234", VAULT_TYPE.BLOB);
      const overviewAad = buildPersonalEntryAAD("user-1", "new-uuid-1234", VAULT_TYPE.OVERVIEW);
      const fullPlain = JSON.parse(await decryptData(callBody.encryptedBlob, testKey, blobAad));
      expect(fullPlain.username).toBe("alice");
      expect(fullPlain.password).toBe("password123");
      expect(fullPlain.title).toBe("example.com");
      expect(fullPlain.url).toBe("https://example.com/login");

      const overviewPlain = JSON.parse(await decryptData(callBody.encryptedOverview, testKey, overviewAad));
      expect(overviewPlain.title).toBe("example.com");
      expect(overviewPlain.username).toBe("alice");
      expect(overviewPlain.urlHost).toBe("example.com");
    });

    it("threads the current key version into the POST body", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "new-uuid-1234" }), { status: 201 }),
      );
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getKeyVersion: vi.fn().mockReturnValue(3),
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
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.keyVersion).toBe(3);
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

    it("returns error when swFetch throws network error", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockRejectedValue(new Error("Failed to fetch")),
      });
      initLoginSave(deps);

      const result = await handleSaveLogin("https://example.com", "example.com", "alice", "pw");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("NETWORK_ERROR");
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
      const blobAad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.BLOB);
      const overviewAad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.OVERVIEW);
      const originalBlob = {
        title: "GitHub",
        username: "alice",
        password: "old-password",
        url: "https://github.com",
        notes: "my notes",
      };
      const encBlob = await encryptData(JSON.stringify(originalBlob), testKey, blobAad);
      const overviewBlob = { title: "GitHub", username: "alice", urlHost: "github.com" };
      const encOverview = await encryptData(JSON.stringify(overviewBlob), testKey, overviewAad);

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
      const updatedBlobPlain = await decryptData(putBody.encryptedBlob, testKey, blobAad);
      const updatedBlob = JSON.parse(updatedBlobPlain);
      expect(updatedBlob.password).toBe("new-password");
      expect(updatedBlob.title).toBe("GitHub");
      expect(updatedBlob.username).toBe("alice");
      expect(updatedBlob.url).toBe("https://github.com");
      expect(updatedBlob.notes).toBe("my notes");

      // The re-encrypted overview must round-trip with the OVERVIEW AAD —
      // guards against the blob/overview AADs being crossed on re-encrypt.
      expect(putBody.encryptedOverview).toBeDefined();
      const updatedOverview = JSON.parse(
        await decryptData(putBody.encryptedOverview, testKey, overviewAad),
      );
      expect(updatedOverview.title).toBe("GitHub");
      expect(updatedOverview.username).toBe("alice");
      expect(updatedOverview.urlHost).toBe("github.com");
    });

    it("threads the current key version into the PUT body", async () => {
      const blobAad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.BLOB);
      const overviewAad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.OVERVIEW);
      const encBlob = await encryptData(JSON.stringify({ password: "old" }), testKey, blobAad);
      const encOverview = await encryptData(JSON.stringify({ title: "GitHub", username: "alice", urlHost: "github.com" }), testKey, overviewAad);

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: TEST_UUID_1, encryptedBlob: encBlob, encryptedOverview: encOverview, aadVersion: 1 })),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: TEST_UUID_1 }), { status: 200 }));

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getKeyVersion: vi.fn().mockReturnValue(3),
        swFetch: mockFetch,
      });
      initLoginSave(deps);

      const result = await handleUpdateLogin(TEST_UUID_1, "new-password");
      expect(result.ok).toBe(true);
      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(putBody.keyVersion).toBe(3);
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
      const blobAad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.BLOB);
      const overviewAad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.OVERVIEW);
      const blob = JSON.stringify({ password: "old" });
      const encBlob = await encryptData(blob, testKey, blobAad);
      const overviewBlob = JSON.stringify({ title: "GitHub", username: "alice", urlHost: "github.com" });
      const encOverview = await encryptData(overviewBlob, testKey, overviewAad);

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

      const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.BLOB);
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
  // ── #885: the vault epoch ──
  // The modules read the real vault-epoch module, and a "lock" is
  // bumpVaultEpoch() while one await is held. The swFetch below stands in for
  // index.ts's: it asserts the epoch it is handed right before the request goes
  // out, and only then records it as sent — so a write that passes no epoch, or
  // the epoch of the wrong moment, is sent across the lock.
  describe("vault epoch (#885)", () => {
    function epochCheckingSwFetch(respond: (path: string, init?: RequestInit) => Response) {
      const sent: Array<{ path: string; method: string }> = [];
      const swFetch = vi.fn(async (path: string, init?: RequestInit, opts?: { epoch?: number }) => {
        if (opts?.epoch !== undefined) assertVaultEpoch(opts.epoch);
        sent.push({ path, method: init?.method ?? "GET" });
        return respond(path, init);
      });
      return { swFetch, sent };
    }
    const isOverviewPlaintext = (plaintext: string) => plaintext.includes('"urlHost"');

    describe("handleLoginDetected (A11)", () => {
      it("a lock during the cache read offers no save", async () => {
        const entries = deferred<DecryptedEntry[]>();
        initLoginSave(createDeps({
          getEncryptionKey: vi.fn().mockReturnValue(testKey),
          getCachedEntries: vi.fn().mockReturnValue(entries.promise),
        }));
        const pending = handleLoginDetected("https://nomatch.example.com", "alice", "pw");
        bumpVaultEpoch();
        entries.resolve(mockEntries);

        expect(await pending).toEqual({ action: "none" });
      });

      it("positive control: the same held cache read without a lock offers the save", async () => {
        const entries = deferred<DecryptedEntry[]>();
        initLoginSave(createDeps({
          getEncryptionKey: vi.fn().mockReturnValue(testKey),
          getCachedEntries: vi.fn().mockReturnValue(entries.promise),
        }));
        const pending = handleLoginDetected("https://nomatch.example.com", "alice", "pw");
        entries.resolve(mockEntries);

        expect(await pending).toEqual({ action: "save" });
      });

      async function heldEntryFetch() {
        const aad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.BLOB);
        const encBlob = await encryptData(JSON.stringify({ password: "old-pw" }), testKey, aad);
        const res = deferred<Response>();
        initLoginSave(createDeps({
          getEncryptionKey: vi.fn().mockReturnValue(testKey),
          swFetch: vi.fn().mockReturnValue(res.promise),
        }));
        const respond = () =>
          res.resolve(new Response(JSON.stringify({ id: TEST_UUID_1, encryptedBlob: encBlob, aadVersion: 1 })));
        return { respond };
      }

      it("a lock during the stored entry's fetch offers no update (and no vault title)", async () => {
        const held = await heldEntryFetch();
        const pending = handleLoginDetected("https://github.com", "alice", "new-pw");
        bumpVaultEpoch();
        held.respond();

        expect(await pending).toEqual({ action: "none" });
      });

      it("positive control: the same held fetch without a lock offers the update", async () => {
        const held = await heldEntryFetch();
        const pending = handleLoginDetected("https://github.com", "alice", "new-pw");
        held.respond();

        expect(await pending).toEqual({ action: "update", existingEntryId: TEST_UUID_1, existingTitle: "GitHub" });
      });
    });

    describe("handleSaveLogin (A12)", () => {
      function setUp() {
        const fake = epochCheckingSwFetch(() => new Response(JSON.stringify({ id: "new-uuid-1234" }), { status: 201 }));
        initLoginSave(createDeps({ getEncryptionKey: vi.fn().mockReturnValue(testKey), swFetch: fake.swFetch }));
        const hold = holdNextCall(vi.mocked(encryptData), isOverviewPlaintext);
        return { ...fake, hold };
      }

      it("passes the epoch it started under, so a lock during the encrypt sends no POST", async () => {
        const { sent, hold } = setUp();
        const pending = handleSaveLogin("https://example.com/login", "example.com", "alice", "pw");
        await hold.reached;
        bumpVaultEpoch();
        hold.release();

        expect(await pending).toEqual({ ok: false, error: "VAULT_LOCKED" });
        expect(sent).toEqual([]);
      });

      it("positive control: released without a lock the POST is sent with that epoch", async () => {
        const { swFetch, sent, hold } = setUp();
        const epoch = currentVaultEpoch();
        const pending = handleSaveLogin("https://example.com/login", "example.com", "alice", "pw");
        await hold.reached;
        hold.release();

        expect(await pending).toEqual({ ok: true });
        expect(sent).toEqual([{ path: "/api/passwords", method: "POST" }]);
        expect(swFetch.mock.calls[0][2]).toEqual({ epoch });
      });
    });

    describe("handleUpdateLogin (A13)", () => {
      async function setUp() {
        const blobAad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.BLOB);
        const overviewAad = buildPersonalEntryAAD("user-1", TEST_UUID_1, VAULT_TYPE.OVERVIEW);
        const encryptedBlob = await encryptData(JSON.stringify({ password: "old-pw" }), testKey, blobAad);
        const encryptedOverview = await encryptData(
          JSON.stringify({ title: "GitHub", urlHost: "github.com" }),
          testKey,
          overviewAad,
        );
        const fake = epochCheckingSwFetch((_path, init) =>
          init?.method === "PUT"
            ? new Response("{}", { status: 200 })
            : new Response(JSON.stringify({ id: TEST_UUID_1, encryptedBlob, encryptedOverview, aadVersion: 1 })),
        );
        initLoginSave(createDeps({ getEncryptionKey: vi.fn().mockReturnValue(testKey), swFetch: fake.swFetch }));
        const hold = holdNextCall(vi.mocked(encryptData), isOverviewPlaintext);
        return { ...fake, hold };
      }

      it("passes the epoch it started under, so a lock during the re-encrypt sends no PUT", async () => {
        const { sent, hold } = await setUp();
        const pending = handleUpdateLogin(TEST_UUID_1, "new-pw");
        await hold.reached;
        bumpVaultEpoch();
        hold.release();

        expect(await pending).toEqual({ ok: false, error: "VAULT_LOCKED" });
        expect(sent.filter((r) => r.method === "PUT")).toEqual([]);
      });

      it("positive control: released without a lock the PUT is sent with that epoch", async () => {
        const { swFetch, sent, hold } = await setUp();
        const epoch = currentVaultEpoch();
        const pending = handleUpdateLogin(TEST_UUID_1, "new-pw");
        await hold.reached;
        hold.release();

        expect(await pending).toEqual({ ok: true });
        expect(sent.filter((r) => r.method === "PUT")).toHaveLength(1);
        const putCall = swFetch.mock.calls.find((c) => c[1]?.method === "PUT");
        expect(putCall?.[2]).toEqual({ epoch });
      });
    });
  });
});
