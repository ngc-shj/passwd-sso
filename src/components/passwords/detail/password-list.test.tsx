// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { mockFetchApi, mockDecryptData, STABLE_KEY } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockDecryptData: vi.fn(),
  STABLE_KEY: {} as CryptoKey,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ encryptionKey: STABLE_KEY, userId: "user-1" }),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildPersonalEntryAAD: vi.fn().mockReturnValue("aad"),
}));

vi.mock("@/hooks/use-travel-mode", () => ({
  useTravelMode: () => ({ active: false }),
}));

vi.mock("./password-card", () => ({
  PasswordCard: ({ entry }: { entry: { id: string; title: string } }) => (
    <div data-testid={`card-${entry.id}`}>{entry.title}</div>
  ),
}));

import { PasswordList } from "./password-list";

describe("PasswordList", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockDecryptData.mockReset();
  });

  it("shows the no-passwords empty state when there are no entries", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => [] });

    render(
      <PasswordList searchQuery="" tagId={null} refreshKey={0} />,
    );

    await waitFor(() => {
      expect(screen.getByText("noPasswords")).toBeInTheDocument();
    });
  });

  it("renders cards for decrypted entries", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: "e1",
          encryptedOverview: { ciphertext: "x", iv: "iv", authTag: "tag" },
          aadVersion: 1,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-02",
        },
      ],
    });
    mockDecryptData.mockResolvedValueOnce(
      JSON.stringify({ title: "Site A", tags: [] }),
    );

    render(<PasswordList searchQuery="" tagId={null} refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByTestId("card-e1")).toBeInTheDocument();
    });
    expect(screen.getByText("Site A")).toBeInTheDocument();
  });

  it("shows favorites empty state when favoritesOnly is true and no entries", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => [] });

    render(
      <PasswordList
        searchQuery=""
        tagId={null}
        refreshKey={0}
        favoritesOnly={true}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("noFavorites")).toBeInTheDocument();
    });
  });
});
