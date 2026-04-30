// @vitest-environment jsdom
/**
 * TenantResetHistoryDialog — Component behavior tests
 *
 * Covers (per plan §11.1 N2 fix):
 *   - Renders 5 statuses with i18n labels via STATUS_KEY_MAP.
 *   - Approve button visible+enabled when status === "pending_approval"
 *     AND currentUser.id !== row.initiatedBy.id.
 *   - Approve button visible+disabled-with-tooltip when initiator views own row.
 *   - Approve button NOT visible for non-pending_approval rows.
 *   - Approve dialog requires APPROVE phrase, posts to correct URL.
 *   - approvedBy display: shown for approved rows when approvedBy is set.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetch, mockToast } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDateTime: (d: string) => `dt(${d})`,
}));

// Dialog primitive: provide onOpenChange via React context so the trigger can
// open the dialog like the real Radix Dialog. Content is rendered when open.
const DialogCtx = React.createContext<{
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
}>({});

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    onOpenChange,
    open,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
  }) => (
    <DialogCtx.Provider value={{ onOpenChange, open }}>
      <div data-testid="dialog">{children}</div>
    </DialogCtx.Provider>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => {
    const { open } = React.useContext(DialogCtx);
    if (open === false) return null;
    return <div>{children}</div>;
  },
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTrigger: ({
    children,
    asChild: _asChild,
  }: {
    children: React.ReactElement<{ onClick?: () => void }>;
    asChild?: boolean;
  }) => {
    const { onOpenChange } = React.useContext(DialogCtx);
    return React.cloneElement(children, {
      onClick: () => onOpenChange?.(true),
    });
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    ...rest
  }: React.ComponentProps<"button">) => (
    <button disabled={disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({
    id,
    value,
    onChange,
    ...rest
  }: React.ComponentProps<"input">) => (
    <input id={id} value={value} onChange={onChange} {...rest} />
  ),
}));

import { TenantResetHistoryDialog } from "./tenant-reset-history-dialog";

const TARGET_USER_ID = "target-user-1";
const CURRENT_USER_ID = "current-admin-1";
const INITIATOR_ID = "other-admin-1";

interface ResetActor {
  id: string;
  name: string | null;
  email: string | null;
}

interface ResetRow {
  id: string;
  status:
    | "pending_approval"
    | "approved"
    | "executed"
    | "revoked"
    | "expired";
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  executedAt: string | null;
  revokedAt: string | null;
  initiatedBy: ResetActor;
  approvedBy: ResetActor | null;
  targetEmailAtInitiate: string;
  approveEligibility: "eligible" | "initiator" | "insufficient_role";
}

const NOW = "2026-04-30T12:00:00.000Z";
const FUTURE = "2026-05-01T12:00:00.000Z";

function makeRow(overrides: Partial<ResetRow>): ResetRow {
  return {
    id: "reset-1",
    status: "pending_approval",
    createdAt: NOW,
    expiresAt: FUTURE,
    approvedAt: null,
    executedAt: null,
    revokedAt: null,
    initiatedBy: { id: INITIATOR_ID, name: "Other Admin", email: "other@x" },
    approvedBy: null,
    targetEmailAtInitiate: "target@example.com",
    approveEligibility: "eligible",
    ...overrides,
  };
}

function setupFetchMocks(rows: ResetRow[]) {
  mockFetch.mockImplementation((url: string) => {
    if (url.endsWith("/reset-vault")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(rows),
      });
    }
    if (url.includes("/approve")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

async function renderAndOpen(rows: ResetRow[]) {
  setupFetchMocks(rows);
  render(
    <TenantResetHistoryDialog
      userId={TARGET_USER_ID}
      memberName="Target"
      pendingResets={rows.length}
    />,
  );
  // Click the trigger button (history icon button has no accessible name —
  // pick by role and index since DialogTrigger renders inline in the mock).
  const buttons = screen.getAllByRole("button");
  fireEvent.click(buttons[0]);
  await waitFor(() => {
    // initiatedBy label is rendered for any record
    expect(screen.queryByText(/initiatedBy/)).toBeInTheDocument();
  });
}

describe("TenantResetHistoryDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("status rendering via STATUS_KEY_MAP", () => {
    const cases: Array<{
      status: ResetRow["status"];
      expectedKey: string;
    }> = [
      { status: "pending_approval", expectedKey: "statusPendingApproval" },
      { status: "approved", expectedKey: "statusApproved" },
      { status: "executed", expectedKey: "statusExecuted" },
      { status: "revoked", expectedKey: "statusRevoked" },
      { status: "expired", expectedKey: "statusExpired" },
    ];

    for (const { status, expectedKey } of cases) {
      it(`renders ${expectedKey} for ${status}`, async () => {
        await renderAndOpen([makeRow({ status })]);
        expect(screen.getByText(expectedKey)).toBeInTheDocument();
      });
    }
  });

  describe("Approve button visibility", () => {
    it("is visible AND enabled when server says approveEligibility=eligible", async () => {
      await renderAndOpen([
        makeRow({ status: "pending_approval", approveEligibility: "eligible" }),
      ]);
      const approveButton = screen
        .getAllByRole("button")
        .find((b) => b.textContent?.includes("approveButton"));
      expect(approveButton).toBeDefined();
      expect(approveButton).not.toBeDisabled();
    });

    it("is visible AND disabled-with-tooltip when server says approveEligibility=initiator", async () => {
      await renderAndOpen([
        makeRow({
          status: "pending_approval",
          approveEligibility: "initiator",
          initiatedBy: { id: CURRENT_USER_ID, name: "Me", email: "me@x" },
        }),
      ]);
      const approveButton = screen
        .getAllByRole("button")
        .find((b) => b.textContent?.includes("approveButton"));
      expect(approveButton).toBeDefined();
      expect(approveButton).toBeDisabled();
      expect(screen.getByTestId("tooltip-content")).toHaveTextContent(
        "approveDisabledTooltip",
      );
    });

    const nonPendingStatuses: ResetRow["status"][] = [
      "approved",
      "executed",
      "revoked",
      "expired",
    ];

    for (const status of nonPendingStatuses) {
      it(`is NOT rendered for status ${status}`, async () => {
        await renderAndOpen([makeRow({ status })]);
        const approveButton = screen
          .queryAllByRole("button")
          .find((b) => b.textContent?.includes("approveButton"));
        expect(approveButton).toBeUndefined();
      });
    }

    it("is NOT rendered when server says approveEligibility=insufficient_role", async () => {
      // Covers BOTH target-self (viewer === target) and peer-admin
      // (e.g., ADMIN viewing another ADMIN's reset). The server hides the
      // distinction; the UI just hides the button rather than surfacing an
      // action that would reject.
      await renderAndOpen([
        makeRow({
          status: "pending_approval",
          approveEligibility: "insufficient_role",
        }),
      ]);
      const approveButton = screen
        .queryAllByRole("button")
        .find((b) => b.textContent?.includes("approveButton"));
      expect(approveButton).toBeUndefined();
    });
  });

  describe("approve confirmation flow", () => {
    it("opens dialog, requires APPROVE typed verbatim, and posts to approve endpoint", async () => {
      await renderAndOpen([
        makeRow({ id: "reset-x", status: "pending_approval" }),
      ]);

      const approveButton = screen
        .getAllByRole("button")
        .find((b) => b.textContent?.includes("approveButton"))!;
      fireEvent.click(approveButton);

      // Dialog now open — locate the confirm input
      const input = screen.getByPlaceholderText("APPROVE");
      const submitButtons = screen
        .getAllByRole("button")
        .filter((b) => b.textContent?.includes("approveButton"));
      // The footer submit is the last "approveButton" rendered (the dialog's submit)
      const submitButton = submitButtons[submitButtons.length - 1];

      // Empty input: submit button is disabled (gate the click before it fires).
      expect(submitButton).toBeDisabled();

      // Wrong phrase: still disabled, so no fetch happens even on click.
      fireEvent.change(input, { target: { value: "approve" } });
      expect(submitButton).toBeDisabled();
      fireEvent.click(submitButton);
      const approveCalls = mockFetch.mock.calls.filter((c) =>
        String(c[0]).includes("/approve"),
      );
      expect(approveCalls.length).toBe(0);

      // Now type the correct phrase: button becomes enabled, click fires fetch.
      fireEvent.change(input, { target: { value: "APPROVE" } });
      expect(submitButton).not.toBeDisabled();
      fireEvent.click(submitButton);

      await waitFor(() => {
        const calls = mockFetch.mock.calls.filter((c) =>
          String(c[0]).includes("/approve"),
        );
        expect(calls.length).toBe(1);
        const [url, init] = calls[0];
        expect(String(url)).toContain(
          `/api/tenant/members/${TARGET_USER_ID}/reset-vault/reset-x/approve`,
        );
        expect((init as RequestInit).method).toBe("POST");
      });
    });
  });

  describe("approvedBy display", () => {
    it("shows approvedBy label for approved rows when approvedBy is set", async () => {
      await renderAndOpen([
        makeRow({
          status: "approved",
          approvedAt: NOW,
          approvedBy: {
            id: "approver-1",
            name: "Carol",
            email: "carol@x",
          },
        }),
      ]);
      expect(screen.getByText(/approvedBy/)).toBeInTheDocument();
      expect(screen.getByText(/Carol/)).toBeInTheDocument();
    });

    it("does NOT show approvedBy label for pending rows where approvedBy is null", async () => {
      await renderAndOpen([
        makeRow({ status: "pending_approval", approvedBy: null }),
      ]);
      // The label "approvedBy" must not be rendered when approvedBy is null.
      expect(screen.queryByText(/approvedBy/)).toBeNull();
    });
  });
});
