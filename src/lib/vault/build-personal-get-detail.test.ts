// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InlineDetailData } from "@/types/entry";

// ── Mock boundaries ──────────────────────────────────────────────────────────
// Mock only the external I/O layer (fetch + crypto). The field-assembly logic
// inside buildPersonalGetDetail is what we are testing — it runs for real.

const { mockFetchApi, mockDecryptData, mockBuildPersonalEntryAAD } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockDecryptData: vi.fn(),
  mockBuildPersonalEntryAAD: vi.fn().mockReturnValue("mock-aad"),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildPersonalEntryAAD: (...args: unknown[]) => mockBuildPersonalEntryAAD(...args),
  VAULT_TYPE: { BLOB: "blob", OVERVIEW: "overview" },
}));

import { buildPersonalGetDetail } from "./build-personal-get-detail";

// ── Test helpers ─────────────────────────────────────────────────────────────

const STABLE_KEY = {} as CryptoKey;
const USER_ID = "user-abc";
const ENTRY_ID = "entry-xyz";

/** A minimal raw server response (the encrypted blob row). */
function makeRawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aadVersion: 1,
    encryptedBlob: { ciphertext: "ct", iv: "iv", authTag: "tag" },
    requireReprompt: false,
    createdAt: "2024-03-01T00:00:00Z",
    updatedAt: "2024-04-01T00:00:00Z",
    ...overrides,
  };
}

/** The decrypted blob payload JSON string returned by the mocked decryptData. */
function makeDecryptedBlob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    password: "s3cr3t",
    url: "https://example.com",
    notes: "test notes",
    customFields: [],
    passwordHistory: [{ id: "h1", createdAt: "2024-01-01", encryptedBlob: {} }],
    ...overrides,
  });
}

/** A minimal PersonalEntryOverview row as seen from the dashboard. */
function makeEntry(overrides: Partial<{
  id: string;
  entryType: string;
  urlHost: string | null;
  requireReprompt: boolean;
}> = {}) {
  return {
    id: ENTRY_ID,
    entryType: "LOGIN",
    urlHost: "example.com",
    requireReprompt: true,
    ...overrides,
  };
}

// ── INV-C3.1 / R16: personal field assembly ──────────────────────────────────

describe("buildPersonalGetDetail", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockDecryptData.mockReset();
    mockBuildPersonalEntryAAD.mockReturnValue("mock-aad");
  });

  it("calls fetchApi with the correct entry URL", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => makeRawRow(),
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob());

    const closure = buildPersonalGetDetail(makeEntry(), { encryptionKey: STABLE_KEY, userId: USER_ID });
    await closure(ENTRY_ID);

    expect(mockFetchApi).toHaveBeenCalledWith(`/api/passwords/${ENTRY_ID}`);
  });

  it("throws when fetchApi returns !ok", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: false, status: 404 });

    const closure = buildPersonalGetDetail(makeEntry(), { encryptionKey: STABLE_KEY, userId: USER_ID });
    await expect(closure(ENTRY_ID)).rejects.toThrow("Failed to fetch entry");
  });

  it("builds the personal AAD with VAULT_TYPE.BLOB when aadVersion >= 1 and userId is set", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => makeRawRow({ aadVersion: 1 }),
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob());

    const closure = buildPersonalGetDetail(makeEntry(), { encryptionKey: STABLE_KEY, userId: USER_ID });
    await closure(ENTRY_ID);

    expect(mockBuildPersonalEntryAAD).toHaveBeenCalledWith(USER_ID, ENTRY_ID, "blob");
    expect(mockDecryptData).toHaveBeenCalledWith(
      expect.objectContaining({ ciphertext: "ct" }),
      STABLE_KEY,
      "mock-aad",
    );
  });

  it("does NOT build personal AAD when aadVersion < 1 (legacy)", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => makeRawRow({ aadVersion: 0 }),
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob());

    const closure = buildPersonalGetDetail(makeEntry(), { encryptionKey: STABLE_KEY, userId: USER_ID });
    await closure(ENTRY_ID);

    expect(mockDecryptData).toHaveBeenCalledWith(
      expect.objectContaining({ ciphertext: "ct" }),
      STABLE_KEY,
      undefined, // no AAD for legacy entries
    );
  });

  it("does NOT build personal AAD when userId is null", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => makeRawRow({ aadVersion: 1 }),
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob());

    const closure = buildPersonalGetDetail(makeEntry(), { encryptionKey: STABLE_KEY, userId: null });
    await closure(ENTRY_ID);

    expect(mockDecryptData).toHaveBeenCalledWith(
      expect.anything(),
      STABLE_KEY,
      undefined,
    );
  });

  // ── Complete InlineDetailData assembly (guards R16 / INV-C3.1) ───────────

  it("returns the correct id", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => makeRawRow() });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob());

    const closure = buildPersonalGetDetail(makeEntry(), { encryptionKey: STABLE_KEY, userId: USER_ID });
    const result = await closure(ENTRY_ID);

    expect(result.id).toBe(ENTRY_ID);
  });

  it("assembles entryType from the overview row", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => makeRawRow() });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob());

    const closure = buildPersonalGetDetail(makeEntry({ entryType: "CREDIT_CARD" }), { encryptionKey: STABLE_KEY, userId: USER_ID });
    const result = await closure(ENTRY_ID);

    expect(result.entryType).toBe("CREDIT_CARD");
  });

  it("assembles urlHost from the overview row (not from the blob)", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => makeRawRow() });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob({ url: "https://other.com" }));

    const closure = buildPersonalGetDetail(makeEntry({ urlHost: "example.com" }), { encryptionKey: STABLE_KEY, userId: USER_ID });
    const result = await closure(ENTRY_ID);

    // urlHost comes from overview row, not parsed from blob url
    expect(result.urlHost).toBe("example.com");
  });

  it("assembles requireReprompt from the raw row when present (overrides entry prop)", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => makeRawRow({ requireReprompt: true }) });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob());

    const closure = buildPersonalGetDetail(makeEntry({ requireReprompt: false }), { encryptionKey: STABLE_KEY, userId: USER_ID });
    const result = await closure(ENTRY_ID);

    // Precondition: entry prop says false, raw row says true
    expect(result.requireReprompt).toBe(true);
  });

  it("assembles requireReprompt from the entry prop when raw row lacks it", async () => {
    const rawWithoutReprompt = makeRawRow();
    delete rawWithoutReprompt.requireReprompt;
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => rawWithoutReprompt });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob());

    const closure = buildPersonalGetDetail(makeEntry({ requireReprompt: true }), { encryptionKey: STABLE_KEY, userId: USER_ID });
    const result = await closure(ENTRY_ID);

    expect(result.requireReprompt).toBe(true);
  });

  it("assembles requireReprompt as false when both raw row and entry prop are absent", async () => {
    const rawWithout = makeRawRow();
    delete rawWithout.requireReprompt;
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => rawWithout });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob());

    const entry = { id: ENTRY_ID, entryType: "LOGIN", urlHost: null } as const;
    const closure = buildPersonalGetDetail(entry, { encryptionKey: STABLE_KEY, userId: USER_ID });
    const result = await closure(ENTRY_ID);

    expect(result.requireReprompt).toBe(false);
  });

  it("assembles createdAt from the raw row", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => makeRawRow({ createdAt: "2023-06-15T10:00:00Z" }) });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob());

    const closure = buildPersonalGetDetail(makeEntry(), { encryptionKey: STABLE_KEY, userId: USER_ID });
    const result = await closure(ENTRY_ID);

    expect(result.createdAt).toBe("2023-06-15T10:00:00Z");
  });

  it("assembles updatedAt from the raw row", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => makeRawRow({ updatedAt: "2024-11-22T08:30:00Z" }) });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob());

    const closure = buildPersonalGetDetail(makeEntry(), { encryptionKey: STABLE_KEY, userId: USER_ID });
    const result = await closure(ENTRY_ID);

    expect(result.updatedAt).toBe("2024-11-22T08:30:00Z");
  });

  it("assembles passwordHistory from the decrypted blob", async () => {
    const history = [
      { id: "h1", createdAt: "2024-01-01T00:00:00Z", encryptedBlob: { ciphertext: "ct1" } },
      { id: "h2", createdAt: "2024-02-01T00:00:00Z", encryptedBlob: { ciphertext: "ct2" } },
    ];
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => makeRawRow() });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob({ passwordHistory: history }));

    const closure = buildPersonalGetDetail(makeEntry(), { encryptionKey: STABLE_KEY, userId: USER_ID });
    const result: InlineDetailData = await closure(ENTRY_ID);

    expect(result.passwordHistory).toHaveLength(2);
    expect(result.passwordHistory[0]).toMatchObject({ id: "h1" });
    expect(result.passwordHistory[1]).toMatchObject({ id: "h2" });
  });

  it("assembles passwordHistory as empty array when blob has none", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => makeRawRow() });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob({ passwordHistory: undefined }));

    const closure = buildPersonalGetDetail(makeEntry(), { encryptionKey: STABLE_KEY, userId: USER_ID });
    const result = await closure(ENTRY_ID);

    expect(result.passwordHistory).toEqual([]);
  });

  it("assembles a COMPLETE InlineDetailData with all sentinel fields present", async () => {
    const historyEntry = { id: "h1", createdAt: "2024-01-01T00:00:00Z", encryptedBlob: { ciphertext: "ct" } };
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => makeRawRow({
        requireReprompt: true,
        createdAt: "2024-03-01T00:00:00Z",
        updatedAt: "2024-04-01T00:00:00Z",
      }),
    });
    mockDecryptData.mockResolvedValueOnce(makeDecryptedBlob({
      passwordHistory: [historyEntry],
    }));

    const entry = makeEntry({ entryType: "LOGIN", urlHost: "example.com", requireReprompt: false });
    const closure = buildPersonalGetDetail(entry, { encryptionKey: STABLE_KEY, userId: USER_ID });
    const result: InlineDetailData = await closure(ENTRY_ID);

    // All sentinel fields must be present and correct (positive assertions on each)
    expect(result.id).toBe(ENTRY_ID);
    expect(result.entryType).toBe("LOGIN");
    expect(result.requireReprompt).toBe(true);           // from raw row (overrides entry prop false)
    expect(result.urlHost).toBe("example.com");           // from entry overview
    expect(result.createdAt).toBe("2024-03-01T00:00:00Z"); // from raw row
    expect(result.updatedAt).toBe("2024-04-01T00:00:00Z"); // from raw row
    expect(result.passwordHistory).toHaveLength(1);        // from decrypted blob
    expect(result.passwordHistory[0]).toMatchObject({ id: "h1" });
    expect(result.password).toBe("s3cr3t");               // from decrypted blob
    expect(result.url).toBe("https://example.com");        // from decrypted blob
    expect(result.notes).toBe("test notes");               // from decrypted blob
    expect(result.customFields).toEqual([]);               // from decrypted blob
  });
});
