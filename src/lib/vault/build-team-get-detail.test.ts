// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { InlineDetailData } from "@/types/entry";
import type { EntryItemKeyData } from "@/lib/team/team-vault-core";

type GetKeyFn = (teamId: string, entryId: string, entry: EntryItemKeyData) => Promise<CryptoKey>;

// ── Mock boundaries ──────────────────────────────────────────────────────────
// Mock only the external I/O + crypto boundary. The field-assembly (via the shared
// mapper) runs for real, so a team-specific drop/rename is caught.

const { mockFetchApi, mockDecryptData, mockBuildTeamEntryAAD } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockDecryptData: vi.fn(),
  mockBuildTeamEntryAAD: vi.fn().mockReturnValue("mock-team-aad"),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildTeamEntryAAD: (...args: unknown[]) => mockBuildTeamEntryAAD(...args),
}));

import { buildTeamGetDetail } from "./build-team-get-detail";

const TEAM_ID = "team-1";
const ENTRY_ID = "entry-xyz";
const STABLE_KEY = {} as CryptoKey;

function makeRawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ENTRY_ID,
    itemKeyVersion: 2,
    encryptedItemKey: "eik",
    itemKeyIv: "ikiv",
    itemKeyAuthTag: "iktag",
    teamKeyVersion: 1,
    encryptedBlob: "ct",
    blobIv: "iv",
    blobAuthTag: "tag",
    createdAt: "2024-03-01T00:00:00Z",
    updatedAt: "2024-04-01T00:00:00Z",
    ...overrides,
  };
}

function makeBlob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "GitHub",
    password: "s3cr3t",
    url: "https://example.com",
    ...overrides,
  });
}

describe("buildTeamGetDetail", () => {
  let getEntryDecryptionKey: Mock<GetKeyFn>;

  beforeEach(() => {
    mockFetchApi.mockReset();
    mockDecryptData.mockReset();
    mockBuildTeamEntryAAD.mockReturnValue("mock-team-aad");
    getEntryDecryptionKey = vi.fn<GetKeyFn>().mockResolvedValue(STABLE_KEY);
  });

  it("fetches the team entry, derives the key, and decrypts with the team blob AAD", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => makeRawRow() });
    mockDecryptData.mockResolvedValueOnce(makeBlob());

    const closure = buildTeamGetDetail(TEAM_ID, { id: ENTRY_ID, entryType: "LOGIN" }, { getEntryDecryptionKey });
    await closure();

    expect(mockFetchApi).toHaveBeenCalledWith(`/api/teams/${TEAM_ID}/passwords/${ENTRY_ID}`);
    expect(getEntryDecryptionKey).toHaveBeenCalledWith(TEAM_ID, ENTRY_ID, expect.objectContaining({
      itemKeyVersion: 2,
      encryptedItemKey: "eik",
      teamKeyVersion: 1,
    }));
    // Team AAD uses the "blob" scope and the row's itemKeyVersion.
    expect(mockBuildTeamEntryAAD).toHaveBeenCalledWith(TEAM_ID, ENTRY_ID, "blob", 2);
    expect(mockDecryptData).toHaveBeenCalledWith(
      expect.objectContaining({ ciphertext: "ct", iv: "iv", authTag: "tag" }),
      STABLE_KEY,
      "mock-team-aad",
    );
  });

  it("throws when the fetch fails", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: false, status: 404 });
    const closure = buildTeamGetDetail(TEAM_ID, { id: ENTRY_ID }, { getEntryDecryptionKey });
    await expect(closure()).rejects.toThrow("Failed to fetch entry");
  });

  it("maps the structured IDENTITY fields from the blob (regression: structured address)", async () => {
    const structured = {
      givenName: "Taro",
      familyName: "Yamada",
      middleName: "M",
      familyNameKana: "ヤマダ",
      givenNameKana: "タロウ",
      addressLine1: "1-2-3 Chuo",
      addressLine2: "Apt 4",
      city: "Yokohama",
      state: "Kanagawa",
      postalCode: "220-0000",
      country: "JP",
    };
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => makeRawRow() });
    mockDecryptData.mockResolvedValueOnce(makeBlob(structured));

    const closure = buildTeamGetDetail(TEAM_ID, { id: ENTRY_ID, entryType: "IDENTITY" }, { getEntryDecryptionKey });
    const detail = await closure();

    for (const [key, value] of Object.entries(structured)) {
      expect(detail[key as keyof InlineDetailData]).toBe(value);
    }
  });

  it("sets the team caller-specific fields (urlHost null, passwordHistory [], entryType, title, timestamps)", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => makeRawRow() });
    mockDecryptData.mockResolvedValueOnce(makeBlob({ title: "Prod DB" }));

    const closure = buildTeamGetDetail(TEAM_ID, { id: ENTRY_ID, entryType: "LOGIN" }, { getEntryDecryptionKey });
    const detail = await closure();

    expect(detail.id).toBe(ENTRY_ID);
    expect(detail.entryType).toBe("LOGIN");
    expect(detail.title).toBe("Prod DB");
    expect(detail.urlHost).toBeNull();
    expect(detail.passwordHistory).toEqual([]);
    expect(detail.createdAt).toBe("2024-03-01T00:00:00Z");
    expect(detail.updatedAt).toBe("2024-04-01T00:00:00Z");
    expect(detail.password).toBe("s3cr3t");
  });
});
