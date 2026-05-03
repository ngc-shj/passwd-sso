// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
    // eslint-disable-next-line jsx-a11y/control-has-associated-label
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
