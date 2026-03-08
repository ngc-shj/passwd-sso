// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

const {
  mockFetch,
  mockGetTeamEncryptionKey,
  mockGetEntryDecryptionKey,
  mockDecryptData,
  mockBuildTeamEntryAAD,
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetTeamEncryptionKey: vi.fn(),
  mockGetEntryDecryptionKey: vi.fn(),
  mockDecryptData: vi.fn(),
  mockBuildTeamEntryAAD: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/team-vault-context", () => ({
  useTeamVault: () => ({
    getTeamEncryptionKey: mockGetTeamEncryptionKey,
    getEntryDecryptionKey: mockGetEntryDecryptionKey,
  }),
}));

vi.mock("@/lib/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/lib/crypto-aad", () => ({
  buildTeamEntryAAD: (...args: unknown[]) => mockBuildTeamEntryAAD(...args),
}));

vi.mock("@/components/team/team-entry-dialog-shell", () => ({
  TeamEntryDialogShell: ({
    title,
    children,
  }: {
    title: string;
    children: React.ReactNode;
  }) => (
    <div data-testid="shell">
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

vi.mock("@/components/team/team-edit-dialog", () => ({
  TeamEditDialog: ({
    teamId,
    editData,
    defaultFolderId,
    defaultTags,
  }: {
    teamId: string;
    editData: { title: string; username: string | null; id: string };
    defaultFolderId?: string | null;
    defaultTags?: Array<{ id: string; name: string }>;
  }) => (
    <div data-testid="edit-dialog">
      <span data-testid="team-id">{teamId}</span>
      <span data-testid="entry-id">{editData.id}</span>
      <span data-testid="title">{editData.title}</span>
      <span data-testid="username">{editData.username ?? ""}</span>
      <span data-testid="folder-id">{defaultFolderId ?? ""}</span>
      <span data-testid="tag-count">{String(defaultTags?.length ?? 0)}</span>
    </div>
  ),
}));

import { TeamEditDialogLoader } from "@/components/team/team-edit-dialog-loader";

describe("TeamEditDialogLoader", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetTeamEncryptionKey.mockReset();
    mockGetEntryDecryptionKey.mockReset();
    mockDecryptData.mockReset();
    mockBuildTeamEntryAAD.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockBuildTeamEntryAAD.mockReturnValue("aad-token");
    mockGetTeamEncryptionKey.mockResolvedValue({} as CryptoKey);
    mockGetEntryDecryptionKey.mockResolvedValue({} as CryptoKey);
  });

  it("loads, decrypts, and passes edit data into TeamEditDialog", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "entry-1",
        entryType: "LOGIN",
        encryptedBlob: "cipher",
        blobIv: "iv",
        blobAuthTag: "tag",
        tags: [{ id: "tag-1", name: "Ops" }],
        teamFolderId: "folder-1",
        requireReprompt: true,
        expiresAt: "2026-04-01T00:00:00.000Z",
      }),
    });
    mockDecryptData.mockResolvedValue(
      JSON.stringify({
        title: "Vault entry",
        username: "alice@example.com",
        password: "secret",
        notes: "note",
      }),
    );

    render(
      <TeamEditDialogLoader
        teamId="team-1"
        id="entry-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        defaultFolderId="folder-default"
        defaultTags={[{ id: "tag-default", name: "Default", color: null }]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("edit-dialog")).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/teams/team-1/passwords/entry-1");
    expect(mockBuildTeamEntryAAD).toHaveBeenCalledWith("team-1", "entry-1", "blob", 0);
    expect(mockDecryptData).toHaveBeenCalledWith(
      {
        ciphertext: "cipher",
        iv: "iv",
        authTag: "tag",
      },
      expect.any(Object),
      "aad-token",
    );
    expect(screen.getByTestId("team-id")).toHaveTextContent("team-1");
    expect(screen.getByTestId("entry-id")).toHaveTextContent("entry-1");
    expect(screen.getByTestId("title")).toHaveTextContent("Vault entry");
    expect(screen.getByTestId("username")).toHaveTextContent("alice@example.com");
    expect(screen.getByTestId("folder-id")).toHaveTextContent("folder-default");
    expect(screen.getByTestId("tag-count")).toHaveTextContent("1");
  });

  it("passes correct ItemKey data to getEntryDecryptionKey for v1 entry", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "entry-1",
        entryType: "LOGIN",
        encryptedBlob: "cipher",
        blobIv: "iv",
        blobAuthTag: "tag",
        tags: [],
        itemKeyVersion: 1,
        teamKeyVersion: 2,
        encryptedItemKey: "ek-ct",
        itemKeyIv: "ek-iv",
        itemKeyAuthTag: "ek-at",
      }),
    });
    mockDecryptData.mockResolvedValue(
      JSON.stringify({ title: "V1 entry", username: "bob" }),
    );

    render(
      <TeamEditDialogLoader
        teamId="team-1"
        id="entry-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("edit-dialog")).toBeInTheDocument();
    });

    expect(mockGetEntryDecryptionKey).toHaveBeenCalledWith("team-1", "entry-1", {
      itemKeyVersion: 1,
      encryptedItemKey: "ek-ct",
      itemKeyIv: "ek-iv",
      itemKeyAuthTag: "ek-at",
      teamKeyVersion: 2,
    });
    expect(mockBuildTeamEntryAAD).toHaveBeenCalledWith("team-1", "entry-1", "blob", 1);
  });

  it("shows an error state when the team key is unavailable", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "entry-1",
        encryptedBlob: "cipher",
        blobIv: "iv",
        blobAuthTag: "tag",
        tags: [],
      }),
    });
    mockGetEntryDecryptionKey.mockRejectedValue(new Error("notFound"));

    render(
      <TeamEditDialogLoader
        teamId="team-1"
        id="entry-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("notFound")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("edit-dialog")).not.toBeInTheDocument();
  });

  it("shows an error when decryption returns invalid JSON", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "entry-1",
        encryptedBlob: "cipher",
        blobIv: "iv",
        blobAuthTag: "tag",
        tags: [],
      }),
    });
    mockDecryptData.mockResolvedValue("{invalid json");

    render(
      <TeamEditDialogLoader
        teamId="team-1"
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

  it("clears stale edit data after close and shows the next load error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "entry-1",
        entryType: "LOGIN",
        encryptedBlob: "cipher",
        blobIv: "iv",
        blobAuthTag: "tag",
        tags: [],
      }),
    });
    mockDecryptData.mockResolvedValueOnce(
      JSON.stringify({
        title: "First entry",
        username: "first@example.com",
        password: "secret",
      }),
    );

    const view = render(
      <TeamEditDialogLoader
        teamId="team-1"
        id="entry-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("title")).toHaveTextContent("First entry");
    });

    view.rerender(
      <TeamEditDialogLoader
        teamId="team-1"
        id="entry-1"
        open={false}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    });

    view.rerender(
      <TeamEditDialogLoader
        teamId="team-1"
        id="entry-2"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("notFound")).toBeInTheDocument();
    });

    expect(screen.queryByText("First entry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("edit-dialog")).not.toBeInTheDocument();
  });
});
