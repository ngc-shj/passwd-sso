// @vitest-environment jsdom
/**
 * BreakGlassDialog tests
 *
 * NOTE: This dialog does NOT take a passphrase or other secret material.
 * It takes a `reason` (free text) and `incidentRef` only — §Sec-2 does not apply.
 *
 * R26: disabled-state cue on submit button + cancel button
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetchApi, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetchApi(path, init),
}));

vi.mock("@/lib/filter-members", () => ({
  filterMembers: <T,>(members: T[]) => members,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/member-info", () => ({
  MemberInfo: ({ name, email }: { name: string | null; email: string | null }) => (
    <span>
      {name ?? "(no-name)"}/{email ?? "(no-email)"}
    </span>
  ),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

vi.mock("@/components/ui/dialog", () => {
  // We pass open state via context-like local var. Use a small DialogCtx pattern
  // by stashing the onOpenChange on a module variable that DialogTrigger reads.
  const dialogState: { onOpenChange?: (v: boolean) => void; open?: boolean } = {};
  const Dialog = ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (v: boolean) => void;
  }) => {
    // Test-mock: capture controlled props into a closure-scoped state object so
    // the Trigger/Content stubs below can read them. Test-only pattern; the
    // immutability rule is meant for production component state.
    // eslint-disable-next-line react-hooks/immutability
    dialogState.onOpenChange = onOpenChange;
    // eslint-disable-next-line react-hooks/immutability
    dialogState.open = open;
    return <div data-testid="dialog-root">{children}</div>;
  };
  const DialogTrigger = ({ children }: { children: React.ReactNode }) => (
    <span
      data-testid="dialog-trigger"
      onClick={() => dialogState.onOpenChange?.(!dialogState.open)}
    >
      {children}
    </span>
  );
  const DialogContent = ({ children }: { children: React.ReactNode }) =>
    dialogState.open ? <div data-testid="dialog">{children}</div> : null;
  return {
    Dialog,
    DialogTrigger,
    DialogContent,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    type,
    ...rest
  }: React.ComponentProps<"button">) => (
    <button type={type} disabled={disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: ({ id, value, onChange, ...rest }: React.ComponentProps<"textarea">) => (
    <textarea id={id} value={value} onChange={onChange} {...rest} />
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({ id, value, onChange, ...rest }: React.ComponentProps<"input">) => (
    <input id={id} value={value} onChange={onChange} {...rest} />
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

import { BreakGlassDialog } from "./breakglass-dialog";

const members = [
  { userId: "u1", name: "Alice", email: "alice@example.com", image: null, deactivatedAt: null },
  { userId: "u2", name: "Bob", email: "bob@example.com", image: null, deactivatedAt: null },
];

function openDialog() {
  // The trigger renders the actual `requestAccess` button; clicking the
  // wrapper span fires the dialog open handler in our mock.
  fireEvent.click(screen.getByTestId("dialog-trigger"));
}

describe("BreakGlassDialog", () => {
  let onGrantCreated: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onGrantCreated = vi.fn();
  });

  it("renders trigger button when closed", () => {
    render(<BreakGlassDialog onGrantCreated={onGrantCreated} />);
    expect(screen.getByText("requestAccess")).toBeInTheDocument();
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("loads members on open and disables submit when no target selected (R26)", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => members });

    render(<BreakGlassDialog onGrantCreated={onGrantCreated} />);
    openDialog();

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalled();
    });

    const submitBtn = screen.getByRole("button", { name: "submit" });
    expect(submitBtn).toBeDisabled();
  });

  it("disables submit until both target user AND reason >= 10 chars are set", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => members });

    render(<BreakGlassDialog onGrantCreated={onGrantCreated} />);
    openDialog();

    await waitFor(() => screen.getByText("Alice/alice@example.com"));

    // Select user (still no reason → still disabled)
    fireEvent.click(screen.getByText("Alice/alice@example.com"));
    expect(screen.getByRole("button", { name: "submit" })).toBeDisabled();

    // Add reason < 10 chars → still disabled
    fireEvent.change(screen.getByLabelText("reason"), { target: { value: "short" } });
    expect(screen.getByRole("button", { name: "submit" })).toBeDisabled();

    // Add reason >= 10 chars → enabled
    fireEvent.change(screen.getByLabelText("reason"), {
      target: { value: "this is a long enough reason" },
    });
    expect(screen.getByRole("button", { name: "submit" })).not.toBeDisabled();
  });

  it("submits with correct payload and fires onGrantCreated on success", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => members });
    mockFetchApi.mockResolvedValueOnce({ ok: true });

    render(<BreakGlassDialog onGrantCreated={onGrantCreated} />);
    openDialog();

    await waitFor(() => screen.getByText("Alice/alice@example.com"));

    fireEvent.click(screen.getByText("Alice/alice@example.com"));
    fireEvent.change(screen.getByLabelText("reason"), {
      target: { value: "we need urgent investigation" },
    });
    fireEvent.change(screen.getByLabelText("incidentRef"), {
      target: { value: "INC-001" },
    });

    fireEvent.click(screen.getByRole("button", { name: "submit" }));

    await waitFor(() => {
      expect(onGrantCreated).toHaveBeenCalled();
    });

    const submitCall = mockFetchApi.mock.calls[1];
    expect(submitCall[1].method).toBe("POST");
    const body = JSON.parse(submitCall[1].body);
    expect(body).toEqual({
      targetUserId: "u1",
      reason: "we need urgent investigation",
      incidentRef: "INC-001",
    });
  });

  it("shows duplicate-grant error on 409", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => members });
    mockFetchApi.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "duplicate" }),
    });

    render(<BreakGlassDialog onGrantCreated={onGrantCreated} />);
    openDialog();

    await waitFor(() => screen.getByText("Alice/alice@example.com"));

    fireEvent.click(screen.getByText("Alice/alice@example.com"));
    fireEvent.change(screen.getByLabelText("reason"), {
      target: { value: "long enough reason text" },
    });

    fireEvent.click(screen.getByRole("button", { name: "submit" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("duplicateGrantError");
    });
    expect(onGrantCreated).not.toHaveBeenCalled();
  });

  it("shows rate-limit error on 429", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => members });
    mockFetchApi.mockResolvedValueOnce({ ok: false, status: 429 });

    render(<BreakGlassDialog onGrantCreated={onGrantCreated} />);
    openDialog();

    await waitFor(() => screen.getByText("Alice/alice@example.com"));

    fireEvent.click(screen.getByText("Alice/alice@example.com"));
    fireEvent.change(screen.getByLabelText("reason"), {
      target: { value: "long enough reason" },
    });

    fireEvent.click(screen.getByRole("button", { name: "submit" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("rateLimitExceeded");
    });
  });

  it("shows self-access error when 400 with details.targetUserId", async () => {
    mockFetchApi.mockResolvedValueOnce({ ok: true, json: async () => members });
    mockFetchApi.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ details: { targetUserId: "self" } }),
    });

    render(<BreakGlassDialog onGrantCreated={onGrantCreated} />);
    openDialog();

    await waitFor(() => screen.getByText("Alice/alice@example.com"));

    fireEvent.click(screen.getByText("Alice/alice@example.com"));
    fireEvent.change(screen.getByLabelText("reason"), {
      target: { value: "long enough reason" },
    });

    fireEvent.click(screen.getByRole("button", { name: "submit" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("selfAccessError");
    });
  });
});
