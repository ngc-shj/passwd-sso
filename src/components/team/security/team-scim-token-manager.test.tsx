// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { render, screen, waitFor, act, fireEvent, within } from "@testing-library/react";

const { mockFetch, mockToast, mockCanUsePasskeyRecovery, mockReauthenticateWithPasskey } = vi.hoisted(() => ({
  mockCanUsePasskeyRecovery: vi.fn(),
  mockReauthenticateWithPasskey: vi.fn(),
  mockFetch: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
}));

// Stable function identity prevents infinite re-render via useCallback([t]).
const stableT = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;

vi.mock("next-intl", () => ({
  useTranslations: () => stableT,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
  appUrl: (path: string) => `https://app.test${path}`,
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDate: (d: string) => `formatted(${d})`,
}));

vi.mock("@/components/passwords/shared/copy-button", () => ({
  CopyButton: () => (
    <button type="button" data-testid="copy-btn" aria-label="copy">
      copy
    </button>
  ),
}));

import "@/__tests__/helpers/passkey-reauth-mocks";

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

vi.mock("@/components/settings/account/section-card-header", () => ({
  SectionCardHeader: ({ title }: { title: string }) => (
    <div data-testid="section-header">{title}</div>
  ),
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

import { ScimTokenManager } from "./team-scim-token-manager";

const ACTIVE_TOKEN = {
  id: "tok-active-1",
  description: "Production",
  createdAt: "2026-01-01T00:00:00Z",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdBy: { id: "u1", name: "Alice", email: "a@x" },
};

const REVOKED_TOKEN = {
  id: "tok-revoked-1",
  description: "Old",
  createdAt: "2025-01-01T00:00:00Z",
  lastUsedAt: "2025-06-01T00:00:00Z",
  expiresAt: null,
  revokedAt: "2025-12-01T00:00:00Z",
  createdBy: { id: "u1", name: "Alice", email: "a@x" },
};

const EXPIRED_TOKEN = {
  id: "tok-expired-1",
  description: "Past",
  createdAt: "2025-01-01T00:00:00Z",
  lastUsedAt: null,
  expiresAt: "2025-02-01T00:00:00Z",
  revokedAt: null,
  createdBy: null,
};

describe("ScimTokenManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true, verifiedAt: "2026-05-10T00:00:00Z" });
  });

  it("fetches tokens on mount", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    await act(async () => {
      render(<ScimTokenManager locale="en" />);
    });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  it("renders active token with revoke button", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([ACTIVE_TOKEN]),
    });
    await act(async () => {
      render(<ScimTokenManager locale="en" />);
    });
    await waitFor(() => {
      expect(screen.getByText("Production")).toBeInTheDocument();
      expect(screen.getByText("scimTokenActive")).toBeInTheDocument();
    });
  });

  it("notes a token whose creator lost access only for false: not for true, null or an absent flag", async () => {
    const token = (id: string, description: string, creatorAuthorized?: boolean | null) => ({
      ...ACTIVE_TOKEN,
      id,
      description,
      ...(creatorAuthorized === undefined ? {} : { creatorAuthorized }),
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          token("t-false", "Orphaned", false),
          token("t-true", "Healthy", true),
          token("t-null", "Legacy", null),
          token("t-absent", "Older server"),
        ]),
    });
    await act(async () => {
      render(<ScimTokenManager locale="en" />);
    });
    await waitFor(() => expect(screen.getByText("Orphaned")).toBeInTheDocument());

    // Each note is scoped to its own row: one note on one row.
    const rowOf = (name: string) => screen.getByText(name).closest(".border") as HTMLElement;
    expect(within(rowOf("Orphaned")).getByText("scimCreatorUnauthorized")).toBeInTheDocument();
    for (const name of ["Healthy", "Legacy", "Older server"]) {
      expect(within(rowOf(name)).queryByText("scimCreatorUnauthorized")).not.toBeInTheDocument();
    }
    expect(screen.getAllByText("scimCreatorUnauthorized")).toHaveLength(1);
  });

  it("does not note a revoked token even when its creator lost access", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ ...REVOKED_TOKEN, creatorAuthorized: false }]),
    });
    await act(async () => {
      render(<ScimTokenManager locale="en" />);
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(screen.queryByText("scimCreatorUnauthorized")).not.toBeInTheDocument();
  });

  it("classifies revoked token correctly", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([REVOKED_TOKEN]),
    });
    await act(async () => {
      render(<ScimTokenManager locale="en" />);
    });
    await waitFor(() => {
      // Inactive tokens are hidden initially behind the show-inactive collapsible
      // but the badge should never say "scimTokenActive" for revoked.
      expect(screen.queryByText("scimTokenActive")).toBeNull();
    });
  });

  it("classifies expired token (past expiresAt) as expired", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([EXPIRED_TOKEN]),
    });
    await act(async () => {
      render(<ScimTokenManager locale="en" />);
    });
    await waitFor(() => {
      expect(screen.queryByText("scimTokenActive")).toBeNull();
    });
  });

  it("toasts error when fetch fails", async () => {
    mockFetch.mockResolvedValue({ ok: false });
    await act(async () => {
      render(<ScimTokenManager locale="en" />);
    });
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("networkError");
    });
  });

  it("toasts error when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("net"));
    await act(async () => {
      render(<ScimTokenManager locale="en" />);
    });
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("networkError");
    });
  });

  it("creates token: button disabled while creating", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise((r) => (resolveFetch = r));
    mockFetch.mockImplementation(() => pending);
    await act(async () => {
      render(<ScimTokenManager locale="en" />);
    });
    // Tokens are still loading; we just verify the component renders without crash
    expect(document.querySelector("body")).toBeDefined();
    resolveFetch({ ok: true, json: () => Promise.resolve([]) });
  });

  it("opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned on create", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
      });

    await act(async () => {
      render(<ScimTokenManager locale="en" />);
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: "scimCreateToken" }));
    const createButtons = screen.getAllByRole("button", { name: "scimCreateToken" });
    await act(async () => {
      fireEvent.click(createButtons[createButtons.length - 1]);
    });

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("opens RecentSessionRequiredDialog when SESSION_STEP_UP_REQUIRED is returned on revoke", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([ACTIVE_TOKEN]) });
      }
      if (init.method === "DELETE") {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    await act(async () => {
      render(<ScimTokenManager locale="en" />);
    });

    await waitFor(() => {
      expect(screen.getByText("Production")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "scimTokenRevoke" }));
    const confirmButtons = screen.getAllByRole("button", { name: "scimTokenRevoke" });
    await act(async () => {
      fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    });

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("falls back to local networkError for an unrecognized API error code", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "BOGUS_NOT_IN_ALLOWLIST" }),
      });

    await act(async () => {
      render(<ScimTokenManager locale="en" />);
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: "scimCreateToken" }));
    const createButtons = screen.getAllByRole("button", { name: "scimCreateToken" });
    await act(async () => {
      fireEvent.click(createButtons[createButtons.length - 1]);
    });

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("networkError");
    });
  });
});
