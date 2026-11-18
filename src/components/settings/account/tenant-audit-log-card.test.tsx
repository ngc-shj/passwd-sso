// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const { mockFetch, mockUseAuditLogs, mockSearchParams, mockReplace, mockPathname } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockUseAuditLogs: vi.fn(),
  mockSearchParams: { current: new URLSearchParams() },
  mockReplace: vi.fn(),
  mockPathname: "/ja/admin/tenant/audit-logs",
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams.current,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => mockPathname,
}));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  useLocale: () => "en",
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/hooks/vault/use-audit-logs", () => ({
  useAuditLogs: (cfg: unknown) => mockUseAuditLogs(cfg),
}));

vi.mock("@/components/audit/audit-action-icons", () => ({
  ACTION_ICONS: {} as Record<string, React.ReactNode>,
  DEFAULT_AUDIT_ICON: <span data-testid="default-icon" />,
}));

vi.mock("@/components/audit/audit-action-filter", () => ({
  AuditActionFilter: () => <div data-testid="audit-action-filter" />,
}));

vi.mock("@/components/audit/audit-date-filter", () => ({
  AuditDateFilter: () => <div data-testid="audit-date-filter" />,
}));

vi.mock("@/components/audit/audit-download-button", () => ({
  AuditDownloadButton: ({ onDownload }: { onDownload: (f: "jsonl" | "csv") => void }) => (
    <button type="button" data-testid="audit-download-button" onClick={() => onDownload("jsonl")}>
      download
    </button>
  ),
}));

vi.mock("@/components/audit/audit-log-list", () => ({
  AuditLogList: ({ logs }: { logs: Array<{ id: string }> }) => (
    <div data-testid="audit-log-list">
      {logs.map((l) => (
        <div key={l.id}>{l.id}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/audit/audit-log-item-row", () => ({
  AuditLogItemRow: ({ id }: { id: string }) => (
    <div data-testid="audit-log-item-row">{id}</div>
  ),
}));

vi.mock("@/components/audit/audit-actor-type-badge", () => ({
  AuditActorTypeBadge: () => <span data-testid="actor-badge" />,
}));

vi.mock("@/components/audit/audit-delegation-detail", () => ({
  AuditDelegationDetail: () => <span data-testid="deleg-detail" />,
}));

vi.mock("@/components/breakglass/breakglass-dialog", () => ({
  BreakGlassDialog: () => (
    <div data-testid="breakglass-dialog" />
  ),
}));

vi.mock("@/components/breakglass/breakglass-grant-list", () => ({
  BreakGlassGrantList: () => <div data-testid="breakglass-grant-list" />,
}));

import { TenantAuditLogCard } from "./tenant-audit-log-card";

const baseHookReturn = {
  logs: [],
  loading: false,
  loadingMore: false,
  nextCursor: null,
  downloading: false,
  selectedActions: [],
  actionSearch: "",
  dateFrom: "",
  dateTo: "",
  filterOpen: false,
  actorTypeFilter: "ALL",
  setActionSearch: vi.fn(),
  setDateFrom: vi.fn(),
  setDateTo: vi.fn(),
  setFilterOpen: vi.fn(),
  setActorTypeFilter: vi.fn(),
  toggleAction: vi.fn(),
  setGroupSelection: vi.fn(),
  clearActions: vi.fn(),
  actionSummary: "",
  filteredActions: [],
  actionLabel: () => "",
  isActionSelected: () => false,
  formatDate: (s: string) => s,
  handleLoadMore: vi.fn(),
  handleDownload: vi.fn(),
};

describe("TenantAuditLogCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.current = new URLSearchParams();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    mockUseAuditLogs.mockReturnValue(baseHookReturn);
  });

  it("renders the logs variant with title and filters", async () => {
    render(<TenantAuditLogCard variant="logs" />);
    await waitFor(() => {
      expect(screen.getByText("subTabTenantLogs")).toBeInTheDocument();
    });
    expect(screen.getByTestId("audit-action-filter")).toBeInTheDocument();
    expect(screen.getByTestId("audit-date-filter")).toBeInTheDocument();
    expect(screen.getByTestId("audit-download-button")).toBeInTheDocument();
    expect(screen.getByTestId("audit-log-list")).toBeInTheDocument();
  });

  it("renders the breakglass variant with grant list and dialog", async () => {
    render(<TenantAuditLogCard variant="breakglass" />);
    await waitFor(() => {
      expect(screen.getByTestId("breakglass-dialog")).toBeInTheDocument();
    });
    expect(screen.getByTestId("breakglass-grant-list")).toBeInTheDocument();
  });

  it("hides team filter select when teams list is empty", async () => {
    render(<TenantAuditLogCard variant="logs" />);
    await waitFor(() => {
      // Only scope label/actorType label should show. The team-scope select
      // requires teams.length > 0 AND scopeFilter !== TENANT.
      expect(screen.getByText("scopeLabel")).toBeInTheDocument();
    });
  });

  describe("member activity deep link", () => {
    const ACTOR = "123e4567-e89b-42d3-a456-426614174000";

    function lastConfig() {
      return mockUseAuditLogs.mock.calls.at(-1)![0] as {
        buildExtraParams: () => URLSearchParams;
        initialDateFrom?: string;
      };
    }

    it("seeds the actor filter and from date from valid params", async () => {
      mockSearchParams.current = new URLSearchParams({ actor: ACTOR, from: "2026-05-01" });
      render(<TenantAuditLogCard variant="logs" />);

      expect(lastConfig().buildExtraParams().get("userId")).toBe(ACTOR);
      expect(lastConfig().initialDateFrom).toBe("2026-05-01");
      expect(screen.getByText(/actorFilterChip/)).toBeInTheDocument();
      expect(screen.getByText("actorFilterNote")).toBeInTheDocument();
    });

    it("sends userId on both the list fetch and the download", async () => {
      const actual = await vi.importActual<typeof import("@/hooks/vault/use-audit-logs")>(
        "@/hooks/vault/use-audit-logs",
      );
      mockUseAuditLogs.mockImplementation((cfg) => actual.useAuditLogs(cfg));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob([""])),
        json: () => Promise.resolve({ items: [], nextCursor: null }),
      });
      mockSearchParams.current = new URLSearchParams({ actor: ACTOR, from: "2026-05-01" });
      render(<TenantAuditLogCard variant="logs" />);

      const urls = () => mockFetch.mock.calls.map((c) => String(c[0]));
      await waitFor(() =>
        expect(urls().some((u) => u.includes("/audit-logs?") && u.includes(`userId=${ACTOR}`))).toBe(true),
      );
      fireEvent.click(screen.getByTestId("audit-download-button"));
      await waitFor(() =>
        expect(urls().some((u) => u.includes("/download?") && u.includes(`userId=${ACTOR}`))).toBe(true),
      );
    });

    it("ignores malformed actor and from params", () => {
      mockSearchParams.current = new URLSearchParams({ actor: "not-a-uuid", from: "yesterday" });
      render(<TenantAuditLogCard variant="logs" />);

      expect(lastConfig().buildExtraParams().has("userId")).toBe(false);
      expect(lastConfig().initialDateFrom).toBeUndefined();
      expect(screen.queryByText(/actorFilterChip/)).not.toBeInTheDocument();
    });

    it("names the member from a loaded log", () => {
      mockSearchParams.current = new URLSearchParams({ actor: ACTOR });
      mockUseAuditLogs.mockReturnValue({
        ...baseHookReturn,
        logs: [{ id: "l1", user: { id: ACTOR, name: "Alice", email: "a@example.com" } }],
      });
      render(<TenantAuditLogCard variant="logs" />);

      expect(screen.getByText(/"name":"Alice"/)).toBeInTheDocument();
    });

    it("clears the filter and the actor URL param, keeping other params", () => {
      mockSearchParams.current = new URLSearchParams({ actor: ACTOR, from: "2026-05-01" });
      render(<TenantAuditLogCard variant="logs" />);

      fireEvent.click(screen.getByLabelText("actorFilterClear"));

      expect(lastConfig().buildExtraParams().has("userId")).toBe(false);
      expect(screen.queryByText(/actorFilterChip/)).not.toBeInTheDocument();
      expect(mockReplace).toHaveBeenCalledWith(`${mockPathname}?from=2026-05-01`);
    });

    it("replaces with the bare path when actor was the only param", () => {
      mockSearchParams.current = new URLSearchParams({ actor: ACTOR });
      render(<TenantAuditLogCard variant="logs" />);

      fireEvent.click(screen.getByLabelText("actorFilterClear"));

      expect(mockReplace).toHaveBeenCalledWith(mockPathname);
    });
  });
});
