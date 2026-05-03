// @vitest-environment jsdom
/**
 * RotateKeyDialog tests
 *
 * R26: disabled-state cue on submit button (consumed via underlying ui/button.test.tsx;
 *      here we assert `disabled` prop wiring)
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockRotateKey } = vi.hoisted(() => ({
  mockRotateKey: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ rotateKey: mockRotateKey }),
}));

vi.mock("@/lib/http/api-error-codes", () => ({
  apiErrorToI18nKey: (code: string) => `apiErr:${code}`,
}));

vi.mock("@/lib/ui/ime-guard", () => ({
  preventIMESubmit: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled, onClick, type, ...rest }: React.ComponentProps<"button">) => (
    <button type={type} disabled={disabled} onClick={onClick} {...rest}>
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

import { RotateKeyDialog } from "./rotate-key-dialog";

describe("RotateKeyDialog", () => {
  let onOpenChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onOpenChange = vi.fn();
  });

  it("renders title and warning when open", () => {
    render(<RotateKeyDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByText("rotateKey")).toBeInTheDocument();
    expect(screen.getByText("rotateKeyWarningEa")).toBeInTheDocument();
    expect(screen.getByText("rotateKeyWarningTime")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(<RotateKeyDialog open={false} onOpenChange={onOpenChange} />);
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("disables submit when passphrase is empty (R26)", () => {
    render(<RotateKeyDialog open={true} onOpenChange={onOpenChange} />);
    const submit = screen.getByRole("button", { name: "rotateKeyButton" });
    expect(submit).toBeDisabled();
  });

  it("enables submit when passphrase is non-empty", () => {
    render(<RotateKeyDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("rotateKeyPassphrase"), {
      target: { value: "abc" },
    });
    const submit = screen.getByRole("button", { name: "rotateKeyButton" });
    expect(submit).not.toBeDisabled();
  });

  it("calls rotateKey with passphrase + progress callback and closes on success", async () => {
    mockRotateKey.mockImplementation(
      async (
        _pass: string,
        progress: (phase: string, current: number, total: number) => void,
      ) => {
        progress("entries", 1, 5);
      },
    );

    render(<RotateKeyDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("rotateKeyPassphrase"), {
      target: { value: "mypass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "rotateKeyButton" }));

    await waitFor(() => {
      expect(mockRotateKey).toHaveBeenCalled();
    });
    expect(mockRotateKey.mock.calls[0][0]).toBe("mypass");
    expect(typeof mockRotateKey.mock.calls[0][1]).toBe("function");

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("renders mapped INVALID_PASSPHRASE error", async () => {
    mockRotateKey.mockRejectedValue({ error: "INVALID_PASSPHRASE" });
    render(<RotateKeyDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("rotateKeyPassphrase"), {
      target: { value: "mypass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "rotateKeyButton" }));

    await waitFor(() => {
      expect(screen.getByText("invalidPassphrase")).toBeInTheDocument();
    });
  });

  it("renders mapped ENTRY_COUNT_MISMATCH error", async () => {
    mockRotateKey.mockRejectedValue({ error: "ENTRY_COUNT_MISMATCH" });
    render(<RotateKeyDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("rotateKeyPassphrase"), {
      target: { value: "mypass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "rotateKeyButton" }));

    await waitFor(() => {
      expect(screen.getByText("entryCountMismatch")).toBeInTheDocument();
    });
  });

  it("falls back to apiErrorToI18nKey for unknown error codes", async () => {
    mockRotateKey.mockRejectedValue({ error: "WEIRD_CODE" });
    render(<RotateKeyDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("rotateKeyPassphrase"), {
      target: { value: "mypass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "rotateKeyButton" }));

    await waitFor(() => {
      expect(screen.getByText("apiErr:WEIRD_CODE")).toBeInTheDocument();
    });
  });

  it("falls back to generic failure for non-API errors", async () => {
    mockRotateKey.mockRejectedValue(new Error("network down"));
    render(<RotateKeyDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("rotateKeyPassphrase"), {
      target: { value: "mypass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "rotateKeyButton" }));

    await waitFor(() => {
      expect(screen.getByText("rotateKeyFailed")).toBeInTheDocument();
    });
  });
});
