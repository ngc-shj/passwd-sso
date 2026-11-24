// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";

const { STABLE_KEY, detailState, captured, reprompt, mockToast, mockFetchApi, mockDecryptData } =
  vi.hoisted(() => ({
    STABLE_KEY: {} as CryptoKey,
    detailState: {
      data: null as null | { id: string },
      loading: false,
      invalidate: vi.fn(),
    },
    captured: {
      copyGetters: new Map<string, () => Promise<string>>(),
      shareProps: null as null | { open: boolean; decryptedData?: Record<string, unknown> },
      editOpen: false,
      inline: null as null | { onRefresh: () => void },
    },
    reprompt: { verified: [] as Array<() => void>, cancelled: [] as Array<() => void> },
    mockToast: { success: vi.fn(), error: vi.fn() },
    mockFetchApi: vi.fn(),
    mockDecryptData: vi.fn(),
  }));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ encryptionKey: STABLE_KEY, userId: "user-1", status: "UNLOCKED" }),
}));

// The expand lifecycle's decrypt lives in usePasswordEntryDetail (tested in
// use-password-entry-detail.test.tsx). The card still fetches + decrypts on its
// own for copy / open-URL / share, which is what these two mocks serve.
vi.mock("@/lib/url-helpers", () => ({
  fetchApi: mockFetchApi,
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: mockDecryptData,
}));

vi.mock("@/hooks/vault/use-password-entry-detail", () => ({
  usePasswordEntryDetail: () => ({
    detailData: detailState.data,
    loading: detailState.loading,
    error: null,
    invalidate: detailState.invalidate,
  }),
}));

vi.mock("@/components/share/share-dialog", () => ({
  ShareDialog: (props: { open: boolean; decryptedData?: Record<string, unknown> }) => {
    captured.shareProps = props;
    return null;
  },
}));

// Records each quick-copy getter by its label so a test can run the exact
// getter the card hands the real CopyButton.
vi.mock("../shared/copy-button", () => ({
  CopyButton: ({ ariaLabel, getValue }: { ariaLabel?: string; getValue: () => Promise<string> }) => {
    if (ariaLabel) captured.copyGetters.set(ariaLabel, getValue);
    return <button type="button" data-testid="copy">copy</button>;
  },
}));

vi.mock("../shared/favicon", () => ({
  Favicon: () => <span data-testid="favicon" />,
}));

vi.mock("./password-detail-inline", () => ({
  PasswordDetailInline: ({ onEdit, onRefresh }: { onEdit?: () => void; onRefresh: () => void }) => {
    captured.inline = { onRefresh };
    return <div data-testid="detail-inline" data-has-on-edit={String(!!onEdit)} />;
  },
}));

vi.mock("../dialogs/personal-password-edit-dialog-loader", () => ({
  PasswordEditDialogLoader: ({ open }: { open: boolean }) => {
    captured.editOpen = open;
    return null;
  },
}));

vi.mock("@/components/tags/tag-badge", () => ({
  TagBadge: ({ name }: { name: string }) => <span data-testid="tag">{name}</span>,
}));

// Stands in for the passphrase dialog so the assertions are about the gate.
vi.mock("@/components/passwords/dialogs/reprompt-dialog", () => ({
  RepromptDialog: ({ onVerified, onCancel }: { onVerified: () => void; onCancel: () => void }) => {
    reprompt.verified.push(onVerified);
    reprompt.cancelled.push(onCancel);
    return <div data-testid="reprompt-dialog" />;
  },
}));

import { PasswordCard, type EntryCardData } from "./password-card";
import { ENTRY_TYPE, type EntryTypeValue } from "@/lib/constants";
import { buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { aadGatedDecrypt } from "@/__tests__/helpers/aad-model-decrypt";
import { installClipboard, uninstallClipboard, type ClipboardStub } from "@/__tests__/helpers/mock-clipboard";
import type { InlineDetailData } from "@/types/entry";

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
    detailState.data = null;
    detailState.loading = false;
  });

  // The inline detail's history restore and attachment upload follow its onEdit
  // (#1014), so canEdit=false must reach it as no onEdit.
  it.each([
    [true, "true"],
    [false, "false"],
  ])("expanded with canEdit=%s passes the inline detail onEdit: %s", (canEdit, hasOnEdit) => {
    detailState.data = { id: "e1" };
    render(
      <PasswordCard
        entry={baseEntry}
        expanded={true}
        canEdit={canEdit}
        onToggleFavorite={vi.fn()}
        onToggleArchive={vi.fn()}
        onDelete={vi.fn()}
        onToggleExpand={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByTestId("detail-inline")).toHaveAttribute("data-has-on-edit", hasOnEdit);
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

  // The next-intl mock returns the key verbatim, so menu labels are the i18n keys.

  it("invokes onRestore with the entry id from the ⋮ menu (trash view)", async () => {
    const onRestore = vi.fn();
    const user = userEvent.setup();

    render(
      <PasswordCard
        entry={baseEntry}
        expanded={false}
        onToggleFavorite={vi.fn()}
        onToggleArchive={vi.fn()}
        onDelete={vi.fn()}
        onToggleExpand={vi.fn()}
        onRefresh={vi.fn()}
        onRestore={onRestore}
      />,
    );

    await user.click(screen.getByRole("button", { name: "moreActions" }));
    await user.click(screen.getByRole("menuitem", { name: "restore" }));

    expect(onRestore).toHaveBeenCalledWith("e1");
  });

  it("invokes onDeletePermanently with the entry id from the ⋮ menu (trash view)", async () => {
    const onDeletePermanently = vi.fn();
    const user = userEvent.setup();

    render(
      <PasswordCard
        entry={baseEntry}
        expanded={false}
        onToggleFavorite={vi.fn()}
        onToggleArchive={vi.fn()}
        onDelete={vi.fn()}
        onToggleExpand={vi.fn()}
        onRefresh={vi.fn()}
        onDeletePermanently={onDeletePermanently}
      />,
    );

    await user.click(screen.getByRole("button", { name: "moreActions" }));
    await user.click(screen.getByRole("menuitem", { name: "deletePermanently" }));

    expect(onDeletePermanently).toHaveBeenCalledWith("e1");
  });

  it("omits the Restore menu item outside the trash view (no onRestore)", async () => {
    const user = userEvent.setup();

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

    await user.click(screen.getByRole("button", { name: "moreActions" }));

    expect(screen.queryByRole("menuitem", { name: "restore" })).not.toBeInTheDocument();
  });

  describe("actions", () => {
    let clip: ClipboardStub;
    let user: ReturnType<typeof userEvent.setup>;

    type CardProps = ComponentProps<typeof PasswordCard>;

    function renderCard(overrides: Partial<CardProps> = {}) {
      const props: CardProps = {
        entry: baseEntry,
        expanded: false,
        onToggleFavorite: vi.fn(),
        onToggleArchive: vi.fn(),
        onDelete: vi.fn(),
        onToggleExpand: vi.fn(),
        onRefresh: vi.fn(),
        ...overrides,
      };
      render(<PasswordCard {...props} />);
      return props;
    }

    /** Serve `plaintext` as entry e1's blob, opening only under its personal AAD. */
    function serveEntry(plaintext: Record<string, unknown>) {
      mockFetchApi.mockResolvedValue({
        ok: true,
        json: async () => ({ encryptedBlob: { ciphertext: "c", iv: "i", authTag: "t" }, aadVersion: 1 }),
      });
      mockDecryptData.mockImplementation(
        aadGatedDecrypt(
          buildPersonalEntryAAD("user-1", "e1", VAULT_TYPE.BLOB),
          JSON.stringify(plaintext),
        ),
      );
    }

    async function chooseMenuItem(name: string) {
      await user.click(screen.getByRole("button", { name: "moreActions" }));
      await user.click(screen.getByRole("menuitem", { name }));
    }

    beforeEach(() => {
      // user-event installs its own clipboard stub on setup, so ours goes after.
      user = userEvent.setup();
      clip = installClipboard();
      captured.copyGetters.clear();
      captured.shareProps = null;
      captured.editOpen = false;
      captured.inline = null;
      reprompt.verified.length = 0;
      reprompt.cancelled.length = 0;
    });

    afterEach(() => uninstallClipboard());

    it("copies the decrypted password of a personal entry from the menu", async () => {
      serveEntry({ title: "GitHub", password: "s3cret", tags: [] });
      renderCard();

      await chooseMenuItem("copyPassword");

      await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith("s3cret"));
      expect(mockFetchApi).toHaveBeenCalledWith("/api/passwords/e1");
    });

    it("withholds a reprompt-protected password until the passphrase is verified", async () => {
      serveEntry({ title: "GitHub", password: "s3cret", tags: [] });
      renderCard({ entry: { ...baseEntry, requireReprompt: true } });

      await chooseMenuItem("copyPassword");

      await screen.findByTestId("reprompt-dialog");
      expect(clip.writeText).not.toHaveBeenCalled();
      reprompt.verified[reprompt.verified.length - 1]();
      await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith("s3cret"));
    });

    it("writes nothing and reports nothing when the reprompt is declined", async () => {
      serveEntry({ title: "GitHub", password: "s3cret", tags: [] });
      renderCard({ entry: { ...baseEntry, requireReprompt: true } });

      await chooseMenuItem("copyPassword");
      await screen.findByTestId("reprompt-dialog");
      reprompt.cancelled[reprompt.cancelled.length - 1]();

      await waitFor(() => expect(screen.queryByTestId("reprompt-dialog")).not.toBeInTheDocument());
      expect(clip.writeText).not.toHaveBeenCalled();
      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it("gates the quick-copy getter behind the reprompt", async () => {
      serveEntry({ title: "GitHub", password: "s3cret", tags: [] });
      renderCard({ entry: { ...baseEntry, requireReprompt: true } });
      const getter = captured.copyGetters.get("copyPassword");
      expect(getter).toBeDefined();

      let settled: string | undefined;
      void getter?.().then((v) => {
        settled = v;
      });

      await screen.findByTestId("reprompt-dialog");
      expect(settled).toBeUndefined();
      reprompt.verified[reprompt.verified.length - 1]();
      await waitFor(() => expect(settled).toBe("s3cret"));
    });

    it("reports a network error when the entry cannot be fetched", async () => {
      mockFetchApi.mockResolvedValue({ ok: false });
      renderCard();

      await chooseMenuItem("copyPassword");

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("networkError"));
      expect(clip.writeText).not.toHaveBeenCalled();
    });

    it("copies the username without fetching the entry", async () => {
      renderCard();

      await chooseMenuItem("copyUsername");

      await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith("alice"));
      expect(mockFetchApi).not.toHaveBeenCalled();
    });

    it("copies a secure note's content", async () => {
      serveEntry({ title: "Note", content: "note body", tags: [] });
      renderCard({ entry: { ...baseEntry, entryType: ENTRY_TYPE.SECURE_NOTE } });

      await chooseMenuItem("copyContent");

      await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith("note body"));
    });

    it("copies through the injected getPassword in team mode without fetching", async () => {
      const getPassword = vi.fn().mockResolvedValue("team-pw");
      renderCard({ getPassword });

      await chooseMenuItem("copyPassword");

      await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith("team-pw"));
      expect(mockFetchApi).not.toHaveBeenCalled();
    });

    const FIELD_CASES: Array<[EntryTypeValue, string, string, string]> = [
      [ENTRY_TYPE.CREDIT_CARD, "copyCardNumber", "cardNumber", "4111111111111111"],
      [ENTRY_TYPE.CREDIT_CARD, "copyCvv", "cvv", "123"],
      [ENTRY_TYPE.IDENTITY, "copyIdNumber", "idNumber", "ID-42"],
      [ENTRY_TYPE.PASSKEY, "copyCredentialId", "credentialId", "cred-1"],
      [ENTRY_TYPE.BANK_ACCOUNT, "copyAccountNumber", "accountNumber", "000123"],
      [ENTRY_TYPE.SOFTWARE_LICENSE, "copyLicenseKey", "licenseKey", "LIC-KEY"],
      [ENTRY_TYPE.SSH_KEY, "copyFingerprint", "fingerprint", "SHA256:abc"],
      [ENTRY_TYPE.SSH_KEY, "copyPublicKey", "publicKey", "ssh-ed25519 AAAA"],
    ];

    it.each(FIELD_CASES)(
      "personal %s: %s copies the decrypted %s",
      async (entryType, menuItem, field, value) => {
        serveEntry({ title: "X", tags: [], [field]: value });
        renderCard({ entry: { ...baseEntry, entryType } });

        await chooseMenuItem(menuItem);

        await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith(value));
      },
    );

    it.each(FIELD_CASES)(
      "team %s: %s copies %s from the injected getDetail",
      async (entryType, menuItem, field, value) => {
        const getDetail = vi.fn().mockResolvedValue({ [field]: value } as unknown as InlineDetailData);
        renderCard({ entry: { ...baseEntry, entryType }, getDetail });

        await chooseMenuItem(menuItem);

        await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith(value));
        expect(mockFetchApi).not.toHaveBeenCalled();
      },
    );

    it("reports an empty field instead of wiping the clipboard", async () => {
      const getDetail = vi.fn().mockResolvedValue({} as InlineDetailData);
      renderCard({ entry: { ...baseEntry, entryType: ENTRY_TYPE.CREDIT_CARD }, getDetail });

      await chooseMenuItem("copyCvv");

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("copyEmpty"));
      expect(clip.writeText).not.toHaveBeenCalled();
    });

    describe("open URL", () => {
      let open: MockInstance<typeof window.open>;

      beforeEach(() => {
        open = vi.spyOn(window, "open").mockReturnValue(null);
      });

      afterEach(() => open.mockRestore());

      it("opens the decrypted URL of a personal entry in a new tab", async () => {
        serveEntry({ title: "GitHub", url: "https://github.com/login", tags: [] });
        renderCard();

        await chooseMenuItem("openUrl");

        await waitFor(() =>
          expect(open).toHaveBeenCalledWith("https://github.com/login", "_blank", "noopener,noreferrer"),
        );
      });

      it("opens the URL from the injected getUrl in team mode", async () => {
        renderCard({ getUrl: vi.fn().mockResolvedValue("https://team.example") });

        await chooseMenuItem("openUrl");

        await waitFor(() =>
          expect(open).toHaveBeenCalledWith("https://team.example", "_blank", "noopener,noreferrer"),
        );
      });

      it("opens nothing when the entry has no URL", async () => {
        const getUrl = vi.fn().mockResolvedValue(null);
        renderCard({ getUrl });

        await chooseMenuItem("openUrl");

        await waitFor(() => expect(getUrl).toHaveBeenCalled());
        expect(open).not.toHaveBeenCalled();
      });

      it("reports a network error when the URL cannot be fetched", async () => {
        mockFetchApi.mockRejectedValue(new TypeError("offline"));
        renderCard();

        await chooseMenuItem("openUrl");

        await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("networkError"));
        expect(open).not.toHaveBeenCalled();
      });
    });

    describe("share", () => {
      it("shares a personal entry without its TOTP, history or tags", async () => {
        serveEntry({
          title: "GitHub",
          password: "s3cret",
          totp: { secret: "JBSW" },
          passwordHistory: [{ password: "old", changedAt: "2025-01-01" }],
          tags: [{ name: "Work", color: null }],
        });
        renderCard();

        await chooseMenuItem("share");

        await waitFor(() => expect(captured.shareProps?.open).toBe(true));
        expect(captured.shareProps?.decryptedData).toEqual({ title: "GitHub", password: "s3cret" });
      });

      it("shares a team entry without its TOTP, history, id or reprompt flag", async () => {
        const getDetail = vi.fn().mockResolvedValue({
          id: "e1",
          requireReprompt: true,
          password: "team-pw",
          totp: { secret: "JBSW" },
          passwordHistory: [],
        } as unknown as InlineDetailData);
        renderCard({ getPassword: vi.fn(), getDetail });

        await chooseMenuItem("share");

        await waitFor(() => expect(captured.shareProps?.open).toBe(true));
        expect(captured.shareProps?.decryptedData).toEqual({ password: "team-pw" });
      });

      it("does not open the share dialog when the entry cannot be decrypted", async () => {
        mockFetchApi.mockResolvedValue({ ok: false });
        renderCard();

        await chooseMenuItem("share");

        await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("networkError"));
        expect(captured.shareProps?.open).toBe(false);
      });

      it("does not open the share dialog when the team detail fails", async () => {
        renderCard({ getPassword: vi.fn(), getDetail: vi.fn().mockRejectedValue(new Error("x")) });

        await chooseMenuItem("share");

        await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("networkError"));
        expect(captured.shareProps?.open).toBe(false);
      });
    });

    it("calls the injected onEditClick from the menu", async () => {
      const onEditClick = vi.fn();
      renderCard({ onEditClick });

      await chooseMenuItem("edit");

      expect(onEditClick).toHaveBeenCalled();
      expect(captured.editOpen).toBe(false);
    });

    it("opens the personal edit dialog from the menu without onEditClick", async () => {
      renderCard();

      await chooseMenuItem("edit");

      await waitFor(() => expect(captured.editOpen).toBe(true));
    });

    it.each([
      [false, "archived"],
      [true, "unarchived"],
    ])("toggles archive for isArchived=%s and confirms with %s", async (isArchived, message) => {
      const props = renderCard({ entry: { ...baseEntry, isArchived } });

      await chooseMenuItem(isArchived ? "unarchive" : "archive");

      expect(props.onToggleArchive).toHaveBeenCalledWith("e1", isArchived);
      expect(mockToast.success).toHaveBeenCalledWith(message);
    });

    it("deletes the entry only after the confirmation", async () => {
      const props = renderCard();

      await chooseMenuItem("delete");
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("deleteConfirm");
      expect(props.onDelete).not.toHaveBeenCalled();
      const deleteButtons = screen.getAllByRole("button", { name: "delete" });
      await user.click(deleteButtons[deleteButtons.length - 1]);

      expect(props.onDelete).toHaveBeenCalledWith("e1");
      expect(mockToast.success).toHaveBeenCalledWith("deleted");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("cancels the delete confirmation without deleting", async () => {
      const props = renderCard();

      await chooseMenuItem("delete");
      await screen.findByRole("dialog");
      await user.click(screen.getByRole("button", { name: "cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(props.onDelete).not.toHaveBeenCalled();
    });

    it("shows a spinner instead of the detail while it loads", () => {
      detailState.loading = true;
      detailState.data = { id: "e1" };
      renderCard({ expanded: true });

      expect(screen.queryByTestId("detail-inline")).not.toBeInTheDocument();
    });

    it("invalidates the detail and refreshes the list when the inline detail refreshes", () => {
      detailState.data = { id: "e1" };
      const props = renderCard({ expanded: true });

      captured.inline?.onRefresh();

      expect(detailState.invalidate).toHaveBeenCalled();
      expect(props.onRefresh).toHaveBeenCalled();
    });

    it("shows the creator when createdBy is given", () => {
      renderCard({ createdBy: "Bob" });

      expect(screen.getByText("Bob")).toBeInTheDocument();
    });
  });

  describe("expiry badge", () => {
    function isoDaysFromNow(days: number): string {
      return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    function renderWithExpiry(expiresAt: string) {
      render(
        <PasswordCard
          entry={{ ...baseEntry, expiresAt }}
          expanded={false}
          onToggleFavorite={vi.fn()}
          onToggleArchive={vi.fn()}
          onDelete={vi.fn()}
          onToggleExpand={vi.fn()}
          onRefresh={vi.fn()}
        />,
      );
    }

    it("marks an entry whose expiry date has passed as expired", () => {
      renderWithExpiry(isoDaysFromNow(-5));

      expect(screen.getByTitle("expiredBadge")).toBeInTheDocument();
    });

    it("marks an entry expiring within the threshold as expiring", () => {
      renderWithExpiry(isoDaysFromNow(10));

      expect(screen.getByTitle("expiringBadge")).toBeInTheDocument();
    });

    it("shows no badge for an expiry beyond the threshold", () => {
      renderWithExpiry(isoDaysFromNow(90));

      expect(screen.queryByTitle("expiringBadge")).not.toBeInTheDocument();
      expect(screen.queryByTitle("expiredBadge")).not.toBeInTheDocument();
    });
  });
});
