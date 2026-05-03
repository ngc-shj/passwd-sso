// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { mockFetchApi, mockDecryptData, mockBuildAAD, STABLE_KEY } = vi.hoisted(
  () => ({
    mockFetchApi: vi.fn(),
    mockDecryptData: vi.fn(),
    mockBuildAAD: vi.fn(),
    STABLE_KEY: {} as CryptoKey,
  }),
);

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    encryptionKey: STABLE_KEY,
    userId: "user-1",
  }),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildPersonalEntryAAD: (...args: unknown[]) => mockBuildAAD(...args),
}));

vi.mock("@/lib/events", () => ({
  notifyVaultDataChanged: vi.fn(),
}));

import { TrashList } from "./trash-list";

describe("TrashList", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockDecryptData.mockReset();
    mockBuildAAD.mockReset().mockReturnValue("aad-bytes");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the empty trash card when no entries are returned", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => [] });

    render(<TrashList refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByText("noTrash")).toBeInTheDocument();
    });
  });

  it("decrypts and renders trashed entries with personal-entry AAD", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: "entry-1",
          entryType: "LOGIN",
          encryptedOverview: { ciphertext: "x", iv: "iv1", authTag: "tag1" },
          aadVersion: 1,
          deletedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    mockDecryptData.mockResolvedValueOnce(
      JSON.stringify({ title: "GitHub", username: "alice" }),
    );

    render(<TrashList refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    // §Sec-1: assert AAD constructed with (userId, entryId) shape
    expect(mockBuildAAD).toHaveBeenCalledWith("user-1", "entry-1");
    // assert mock was called (S104)
    expect(mockDecryptData).toHaveBeenCalled();
    // §Sec-1: encrypted blob argument is shape { ciphertext, iv, authTag }
    const [blobArg, , aadArg] = mockDecryptData.mock.calls[0];
    expect(blobArg).toMatchObject({ ciphertext: "x", iv: "iv1", authTag: "tag1" });
    expect(aadArg).toBe("aad-bytes");
  });
});
