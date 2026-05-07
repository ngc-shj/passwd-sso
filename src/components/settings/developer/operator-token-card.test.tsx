// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const {
  mockFetchApi,
  mockToastSuccess,
  mockToastError,
  mockReauthenticateWithPasskey,
  stableT,
  stableLocale,
} =
  vi.hoisted(() => {
    const t = (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key;
    return {
      mockFetchApi: vi.fn(),
      mockToastSuccess: vi.fn(),
      mockToastError: vi.fn(),
      mockReauthenticateWithPasskey: vi.fn(),
      stableT: t,
      stableLocale: "en",
    };
  });

vi.mock("next-intl", () => ({
  useTranslations: () => stableT,
  useLocale: () => stableLocale,
}));

vi.mock("sonner", () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: mockFetchApi,
  withBasePath: (path: string) => path,
}));
vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));
vi.mock("@/components/auth/recent-session-required-dialog", () => ({
  RecentSessionRequiredDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="recent-session-dialog" /> : null,
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDate: (d: string) => d,
}));

// Mock the heavy shadcn components down to plain primitives
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card">{children}</div>
  ),
  CardContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card-content">{children}</div>
  ),
}));
vi.mock("@/components/settings/account/section-card-header", () => ({
  SectionCardHeader: ({ title, description }: { title: string; description: string }) => (
    <div>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, ...rest }: React.ComponentProps<"button">) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectValue: () => null,
}));
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    children,
    open = true,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => (open ? <>{children}</> : null),
  AlertDialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
  AlertDialogCancel: ({
    children,
    disabled,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
  }) => <button disabled={disabled}>{children}</button>,
}));
vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/passwords/shared/copy-button", () => ({
  CopyButton: () => <button>copy</button>,
}));
vi.mock("lucide-react", () => ({
  KeyRound: () => null,
  Loader2: () => null,
  Plus: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
}));

import { OperatorTokenCard } from "./operator-token-card";

describe("OperatorTokenCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReauthenticateWithPasskey.mockResolvedValue({
      ok: true,
      verifiedAt: "2026-05-07T00:00:00Z",
    });
  });

  it("renders title + empty list when no tokens exist", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tokens: [] }),
    });

    render(<OperatorTokenCard />);

    expect(await screen.findByText("title")).toBeInTheDocument();
    expect(await screen.findByText("noTokens")).toBeInTheDocument();
    expect(mockFetchApi).toHaveBeenCalledWith("/api/tenant/operator-tokens");
  });

  it("creates a new token and shows the plaintext once", async () => {
    mockFetchApi
      // initial list
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tokens: [] }) })
      // POST create
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "tok-1",
          prefix: "op_AbCd",
          plaintext: "op_PLAINTEXT_VALUE_FOR_TEST",
          name: "test-token",
          scope: "maintenance",
          expiresAt: "2026-05-27T00:00:00Z",
          createdAt: "2026-04-27T00:00:00Z",
        }),
      })
      // refetch after create
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tokens: [] }) });

    render(<OperatorTokenCard />);

    const input = await screen.findByPlaceholderText("tokenNamePlaceholder");
    fireEvent.change(input, { target: { value: "test-token" } });

    const createButton = (await screen.findAllByText("createToken")).find(
      (el) => el.tagName === "BUTTON",
    );
    if (!createButton) throw new Error("createToken button not found");
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalledWith(
        "/api/tenant/operator-tokens",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("test-token"),
        }),
      );
    });

    expect(
      await screen.findByDisplayValue("op_PLAINTEXT_VALUE_FOR_TEST"),
    ).toBeInTheDocument();
    expect(mockToastSuccess).toHaveBeenCalledWith("tokenCreated");
  });

  it("opens reauth and retries create when stale-session is returned", async () => {
    mockFetchApi
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tokens: [] }) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "OPERATOR_TOKEN_STALE_SESSION" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ canPasskeySignIn: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "tok-1",
          prefix: "op_1234",
          plaintext: "op_PLAINTEXT_AFTER_REAUTH",
          name: "stale-test",
          scope: "maintenance",
          expiresAt: "2026-06-01T00:00:00Z",
          createdAt: "2026-05-07T00:00:00Z",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tokens: [] }),
      });

    render(<OperatorTokenCard />);

    const input = await screen.findByPlaceholderText("tokenNamePlaceholder");
    fireEvent.change(input, { target: { value: "stale-test" } });

    const createButton = (await screen.findAllByText("createToken")).find(
      (el) => el.tagName === "BUTTON",
    );
    if (!createButton) throw new Error("createToken button not found");
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(screen.getByText("reauthTitle")).toBeInTheDocument();
    });

    const reauthButtons = await screen.findAllByText("reauthAction");
    fireEvent.click(reauthButtons[reauthButtons.length - 1]);

    await waitFor(() => {
      expect(mockReauthenticateWithPasskey).toHaveBeenCalled();
      expect(mockToastSuccess).toHaveBeenCalledWith("tokenCreated");
    });

    expect(
      await screen.findByDisplayValue("op_PLAINTEXT_AFTER_REAUTH"),
    ).toBeInTheDocument();
  });

  it("shows reauth failure message when the ceremony is cancelled", async () => {
    mockFetchApi
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tokens: [] }) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "OPERATOR_TOKEN_STALE_SESSION" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ canPasskeySignIn: true }),
      });
    mockReauthenticateWithPasskey.mockResolvedValueOnce({
      ok: false,
      error: "AUTHENTICATION_CANCELLED",
    });

    render(<OperatorTokenCard />);

    const input = await screen.findByPlaceholderText("tokenNamePlaceholder");
    fireEvent.change(input, { target: { value: "stale-test" } });

    const createButton = (await screen.findAllByText("createToken")).find(
      (el) => el.tagName === "BUTTON",
    );
    if (!createButton) throw new Error("createToken button not found");
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(screen.getByText("reauthTitle")).toBeInTheDocument();
    });

    const reauthButtons = await screen.findAllByText("reauthAction");
    fireEvent.click(reauthButtons[reauthButtons.length - 1]);

    await waitFor(() => {
      expect(screen.getByText("reauthCancelled")).toBeInTheDocument();
    });
  });

  it("renders an existing token and triggers revoke on confirm", async () => {
    const existingToken = {
      id: "tok-existing",
      prefix: "op_zzzz",
      name: "existing-token",
      scope: "maintenance",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: null,
      lastUsedAt: null,
      createdAt: "2026-04-20T00:00:00Z",
      subjectUserId: "user-1",
      createdByUserId: "user-1",
      subjectUser: { id: "user-1", name: "Alice", email: "alice@example.com" },
      createdBy: { id: "user-1", name: "Alice", email: "alice@example.com" },
    };
    mockFetchApi
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tokens: [existingToken] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tokens: [] }) });

    render(<OperatorTokenCard />);

    expect(await screen.findByText("existing-token")).toBeInTheDocument();

    // The AlertDialog is mocked flat, so the "Revoke" action button is exposed directly
    const revokeButtons = await screen.findAllByText("tokenRevoke");
    // Click the AlertDialogAction (last "tokenRevoke" text — the confirm action)
    const action = revokeButtons[revokeButtons.length - 1];
    fireEvent.click(action);

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalledWith(
        "/api/tenant/operator-tokens/tok-existing",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("tokenRevoked");
  });
});
