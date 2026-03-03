// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

const {
  mockFetch,
  mockDecryptData,
  mockBuildPersonalEntryAAD,
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockDecryptData: vi.fn(),
  mockBuildPersonalEntryAAD: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault-context", () => ({
  useVault: () => ({
    encryptionKey: {} as CryptoKey,
    userId: "user-1",
  }),
}));

vi.mock("@/lib/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/lib/crypto-aad", () => ({
  buildPersonalEntryAAD: (...args: unknown[]) => mockBuildPersonalEntryAAD(...args),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/passwords/personal-password-edit-dialog", () => ({
  PasswordEditDialog: ({
    editData,
    attachments,
  }: {
    editData: { title: string; id: string };
    attachments: unknown[];
  }) => (
    <div data-testid="edit-dialog">
      <span data-testid="entry-id">{editData.id}</span>
      <span data-testid="title">{editData.title}</span>
      <span data-testid="attachments-count">{String(attachments.length)}</span>
    </div>
  ),
}));

import { PasswordEditDialogLoader } from "@/components/passwords/personal-password-edit-dialog-loader";

describe("PasswordEditDialogLoader", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockDecryptData.mockReset();
    mockBuildPersonalEntryAAD.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockBuildPersonalEntryAAD.mockReturnValue("aad");
  });

  it("loads, decrypts, resolves tags/attachments, and renders PasswordEditDialog", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "entry-1",
          entryType: "LOGIN",
          encryptedBlob: { ciphertext: "cipher", iv: "iv", authTag: "tag" },
          aadVersion: 1,
          tagIds: ["tag-1"],
          folderId: "folder-1",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: "tag-1", name: "Ops", color: null }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: "att-1", name: "a.txt" }],
      });
    mockDecryptData.mockResolvedValue(
      JSON.stringify({
        title: "My Login",
        username: "alice",
        password: "secret",
        tags: [],
      }),
    );

    render(
      <PasswordEditDialogLoader
        id="entry-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("edit-dialog")).toBeInTheDocument();
    });

    expect(mockBuildPersonalEntryAAD).toHaveBeenCalledWith("user-1", "entry-1");
    expect(screen.getByTestId("entry-id")).toHaveTextContent("entry-1");
    expect(screen.getByTestId("title")).toHaveTextContent("My Login");
    expect(screen.getByTestId("attachments-count")).toHaveTextContent("1");
  });

  it("shows an error when decrypted payload is invalid JSON", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "entry-1",
        encryptedBlob: { ciphertext: "cipher", iv: "iv", authTag: "tag" },
        aadVersion: 1,
        tagIds: [],
      }),
    });
    mockDecryptData.mockResolvedValue("{invalid json");

    render(
      <PasswordEditDialogLoader
        id="entry-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Unexpected token|Expected property name/i)).toBeInTheDocument();
    });

    expect(screen.queryByTestId("edit-dialog")).not.toBeInTheDocument();
  });
});
