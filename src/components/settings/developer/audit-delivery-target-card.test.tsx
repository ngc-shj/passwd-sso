// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
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

import "@/__tests__/helpers/passkey-reauth-mocks";

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

describe("AuditDeliveryTargetCard create validation and payloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  function postBodies() {
    return mockFetch.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown);
  }

  async function openCreate(kindLabel: string) {
    render(<AuditDeliveryTargetCard />);
    await waitFor(() => expect(screen.getByText("noTargets")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /addTarget/ }));
    fireEvent.click(screen.getByText(kindLabel));
  }

  function submit() {
    const addButtons = screen.getAllByRole("button", { name: /addTarget/ });
    fireEvent.click(addButtons[addButtons.length - 1]);
  }

  function lastAddButton() {
    const addButtons = screen.getAllByRole("button", { name: /addTarget/ });
    return addButtons[addButtons.length - 1];
  }

  it("rejects a non-https webhook URL without posting", async () => {
    setupTargets([]);
    await openCreate("kindWebhook");
    fireEvent.change(screen.getByLabelText("url"), { target: { value: "http://hooks.example.com" } });
    fireEvent.change(screen.getByLabelText("secret"), { target: { value: "s" } });

    submit();

    expect(await screen.findByText("urlHttpsRequired")).toBeInTheDocument();
    expect(postBodies()).toHaveLength(0);
  });

  it("rejects an unparseable URL and clears the error once the URL is edited", async () => {
    setupTargets([]);
    await openCreate("kindSiemHec");
    fireEvent.change(screen.getByLabelText("url"), { target: { value: "not a url" } });
    fireEvent.change(screen.getByLabelText("hecToken"), { target: { value: "tok" } });

    submit();
    expect(await screen.findByText("urlInvalid")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("url"), { target: { value: "https://splunk.example.com" } });
    expect(screen.queryByText("urlInvalid")).not.toBeInTheDocument();
  });

  it("keeps create disabled until the webhook secret is filled", async () => {
    setupTargets([]);
    await openCreate("kindWebhook");
    fireEvent.change(screen.getByLabelText("url"), { target: { value: "https://hooks.example.com" } });
    expect(lastAddButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText("secret"), { target: { value: "   " } });
    expect(lastAddButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText("secret"), { target: { value: "s3cret" } });
    expect(lastAddButton()).toBeEnabled();
  });

  it("posts a trimmed SIEM HEC payload", async () => {
    setupTargets([]);
    await openCreate("kindSiemHec");
    fireEvent.change(screen.getByLabelText("url"), { target: { value: " https://splunk.example.com/hec " } });
    fireEvent.change(screen.getByLabelText("hecToken"), { target: { value: " tok " } });

    submit();

    await waitFor(() => expect(postBodies()).toHaveLength(1));
    expect(postBodies()[0]).toEqual({
      kind: "SIEM_HEC",
      url: "https://splunk.example.com/hec",
      token: "tok",
    });
  });

  it("posts a trimmed S3 payload after validating the endpoint", async () => {
    setupTargets([]);
    await openCreate("kindS3Object");
    fireEvent.change(screen.getByLabelText("endpoint"), { target: { value: "https://s3.example.com " } });
    fireEvent.change(screen.getByLabelText("region"), { target: { value: " ap-northeast-1" } });
    fireEvent.change(screen.getByLabelText("accessKeyId"), { target: { value: "AKIA " } });
    fireEvent.change(screen.getByLabelText("secretAccessKey"), { target: { value: " sk" } });

    submit();

    await waitFor(() => expect(postBodies()).toHaveLength(1));
    expect(postBodies()[0]).toEqual({
      kind: "S3_OBJECT",
      endpoint: "https://s3.example.com",
      region: "ap-northeast-1",
      accessKeyId: "AKIA",
      secretAccessKey: "sk",
    });
  });

  it("rejects a non-https S3 endpoint", async () => {
    setupTargets([]);
    await openCreate("kindS3Object");
    fireEvent.change(screen.getByLabelText("endpoint"), { target: { value: "http://s3.example.com" } });
    fireEvent.change(screen.getByLabelText("region"), { target: { value: "r" } });
    fireEvent.change(screen.getByLabelText("accessKeyId"), { target: { value: "a" } });
    fireEvent.change(screen.getByLabelText("secretAccessKey"), { target: { value: "s" } });

    submit();

    expect(await screen.findByText("urlHttpsRequired")).toBeInTheDocument();
    expect(postBodies()).toHaveLength(0);
  });

  it("toasts createFailed and keeps the dialog open on a failed create", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "POST"
          ? { ok: false, status: 500, json: () => Promise.resolve({ error: "INTERNAL_ERROR" }) }
          : { ok: true, status: 200, json: () => Promise.resolve({ targets: [] }) },
      ),
    );
    await openCreate("kindWebhook");
    fireEvent.change(screen.getByLabelText("url"), { target: { value: "https://hooks.example.com" } });
    fireEvent.change(screen.getByLabelText("secret"), { target: { value: "s" } });

    submit();

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("createFailed"));
    expect(screen.getByLabelText("url")).toHaveValue("https://hooks.example.com");
  });

  it("resets the form when the dialog is cancelled", async () => {
    setupTargets([]);
    await openCreate("kindWebhook");
    fireEvent.change(screen.getByLabelText("url"), { target: { value: "https://hooks.example.com" } });

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /addTarget/ }));

    expect(screen.queryByLabelText("url")).not.toBeInTheDocument();
  });
});

describe("AuditDeliveryTargetCard target list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  const activeTarget = {
    id: "t1",
    kind: "SIEM_HEC",
    isActive: true,
    failCount: 0,
    lastError: "timeout",
    lastDeliveredAt: "2026-02-03T04:05:06Z",
    createdAt: "2026-01-01T00:00:00Z",
  };

  function patchBodies() {
    return mockFetch.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
      .map(([url, init]) => [url, JSON.parse(String((init as RequestInit).body))] as const);
  }

  async function confirmToggle(kindLabel: string, confirmLabel: string) {
    const badge = await screen.findByText(kindLabel);
    const item = badge.closest("div.p-3") as HTMLElement;
    fireEvent.click(within(item).getByRole("button"));
    fireEvent.click(await screen.findByRole("button", { name: confirmLabel }));
  }

  it("shows the last delivery time and last error of a target", async () => {
    setupTargets([activeTarget]);
    render(<AuditDeliveryTargetCard />);
    expect(await screen.findByText("lastDelivered: 2026-02-03T04:05:06Z")).toBeInTheDocument();
    expect(screen.getByText("lastError: timeout")).toBeInTheDocument();
  });

  it("deactivates an active target after confirmation", async () => {
    setupTargets([activeTarget]);
    render(<AuditDeliveryTargetCard />);

    await confirmToggle("kindSiemHec", "deactivate");

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("deactivated"));
    expect(patchBodies()).toEqual([[expect.stringContaining("t1"), { isActive: false }]]);
  });

  it("lists inactive targets separately and reactivates one after confirmation", async () => {
    setupTargets([{ ...activeTarget, id: "t9", kind: "S3_OBJECT", isActive: false }]);
    render(<AuditDeliveryTargetCard />);

    expect(await screen.findByText("noActiveTargets")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/^inactiveTargets/));
    await confirmToggle("kindS3Object", "activate");

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("reactivated"));
    expect(patchBodies()).toEqual([[expect.stringContaining("t9"), { isActive: true }]]);
  });

  it("toasts updateFailed when the toggle is rejected", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "PATCH"
          ? { ok: false, status: 500, json: () => Promise.resolve({ error: "INTERNAL_ERROR" }) }
          : { ok: true, status: 200, json: () => Promise.resolve({ targets: [activeTarget] }) },
      ),
    );
    render(<AuditDeliveryTargetCard />);

    await confirmToggle("kindSiemHec", "deactivate");

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("updateFailed"));
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("toasts updateFailed when the toggle request throws", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ targets: [activeTarget] }) }),
    );
    render(<AuditDeliveryTargetCard />);

    await confirmToggle("kindSiemHec", "deactivate");

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("updateFailed"));
  });
});

