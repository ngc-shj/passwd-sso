import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import type { ParsedEntry } from "@/components/passwords/password-import-types";

const { mockEncryptData } = vi.hoisted(() => ({
  mockEncryptData: vi.fn(),
}));

vi.mock("@/lib/crypto-client", () => ({
  encryptData: mockEncryptData,
}));

import { runImportEntries } from "@/components/passwords/password-import-importer";

function response(ok: boolean): Response {
  return {
    ok,
    json: async () => [],
  } as unknown as Response;
}

function makeEntry(overrides: Partial<ParsedEntry> = {}): ParsedEntry {
  return {
    entryType: ENTRY_TYPE.LOGIN,
    title: "Example",
    username: "user@example.com",
    password: "secret",
    content: "",
    url: "https://example.com",
    notes: "",
    cardholderName: "",
    cardNumber: "",
    brand: "",
    expiryMonth: "",
    expiryYear: "",
    cvv: "",
    fullName: "",
    address: "",
    phone: "",
    email: "",
    dateOfBirth: "",
    nationality: "",
    idNumber: "",
    issueDate: "",
    expiryDate: "",
    relyingPartyId: "",
    relyingPartyName: "",
    credentialId: "",
    creationDate: "",
    deviceInfo: "",
    bankName: "",
    accountType: "",
    accountHolderName: "",
    accountNumber: "",
    routingNumber: "",
    swiftBic: "",
    iban: "",
    branchName: "",
    softwareName: "",
    licenseKey: "",
    version: "",
    licensee: "",
    purchaseDate: "",
    expirationDate: "",
    tags: [],
    customFields: [],
    totp: null,
    generatorSettings: null,
    passwordHistory: [],
    requireReprompt: false,
    folderPath: "",
    isFavorite: false,
    expiresAt: null,
    ...overrides,
  };
}

describe("runImportEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("imports team entries and reports success/failed counts", async () => {
    // No folderPath on entries → folder resolution skips GET
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true)) // GET tags
      .mockResolvedValueOnce(response(true)) // POST entry 1
      .mockResolvedValueOnce(response(false)); // POST entry 2
    vi.stubGlobal("fetch", fetchMock);

    mockEncryptData
      .mockResolvedValueOnce({ ciphertext: "blob1", iv: "iv1", authTag: "tag1" })
      .mockResolvedValueOnce({ ciphertext: "ov1", iv: "iv2", authTag: "tag2" })
      .mockResolvedValueOnce({ ciphertext: "blob2", iv: "iv3", authTag: "tag3" })
      .mockResolvedValueOnce({ ciphertext: "ov2", iv: "iv4", authTag: "tag4" });

    const progress = vi.fn();
    const result = await runImportEntries({
      entries: [makeEntry({ title: "a", isFavorite: false }), makeEntry({ title: "b", isFavorite: false })],
      isTeamImport: true,
      tagsPath: "/api/teams/tags",
      foldersPath: "/api/teams/folders",
      passwordsPath: "/api/teams/passwords",
      sourceFilename: "team.csv",
      teamEncryptionKey: {} as CryptoKey,
      teamKeyVersion: 1,
      teamId: "team-1",
      onProgress: progress,
    });

    expect(result).toEqual({ successCount: 1, failedCount: 1 });
    expect(progress).toHaveBeenNthCalledWith(1, 1, 2);
    expect(progress).toHaveBeenNthCalledWith(2, 2, 2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Team import now encrypts client-side (blob + overview per entry)
    expect(mockEncryptData).toHaveBeenCalledTimes(4);
  });

  it("imports personal entry with encrypted payload", async () => {
    // No folderPath on entries → folder resolution skips GET
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true)) // GET tags
      .mockResolvedValueOnce(response(true)); // POST password
    vi.stubGlobal("fetch", fetchMock);

    mockEncryptData
      .mockResolvedValueOnce({ ciphertext: "full", iv: "iv1", authTag: "tag1" })
      .mockResolvedValueOnce({ ciphertext: "overview", iv: "iv2", authTag: "tag2" });

    const result = await runImportEntries({
      entries: [makeEntry()],
      isTeamImport: false,
      tagsPath: "/api/tags",
      foldersPath: "/api/folders",
      passwordsPath: "/api/passwords",
      sourceFilename: "personal.json",
      userId: "user-1",
      encryptionKey: {} as CryptoKey,
    });

    expect(result).toEqual({ successCount: 1, failedCount: 0 });
    expect(mockEncryptData).toHaveBeenCalledTimes(2);

    const postCall = fetchMock.mock.calls[1];
    expect(postCall[0]).toBe("/api/passwords");
    const options = postCall[1] as RequestInit;
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-passwd-sso-source": "import",
      "x-passwd-sso-filename": "personal.json",
    });
    const body = JSON.parse(String(options.body));
    expect(body.entryType).toBe(ENTRY_TYPE.LOGIN);
    expect(body.encryptedBlob).toEqual({ ciphertext: "full", iv: "iv1", authTag: "tag1" });
    expect(body.encryptedOverview).toEqual({ ciphertext: "overview", iv: "iv2", authTag: "tag2" });
  });

  it("calls favorite toggle API for team import when isFavorite is true", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true)) // GET tags
      .mockResolvedValueOnce(response(true)) // POST entry
      .mockResolvedValueOnce(response(true)); // POST favorite
    vi.stubGlobal("fetch", fetchMock);

    mockEncryptData
      .mockResolvedValueOnce({ ciphertext: "blob", iv: "iv1", authTag: "tag1" })
      .mockResolvedValueOnce({ ciphertext: "ov", iv: "iv2", authTag: "tag2" });

    const result = await runImportEntries({
      entries: [makeEntry({ isFavorite: true })],
      isTeamImport: true,
      tagsPath: "/api/teams/t1/tags",
      foldersPath: "/api/teams/t1/folders",
      passwordsPath: "/api/teams/t1/passwords",
      sourceFilename: "team.json",
      teamEncryptionKey: {} as CryptoKey,
      teamKeyVersion: 1,
      teamId: "t1",
    });

    expect(result).toEqual({ successCount: 1, failedCount: 0 });

    // 3 calls: GET tags, POST entry, POST favorite
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Verify favorite URL uses the same entryId from the POST body
    const entryCall = fetchMock.mock.calls[1];
    const entryBody = JSON.parse(String((entryCall[1] as RequestInit).body));
    const favoriteCall = fetchMock.mock.calls[2];
    expect(favoriteCall[0]).toBe(`/api/teams/t1/passwords/${entryBody.id}/favorite`);
    expect((favoriteCall[1] as RequestInit).method).toBe("POST");
  });

  it("does not call favorite toggle API for team import when isFavorite is false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true)) // GET tags
      .mockResolvedValueOnce(response(true)); // POST entry
    vi.stubGlobal("fetch", fetchMock);

    mockEncryptData
      .mockResolvedValueOnce({ ciphertext: "blob", iv: "iv1", authTag: "tag1" })
      .mockResolvedValueOnce({ ciphertext: "ov", iv: "iv2", authTag: "tag2" });

    await runImportEntries({
      entries: [makeEntry({ isFavorite: false })],
      isTeamImport: true,
      tagsPath: "/api/teams/t1/tags",
      foldersPath: "/api/teams/t1/folders",
      passwordsPath: "/api/teams/t1/passwords",
      sourceFilename: "team.json",
      teamEncryptionKey: {} as CryptoKey,
      teamKeyVersion: 1,
      teamId: "t1",
    });

    // Only 2 calls: GET tags, POST entry (no favorite call)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("counts entry as success even when favorite API throws", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true)) // GET tags
      .mockResolvedValueOnce(response(true)) // POST entry
      .mockRejectedValueOnce(new Error("network error")); // POST favorite — reject
    vi.stubGlobal("fetch", fetchMock);

    mockEncryptData
      .mockResolvedValueOnce({ ciphertext: "blob", iv: "iv1", authTag: "tag1" })
      .mockResolvedValueOnce({ ciphertext: "ov", iv: "iv2", authTag: "tag2" });

    const result = await runImportEntries({
      entries: [makeEntry({ isFavorite: true })],
      isTeamImport: true,
      tagsPath: "/api/teams/t1/tags",
      foldersPath: "/api/teams/t1/folders",
      passwordsPath: "/api/teams/t1/passwords",
      sourceFilename: "team.json",
      teamEncryptionKey: {} as CryptoKey,
      teamKeyVersion: 1,
      teamId: "t1",
    });

    expect(result).toEqual({ successCount: 1, failedCount: 0 });
  });

  it("does not call favorite API when entry creation fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true)) // GET tags
      .mockResolvedValueOnce(response(false)); // POST entry — fail
    vi.stubGlobal("fetch", fetchMock);

    mockEncryptData
      .mockResolvedValueOnce({ ciphertext: "blob", iv: "iv1", authTag: "tag1" })
      .mockResolvedValueOnce({ ciphertext: "ov", iv: "iv2", authTag: "tag2" });

    const result = await runImportEntries({
      entries: [makeEntry({ isFavorite: true })],
      isTeamImport: true,
      tagsPath: "/api/teams/t1/tags",
      foldersPath: "/api/teams/t1/folders",
      passwordsPath: "/api/teams/t1/passwords",
      sourceFilename: "team.json",
      teamEncryptionKey: {} as CryptoKey,
      teamKeyVersion: 1,
      teamId: "t1",
    });

    // Only 2 calls: GET tags, POST entry (no favorite call)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ successCount: 0, failedCount: 1 });
  });

  it("includes isFavorite and expiresAt in personal import POST body", async () => {
    // No folderPath on entries → folder resolution skips GET
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true)) // GET tags
      .mockResolvedValueOnce(response(true)); // POST password
    vi.stubGlobal("fetch", fetchMock);

    mockEncryptData
      .mockResolvedValueOnce({ ciphertext: "full", iv: "iv1", authTag: "tag1" })
      .mockResolvedValueOnce({ ciphertext: "overview", iv: "iv2", authTag: "tag2" });

    await runImportEntries({
      entries: [makeEntry({ isFavorite: true, expiresAt: "2027-01-01T00:00:00.000Z" })],
      isTeamImport: false,
      tagsPath: "/api/tags",
      foldersPath: "/api/folders",
      passwordsPath: "/api/passwords",
      sourceFilename: "personal.json",
      userId: "user-1",
      encryptionKey: {} as CryptoKey,
    });

    const postCall = fetchMock.mock.calls[1];
    const body = JSON.parse(String((postCall[1] as RequestInit).body));
    expect(body.isFavorite).toBe(true);
    expect(body.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("includes folderId in personal import POST body when folderPath resolves", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true)) // GET tags
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: "folder-1", name: "Work", parentId: null }],
      } as unknown as Response) // GET folders
      .mockResolvedValueOnce(response(true)); // POST password
    vi.stubGlobal("fetch", fetchMock);

    mockEncryptData
      .mockResolvedValueOnce({ ciphertext: "full", iv: "iv1", authTag: "tag1" })
      .mockResolvedValueOnce({ ciphertext: "overview", iv: "iv2", authTag: "tag2" });

    await runImportEntries({
      entries: [makeEntry({ folderPath: "Work" })],
      isTeamImport: false,
      tagsPath: "/api/tags",
      foldersPath: "/api/folders",
      passwordsPath: "/api/passwords",
      sourceFilename: "personal.json",
      userId: "user-1",
      encryptionKey: {} as CryptoKey,
    });

    const postCall = fetchMock.mock.calls[2];
    const body = JSON.parse(String((postCall[1] as RequestInit).body));
    expect(body.folderId).toBe("folder-1");
  });

  it("omits folderId when folderPath is empty", async () => {
    // No folderPath on entries → folder resolution skips GET
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true)) // GET tags
      .mockResolvedValueOnce(response(true)); // POST password
    vi.stubGlobal("fetch", fetchMock);

    mockEncryptData
      .mockResolvedValueOnce({ ciphertext: "full", iv: "iv1", authTag: "tag1" })
      .mockResolvedValueOnce({ ciphertext: "overview", iv: "iv2", authTag: "tag2" });

    await runImportEntries({
      entries: [makeEntry({ folderPath: "" })],
      isTeamImport: false,
      tagsPath: "/api/tags",
      foldersPath: "/api/folders",
      passwordsPath: "/api/passwords",
      sourceFilename: "personal.json",
      userId: "user-1",
      encryptionKey: {} as CryptoKey,
    });

    const postCall = fetchMock.mock.calls[1];
    const body = JSON.parse(String((postCall[1] as RequestInit).body));
    expect(body.folderId).toBeUndefined();
  });
});
