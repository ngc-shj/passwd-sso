import { beforeEach, describe, expect, it, vi } from "vitest";
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
    tags: [],
    customFields: [],
    totp: null,
    generatorSettings: null,
    passwordHistory: [],
    requireReprompt: false,
    ...overrides,
  };
}

describe("runImportEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("imports team entries and reports success/failed counts", async () => {
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
      entries: [makeEntry({ title: "a" }), makeEntry({ title: "b" })],
      isTeamImport: true,
      tagsPath: "/api/teams/tags",
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
});
