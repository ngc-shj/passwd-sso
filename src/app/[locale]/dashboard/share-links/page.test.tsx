// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { API_PATH } from "@/lib/constants";

const { mockFetchApi, mockToast, searchState } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
  searchState: { params: new URLSearchParams() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${JSON.stringify(values)})` : key,
  useLocale: () => "en",
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchState.params,
}));
vi.mock("sonner", () => ({ toast: mockToast }));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
}));
vi.mock("@/components/share/send-dialog", () => ({
  SendDialog: ({ open, onCreated }: { open: boolean; onCreated: () => void }) => (
    <div data-testid="send-dialog" data-open={String(open)}>
      <button type="button" onClick={onCreated}>
        simulate-send-created
      </button>
    </div>
  ),
}));

import ShareLinksPage from "./page";

const FUTURE = "2099-01-01T00:00:00.000Z";

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    entryType: "LOGIN",
    shareType: "ENTRY_SHARE",
    sendName: null,
    sendFilename: null,
    sendSizeBytes: null,
    expiresAt: FUTURE,
    maxViews: null,
    viewCount: 0,
    revokedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    passwordEntryId: "p1",
    teamPasswordEntryId: null,
    teamName: null,
    hasPersonalEntry: true,
    sharedBy: null,
    canRevoke: true,
    canViewAccessLogs: true,
    isActive: true,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function serve(items: unknown[], nextCursor: string | null = null) {
  mockFetchApi.mockResolvedValueOnce(json({ items, nextCursor }));
}

function listCalls(): string[] {
  return mockFetchApi.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith(API_PATH.SHARE_LINKS_MINE));
}

describe("ShareLinksPage", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    searchState.params = new URLSearchParams();
  });

  it("shows the empty state when there are no links", async () => {
    serve([]);
    render(<ShareLinksPage />);

    expect(await screen.findByText("noLinks")).toBeInTheDocument();
    expect(listCalls()[0]).toBe(`${API_PATH.SHARE_LINKS_MINE}?`);
  });

  it("keeps the empty state when the list request fails", async () => {
    mockFetchApi.mockResolvedValueOnce(json({}, 500));
    render(<ShareLinksPage />);

    expect(await screen.findByText("noLinks")).toBeInTheDocument();
  });

  it("passes the team and type query parameters through to the list request", async () => {
    searchState.params = new URLSearchParams("team=t1&type=entry");
    serve([]);
    render(<ShareLinksPage />);

    await screen.findByText("noLinks");
    expect(listCalls()[0]).toBe(`${API_PATH.SHARE_LINKS_MINE}?shareType=entry&team=t1`);
  });

  it("ignores an unknown type parameter", async () => {
    searchState.params = new URLSearchParams("type=bogus");
    serve([]);
    render(<ShareLinksPage />);

    await screen.findByText("noLinks");
    expect(listCalls()[0]).toBe(`${API_PATH.SHARE_LINKS_MINE}?`);
  });

  it("hides the new-send button inside a team filter", async () => {
    searchState.params = new URLSearchParams("team=t1");
    serve([]);
    render(<ShareLinksPage />);

    await screen.findByText("noLinks");
    expect(screen.queryByRole("button", { name: "newSend" })).toBeNull();
  });

  it("opens the send dialog from the new-send button", async () => {
    serve([]);
    render(<ShareLinksPage />);
    await screen.findByText("noLinks");

    fireEvent.click(screen.getByRole("button", { name: "newSend" }));

    expect(screen.getByTestId("send-dialog")).toHaveAttribute("data-open", "true");
  });

  it("refetches the list after a send is created", async () => {
    serve([]);
    render(<ShareLinksPage />);
    await screen.findByText("noLinks");

    serve([link({ id: "new", shareType: "TEXT", sendName: "Wifi", hasPersonalEntry: false, passwordEntryId: null })]);
    fireEvent.click(screen.getByRole("button", { name: "simulate-send-created" }));

    expect(await screen.findByText("Wifi")).toBeInTheDocument();
  });

  it.each([
    [link(), "active"],
    [link({ isActive: true, creatorAdmitted: false }), "notAdmitted"],
    [link({ isActive: false, revokedAt: "2026-01-02T00:00:00.000Z" }), "revoked"],
    [link({ isActive: false, maxViews: 2, viewCount: 2 }), "maxViewsReached"],
    [link({ isActive: false, expiresAt: "2020-01-01T00:00:00.000Z" }), "expired"],
  ])("shows the status badge %#", async (item, badge) => {
    serve([item]);
    render(<ShareLinksPage />);

    const list = await screen.findByText("personalEntry");
    expect(within(list.closest("[data-slot='card']") as HTMLElement).getByText(badge)).toBeInTheDocument();
  });

  it("describes text, file and entry shares", async () => {
    serve([
      link({ id: "a", shareType: "TEXT", sendName: null, hasPersonalEntry: false }),
      link({ id: "b", shareType: "FILE", sendFilename: "doc.pdf", sendSizeBytes: 2048, hasPersonalEntry: false }),
      link({ id: "c", shareType: "FILE", sendFilename: null, sendName: null, hasPersonalEntry: false }),
      link({ id: "d", hasPersonalEntry: false, teamPasswordEntryId: null, sharedBy: "Bob" }),
    ]);
    render(<ShareLinksPage />);

    expect(await screen.findByText("textSend")).toBeInTheDocument();
    expect(screen.getByText("doc.pdf")).toBeInTheDocument();
    expect(screen.getByText("(2.0 KB)")).toBeInTheDocument();
    expect(screen.getByText("fileSend")).toBeInTheDocument();
    expect(screen.getByText("deletedEntry")).toBeInTheDocument();
    expect(screen.getByText('sharedBy({"name":"Bob"})')).toBeInTheDocument();
  });

  it("shows views against the max when a max is set", async () => {
    serve([link({ maxViews: 5, viewCount: 1 }), link({ id: "s2", viewCount: 3 })]);
    render(<ShareLinksPage />);

    expect(await screen.findByText('viewCount({"current":1,"max":5})')).toBeInTheDocument();
    expect(screen.getByText("3 views")).toBeInTheDocument();
  });

  it("revokes a link in place", async () => {
    serve([link()]);
    render(<ShareLinksPage />);
    const revoke = await screen.findByRole("button", { name: "revoked" });

    mockFetchApi.mockResolvedValueOnce(json({}));
    fireEvent.click(revoke);

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("revokeSuccess"));
    expect(mockFetchApi).toHaveBeenLastCalledWith("/api/share-links/s1", { method: "DELETE" });
    expect(screen.queryByRole("button", { name: "revoked" })).toBeNull();
    expect(screen.getAllByText("revoked").length).toBeGreaterThan(0);
  });

  it("treats an already-revoked answer as a successful revoke", async () => {
    serve([link()]);
    render(<ShareLinksPage />);
    const revoke = await screen.findByRole("button", { name: "revoked" });

    mockFetchApi.mockResolvedValueOnce(json({ error: "ALREADY_REVOKED" }, 409));
    fireEvent.click(revoke);

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("revokeSuccess"));
  });

  it("reports a failed revoke and keeps the link active", async () => {
    serve([link()]);
    render(<ShareLinksPage />);
    const revoke = await screen.findByRole("button", { name: "revoked" });

    mockFetchApi.mockResolvedValueOnce(json({ error: "FORBIDDEN" }, 403));
    fireEvent.click(revoke);

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("revokeError"));
    expect(screen.getByRole("button", { name: "revoked" })).toBeEnabled();
  });

  it("reports a revoke that throws", async () => {
    serve([link()]);
    render(<ShareLinksPage />);
    const revoke = await screen.findByRole("button", { name: "revoked" });

    mockFetchApi.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(revoke);

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("revokeError"));
  });

  it("hides the revoke button when the viewer cannot revoke", async () => {
    serve([link({ canRevoke: false })]);
    render(<ShareLinksPage />);

    await screen.findByText("personalEntry");
    expect(screen.queryByRole("button", { name: "revoked" })).toBeNull();
  });

  it("hides the access-log toggle from a non-creator", async () => {
    serve([link({ viewCount: 2, canViewAccessLogs: false })]);
    render(<ShareLinksPage />);

    await screen.findByText("personalEntry");
    expect(screen.queryByRole("button", { name: "accessLogs" })).toBeNull();
  });

  it("expands the access logs, pages them, and collapses them", async () => {
    serve([link({ viewCount: 2 })]);
    render(<ShareLinksPage />);
    const toggle = await screen.findByRole("button", { name: "accessLogs" });

    mockFetchApi.mockResolvedValueOnce(
      json({ items: [{ id: "a1", ip: "10.0.0.1", userAgent: null, createdAt: "2026-01-01T00:00:00.000Z" }], nextCursor: "lc" }),
    );
    fireEvent.click(toggle);
    expect(await screen.findByText("10.0.0.1")).toBeInTheDocument();
    expect(mockFetchApi).toHaveBeenLastCalledWith("/api/share-links/s1/access-logs");

    mockFetchApi.mockResolvedValueOnce(
      json({ items: [{ id: "a2", ip: null, userAgent: null, createdAt: "2026-01-01T00:00:00.000Z" }], nextCursor: null }),
    );
    fireEvent.click(screen.getByRole("button", { name: "loadMoreLogs" }));
    expect(await screen.findByText("-")).toBeInTheDocument();
    expect(mockFetchApi).toHaveBeenLastCalledWith("/api/share-links/s1/access-logs?cursor=lc");
    expect(screen.getByText("10.0.0.1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "accessLogs" }));
    expect(screen.queryByText("10.0.0.1")).toBeNull();
  });

  it("shows the no-logs notice when the access-log request fails", async () => {
    serve([link({ viewCount: 1 })]);
    render(<ShareLinksPage />);
    const toggle = await screen.findByRole("button", { name: "accessLogs" });

    mockFetchApi.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(toggle);

    expect(await screen.findByText("noAccessLogs")).toBeInTheDocument();
  });

  it("appends the next page of links", async () => {
    serve([link()], "c1");
    render(<ShareLinksPage />);
    await screen.findByText("personalEntry");

    serve([link({ id: "s2", hasPersonalEntry: false, shareType: "TEXT", sendName: "Second" })]);
    fireEvent.click(screen.getByRole("button", { name: "loadMore" }));

    expect(await screen.findByText("Second")).toBeInTheDocument();
    expect(screen.getByText("personalEntry")).toBeInTheDocument();
    expect(listCalls()[1]).toBe(`${API_PATH.SHARE_LINKS_MINE}?cursor=c1`);
    expect(screen.queryByRole("button", { name: "loadMore" })).toBeNull();
  });
});
