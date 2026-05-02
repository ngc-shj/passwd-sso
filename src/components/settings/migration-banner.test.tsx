// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
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

  it("sets localStorage key and posts audit event on dismiss click", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    render(<MigrationBanner />);

    fireEvent.click(screen.getByText("banner.dismiss"));

    expect(storageMap.get(BANNER_DISMISS_KEY)).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/internal/audit-emit",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          action: "SETTINGS_IA_MIGRATION_V1_SEEN",
          scope: "PERSONAL",
        }),
      }),
    );
  });

  it("does not throw when fetch fails on dismiss", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", fetchMock);

    render(<MigrationBanner />);

    // Should not throw
    expect(() => {
      fireEvent.click(screen.getByText("banner.dismiss"));
    }).not.toThrow();

    // Allow the rejected promise to settle
    await vi.runAllTimersAsync();

    warnSpy.mockRestore();
  });

  it("hides banner after dismiss click", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    render(<MigrationBanner />);
    expect(screen.getByText("banner.title")).toBeInTheDocument();

    fireEvent.click(screen.getByText("banner.dismiss"));

    expect(screen.queryByText("banner.title")).not.toBeInTheDocument();
  });
});
