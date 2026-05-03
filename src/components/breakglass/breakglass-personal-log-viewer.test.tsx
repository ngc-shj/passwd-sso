// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetchApi } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key;
    return Object.assign(t, { has: (_k: string) => true });
  },
  useLocale: () => "en",
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetchApi(path, init),
}));

vi.mock("@/lib/audit/audit-action-key", () => ({
  normalizeAuditActionKey: (k: string) => k,
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDateTime: (s: string) => s,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled, onClick }: React.ComponentProps<"button">) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

import { BreakGlassPersonalLogViewer } from "./breakglass-personal-log-viewer";

describe("BreakGlassPersonalLogViewer", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
  });

  it("calls onBack when back button clicked", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], nextCursor: null }),
    });
    const onBack = vi.fn();

    render(
      <BreakGlassPersonalLogViewer
        grantId="g1"
        targetUserName="Target"
        expiresAt="2026-05-04"
        onBack={onBack}
      />,
    );

    fireEvent.click(screen.getByText("backToGrants"));
    expect(onBack).toHaveBeenCalled();
  });

  it("renders empty state when no logs", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], nextCursor: null }),
    });

    render(
      <BreakGlassPersonalLogViewer
        grantId="g1"
        targetUserName="Target"
        expiresAt="2026-05-04"
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("noLogs")).toBeInTheDocument();
    });
  });

  it("renders log entries with action and target labels", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "log-1",
            action: "PASSWORD_VIEW",
            targetType: "PASSWORD_ENTRY",
            targetId: "pe-1",
            metadata: null,
            ip: "1.2.3.4",
            createdAt: "2026-05-04",
          },
        ],
        nextCursor: null,
      }),
    });

    render(
      <BreakGlassPersonalLogViewer
        grantId="g1"
        targetUserName="Target"
        expiresAt="2026-05-04"
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("PASSWORD_VIEW")).toBeInTheDocument();
    });
    expect(screen.getByText("encryptedEntry")).toBeInTheDocument();
    expect(screen.getByText("1.2.3.4")).toBeInTheDocument();
  });

  it("uses metadata.filename as target label when present and not PASSWORD_ENTRY", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "log-1",
            action: "DOWNLOAD",
            targetType: "FILE",
            targetId: null,
            metadata: { filename: "secret.txt" },
            ip: null,
            createdAt: "2026-05-04",
          },
        ],
        nextCursor: null,
      }),
    });

    render(
      <BreakGlassPersonalLogViewer
        grantId="g1"
        targetUserName="Target"
        expiresAt="2026-05-04"
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("secret.txt")).toBeInTheDocument();
    });
  });

  it("loads more entries via cursor pagination", async () => {
    mockFetchApi
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            {
              id: "log-1",
              action: "FIRST",
              targetType: null,
              targetId: null,
              metadata: null,
              ip: null,
              createdAt: "2026-05-04",
            },
          ],
          nextCursor: "cursor-1",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            {
              id: "log-2",
              action: "SECOND",
              targetType: null,
              targetId: null,
              metadata: null,
              ip: null,
              createdAt: "2026-05-04",
            },
          ],
          nextCursor: null,
        }),
      });

    render(
      <BreakGlassPersonalLogViewer
        grantId="g1"
        targetUserName="Target"
        expiresAt="2026-05-04"
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("FIRST")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("loadMore"));

    await waitFor(() => {
      expect(screen.getByText("SECOND")).toBeInTheDocument();
    });
    // First entry still rendered (append, not replace)
    expect(screen.getByText("FIRST")).toBeInTheDocument();
  });

  it("does not crash when API returns non-ok", async () => {
    mockFetchApi.mockResolvedValue({ ok: false });

    render(
      <BreakGlassPersonalLogViewer
        grantId="g1"
        targetUserName="Target"
        expiresAt="2026-05-04"
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("noLogs")).toBeInTheDocument();
    });
  });
});
