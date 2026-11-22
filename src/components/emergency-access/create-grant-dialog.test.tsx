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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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
    // "escape" stands in for every dismissal Radix routes through
    // onOpenChange(false): Esc, the overlay and the X.
    DialogContent: ({ children }: { children: React.ReactNode }) =>
      dialogState.open ? (
        <div data-testid="dialog">
          <button type="button" onClick={() => dialogState.onOpenChange?.(false)}>
            escape
          </button>
          {children}
        </div>
      ) : null,
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

vi.mock("@/components/passwords/shared/copy-button", () => ({
  CopyButton: ({ getValue }: { getValue: () => string }) => (
    <button type="button" data-copy-value={getValue()}>
      copy
    </button>
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

import { CLIPBOARD_CLEAR_TIMEOUT_MS } from "@/lib/constants";
import { installClipboard, uninstallClipboard } from "@/__tests__/helpers/mock-clipboard";
import { CreateGrantDialog } from "./create-grant-dialog";

const INVITE_URL = "https://example.test/dashboard/emergency-access/invite/tok-123";

function openDialog() {
  fireEvent.click(screen.getByTestId("dialog-trigger"));
}

function fillEmail(value = "trustee@example.com") {
  fireEvent.change(screen.getByLabelText("granteeEmail"), { target: { value } });
}

function okResponse(json: () => Promise<unknown>) {
  return { ok: true, json };
}

async function createGrant() {
  openDialog();
  fillEmail();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "createGrant" }));
  });
}

describe("CreateGrantDialog", () => {
  let onCreated: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    mockFetchApi.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    installClipboard();
    onCreated = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallClipboard();
  });

  it("renders trigger button when closed", () => {
    render(<CreateGrantDialog onCreated={onCreated} />);
    expect(screen.getByText("addTrustedContact")).toBeInTheDocument();
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("disables submit when email is empty (R26)", () => {
    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    expect(screen.getByRole("button", { name: "createGrant" })).toBeDisabled();
  });

  it("disables submit when email is invalid", () => {
    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    fillEmail("not-an-email");
    expect(screen.getByRole("button", { name: "createGrant" })).toBeDisabled();
  });

  it("enables submit when email is valid", () => {
    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    fillEmail();
    expect(screen.getByRole("button", { name: "createGrant" })).not.toBeDisabled();
  });

  it("posts the email and the chosen wait period", async () => {
    mockFetchApi.mockResolvedValue(okResponse(async () => ({ token: "tok-123" })));
    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    fillEmail();
    fireEvent.change(screen.getByTestId("select"), { target: { value: "14" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "createGrant" }));
    });

    expect(mockFetchApi).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetchApi.mock.calls[0][1].body)).toEqual({
      granteeEmail: "trustee@example.com",
      waitDays: 14,
    });
  });

  describe("after the grant is created", () => {
    beforeEach(() => {
      mockFetchApi.mockResolvedValue(okResponse(async () => ({ token: "tok-123" })));
    });

    it("copies the invite URL and shows it with the copied message", async () => {
      const clip = installClipboard();
      render(<CreateGrantDialog onCreated={onCreated} />);
      await createGrant();

      expect(clip.writeText).toHaveBeenCalledWith(INVITE_URL);
      expect(screen.getByText("grantCreatedWithLink")).toBeInTheDocument();
      expect(screen.getByLabelText("inviteLinkLabel")).toHaveValue(INVITE_URL);
      expect(onCreated).toHaveBeenCalledTimes(1);
    });

    it("blanks the invite URL from the clipboard after the clear timeout", async () => {
      const clip = installClipboard({ readText: vi.fn().mockResolvedValue(INVITE_URL) });
      vi.useFakeTimers();
      render(<CreateGrantDialog onCreated={onCreated} />);
      await createGrant();
      expect(clip.writeText).toHaveBeenCalledWith(INVITE_URL);

      await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_TIMEOUT_MS);
      expect(clip.writeText).toHaveBeenLastCalledWith("");
    });

    it("keeps the link on screen with the not-copied message when the clipboard refuses", async () => {
      installClipboard({
        writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      });
      render(<CreateGrantDialog onCreated={onCreated} />);
      await createGrant();

      expect(screen.getByText("grantCreatedLinkNotCopied")).toBeInTheDocument();
      expect(screen.getByLabelText("inviteLinkLabel")).toHaveValue(INVITE_URL);
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(mockToastError).not.toHaveBeenCalled();
    });

    it("shows the footer's Done button only", async () => {
      render(<CreateGrantDialog onCreated={onCreated} />);
      await createGrant();

      expect(screen.getByRole("button", { name: "done" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "cancel" })).toBeNull();
      expect(screen.queryByRole("button", { name: "createGrant" })).toBeNull();
    });

    it.each([
      ["the body is not JSON", () => Promise.reject(new SyntaxError("bad json"))],
      ["the body has no token", () => Promise.resolve({})],
    ])("reports the link as unavailable when %s, without a creation failure", async (_label, json) => {
      mockFetchApi.mockResolvedValue(okResponse(json));
      const clip = installClipboard();
      render(<CreateGrantDialog onCreated={onCreated} />);
      await createGrant();

      expect(screen.getByText("grantCreatedLinkUnavailable")).toBeInTheDocument();
      expect(screen.queryByLabelText("inviteLinkLabel")).toBeNull();
      expect(clip.writeText).not.toHaveBeenCalled();
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(mockToastError).not.toHaveBeenCalled();
    });

    it.each(["done", "escape"])("forgets the invite URL when closed with %s", async (closeWith) => {
      render(<CreateGrantDialog onCreated={onCreated} />);
      await createGrant();
      expect(screen.getByLabelText("inviteLinkLabel")).toHaveValue(INVITE_URL);

      fireEvent.click(screen.getByRole("button", { name: closeWith }));
      openDialog();

      expect(screen.queryByDisplayValue(INVITE_URL)).toBeNull();
      expect(screen.getByLabelText("granteeEmail")).toHaveValue("");
    });
  });

  it("empties the form when cancelled and reopened", () => {
    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    fillEmail();
    fireEvent.change(screen.getByTestId("select"), { target: { value: "30" } });

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    openDialog();

    expect(screen.getByLabelText("granteeEmail")).toHaveValue("");
    expect(screen.getByTestId("select")).toHaveValue("7");
  });

  it("stays open while the request is in flight, then shows the result", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    mockFetchApi.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    fillEmail();
    fireEvent.click(screen.getByRole("button", { name: "createGrant" }));

    fireEvent.click(screen.getByRole("button", { name: "escape" }));
    expect(screen.getByTestId("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "cancel" })).toBeDisabled();

    await act(async () => {
      resolveFetch(okResponse(async () => ({ token: "tok-123" })));
    });
    expect(screen.getByLabelText("inviteLinkLabel")).toHaveValue(INVITE_URL);

    fireEvent.click(screen.getByRole("button", { name: "escape" }));
    openDialog();
    expect(screen.getByLabelText("granteeEmail")).toBeInTheDocument();
    expect(screen.queryByDisplayValue(INVITE_URL)).toBeNull();
  });

  it("shows mapped error toast on API failure", async () => {
    mockFetchApi.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "DUPLICATE" }),
    });

    render(<CreateGrantDialog onCreated={onCreated} />);
    openDialog();
    fillEmail();
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
    fillEmail();
    fireEvent.click(screen.getByRole("button", { name: "createGrant" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("networkError");
    });
    expect(onCreated).not.toHaveBeenCalled();
  });
});
