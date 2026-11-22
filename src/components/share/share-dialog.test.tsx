// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetch(path, init),
  appUrl: (p: string) => `https://app.example.com${p}`,
  withBasePath: (p: string) => p,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/http/toast-api-error", () => ({
  toastApiError: vi.fn(),
}));

// Stub heavy UI primitives so child rendering is deterministic in jsdom.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange?: (v: string) => void;
  }) => (
    <select
      aria-label="select"
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
    disabled?: boolean;
  }) => (
    <input
      type="checkbox"
      role="switch"
      aria-label="switch"
      checked={!!checked}
      disabled={disabled}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}));

import { toast } from "sonner";
import { CLIPBOARD_CLEAR_TIMEOUT_MS } from "@/lib/constants";
import { installClipboard, uninstallClipboard } from "@/__tests__/helpers/mock-clipboard";
import { ShareDialog } from "./share-dialog";

function okJson(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

describe("ShareDialog — §Sec-1 share-flow crypto invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the dialog with the title when open", () => {
    mockFetch.mockResolvedValue(okJson({ items: [] }));
    render(
      <ShareDialog
        open={true}
        onOpenChange={vi.fn()}
        passwordEntryId="p1"
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("for a personal entry, POSTs to /api/share-links with the data inline (no shareKey)", async () => {
    mockFetch
      .mockResolvedValueOnce(okJson({ items: [] })) // initial fetchLinks
      .mockResolvedValueOnce(okJson({ url: "/share/abc123" })) // create
      .mockResolvedValueOnce(okJson({ items: [] })); // refetchLinks

    render(
      <ShareDialog
        open={true}
        onOpenChange={vi.fn()}
        passwordEntryId="p1"
        decryptedData={{ title: "x", username: "u", password: "pw" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /create/ }));

    await waitFor(() => {
      const createCall = mockFetch.mock.calls.find(
        (c) => c[0] === "/api/share-links" && c[1]?.method === "POST",
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(createCall![1].body as string);
      expect(body.passwordEntryId).toBe("p1");
      expect(body.data).toBeTruthy();
      expect(body.encryptedShareData).toBeUndefined();
    });
  });

  it("(a)+(b)+(c) for a TEAM entry, calls crypto.getRandomValues, POSTs only ciphertext, and zeroizes shareKey", async () => {
    // Sentinel: 0xCD bytes for shareKey path. Track the actual array the source
    // receives so we can post-hoc verify it was zeroized.
    const sentinelHex = "cd".repeat(32);
    let capturedShareKey: Uint8Array | null = null;
    let firstCall = true;

    const realGetRandomValues = crypto.getRandomValues.bind(crypto);
    const grvSpy = vi.spyOn(crypto, "getRandomValues").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((arr: any) => {
        if (firstCall && arr instanceof Uint8Array && arr.length === 32) {
          firstCall = false;
          arr.fill(0xcd);
          capturedShareKey = arr; // keep the live reference
          return arr;
        }
        return realGetRandomValues(arr);
      }) as typeof crypto.getRandomValues,
    );

    mockFetch
      .mockResolvedValueOnce(okJson({ items: [] })) // initial fetchLinks
      .mockResolvedValueOnce(
        okJson({
          allowSharing: true,
          requireSharePassword: false,
        }),
      ) // team policy
      .mockResolvedValueOnce(okJson({ url: "/share/team-abc" })) // create
      .mockResolvedValueOnce(okJson({ items: [] })); // refetch

    render(
      <ShareDialog
        open={true}
        onOpenChange={vi.fn()}
        teamPasswordEntryId="tp1"
        teamId="team-1"
        entryType="LOGIN"
        decryptedData={{ title: "x", username: "u", password: "pw" }}
      />,
    );

    // Wait for team policy fetch to settle
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("policy"),
        undefined,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /create/ }));

    await waitFor(() => {
      // (a) shareKey was generated via crypto.getRandomValues
      expect(grvSpy).toHaveBeenCalled();
      // (b) POST body to /api/share-links does NOT contain raw shareKey hex
      const createCall = mockFetch.mock.calls.find(
        (c) => c[0] === "/api/share-links" && c[1]?.method === "POST",
      );
      expect(createCall).toBeTruthy();
      const bodyStr = createCall![1].body as string;
      expect(bodyStr).not.toContain(sentinelHex);
      // Encrypted blob is what we send instead
      const body = JSON.parse(bodyStr);
      expect(body.encryptedShareData).toBeDefined();
      expect(body.encryptedShareData.ciphertext).toMatch(/^[0-9a-f]+$/);
    });

    // (c) After successful create, the URL contains the share key in its fragment
    // and `shareKey.fill(0)` ran AFTER fragment construction. The captured array
    // (the live one the source held) must now be all-zero.
    await waitFor(() => {
      expect(capturedShareKey).not.toBeNull();
      expect(capturedShareKey!.every((b) => b === 0)).toBe(true);
    });
  });

  it("(c-failure) zeroizes shareKey in finally even when create fetch fails", async () => {
    let capturedShareKey: Uint8Array | null = null;
    let firstCall = true;
    const realGetRandomValues = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, "getRandomValues").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((arr: any) => {
        if (firstCall && arr instanceof Uint8Array && arr.length === 32) {
          firstCall = false;
          arr.fill(0xcd);
          capturedShareKey = arr;
          return arr;
        }
        return realGetRandomValues(arr);
      }) as typeof crypto.getRandomValues,
    );

    mockFetch
      .mockResolvedValueOnce(okJson({ items: [] }))
      .mockResolvedValueOnce(okJson({ allowSharing: true, requireSharePassword: false }))
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) } as unknown as Response);

    render(
      <ShareDialog
        open={true}
        onOpenChange={vi.fn()}
        teamPasswordEntryId="tp1"
        teamId="team-1"
        entryType="LOGIN"
        decryptedData={{ title: "x", password: "pw" }}
      />,
    );

    // Wait for the policy probe to land
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByRole("button", { name: /create/ }));

    // Wait for the create call to settle
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    // finally block ran shareKey.fill(0)
    await waitFor(() => {
      expect(capturedShareKey).not.toBeNull();
      expect(capturedShareKey!.every((b) => b === 0)).toBe(true);
    });
  });

  it("labels a not-admitted link, and only that one", async () => {
    const link = {
      expiresAt: "2099-01-01T00:00:00Z",
      maxViews: null,
      viewCount: 0,
      revokedAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      isActive: true,
    };
    mockFetch.mockResolvedValue(
      okJson({
        items: [
          { ...link, id: "dead", viewCount: 7, creatorAdmitted: false },
          { ...link, id: "live", viewCount: 0, creatorAdmitted: true },
        ],
      }),
    );

    render(
      <ShareDialog
        open={true}
        onOpenChange={vi.fn()}
        passwordEntryId="p1"
        entryType="LOGIN"
        decryptedData={{ title: "x" }}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText("notAdmitted")).toHaveLength(1);
    });
    // On the dead link's row, not the live one's.
    expect(within(screen.getByText("7 views").parentElement!).getByText("notAdmitted")).toBeInTheDocument();
    expect(within(screen.getByText("0 views").parentElement!).queryByText("notAdmitted")).toBeNull();
  });

  it("renders 'sharing disabled by policy' when team policy disallows sharing", async () => {
    mockFetch
      .mockResolvedValueOnce(okJson({ items: [] }))
      .mockResolvedValueOnce(okJson({ allowSharing: false }));

    render(
      <ShareDialog
        open={true}
        onOpenChange={vi.fn()}
        teamPasswordEntryId="tp1"
        teamId="team-1"
        entryType="LOGIN"
        decryptedData={{ title: "x" }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("sharingDisabledByPolicy")).toBeInTheDocument();
    });
  });
});

describe("ShareDialog — copying the created share URL", () => {
  const SHARE_URL = "https://app.example.com/s/abc123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallClipboard();
  });

  async function createLinkAndFindCopyButton(): Promise<HTMLElement> {
    mockFetch
      .mockResolvedValueOnce(okJson({ items: [] }))
      .mockResolvedValueOnce(okJson({ url: "/s/abc123" }))
      .mockResolvedValueOnce(okJson({ items: [] }));
    render(
      <ShareDialog
        open={true}
        onOpenChange={vi.fn()}
        passwordEntryId="p1"
        decryptedData={{ title: "x", username: "u", password: "pw" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /create/ }));
    const field = await screen.findByDisplayValue(SHARE_URL);
    return within(field.parentElement as HTMLElement).getByRole("button");
  }

  it("writes the share URL to the clipboard and blanks it after the clear timeout", async () => {
    const clip = installClipboard({ readText: vi.fn().mockResolvedValue(SHARE_URL) });
    const copyButton = await createLinkAndFindCopyButton();
    vi.useFakeTimers();

    fireEvent.click(copyButton);
    await vi.advanceTimersByTimeAsync(0);
    expect(clip.writeText).toHaveBeenCalledWith(SHARE_URL);

    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_TIMEOUT_MS);
    expect(clip.writeText).toHaveBeenLastCalledWith("");
  });

  it("shows the copied tick instead of a toast when the write succeeds", async () => {
    installClipboard();
    const copyButton = await createLinkAndFindCopyButton();

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(copyButton.querySelector(".lucide-check")).not.toBeNull();
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reports a rejected write with the write-failed toast and keeps the copy icon", async () => {
    installClipboard({
      writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
    });
    const copyButton = await createLinkAndFindCopyButton();

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("copyWriteFailed");
    });
    expect(toast.error).not.toHaveBeenCalledWith("createError");
    expect(copyButton.querySelector(".lucide-check")).toBeNull();
    expect(copyButton.querySelector(".lucide-copy")).not.toBeNull();
  });
});

describe("ShareDialog — reopening after a session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderOpen(open: boolean) {
    return (
      <ShareDialog
        open={open}
        onOpenChange={vi.fn()}
        passwordEntryId="p1"
        decryptedData={{ title: "x", username: "u", password: "pw" }}
      />
    );
  }

  it("does not show the previous link's access password next to a new link created without one", async () => {
    mockFetch
      .mockResolvedValueOnce(okJson({ items: [] }))
      .mockResolvedValueOnce(okJson({ url: "/s/first", accessPassword: "old-access-pw" }))
      .mockResolvedValueOnce(okJson({ items: [] }))
      .mockResolvedValueOnce(okJson({ items: [] }))
      .mockResolvedValueOnce(okJson({ url: "/s/second" }))
      .mockResolvedValueOnce(okJson({ items: [] }));
    const { rerender } = render(renderOpen(true));
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: /create/ }));
    expect(await screen.findByDisplayValue("old-access-pw")).toBeInTheDocument();

    rerender(renderOpen(false));
    rerender(renderOpen(true));
    fireEvent.click(screen.getByRole("button", { name: /create/ }));

    expect(await screen.findByDisplayValue("https://app.example.com/s/second")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("old-access-pw")).not.toBeInTheDocument();
  });

  it("clears the password toggle and max views the previous session set", () => {
    mockFetch.mockResolvedValue(okJson({ items: [] }));
    const { rerender } = render(renderOpen(true));
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByPlaceholderText("maxViewsPlaceholder"), { target: { value: "5" } });
    expect(screen.getByRole("switch")).toBeChecked();
    expect(screen.getByPlaceholderText("maxViewsPlaceholder")).toHaveValue(5);

    rerender(renderOpen(false));
    rerender(renderOpen(true));

    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(screen.getByPlaceholderText("maxViewsPlaceholder")).toHaveValue(null);
  });
});
