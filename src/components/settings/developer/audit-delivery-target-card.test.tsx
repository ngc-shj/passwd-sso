// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const { mockFetch, mockToast, mockCanUsePasskeyRecovery, mockReauthenticateWithPasskey } =
  vi.hoisted(() => ({
    mockFetch: vi.fn(),
    mockToast: { success: vi.fn(), error: vi.fn() },
    mockCanUsePasskeyRecovery: vi.fn(),
    mockReauthenticateWithPasskey: vi.fn(),
  }));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDateTime: (d: string) => d,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    open ? <>{children}</> : null
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Flat Select mock: each SelectItem becomes a button that fires the parent's
// onValueChange when clicked. Lets the test drive value selection without
// going through Radix's portaled popover.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode;
    onValueChange?: (value: string) => void;
  }) => (
    <div data-mock-select onClick={(e) => {
      const target = e.target as HTMLElement;
      const value = target.getAttribute("data-value");
      if (value && onValueChange) onValueChange(value);
    }}>{children}</div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button type="button" data-value={value}>{children}</button>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));

import { setupPasskeyReauthDialogMocks } from "@/__tests__/helpers/passkey-reauth-mocks";
setupPasskeyReauthDialogMocks();

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

import { AuditDeliveryTargetCard } from "./audit-delivery-target-card";

function setupTargets(targets: Array<Record<string, unknown>>) {
  mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
    if (!init || init.method === undefined || init.method === "GET") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ targets }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
  });
}

describe("AuditDeliveryTargetCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true });
  });

  it("renders empty state when no targets", async () => {
    setupTargets([]);
    render(<AuditDeliveryTargetCard />);
    await waitFor(() => {
      expect(screen.getByText("noTargets")).toBeInTheDocument();
    });
  });

  it("renders an active target's badges", async () => {
    setupTargets([
      {
        id: "t1",
        kind: "WEBHOOK",
        isActive: true,
        failCount: 0,
        lastError: null,
        lastDeliveredAt: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    render(<AuditDeliveryTargetCard />);
    await waitFor(() => {
      expect(screen.getByText("kindWebhook")).toBeInTheDocument();
    });
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("R26: shows fail count when present", async () => {
    setupTargets([
      {
        id: "t1",
        kind: "SIEM_HEC",
        isActive: true,
        failCount: 3,
        lastError: "auth failed",
        lastDeliveredAt: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    render(<AuditDeliveryTargetCard />);
    await waitFor(() => {
      expect(screen.getByText("kindSiemHec")).toBeInTheDocument();
    });
    const expected = `failCount:${JSON.stringify({ count: 3 })}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.getByText(/lastError/)).toBeInTheDocument();
  });

  it("renders endpoint URL on the list item", async () => {
    setupTargets([
      {
        id: "t1",
        kind: "WEBHOOK",
        isActive: true,
        failCount: 0,
        lastError: null,
        lastDeliveredAt: null,
        createdAt: new Date().toISOString(),
        endpoint: "https://hooks.example.com/audit",
      },
    ]);
    render(<AuditDeliveryTargetCard />);
    await waitFor(() => {
      expect(
        screen.getByText("https://hooks.example.com/audit"),
      ).toBeInTheDocument();
    });
  });

  it("closes the create dialog after successful registration", async () => {
    let postCalls = 0;
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === "GET") {
        // First GET returns empty list, second GET (after create) returns the
        // created row so we can verify the list updates AND the dialog closed.
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              targets:
                postCalls > 0
                  ? [
                      {
                        id: "t1",
                        kind: "WEBHOOK",
                        isActive: true,
                        failCount: 0,
                        lastError: null,
                        lastDeliveredAt: null,
                        createdAt: new Date().toISOString(),
                        endpoint: "https://hooks.example.com/audit",
                      },
                    ]
                  : [],
            }),
        });
      }
      postCalls += 1;
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ target: { id: "t1" } }),
      });
    });

    render(<AuditDeliveryTargetCard />);
    await waitFor(() =>
      expect(screen.getByText("noTargets")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /addTarget/ }));
    // The mocked Dialog renders children only when open=true, so the dialog
    // title is in the DOM after open.
    await waitFor(() => {
      const titles = screen.getAllByText("addTarget");
      expect(titles.length).toBeGreaterThan(1); // section button + dialog title
    });

    // Pick the WEBHOOK kind via the underlying native control (radix Select
    // renders into a portal that the test's flat dialog mock cannot reach,
    // so we drive the value by directly clicking the SelectItem text).
    fireEvent.click(screen.getByText("kindWebhook"));
    fireEvent.change(screen.getByLabelText("url"), {
      target: { value: "https://hooks.example.com/audit" },
    });
    fireEvent.change(screen.getByLabelText("secret"), {
      target: { value: "s3cret" },
    });

    const addButtons = screen.getAllByRole("button", { name: /addTarget/ });
    // Last addTarget button is the dialog footer's submit.
    fireEvent.click(addButtons[addButtons.length - 1]);

    // After success, the dialog (and its title) must be removed from the DOM.
    await waitFor(() => {
      const titles = screen.queryAllByText("addTarget");
      // Only the section's outer button remains; the dialog title is gone.
      expect(titles.length).toBe(1);
    });
    expect(mockToast.success).toHaveBeenCalledWith("created");
  });

  // RT8: a stale-session create must surface the reauth recovery path, not the
  // generic createFailed toast, and must NOT report success.
  it("opens the recent-session dialog on a SESSION_STEP_UP_REQUIRED create (RT8)", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ targets: [] }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
      });
    });

    render(<AuditDeliveryTargetCard />);
    await waitFor(() => expect(screen.getByText("noTargets")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /addTarget/ }));
    await waitFor(() => {
      expect(screen.getAllByText("addTarget").length).toBeGreaterThan(1);
    });

    fireEvent.click(screen.getByText("kindWebhook"));
    fireEvent.change(screen.getByLabelText("url"), {
      target: { value: "https://hooks.example.com/audit" },
    });
    fireEvent.change(screen.getByLabelText("secret"), {
      target: { value: "s3cret" },
    });

    const addButtons = screen.getAllByRole("button", { name: /addTarget/ });
    fireEvent.click(addButtons[addButtons.length - 1]);

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("does NOT render the create form when limit is reached (limitReached path)", async () => {
    // Mock 100 targets to exceed MAX_AUDIT_DELIVERY_TARGETS (the constant guards this)
    setupTargets(
      Array.from({ length: 100 }, (_, i) => ({
        id: `t${i}`,
        kind: "WEBHOOK",
        isActive: true,
        failCount: 0,
        lastError: null,
        lastDeliveredAt: null,
        createdAt: new Date().toISOString(),
      })),
    );
    render(<AuditDeliveryTargetCard />);
    await waitFor(() => {
      expect(screen.getByText(/^limitReached/)).toBeInTheDocument();
    });
  });
});
