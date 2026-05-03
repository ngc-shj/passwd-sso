// @vitest-environment jsdom
/**
 * CreateGrantDialog tests
 *
 * NOTE: This dialog accepts an EMAIL ADDRESS (granteeEmail), not a passphrase
 * or other secret material. §Sec-2 sentinel-in-DOM does not apply.
 *
 * R26: disabled-state cue on submit button (loading + invalid email)
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetchApi, mockToastSuccess, mockToastError, mockClipboardWrite } =
  vi.hoisted(() => ({
    mockFetchApi: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
    mockClipboardWrite: vi.fn(async () => undefined),
  }));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetchApi(path, init),
  appUrl: (path: string) => `https://example.test${path}`,
}));

vi.mock("@/lib/http/api-error-codes", () => ({
  eaErrorToI18nKey: (e: unknown) => `ea:${String(e ?? "unknown")}`,
}));

vi.mock("sonner", () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

vi.mock("@/components/ui/dialog", () => {
  const dialogState: { onOpenChange?: (v: boolean) => void; open?: boolean } = {};
  return {
    Dialog: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open: boolean;
      onOpenChange: (v: boolean) => void;
    }) => {
      dialogState.onOpenChange = onOpenChange;
      dialogState.open = open;
      return <div>{children}</div>;
    },
    DialogTrigger: ({ children }: { children: React.ReactNode }) => (
      <span
        data-testid="dialog-trigger"
        onClick={() => dialogState.onOpenChange?.(!dialogState.open)}
      >
        {children}
      </span>
    ),
    DialogContent: ({ children }: { children: React.ReactNode }) =>
      dialogState.open ? <div data-testid="dialog">{children}</div> : null,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled, onClick, type }: React.ComponentProps<"button">) => (
    <button type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({ id, value, onChange, type, ...rest }: React.ComponentProps<"input">) => (
    <input id={id} value={value} onChange={onChange} type={type} {...rest} />
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => (
    <select
      data-testid="select"
      aria-label="select"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

import { CreateGrantDialog } from "./create-grant-dialog";

function openDialog() {
  fireEvent.click(screen.getByTestId("dialog-trigger"));
}

describe("CreateGrantDialog", () => {
  let onCreated: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetchApi.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockClipboardWrite.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockClipboardWrite },
      configurable: true,
    });
    onCreated = vi.fn();
  });

  it("renders trigger button when closed", () => {
    render(<CreateGrantDialog onCreated={onCreated} />);
    expect(screen.getByText("addTrustedContact")).toBeInTheDocument();
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("disables submit when email is empty (R26)", () => {
    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    const submit = screen.getByRole("button", { name: "createGrant" });
    expect(submit).toBeDisabled();
  });

  it("disables submit when email is invalid", () => {
    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    fireEvent.change(screen.getByLabelText("granteeEmail"), {
      target: { value: "not-an-email" },
    });
    expect(screen.getByRole("button", { name: "createGrant" })).toBeDisabled();
  });

  it("enables submit when email is valid", () => {
    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    fireEvent.change(screen.getByLabelText("granteeEmail"), {
      target: { value: "trustee@example.com" },
    });
    expect(screen.getByRole("button", { name: "createGrant" })).not.toBeDisabled();
  });

  it("submits with email + waitDays, copies invite URL on success", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => ({ token: "tok-123" }),
    });

    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    fireEvent.change(screen.getByLabelText("granteeEmail"), {
      target: { value: "trustee@example.com" },
    });
    fireEvent.change(screen.getByTestId("select"), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: "createGrant" }));

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalled();
    });
    const body = JSON.parse(mockFetchApi.mock.calls[0][1].body);
    expect(body).toEqual({ granteeEmail: "trustee@example.com", waitDays: 14 });

    await waitFor(() => {
      expect(mockClipboardWrite).toHaveBeenCalledWith(
        "https://example.test/dashboard/emergency-access/invite/tok-123",
      );
    });

    expect(mockToastSuccess).toHaveBeenCalledWith("grantCreatedWithLink");
    expect(onCreated).toHaveBeenCalled();
  });

  it("shows mapped error toast on API failure", async () => {
    mockFetchApi.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "DUPLICATE" }),
    });

    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    fireEvent.change(screen.getByLabelText("granteeEmail"), {
      target: { value: "trustee@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "createGrant" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("ea:DUPLICATE");
    });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows networkError toast on thrown error", async () => {
    mockFetchApi.mockRejectedValue(new Error("network down"));

    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    fireEvent.change(screen.getByLabelText("granteeEmail"), {
      target: { value: "trustee@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "createGrant" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("networkError");
    });
  });

});
