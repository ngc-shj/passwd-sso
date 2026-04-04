import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DecryptedEntry } from "../types/messages";
import {
  encryptData,
  buildPersonalEntryAAD,
} from "../lib/crypto";

// Must stub chrome before importing passkey-provider
vi.stubGlobal("chrome", { runtime: { id: "test-ext" } });
// Preserve real crypto.subtle while adding randomUUID mock
const originalCrypto = globalThis.crypto;
vi.stubGlobal("crypto", {
  subtle: originalCrypto.subtle,
  getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
  randomUUID: vi.fn().mockReturnValue("new-cred-uuid-1"),
});

import {
  initPasskeyProvider,
  handlePasskeyGetMatches,
  handlePasskeyCheckDuplicate,
  handlePasskeySignAssertion,
  handlePasskeyCreateCredential,
  isSenderAuthorizedForRpId,
  type PasskeyProviderDeps,
} from "../background/passkey-provider";

async function makeTestKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

const TEST_USER_ID = "user-aaa";
const TEST_ENTRY_ID = "entry-001";
const TEST_CRED_ID = "cred-base64url-abc123";
const TEST_RP_ID = "example.com";

const mockPasskeyEntry: DecryptedEntry = {
  id: TEST_ENTRY_ID,
  title: "Example Passkey",
  username: "alice",
  urlHost: "example.com",
  entryType: "PASSKEY",
  relyingPartyId: TEST_RP_ID,
  credentialId: TEST_CRED_ID,
};

const mockLoginEntry: DecryptedEntry = {
  id: "entry-002",
  title: "GitHub Login",
  username: "alice",
  urlHost: "github.com",
  entryType: "LOGIN",
};

const mockPasskeyEntryOtherRp: DecryptedEntry = {
  id: "entry-003",
  title: "Other Passkey",
  username: "bob",
  urlHost: "other.com",
  entryType: "PASSKEY",
  relyingPartyId: "other.com",
  credentialId: "cred-other",
};

const mockPasskeyEntryNoCredId: DecryptedEntry = {
  id: "entry-004",
  title: "Incomplete Passkey",
  username: "charlie",
  urlHost: "example.com",
  entryType: "PASSKEY",
  relyingPartyId: TEST_RP_ID,
  // credentialId intentionally omitted
};

function createDeps(overrides?: Partial<PasskeyProviderDeps>): PasskeyProviderDeps {
  return {
    getEncryptionKey: vi.fn().mockReturnValue(null),
    getCurrentUserId: vi.fn().mockReturnValue(TEST_USER_ID),
    getCachedEntries: vi.fn().mockResolvedValue([
      mockPasskeyEntry,
      mockLoginEntry,
      mockPasskeyEntryOtherRp,
      mockPasskeyEntryNoCredId,
    ]),
    swFetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    invalidateCache: vi.fn(),
    ...overrides,
  };
}

describe("passkey-provider", () => {
  let testKey: CryptoKey;

  beforeEach(async () => {
    vi.clearAllMocks();
    testKey = await makeTestKey();
  });

  // ── handlePasskeyGetMatches ──────────────────────────────────

  describe("handlePasskeyGetMatches", () => {
    it("returns vaultLocked:true when vault is locked (no encryptionKey)", async () => {
      const deps = createDeps({ getEncryptionKey: vi.fn().mockReturnValue(null) });
      initPasskeyProvider(deps);

      const result = await handlePasskeyGetMatches(TEST_RP_ID);
      expect(result).toEqual({ entries: [], vaultLocked: true });
    });

    it("returns vaultLocked:true when userId is null", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCurrentUserId: vi.fn().mockReturnValue(null),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyGetMatches(TEST_RP_ID);
      expect(result).toEqual({ entries: [], vaultLocked: true });
    });

    it("filters by rpId and returns only PASSKEY entries", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyGetMatches(TEST_RP_ID);
      expect(result.vaultLocked).toBe(false);
      // Only mockPasskeyEntry matches example.com — not LOGIN, not other RP, not missing credId
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].id).toBe(TEST_ENTRY_ID);
    });

    it("excludes entries without credentialId", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyGetMatches(TEST_RP_ID);
      const ids = result.entries.map((e) => e.id);
      expect(ids).not.toContain("entry-004");
    });

    it("returns matching entries with correct PasskeyMatchEntry shape", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyGetMatches(TEST_RP_ID);
      expect(result.entries[0]).toEqual({
        id: TEST_ENTRY_ID,
        title: "Example Passkey",
        username: "alice",
        relyingPartyId: TEST_RP_ID,
        credentialId: TEST_CRED_ID,
      });
      // teamId should not be present when undefined
      expect(result.entries[0]).not.toHaveProperty("teamId");
    });

    it("includes teamId in match entry when entry has teamId", async () => {
      const teamEntry: DecryptedEntry = {
        ...mockPasskeyEntry,
        id: "entry-team-1",
        teamId: "team-abc",
      };
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockResolvedValue([teamEntry]),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyGetMatches(TEST_RP_ID);
      expect(result.entries[0].teamId).toBe("team-abc");
    });

    it("returns empty entries (not error) when getCachedEntries throws", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockRejectedValue(new Error("cache error")),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyGetMatches(TEST_RP_ID);
      expect(result).toEqual({ entries: [], vaultLocked: false });
    });
  });

  // ── handlePasskeySignAssertion ───────────────────────────────

  describe("handlePasskeySignAssertion", () => {
    const validClientDataJSON = JSON.stringify({
      type: "webauthn.get",
      challenge: "dGVzdC1jaGFsbGVuZ2U",
      origin: "https://example.com",
    });

    it("returns VAULT_LOCKED when vault is locked", async () => {
      const deps = createDeps({ getEncryptionKey: vi.fn().mockReturnValue(null) });
      initPasskeyProvider(deps);

      const result = await handlePasskeySignAssertion(
        TEST_ENTRY_ID,
        validClientDataJSON,
      );
      expect(result).toEqual({ ok: false, error: "VAULT_LOCKED" });
    });

    it("returns VAULT_LOCKED when userId is null", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCurrentUserId: vi.fn().mockReturnValue(null),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeySignAssertion(
        TEST_ENTRY_ID,
        validClientDataJSON,
      );
      expect(result).toEqual({ ok: false, error: "VAULT_LOCKED" });
    });

    it("returns TEAM_PASSKEY_NOT_SUPPORTED when teamId is provided", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeySignAssertion(
        TEST_ENTRY_ID,
        validClientDataJSON,
        "team-xyz",
      );
      expect(result).toEqual({ ok: false, error: "TEAM_PASSKEY_NOT_SUPPORTED" });
    });

    it("returns INVALID_CLIENT_DATA for malformed clientDataJSON (not JSON)", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeySignAssertion(
        TEST_ENTRY_ID,
        "not-valid-json{{{",
      );
      expect(result).toEqual({ ok: false, error: "INVALID_CLIENT_DATA" });
    });

    it("returns INVALID_CLIENT_DATA when type is not webauthn.get", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initPasskeyProvider(deps);

      const badClientData = JSON.stringify({
        type: "webauthn.create",
        challenge: "abc",
      });
      const result = await handlePasskeySignAssertion(TEST_ENTRY_ID, badClientData);
      expect(result).toEqual({ ok: false, error: "INVALID_CLIENT_DATA" });
    });

    it("returns INVALID_CLIENT_DATA when challenge is missing", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initPasskeyProvider(deps);

      const badClientData = JSON.stringify({ type: "webauthn.get" });
      const result = await handlePasskeySignAssertion(TEST_ENTRY_ID, badClientData);
      expect(result).toEqual({ ok: false, error: "INVALID_CLIENT_DATA" });
    });

    it("returns FETCH_FAILED when swFetch returns non-ok response", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockResolvedValue(new Response("{}", { status: 404 })),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeySignAssertion(
        TEST_ENTRY_ID,
        validClientDataJSON,
        undefined,
        "https://example.com",
      );
      expect(result).toEqual({ ok: false, error: "FETCH_FAILED" });
    });

    it("returns FETCH_FAILED when swFetch rejects", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockRejectedValue(new Error("network error")),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeySignAssertion(
        TEST_ENTRY_ID,
        validClientDataJSON,
        undefined,
        "https://example.com",
      );
      // normalizeErrorCode converts unknown errors
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("returns MISSING_KEY_MATERIAL when blob lacks privateKeyJwk", async () => {
      const aad = buildPersonalEntryAAD(TEST_USER_ID, TEST_ENTRY_ID);
      const blob = JSON.stringify({ credentialId: TEST_CRED_ID, relyingPartyId: TEST_RP_ID });
      const encryptedBlob = await encryptData(blob, testKey, aad);

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ id: TEST_ENTRY_ID, encryptedBlob, encryptedOverview: { ciphertext: "", iv: "", authTag: "" }, aadVersion: 1 }),
            { status: 200 },
          ),
        ),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeySignAssertion(
        TEST_ENTRY_ID,
        validClientDataJSON,
        undefined,
        "https://example.com",
      );
      expect(result).toEqual({ ok: false, error: "MISSING_KEY_MATERIAL" });
    });

    it("returns ok:true with signature on success", async () => {
      // Build a real encrypted blob with a P-256 key pair
      const { generatePasskeyKeypair } = await import("../lib/webauthn-crypto");
      const { privateKeyJwk } = await generatePasskeyKeypair();
      const aad = buildPersonalEntryAAD(TEST_USER_ID, TEST_ENTRY_ID);
      const blob = JSON.stringify({
        credentialId: TEST_CRED_ID,
        relyingPartyId: TEST_RP_ID,
        passkeyPrivateKeyJwk: JSON.stringify(privateKeyJwk),
        passkeySignCount: 0,
      });
      const encryptedBlob = await encryptData(blob, testKey, aad);

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn()
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({ id: TEST_ENTRY_ID, encryptedBlob, encryptedOverview: { ciphertext: "", iv: "", authTag: "" }, aadVersion: 1 }),
              { status: 200 },
            ),
          )
          .mockResolvedValueOnce(new Response("{}", { status: 200 })), // counter PUT
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeySignAssertion(
        TEST_ENTRY_ID,
        validClientDataJSON,
        undefined,
        "https://example.com/auth",
      );
      expect(result.ok).toBe(true);
      expect(result.response).toBeDefined();
      expect(typeof result.response?.signature).toBe("string");
      expect(result.response!.signature.length).toBeGreaterThan(0);
      expect(typeof result.response?.authenticatorData).toBe("string");
      expect(typeof result.response?.clientDataJSON).toBe("string");
      expect(result.response?.credentialId).toBe(TEST_CRED_ID);
      // Verify counter-update PUT was issued
      const putCalls = (deps.swFetch as ReturnType<typeof vi.fn>).mock.calls
        .filter(([, init]: [string, RequestInit?]) => init?.method === "PUT");
      expect(putCalls).toHaveLength(1);
    });

    it("returns SENDER_ORIGIN_MISMATCH when senderUrl hostname does not match stored rpId", async () => {
      const { generatePasskeyKeypair } = await import("../lib/webauthn-crypto");
      const { privateKeyJwk } = await generatePasskeyKeypair();
      const aad = buildPersonalEntryAAD(TEST_USER_ID, TEST_ENTRY_ID);
      const blob = JSON.stringify({
        credentialId: TEST_CRED_ID,
        relyingPartyId: TEST_RP_ID, // example.com
        passkeyPrivateKeyJwk: JSON.stringify(privateKeyJwk),
        passkeySignCount: 0,
      });
      const encryptedBlob = await encryptData(blob, testKey, aad);

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ id: TEST_ENTRY_ID, encryptedBlob, encryptedOverview: { ciphertext: "", iv: "", authTag: "" }, aadVersion: 1 }),
            { status: 200 },
          ),
        ),
      });
      initPasskeyProvider(deps);

      // Sender is evil.com but stored rpId is example.com — post-decrypt path
      const result = await handlePasskeySignAssertion(
        TEST_ENTRY_ID,
        validClientDataJSON,
        undefined,
        "https://evil.com/path",
      );
      expect(result).toEqual({ ok: false, error: "SENDER_ORIGIN_MISMATCH" });
      // Verify fetch was called (post-decrypt path, not early return)
      expect(deps.swFetch).toHaveBeenCalledTimes(1);
    });

    it("returns SENDER_ORIGIN_MISMATCH when senderUrl is undefined (early return, no fetch)", async () => {
      const deps = createDeps({ getEncryptionKey: vi.fn().mockReturnValue(testKey) });
      initPasskeyProvider(deps);

      const result = await handlePasskeySignAssertion(
        TEST_ENTRY_ID,
        validClientDataJSON,
        undefined,
        undefined,
      );
      expect(result).toEqual({ ok: false, error: "SENDER_ORIGIN_MISMATCH" });
      expect(deps.swFetch).not.toHaveBeenCalled();
    });
  });

  // ── handlePasskeyCheckDuplicate ─────────────────────────────

  describe("handlePasskeyCheckDuplicate", () => {
    it("returns vaultLocked:true when vault is locked", async () => {
      const deps = createDeps({ getEncryptionKey: vi.fn().mockReturnValue(null) });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCheckDuplicate(TEST_RP_ID, "alice");
      expect(result).toEqual({ entries: [], vaultLocked: true });
    });

    it("returns matching entries when rpId and userName match", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockResolvedValue([mockPasskeyEntry]),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCheckDuplicate(TEST_RP_ID, "alice");
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].credentialId).toBe(TEST_CRED_ID);
      expect(result.vaultLocked).toBeUndefined();
    });

    it("returns empty entries when rpId does not match", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockResolvedValue([mockPasskeyEntry]),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCheckDuplicate("other.com", "alice");
      expect(result.entries).toHaveLength(0);
    });

    it("returns empty entries when userName does not match", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockResolvedValue([mockPasskeyEntry]),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCheckDuplicate(TEST_RP_ID, "bob");
      expect(result.entries).toHaveLength(0);
    });

    it("returns empty entries when getCachedEntries throws", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockRejectedValue(new Error("cache error")),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCheckDuplicate(TEST_RP_ID, "alice");
      expect(result).toEqual({ entries: [] });
    });
  });

  // ── isSenderAuthorizedForRpId ────────────────────────────────

  describe("isSenderAuthorizedForRpId", () => {
    it("returns true when senderUrl hostname exactly matches rpId", () => {
      expect(isSenderAuthorizedForRpId("example.com", "https://example.com/login")).toBe(true);
    });

    it("returns true when senderUrl hostname is a subdomain of rpId", () => {
      expect(isSenderAuthorizedForRpId("example.com", "https://sub.example.com/login")).toBe(true);
    });

    it("returns false when senderUrl hostname does not match rpId", () => {
      expect(isSenderAuthorizedForRpId("example.com", "https://evil.com/login")).toBe(false);
    });

    it("returns false when rpId has less than 2 labels", () => {
      expect(isSenderAuthorizedForRpId("localhost", "https://localhost/login")).toBe(false);
    });

    it("returns false when senderUrl is undefined", () => {
      expect(isSenderAuthorizedForRpId("example.com", undefined)).toBe(false);
    });

    it("returns false when senderUrl is not a valid URL", () => {
      expect(isSenderAuthorizedForRpId("example.com", "not-a-url")).toBe(false);
    });
  });

  // ── handlePasskeyCreateCredential ────────────────────────────

  describe("handlePasskeyCreateCredential", () => {
    const validCreateParams = {
      rpId: TEST_RP_ID,
      rpName: "Example Corp",
      userId: "user-handle-abc",
      userName: "alice@example.com",
      userDisplayName: "Alice",
      excludeCredentialIds: [],
      clientDataJSON: JSON.stringify({
        type: "webauthn.create",
        challenge: "Y3JlYXRlLWNoYWxsZW5nZQ",
        origin: "https://example.com",
      }),
      senderUrl: "https://example.com/register",
    };

    it("returns VAULT_LOCKED when vault is locked", async () => {
      const deps = createDeps({ getEncryptionKey: vi.fn().mockReturnValue(null) });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential(validCreateParams);
      expect(result).toEqual({ ok: false, error: "VAULT_LOCKED" });
    });

    it("returns VAULT_LOCKED when userId is null", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCurrentUserId: vi.fn().mockReturnValue(null),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential(validCreateParams);
      expect(result).toEqual({ ok: false, error: "VAULT_LOCKED" });
    });

    it("returns INVALID_CLIENT_DATA for malformed clientDataJSON", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential({
        ...validCreateParams,
        clientDataJSON: "{{invalid",
      });
      expect(result).toEqual({ ok: false, error: "INVALID_CLIENT_DATA" });
    });

    it("returns INVALID_CLIENT_DATA when type is not webauthn.create", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential({
        ...validCreateParams,
        clientDataJSON: JSON.stringify({ type: "webauthn.get", challenge: "abc" }),
      });
      expect(result).toEqual({ ok: false, error: "INVALID_CLIENT_DATA" });
    });

    it("returns INVALID_CLIENT_DATA when challenge is missing", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential({
        ...validCreateParams,
        clientDataJSON: JSON.stringify({ type: "webauthn.create" }),
      });
      expect(result).toEqual({ ok: false, error: "INVALID_CLIENT_DATA" });
    });

    it("proceeds when excludeCredentialIds matches existing entry (upgrade flow)", async () => {
      // Upgrade scenario: old credential ID is in excludeCredentials, but we still create
      // a new credential. Duplicate detection and replace logic is handled upstream via
      // PASSKEY_CHECK_DUPLICATE + banner, not by blocking creation here.
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockResolvedValue([mockPasskeyEntry]),
        swFetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential({
        ...validCreateParams,
        excludeCredentialIds: [TEST_CRED_ID],
      });
      expect(result.ok).toBe(true);
    });

    it("does not exclude when credentialId is in list but entry has different rpId", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockResolvedValue([mockPasskeyEntry]),
        // swFetch returns ok for the POST
        swFetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
      });
      initPasskeyProvider(deps);

      // rpId differs from entry's relyingPartyId → no exclusion
      const result = await handlePasskeyCreateCredential({
        ...validCreateParams,
        rpId: "different-rp.com",
        excludeCredentialIds: [TEST_CRED_ID],
        senderUrl: "https://different-rp.com/register",
      });
      // Should proceed (not CREDENTIAL_EXCLUDED); may succeed or fail at POST
      expect(result.error).not.toBe("CREDENTIAL_EXCLUDED");
    });

    it("returns SAVE_FAILED when swFetch POST returns non-ok", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockResolvedValue([]),
        swFetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: "SERVER_ERROR" }), { status: 500 }),
        ),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential(validCreateParams);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("SERVER_ERROR");
    });

    it("invalidates cache on successful creation", async () => {
      const invalidateCache = vi.fn();
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockResolvedValue([]),
        swFetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
        invalidateCache,
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential(validCreateParams);
      expect(result.ok).toBe(true);
      expect(invalidateCache).toHaveBeenCalledOnce();
    });

    it("returns serialized attestation response on success", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        getCachedEntries: vi.fn().mockResolvedValue([]),
        swFetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
        invalidateCache: vi.fn(),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential(validCreateParams);
      expect(result.ok).toBe(true);
      expect(result.response).toBeDefined();
      expect(typeof result.response?.credentialId).toBe("string");
      expect(typeof result.response?.attestationObject).toBe("string");
      expect(typeof result.response?.clientDataJSON).toBe("string");
      expect(result.response?.transports).toEqual(["internal", "hybrid"]);
    });

    it("returns SENDER_ORIGIN_MISMATCH when senderUrl does not match rpId", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential({
        ...validCreateParams,
        senderUrl: "https://evil.com/register",
      });
      expect(result).toEqual({ ok: false, error: "SENDER_ORIGIN_MISMATCH" });
    });

    it("returns SENDER_ORIGIN_MISMATCH when senderUrl is undefined", async () => {
      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential({
        ...validCreateParams,
        senderUrl: undefined,
      });
      expect(result).toEqual({ ok: false, error: "SENDER_ORIGIN_MISMATCH" });
    });

    it("issues DELETE when replaceEntryId matches a PASSKEY entry with same rpId", async () => {
      const replaceId = "entry-to-replace";
      const replaceBlob = JSON.stringify({
        entryType: "PASSKEY",
        relyingPartyId: TEST_RP_ID,
      });
      const replaceAad = buildPersonalEntryAAD(TEST_USER_ID, replaceId);
      const encryptedReplaceBlob = await encryptData(replaceBlob, testKey, replaceAad);

      const swFetch = vi.fn()
        // POST (create new entry)
        .mockResolvedValueOnce(new Response("{}", { status: 200 }))
        // GET (fetch target entry for validation)
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ id: replaceId, encryptedBlob: encryptedReplaceBlob, aadVersion: 1 }),
            { status: 200 },
          ),
        )
        // DELETE
        .mockResolvedValueOnce(new Response("{}", { status: 200 }));

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch,
        invalidateCache: vi.fn(),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential({
        ...validCreateParams,
        replaceEntryId: replaceId,
      });
      expect(result.ok).toBe(true);
      // Verify DELETE was issued for the correct entry
      const deleteCalls = (swFetch.mock.calls as Array<[string, RequestInit?]>)
        .filter(([, init]) => init?.method === "DELETE");
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0][0]).toContain(replaceId);
    });

    it("skips DELETE when replaceEntryId entry has a different entryType", async () => {
      const replaceId = "entry-login";
      const replaceBlob = JSON.stringify({
        entryType: "LOGIN", // not PASSKEY
        relyingPartyId: TEST_RP_ID,
      });
      const replaceAad = buildPersonalEntryAAD(TEST_USER_ID, replaceId);
      const encryptedReplaceBlob = await encryptData(replaceBlob, testKey, replaceAad);

      const swFetch = vi.fn()
        .mockResolvedValueOnce(new Response("{}", { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ id: replaceId, encryptedBlob: encryptedReplaceBlob, aadVersion: 1 }),
            { status: 200 },
          ),
        );

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch,
        invalidateCache: vi.fn(),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential({
        ...validCreateParams,
        replaceEntryId: replaceId,
      });
      expect(result.ok).toBe(true);
      const deleteCalls = (swFetch.mock.calls as Array<[string, RequestInit?]>)
        .filter(([, init]) => init?.method === "DELETE");
      expect(deleteCalls).toHaveLength(0);
      expect(swFetch).toHaveBeenCalledTimes(2); // POST + GET only
    });

    it("skips DELETE when replaceEntryId entry has a different rpId", async () => {
      const replaceId = "entry-other-rp";
      const replaceBlob = JSON.stringify({
        entryType: "PASSKEY",
        relyingPartyId: "other.com", // different rpId
      });
      const replaceAad = buildPersonalEntryAAD(TEST_USER_ID, replaceId);
      const encryptedReplaceBlob = await encryptData(replaceBlob, testKey, replaceAad);

      const swFetch = vi.fn()
        .mockResolvedValueOnce(new Response("{}", { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ id: replaceId, encryptedBlob: encryptedReplaceBlob, aadVersion: 1 }),
            { status: 200 },
          ),
        );

      const deps = createDeps({
        getEncryptionKey: vi.fn().mockReturnValue(testKey),
        swFetch,
        invalidateCache: vi.fn(),
      });
      initPasskeyProvider(deps);

      const result = await handlePasskeyCreateCredential({
        ...validCreateParams,
        replaceEntryId: replaceId,
      });
      expect(result.ok).toBe(true);
      const deleteCalls = (swFetch.mock.calls as Array<[string, RequestInit?]>)
        .filter(([, init]) => init?.method === "DELETE");
      expect(deleteCalls).toHaveLength(0);
      expect(swFetch).toHaveBeenCalledTimes(2); // POST + GET only
    });
  });
});
