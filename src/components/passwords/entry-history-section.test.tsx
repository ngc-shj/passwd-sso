// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";

const {
  mockRequireVerification,
  mockRepromptDialog,
  mockEncryptionKey,
  mockDecryptData,
  mockGetOrgEncryptionKey,
} = vi.hoisted(() => ({
  mockRequireVerification: vi.fn(),
  mockRepromptDialog: null as React.ReactNode,
  mockEncryptionKey: {} as CryptoKey,
  mockDecryptData: vi.fn(),
  mockGetOrgEncryptionKey: vi.fn().mockResolvedValue({} as CryptoKey),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/lib/vault-context", () => ({
  useVault: () => ({
    encryptionKey: mockEncryptionKey,
    userId: "user-1",
  }),
}));

vi.mock("@/hooks/use-reprompt", () => ({
  useReprompt: () => ({
    requireVerification: mockRequireVerification,
    repromptDialog: mockRepromptDialog,
  }),
}));

vi.mock("@/lib/crypto-client", () => ({
  decryptData: mockDecryptData,
}));

vi.mock("@/lib/team-vault-context", () => ({
  useTeamVault: () => ({
    getTeamEncryptionKey: mockGetOrgEncryptionKey,
  }),
}));

vi.mock("@/lib/crypto-aad", () => ({
  buildPersonalEntryAAD: vi.fn().mockReturnValue("test-aad"),
  buildTeamEntryAAD: vi.fn().mockReturnValue("test-org-aad"),
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
      JSON.stringify({ title: "Org PW", password: "secret" }),
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
        (c: [string]) => c[0].includes("/teams/team-1/passwords/entry-1/history/h1"),
      );
      expect(viewCall).toBeDefined();
      // Verify client-side decryption was called
      expect(mockDecryptData).toHaveBeenCalled();
    });
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
