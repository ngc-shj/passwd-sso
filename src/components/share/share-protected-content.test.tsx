// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetch(path, init),
  withBasePath: (p: string) => p,
}));

vi.mock("@/components/share/share-password-gate", () => ({
  SharePasswordGate: ({ token, error }: { token: string; error?: string | null }) => (
    <div data-testid="password-gate" data-token={token} data-error={error ?? ""} />
  ),
}));

vi.mock("@/components/share/share-send-view", () => ({
  ShareSendView: ({ sendType }: { sendType: string }) => (
    <div data-testid="send-view" data-type={sendType} />
  ),
}));

vi.mock("@/components/share/share-entry-view", () => ({
  ShareEntryView: ({ entryType }: { entryType: string }) => (
    <div data-testid="entry-view" data-type={entryType} />
  ),
}));

vi.mock("@/components/share/share-e2e-entry-view", () => ({
  ShareE2EEntryView: ({ entryType }: { entryType: string }) => (
    <div data-testid="e2e-view" data-type={entryType} />
  ),
}));

import { ShareProtectedContent } from "./share-protected-content";

function okJson(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

describe("ShareProtectedContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("shows the password gate when no access token is available", () => {
    render(<ShareProtectedContent shareId="s1" token="t1" />);
    expect(screen.getByTestId("password-gate")).toBeInTheDocument();
  });

  it("attempts to use sessionStorage-cached access token on mount and renders entry view on success", async () => {
    sessionStorage.setItem("share-access:t1", "stored-token");
    mockFetch.mockResolvedValueOnce(
      okJson({
        shareType: "ENTRY_SHARE",
        entryType: "LOGIN",
        data: { title: "x" },
        expiresAt: "2025-12-31T00:00:00Z",
        viewCount: 0,
        maxViews: null,
      }),
    );
    render(<ShareProtectedContent shareId="s1" token="t1" />);
    await waitFor(() => {
      expect(screen.getByTestId("entry-view")).toHaveAttribute("data-type", "LOGIN");
    });
  });

  it("evicts a stale cached access token when the content fetch returns non-ok", async () => {
    sessionStorage.setItem("share-access:t1", "stale-token");
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({}),
    } as unknown as Response);
    render(<ShareProtectedContent shareId="s1" token="t1" />);
    await waitFor(() => {
      expect(sessionStorage.getItem("share-access:t1")).toBeNull();
    });
    expect(screen.getByTestId("password-gate")).toBeInTheDocument();
  });

  it("renders ShareE2EEntryView for E2E content (encryptedData present)", async () => {
    sessionStorage.setItem("share-access:t1", "ok-token");
    mockFetch.mockResolvedValueOnce(
      okJson({
        shareType: "ENTRY_SHARE",
        entryType: "LOGIN",
        encryptedData: "ct",
        dataIv: "iv",
        dataAuthTag: "tag",
        expiresAt: "2025-12-31T00:00:00Z",
        viewCount: 0,
        maxViews: null,
      }),
    );
    render(<ShareProtectedContent shareId="s1" token="t1" />);
    await waitFor(() => {
      expect(screen.getByTestId("e2e-view")).toBeInTheDocument();
    });
  });

  it("renders ShareSendView for TEXT shareType", async () => {
    sessionStorage.setItem("share-access:t1", "ok-token");
    mockFetch.mockResolvedValueOnce(
      okJson({
        shareType: "TEXT",
        entryType: null,
        data: { name: "msg", text: "hello" },
        expiresAt: "2025-12-31T00:00:00Z",
        viewCount: 0,
        maxViews: null,
      }),
    );
    render(<ShareProtectedContent shareId="s1" token="t1" />);
    await waitFor(() => {
      expect(screen.getByTestId("send-view")).toHaveAttribute("data-type", "TEXT");
    });
  });
});
