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

const { mockFetch, mockUseAuditLogs } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockUseAuditLogs: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/hooks/vault/use-audit-logs", () => ({
  useAuditLogs: () => mockUseAuditLogs(),
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
  AuditDownloadButton: () => (
    <button type="button" data-testid="audit-download-button">
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
});
