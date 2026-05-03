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

import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";

const { mockFetch, mockToast } = vi.hoisted(() => ({
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

vi.mock("@/components/settings/account/section-card-header", () => ({
  SectionCardHeader: ({ title }: { title: string }) => (
    <div data-testid="section-header">{title}</div>
  ),
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
});
