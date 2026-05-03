// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { STABLE_KEY } = vi.hoisted(() => ({
  STABLE_KEY: {} as CryptoKey,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ encryptionKey: STABLE_KEY, userId: "user-1" }),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: vi.fn(),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildPersonalEntryAAD: vi.fn().mockReturnValue("aad"),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}));

vi.mock("@/components/share/share-dialog", () => ({
  ShareDialog: () => null,
}));

vi.mock("../shared/copy-button", () => ({
  CopyButton: () => <button type="button" data-testid="copy">copy</button>,
}));

vi.mock("../shared/favicon", () => ({
  Favicon: () => <span data-testid="favicon" />,
}));

vi.mock("./password-detail-inline", () => ({
  PasswordDetailInline: () => <div data-testid="detail-inline" />,
}));

vi.mock("../dialogs/personal-password-edit-dialog-loader", () => ({
  PasswordEditDialogLoader: () => null,
}));

vi.mock("@/components/tags/tag-badge", () => ({
  TagBadge: ({ name }: { name: string }) => <span data-testid="tag">{name}</span>,
}));

import { PasswordCard, type EntryCardData } from "./password-card";
import { ENTRY_TYPE } from "@/lib/constants";

const baseEntry: EntryCardData = {
  id: "e1",
  entryType: ENTRY_TYPE.LOGIN,
  title: "GitHub",
  username: "alice",
  urlHost: "github.com",
  snippet: null,
  brand: null,
  lastFour: null,
  cardholderName: null,
  fullName: null,
  idNumberLast4: null,
  relyingPartyId: null,
  bankName: null,
  accountNumberLast4: null,
  softwareName: null,
  licensee: null,
  keyType: null,
  fingerprint: null,
  tags: [],
  isFavorite: false,
  isArchived: false,
  requireReprompt: false,
  expiresAt: null,
};

describe("PasswordCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the entry title and username", () => {
    render(
      <PasswordCard
        entry={baseEntry}
        expanded={false}
        onToggleFavorite={vi.fn()}
        onToggleArchive={vi.fn()}
        onDelete={vi.fn()}
        onToggleExpand={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("renders tags from the entry", () => {
    render(
      <PasswordCard
        entry={{ ...baseEntry, tags: [{ name: "Work", color: null }] }}
        expanded={false}
        onToggleFavorite={vi.fn()}
        onToggleArchive={vi.fn()}
        onDelete={vi.fn()}
        onToggleExpand={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByTestId("tag")).toHaveTextContent("Work");
  });

  it("calls onToggleExpand when the card is clicked", async () => {
    const onToggleExpand = vi.fn();
    const user = userEvent.setup();

    render(
      <PasswordCard
        entry={baseEntry}
        expanded={false}
        onToggleFavorite={vi.fn()}
        onToggleArchive={vi.fn()}
        onDelete={vi.fn()}
        onToggleExpand={onToggleExpand}
        onRefresh={vi.fn()}
      />,
    );

    // Click the card header (the title text is inside the card body)
    await user.click(screen.getByText("GitHub"));

    expect(onToggleExpand).toHaveBeenCalledWith("e1");
  });

  it("calls onToggleFavorite when the star button is clicked", async () => {
    const onToggleFavorite = vi.fn();
    const user = userEvent.setup();

    render(
      <PasswordCard
        entry={baseEntry}
        expanded={false}
        onToggleFavorite={onToggleFavorite}
        onToggleArchive={vi.fn()}
        onDelete={vi.fn()}
        onToggleExpand={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    // Star button is the first button in the card
    const buttons = screen.getAllByRole("button");
    await user.click(buttons[0]);

    expect(onToggleFavorite).toHaveBeenCalledWith("e1", false);
  });
});
