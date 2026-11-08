// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";

const {
  mockRequireVerification,
  mockRepromptDialog,
  mockEncryptionKey,
  mockDecryptData,
  mockGetTeamEncryptionKey,
} = vi.hoisted(() => ({
  mockRequireVerification: vi.fn(),
  mockRepromptDialog: null as React.ReactNode,
  mockEncryptionKey: {} as CryptoKey,
  mockDecryptData: vi.fn(),
  mockGetTeamEncryptionKey: vi.fn().mockResolvedValue({} as CryptoKey),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    encryptionKey: mockEncryptionKey,
    userId: "user-1",
  }),
}));

vi.mock("@/hooks/vault/use-reprompt", () => ({
  useReprompt: () => ({
    requireVerification: mockRequireVerification,
    repromptDialog: mockRepromptDialog,
  }),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: mockDecryptData,
  encryptData: vi.fn().mockResolvedValue({ ciphertext: "ov-ct", iv: "ov-iv", authTag: "ov-tag" }),
}));

vi.mock("@/lib/team/team-vault-context", () => ({
  useTeamVault: () => ({
    getTeamEncryptionKey: mockGetTeamEncryptionKey,
    getEntryDecryptionKey: mockGetTeamEncryptionKey,
    invalidateTeamKey: vi.fn(),
  }),
}));

// Real class (not mocked): entry-history-section imports it directly to
// branch on the distinguishable versioned-key-unavailable error. Importing
// the real module keeps `instanceof` checks in the component working while
// getEntryDecryptionKey itself is still the mock above.
vi.mock("@/lib/team/team-vault-core", async () => {
  const actual = await vi.importActual<typeof import("@/lib/team/team-vault-core")>(
    "@/lib/team/team-vault-core",
  );
  return { TeamKeyVersionUnavailableError: actual.TeamKeyVersionUnavailableError };
});

vi.mock("@/lib/crypto/crypto-aad", async (importOriginal) => ({
  // History uses the entry-blob AAD (PV "blob"); see C1 in
  // personal-history-aad-mismatch-plan.md. NOTE (RT1): decryptData and the
  // personal AAD builder are mocked here, so this suite verifies AAD scope
  // SELECTION + wiring only, not real AES-GCM. Real-crypto coverage is the
  // integration test (C5). The team AAD is the real builder's, reached
  // through the real crypto-team helpers (plan C5 T8).
  ...(await importOriginal<typeof import("@/lib/crypto/crypto-aad")>()),
  buildPersonalEntryAAD: vi.fn().mockReturnValue("test-aad"),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Mock UI components as semantic HTML
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, ...rest }: React.ComponentProps<"button">) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div data-testid="view-dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div data-testid="restore-dialog">{children}</div> : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
    disabled,
  }: React.ComponentProps<"button">) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { EntryHistorySection } from "./entry-history-section";
import { buildPersonalEntryAAD, buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
import { aadGatedDecrypt } from "@/__tests__/helpers/aad-model-decrypt";
import { toast } from "sonner";
import { TeamKeyVersionUnavailableError } from "@/lib/team/team-vault-core";

const HISTORY_ITEMS = [
  {
    id: "h1",
    entryId: "entry-1",
    encryptedBlob: { ciphertext: "ct", iv: "iv", authTag: "tag" },
    aadVersion: 1,
    changedAt: "2025-06-01T00:00:00Z",
  },
];

function mockFetchHistoryList(items = HISTORY_ITEMS) {
  return vi.fn((url: string) => {
    if (url.includes("/history")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(items),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  }) as unknown as typeof fetch;
}

describe("EntryHistorySection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // By default, requireVerification calls the callback immediately
    mockRequireVerification.mockImplementation(
      (_entryId: string, _reqReprompt: boolean, cb: () => void) => cb(),
    );
    globalThis.fetch = mockFetchHistoryList();
  });

  it("fetches history on mount and shows count", async () => {
    await act(async () => {
      render(<EntryHistorySection entryId="entry-1" />);
    });

    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });
  });

  it("expands to show history list", async () => {
    await act(async () => {
      render(<EntryHistorySection entryId="entry-1" />);
    });

    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });

    // Click to expand
    fireEvent.click(screen.getByText(/entryHistory/));

    expect(screen.getByText(/viewVersion/)).toBeInTheDocument();
    expect(screen.getByText(/restoreVersion/)).toBeInTheDocument();
  });

  it.each([
    ["aadVersion 1", HISTORY_ITEMS[0]],
    ["aadVersion 0 (too old)", { ...HISTORY_ITEMS[0], aadVersion: 0 }],
  ])("canRestore=false: a team row (%s) keeps View and offers no Restore or too-old label (#1014)", async (_label, item) => {
    globalThis.fetch = mockFetchHistoryList([item] as typeof HISTORY_ITEMS);
    await act(async () => {
      render(<EntryHistorySection entryId="entry-1" teamId="team-1" canRestore={false} />);
    });
    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });
    fireEvent.click(screen.getByText(/entryHistory/));

    expect(screen.getByRole("button", { name: "viewVersion" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "restoreVersion" })).toBeNull();
    expect(screen.queryByText("restoreVersionTooOld")).toBeNull();
  });

  it("View button calls requireVerification", async () => {
    await act(async () => {
      render(
        <EntryHistorySection
          entryId="entry-1"
          requireReprompt={true}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });

    fireEvent.click(screen.getByText(/entryHistory/));

    const viewButtons = screen.getAllByText(/viewVersion/);
    await act(async () => {
      fireEvent.click(viewButtons[0]);
    });

    expect(mockRequireVerification).toHaveBeenCalledWith(
      "entry-1",
      true,
      expect.any(Function),
    );
  });

  it("Restore button calls requireVerification", async () => {
    await act(async () => {
      render(
        <EntryHistorySection
          entryId="entry-1"
          requireReprompt={true}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });

    fireEvent.click(screen.getByText(/entryHistory/));

    const restoreButtons = screen.getAllByText(/restoreVersion/);
    await act(async () => {
      fireEvent.click(restoreButtons[0]);
    });

    expect(mockRequireVerification).toHaveBeenCalledWith(
      "entry-1",
      true,
      expect.any(Function),
    );
  });

  it("skips requireVerification when requireReprompt is false", async () => {
    await act(async () => {
      render(
        <EntryHistorySection
          entryId="entry-1"
          requireReprompt={false}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });

    fireEvent.click(screen.getByText(/entryHistory/));
    const viewButtons = screen.getAllByText(/viewVersion/);
    await act(async () => {
      fireEvent.click(viewButtons[0]);
    });

    expect(mockRequireVerification).toHaveBeenCalledWith(
      "entry-1",
      false,
      expect.any(Function),
    );
  });

  it("fetches from teamPasswordHistoryById for team entries on View", async () => {
    mockDecryptData.mockResolvedValue(
      JSON.stringify({ title: "Team PW", password: "secret" }),
    );

    const fetchMock = vi.fn((url: string) => {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes("/history/h1")
              ? {
                  encryptedBlob: "encrypted-ct",
                  blobIv: "encrypted-iv",
                  blobAuthTag: "encrypted-tag",
                  aadVersion: 1,
                  teamKeyVersion: 1,
                }
              : HISTORY_ITEMS,
          ),
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(
        <EntryHistorySection entryId="entry-1" teamId="team-1" />
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });

    fireEvent.click(screen.getByText(/entryHistory/));
    const viewButtons = screen.getAllByText(/viewVersion/);

    await act(async () => {
      fireEvent.click(viewButtons[0]);
    });

    await waitFor(() => {
      // Verify fetch was called with team history detail URL
      const calls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls;
      const viewCall = calls.find(
        (c: unknown[]) => (c[0] as string).includes("/teams/team-1/passwords/entry-1/history/h1"),
      );
      expect(viewCall).toBeDefined();
      // Verify client-side decryption was called
      expect(mockDecryptData).toHaveBeenCalled();
    });
  });

  it("passes the history record's own teamKeyVersion to getEntryDecryptionKey (not hardcoded 1)", async () => {
    mockDecryptData.mockResolvedValue(
      JSON.stringify({ title: "Team PW", password: "secret" }),
    );

    const OLD_TEAM_KEY_VERSION = 5;
    const fetchMock = vi.fn((url: string) => {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes("/history/h1")
              ? {
                  encryptedBlob: "encrypted-ct",
                  blobIv: "encrypted-iv",
                  blobAuthTag: "encrypted-tag",
                  aadVersion: 1,
                  teamKeyVersion: OLD_TEAM_KEY_VERSION,
                }
              : HISTORY_ITEMS,
          ),
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<EntryHistorySection entryId="entry-1" teamId="team-1" />);
    });

    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });

    fireEvent.click(screen.getByText(/entryHistory/));
    const viewButtons = screen.getAllByText(/viewVersion/);

    await act(async () => {
      fireEvent.click(viewButtons[0]);
    });

    await waitFor(() => {
      // Call-arg pin: getEntryDecryptionKey must RECEIVE the history record's
      // own teamKeyVersion (5), not a hardcoded 1 — hardcoding must go red here.
      expect(mockGetTeamEncryptionKey).toHaveBeenCalledWith(
        "team-1",
        "entry-1",
        expect.objectContaining({ teamKeyVersion: OLD_TEAM_KEY_VERSION }),
      );
    });
  });

  // T8: the team view opens the history blob at the blob vaultType and the
  // row's own ItemKey version (aadVersion 1), or without AAD (aadVersion 0).
  describe("team view AAD", () => {
    afterEach(() => {
      mockDecryptData.mockReset();
    });

    async function viewTeamRow(row: { itemKeyVersion: number; aadVersion: number }) {
      globalThis.fetch = vi.fn((url: string) => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(
          url.includes("/history/h1")
            ? { encryptedBlob: "ct", blobIv: "iv", blobAuthTag: "tag", teamKeyVersion: 1, ...row }
            : HISTORY_ITEMS,
        ),
      })) as unknown as typeof fetch;
      await act(async () => {
        render(<EntryHistorySection entryId="entry-1" teamId="team-1" />);
      });
      await waitFor(() => expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)"));
      fireEvent.click(screen.getByText(/entryHistory/));
      await act(async () => {
        fireEvent.click(screen.getAllByText(/viewVersion/)[0]);
      });
      await waitFor(() => expect(mockDecryptData).toHaveBeenCalled());
      return {
        opened: screen.queryByTestId("view-dialog") !== null,
        failed: vi.mocked(toast.error).mock.calls.some((c) => c[0] === "historyDecryptFailed"),
      };
    }
    const sealedAt = (vaultType: "blob" | "overview", itemKeyVersion: number) =>
      buildTeamEntryAAD("team-1", "entry-1", vaultType, itemKeyVersion);

    it("control: a row sealed at blob / its own ItemKey version opens", async () => {
      mockDecryptData.mockImplementation(aadGatedDecrypt(sealedAt("blob", 3), JSON.stringify({ title: "T" })));
      expect(await viewTeamRow({ itemKeyVersion: 3, aadVersion: 1 })).toEqual({ opened: true, failed: false });
    });

    it("a row whose blob was sealed at the overview vaultType is refused", async () => {
      mockDecryptData.mockImplementation(aadGatedDecrypt(sealedAt("overview", 3), JSON.stringify({ title: "T" })));
      expect(await viewTeamRow({ itemKeyVersion: 3, aadVersion: 1 })).toEqual({ opened: false, failed: true });
    });

    it("a row sealed at another ItemKey version than it reports is refused", async () => {
      mockDecryptData.mockImplementation(aadGatedDecrypt(sealedAt("blob", 2), JSON.stringify({ title: "T" })));
      expect(await viewTeamRow({ itemKeyVersion: 3, aadVersion: 1 })).toEqual({ opened: false, failed: true });
    });

    it("control: a legacy row (aadVersion 0) opens without AAD", async () => {
      mockDecryptData.mockImplementation(aadGatedDecrypt(undefined, JSON.stringify({ title: "T" })));
      expect(await viewTeamRow({ itemKeyVersion: 0, aadVersion: 0 })).toEqual({ opened: true, failed: false });
    });
  });

  it("shows a distinct message when the versioned team key is unavailable", async () => {
    mockGetTeamEncryptionKey.mockRejectedValueOnce(
      new TeamKeyVersionUnavailableError("team-1", 2),
    );

    const fetchMock = vi.fn((url: string) => {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes("/history/h1")
              ? {
                  encryptedBlob: "encrypted-ct",
                  blobIv: "encrypted-iv",
                  blobAuthTag: "encrypted-tag",
                  aadVersion: 1,
                  teamKeyVersion: 2,
                }
              : HISTORY_ITEMS,
          ),
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<EntryHistorySection entryId="entry-1" teamId="team-1" />);
    });

    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });

    fireEvent.click(screen.getByText(/entryHistory/));
    const viewButtons = screen.getAllByText(/viewVersion/);

    await act(async () => {
      fireEvent.click(viewButtons[0]);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("historyKeyUnavailable");
    });
    // Distinguish from the generic decrypt-failure message.
    expect(toast.error).not.toHaveBeenCalledWith("historyDecryptFailed");
  });

  it("shows the broken-key message when the member's key row at the version fails to unwrap", async () => {
    mockGetTeamEncryptionKey.mockRejectedValueOnce(
      new TeamKeyVersionUnavailableError("team-1", 2, "key_invalid"),
    );
    globalThis.fetch = vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes("/history/h1")
              ? { encryptedBlob: "c", blobIv: "i", blobAuthTag: "t", aadVersion: 1, teamKeyVersion: 2 }
              : HISTORY_ITEMS,
          ),
      }),
    ) as unknown as typeof fetch;

    await act(async () => {
      render(<EntryHistorySection entryId="entry-1" teamId="team-1" />);
    });
    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });
    fireEvent.click(screen.getByText(/entryHistory/));
    await act(async () => {
      fireEvent.click(screen.getAllByText(/viewVersion/)[0]);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("historyKeyInvalid");
    });
  });

  describe("team restore", () => {
    const ROW = {
      id: "h1",
      entryType: "LOGIN",
      encryptedBlob: "c",
      blobIv: "i",
      blobAuthTag: "t",
      aadVersion: 1,
      teamKeyVersion: 2,
      itemKeyVersion: 1,
      encryptedItemKey: "eik",
      itemKeyIv: "iki",
      itemKeyAuthTag: "ika",
      itemKeyId: "row-ik",
    };

    function restoreFetch(restoreStatus: number, restoreBody: unknown, row: typeof ROW = ROW) {
      return vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/restore")) {
          return Promise.resolve({
            ok: restoreStatus === 200,
            status: restoreStatus,
            json: () => Promise.resolve(restoreBody),
          });
        }
        if (url.includes("/history/h1")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(row) });
        }
        void init;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(HISTORY_ITEMS) });
      });
    }

    async function confirmRestore() {
      await act(async () => {
        render(<EntryHistorySection entryId="entry-1" teamId="team-1" />);
      });
      await waitFor(() => {
        expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
      });
      fireEvent.click(screen.getByText(/entryHistory/));
      await act(async () => {
        fireEvent.click(screen.getAllByText(/restoreVersion/)[0]);
      });
      const dialog = screen.getByTestId("restore-dialog");
      const confirm = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "restoreVersion");
      await act(async () => {
        fireEvent.click(confirm as HTMLButtonElement);
      });
    }

    it("sends the row's blob and the overview rebuilt from it, re-sealed with the row's own key", async () => {
      mockDecryptData.mockResolvedValue(JSON.stringify({ title: "Old", username: "u", url: "https://a.example/x" }));
      const fetchMock = restoreFetch(200, { success: true });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await confirmRestore();

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(mockGetTeamEncryptionKey).toHaveBeenCalledWith(
        "team-1",
        "entry-1",
        expect.objectContaining({ itemKeyId: "row-ik", teamKeyVersion: 2, itemKeyVersion: 1 }),
      );
      const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/restore"));
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        encryptedBlob: { ciphertext: "ov-ct", iv: "ov-iv", authTag: "ov-tag" },
        encryptedOverview: { ciphertext: "ov-ct", iv: "ov-iv", authTag: "ov-tag" },
        snapshotBlobIv: ROW.blobIv,
      });
    });

    it("HISTORY_ROW_CHANGED → re-fetches the row and retries once with the rebuilt body", async () => {
      mockDecryptData.mockResolvedValue(JSON.stringify({ title: "Old" }));
      const rows = [ROW, { ...ROW, blobIv: "i2" }];
      let rowReads = 0;
      let restores = 0;
      const fetchMock = vi.fn((url: string) => {
        if (url.endsWith("/restore")) {
          restores++;
          const ok = restores > 1;
          return Promise.resolve({
            ok,
            status: ok ? 200 : 409,
            json: () => Promise.resolve(ok ? { success: true } : { error: "HISTORY_ROW_CHANGED" }),
          });
        }
        if (url.includes("/history/h1")) {
          const row = rows[Math.min(rowReads++, rows.length - 1)];
          return Promise.resolve({ ok: true, json: () => Promise.resolve(row) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(HISTORY_ITEMS) });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await confirmRestore();

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      const posts = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/restore"));
      expect(posts.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).snapshotBlobIv)).toEqual(["i", "i2"]);
      expect(rowReads).toBe(2);
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("HISTORY_ROW_CHANGED twice → one retry only, then the refusal is shown", async () => {
      mockDecryptData.mockResolvedValue(JSON.stringify({ title: "Old" }));
      const fetchMock = restoreFetch(409, { error: "HISTORY_ROW_CHANGED" });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await confirmRestore();

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("historyRowChanged"));
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/restore"))).toHaveLength(2);
      expect(toast.success).not.toHaveBeenCalled();
    });

    // N-R4-2: the list already carries each row's aadVersion, so a team row the
    // restore refuses is not offered (the teamRestoreInit refusal below stays for
    // a row GET that disagrees with the list).
    async function renderExpanded(items: unknown[], teamId?: string) {
      globalThis.fetch = mockFetchHistoryList(items as typeof HISTORY_ITEMS);
      await act(async () => {
        render(<EntryHistorySection entryId="entry-1" teamId={teamId} />);
      });
      await waitFor(() => {
        expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
      });
      fireEvent.click(screen.getByText(/entryHistory/));
      return screen.getByRole("button", { name: "restoreVersion" });
    }

    it.each([
      ["0", 0],
      ["undefined", undefined],
    ])("a team row listed at aadVersion %s: Restore is disabled and described by the too-old label", async (_label, aadVersion) => {
      const restore = await renderExpanded([{ ...HISTORY_ITEMS[0], aadVersion }], "team-1");

      expect(restore).toBeDisabled();
      expect(restore).toHaveAccessibleDescription("restoreVersionTooOld");
      expect(screen.getByText("restoreVersionTooOld")).toBeVisible();
      fireEvent.click(restore);
      expect(mockRequireVerification).not.toHaveBeenCalled();
      expect(screen.queryByTestId("restore-dialog")).toBeNull();
    });

    it("control: a team row listed at aadVersion 1 offers Restore with no too-old label", async () => {
      const restore = await renderExpanded([HISTORY_ITEMS[0]], "team-1");

      expect(restore).toBeEnabled();
      expect(restore).not.toHaveAccessibleDescription();
      expect(screen.queryByText("restoreVersionTooOld")).toBeNull();
      fireEvent.click(restore);
      expect(screen.getByTestId("restore-dialog")).toBeInTheDocument();
    });

    it("control: a personal row at aadVersion 0 still offers Restore (only team restores refuse it)", async () => {
      const restore = await renderExpanded([{ ...HISTORY_ITEMS[0], aadVersion: 0 }]);

      expect(restore).toBeEnabled();
      expect(screen.queryByText("restoreVersionTooOld")).toBeNull();
    });

    it("refuses an aadVersion-0 row GET (listed at 1) before decrypting: no POST, the too-old message is shown (S-R3-2)", async () => {
      mockDecryptData.mockResolvedValue(JSON.stringify({ title: "Old" }));
      const fetchMock = restoreFetch(200, { success: true }, { ...ROW, aadVersion: 0 });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await confirmRestore();

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("historyRowLegacy"));
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/restore"))).toBe(false);
      expect(mockDecryptData).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("control: the same row at aadVersion 1 is decrypted and POSTed", async () => {
      mockDecryptData.mockResolvedValue(JSON.stringify({ title: "Old" }));
      const fetchMock = restoreFetch(200, { success: true }, { ...ROW, aadVersion: 1 });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await confirmRestore();

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/restore"))).toBe(true);
      expect(toast.error).not.toHaveBeenCalledWith("historyRowLegacy");
    });

    it("surfaces HISTORY_KEY_UNAVAILABLE with its exits", async () => {
      mockDecryptData.mockResolvedValue(JSON.stringify({ title: "Old" }));
      globalThis.fetch = restoreFetch(409, { error: "HISTORY_KEY_UNAVAILABLE" }) as unknown as typeof fetch;

      await confirmRestore();

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("historyKeyUnavailable"));
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  // F3: a transient failure (network/5xx/unwrap) must NOT be mistaken for
  // "key predates team membership" — only a plain Error surfaces here
  // (team-vault-core only throws TeamKeyVersionUnavailableError for the
  // not_available reason), so the generic toast fires instead.
  it("shows the generic decrypt-failure toast on a transient (non-version) failure", async () => {
    mockGetTeamEncryptionKey.mockRejectedValueOnce(
      new Error("Failed to obtain team encryption key"),
    );

    const fetchMock = vi.fn((url: string) => {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes("/history/h1")
              ? {
                  encryptedBlob: "encrypted-ct",
                  blobIv: "encrypted-iv",
                  blobAuthTag: "encrypted-tag",
                  aadVersion: 1,
                  teamKeyVersion: 2,
                }
              : HISTORY_ITEMS,
          ),
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await act(async () => {
      render(<EntryHistorySection entryId="entry-1" teamId="team-1" />);
    });

    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });

    fireEvent.click(screen.getByText(/entryHistory/));
    const viewButtons = screen.getAllByText(/viewVersion/);

    await act(async () => {
      fireEvent.click(viewButtons[0]);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("historyDecryptFailed");
    });
    // Must NOT show the "predates your team membership" message for a
    // transient failure.
    expect(toast.error).not.toHaveBeenCalledWith("historyKeyUnavailable");
  });

  it("decrypts client-side for personal entries on View", async () => {
    mockDecryptData.mockResolvedValue(
      JSON.stringify({ title: "My PW", password: "secret123" }),
    );

    await act(async () => {
      render(<EntryHistorySection entryId="entry-1" />);
    });

    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });

    fireEvent.click(screen.getByText(/entryHistory/));
    const viewButtons = screen.getAllByText(/viewVersion/);

    await act(async () => {
      fireEvent.click(viewButtons[0]);
    });

    await waitFor(() => {
      expect(mockDecryptData).toHaveBeenCalled();
    });

    // C1 (anti-vacuous): the personal history blob MUST be decrypted with the
    // entry AAD (PV "blob"), not a history-specific scope. Assert both the
    // scope selection AND that the built AAD is forwarded to decryptData —
    // (1) alone would pass even if the wrong value were passed downstream.
    expect(buildPersonalEntryAAD).toHaveBeenCalledWith("user-1", "entry-1", "blob");
    expect(mockDecryptData).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "test-aad",
    );
  });
});

describe("ViewContent — sensitive field masking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireVerification.mockImplementation(
      (_entryId: string, _reqReprompt: boolean, cb: () => void) => cb(),
    );
    mockDecryptData.mockResolvedValue(
      JSON.stringify({
        title: "Test Entry",
        username: "admin",
        password: "s3cret!",
        url: "https://example.com",
        cvv: "123",
        cardNumber: "4111111111111111",
        idNumber: "A12345678",
      }),
    );
    globalThis.fetch = mockFetchHistoryList();
  });

  it("masks password, cvv, cardNumber, idNumber on initial display", async () => {
    await act(async () => {
      render(<EntryHistorySection entryId="entry-1" />);
    });

    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });

    // Expand and click View
    fireEvent.click(screen.getByText(/entryHistory/));
    const viewButtons = screen.getAllByText(/viewVersion/);

    await act(async () => {
      fireEvent.click(viewButtons[0]);
    });

    await waitFor(() => {
      expect(screen.getByTestId("view-dialog")).toBeInTheDocument();
    });

    // Non-sensitive fields should be visible
    expect(screen.getByText("Test Entry")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("https://example.com")).toBeInTheDocument();

    // Sensitive fields should be masked
    const maskedValues = screen.getAllByText("••••••••");
    expect(maskedValues.length).toBe(4); // password, cvv, cardNumber, idNumber

    // Raw values should NOT be visible
    expect(screen.queryByText("s3cret!")).not.toBeInTheDocument();
    expect(screen.queryByText("123")).not.toBeInTheDocument();
    expect(screen.queryByText("4111111111111111")).not.toBeInTheDocument();
    expect(screen.queryByText("A12345678")).not.toBeInTheDocument();
  });

  it("reveals masked field on Eye button click", async () => {
    await act(async () => {
      render(<EntryHistorySection entryId="entry-1" />);
    });

    await waitFor(() => {
      expect(screen.getByText(/entryHistory/)).toHaveTextContent("(1)");
    });

    fireEvent.click(screen.getByText(/entryHistory/));
    const viewButtons = screen.getAllByText(/viewVersion/);

    await act(async () => {
      fireEvent.click(viewButtons[0]);
    });

    await waitFor(() => {
      expect(screen.getByTestId("view-dialog")).toBeInTheDocument();
    });

    // Find eye toggle buttons inside the view dialog (one per sensitive field)
    const dialog = screen.getByTestId("view-dialog");
    const toggleButtons = dialog.querySelectorAll('button[type="button"]');

    // Click the first toggle (password field)
    fireEvent.click(toggleButtons[0]);

    // Password should now be visible
    expect(screen.getByText("s3cret!")).toBeInTheDocument();

    // Other sensitive fields should still be masked
    expect(screen.queryByText("123")).not.toBeInTheDocument();
    expect(screen.queryByText("4111111111111111")).not.toBeInTheDocument();
    expect(screen.queryByText("A12345678")).not.toBeInTheDocument();
  });
});
