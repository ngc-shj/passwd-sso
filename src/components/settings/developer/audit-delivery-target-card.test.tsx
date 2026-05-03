// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const { mockFetch, mockToast } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDateTime: (d: string) => d,
}));

import { AuditDeliveryTargetCard } from "./audit-delivery-target-card";

function setupTargets(targets: Array<Record<string, unknown>>) {
  mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
    if (!init || init.method === undefined || init.method === "GET") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ targets }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
  });
}

describe("AuditDeliveryTargetCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when no targets", async () => {
    setupTargets([]);
    render(<AuditDeliveryTargetCard />);
    await waitFor(() => {
      expect(screen.getByText("noTargets")).toBeInTheDocument();
    });
  });

  it("renders an active target's badges", async () => {
    setupTargets([
      {
        id: "t1",
        kind: "WEBHOOK",
        isActive: true,
        failCount: 0,
        lastError: null,
        lastDeliveredAt: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    render(<AuditDeliveryTargetCard />);
    await waitFor(() => {
      expect(screen.getByText("kindWebhook")).toBeInTheDocument();
    });
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("R26: shows fail count when present", async () => {
    setupTargets([
      {
        id: "t1",
        kind: "SIEM_HEC",
        isActive: true,
        failCount: 3,
        lastError: "auth failed",
        lastDeliveredAt: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    render(<AuditDeliveryTargetCard />);
    await waitFor(() => {
      expect(screen.getByText("kindSiemHec")).toBeInTheDocument();
    });
    const expected = `failCount:${JSON.stringify({ count: 3 })}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.getByText(/lastError/)).toBeInTheDocument();
  });

  it("does NOT render the create form when limit is reached (limitReached path)", async () => {
    // Mock 100 targets to exceed MAX_AUDIT_DELIVERY_TARGETS (the constant guards this)
    setupTargets(
      Array.from({ length: 100 }, (_, i) => ({
        id: `t${i}`,
        kind: "WEBHOOK",
        isActive: true,
        failCount: 0,
        lastError: null,
        lastDeliveredAt: null,
        createdAt: new Date().toISOString(),
      })),
    );
    render(<AuditDeliveryTargetCard />);
    await waitFor(() => {
      expect(screen.getByText(/^limitReached/)).toBeInTheDocument();
    });
  });
});
