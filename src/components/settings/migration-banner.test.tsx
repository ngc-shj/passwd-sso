// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { BANNER_DISMISS_KEY, BANNER_SUNSET_TS } from "./migration-banner-config";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, ...rest }: React.ComponentProps<"button">) => (
    <button onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: mockToastError, success: vi.fn(), warning: vi.fn() },
}));

const { mockFetchApi } = vi.hoisted(() => ({ mockFetchApi: vi.fn() }));
vi.mock("@/lib/url-helpers", () => ({
  fetchApi: mockFetchApi,
}));

// The jsdom environment used by this project provides localStorage as a plain object
// (localstorage-file config issue), so we stub it explicitly.
const storageMap = new Map<string, string>();
const mockLocalStorage = {
  getItem: vi.fn((key: string) => storageMap.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { storageMap.set(key, value); }),
  removeItem: vi.fn((key: string) => { storageMap.delete(key); }),
  clear: vi.fn(() => { storageMap.clear(); }),
};
vi.stubGlobal("localStorage", mockLocalStorage);

import { MigrationBanner } from "./migration-banner";

describe("MigrationBanner", () => {
  const PRE_SUNSET_TIME = BANNER_SUNSET_TS.getTime() - 10 * 24 * 60 * 60 * 1000; // 10 days before sunset

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PRE_SUNSET_TIME);
    storageMap.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    storageMap.clear();
  });

  it("renders banner when pre-sunset and no dismiss key", () => {
    render(<MigrationBanner />);

    expect(screen.getByText("banner.title")).toBeInTheDocument();
  });

  it("does not render when dismiss key is set in localStorage", () => {
    storageMap.set(BANNER_DISMISS_KEY, String(Date.now()));

    render(<MigrationBanner />);

    expect(screen.queryByText("banner.title")).not.toBeInTheDocument();
  });

  it("does not render when post-sunset (no dismiss key)", () => {
    vi.setSystemTime(BANNER_SUNSET_TS.getTime() + 1000);

    render(<MigrationBanner />);

    expect(screen.queryByText("banner.title")).not.toBeInTheDocument();
  });

  it("posts audit event with AUDIT_ACTION constant + AUDIT_SCOPE.PERSONAL on dismiss", async () => {
    mockFetchApi.mockResolvedValue({ ok: true });

    render(<MigrationBanner />);

    await act(async () => {
      fireEvent.click(screen.getByText("banner.dismiss"));
      await vi.runAllTimersAsync();
    });

    expect(mockFetchApi).toHaveBeenCalledWith(
      "/api/internal/audit-emit",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          action: AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN,
          scope: AUDIT_SCOPE.PERSONAL,
        }),
      }),
    );
  });

  it("persists dismiss key to localStorage ONLY after fetch resolves successfully", async () => {
    mockFetchApi.mockResolvedValue({ ok: true });

    render(<MigrationBanner />);

    await act(async () => {
      fireEvent.click(screen.getByText("banner.dismiss"));
      await vi.runAllTimersAsync();
    });

    expect(storageMap.get(BANNER_DISMISS_KEY)).toBeDefined();
  });

  it("does NOT persist dismiss key when fetch returns a non-OK response (retry-on-next-session)", async () => {
    mockFetchApi.mockResolvedValue({ ok: false, status: 429 });

    render(<MigrationBanner />);

    await act(async () => {
      fireEvent.click(screen.getByText("banner.dismiss"));
      await vi.runAllTimersAsync();
    });

    expect(storageMap.has(BANNER_DISMISS_KEY)).toBe(false);
    expect(mockToastError).toHaveBeenCalledWith("banner.dismissError");
  });

  it("does not throw and does NOT persist dismiss key when fetch rejects (network error)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetchApi.mockRejectedValue(new Error("network error"));

    render(<MigrationBanner />);

    expect(() => {
      fireEvent.click(screen.getByText("banner.dismiss"));
    }).not.toThrow();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(storageMap.has(BANNER_DISMISS_KEY)).toBe(false);
    warnSpy.mockRestore();
  });

  it("hides banner immediately after dismiss click (optimistic UI)", async () => {
    mockFetchApi.mockResolvedValue({ ok: true });

    render(<MigrationBanner />);
    expect(screen.getByText("banner.title")).toBeInTheDocument();

    fireEvent.click(screen.getByText("banner.dismiss"));

    // Banner is removed from DOM immediately, before fetch resolves.
    expect(screen.queryByText("banner.title")).not.toBeInTheDocument();
  });
});
