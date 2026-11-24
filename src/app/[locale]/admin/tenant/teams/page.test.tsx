// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { mockI18nNavigation } from "@/__tests__/helpers/mock-app-navigation";
import { TEAM_DATA_CHANGED_EVENT } from "@/lib/events";

const { mockFetchApi } = vi.hoisted(() => ({ mockFetchApi: vi.fn() }));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${JSON.stringify(values)})` : key,
  useLocale: () => "en",
}));
vi.mock("@/i18n/navigation", () => mockI18nNavigation());
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
}));
vi.mock("@/components/team/management/team-create-dialog", () => ({
  TeamCreateDialog: ({ trigger, onCreated }: { trigger: ReactNode; onCreated: () => void }) => (
    <div>
      {trigger}
      <button type="button" onClick={onCreated}>
        simulate-created
      </button>
    </div>
  ),
}));
vi.mock("@/components/team/management/ownerless-teams-card", () => ({
  OwnerlessTeamsCard: () => <div data-testid="ownerless-card" />,
}));

import AdminTenantTeamsPage from "./page";

const TEAM = {
  id: "team-1",
  name: "Platform",
  slug: "platform",
  description: null,
  role: "OWNER",
  createdAt: "2026-01-02T00:00:00.000Z",
  memberCount: 3,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function routeFetch(opts: { role?: string | null; teams?: unknown; teamsStatus?: number }) {
  mockFetchApi.mockImplementation(async (path: string) => {
    if (path.includes("/tenant/role")) return json({ role: opts.role ?? null });
    if (opts.teamsStatus && opts.teamsStatus >= 400) return json({ error: "x" }, opts.teamsStatus);
    return json(opts.teams ?? []);
  });
}

describe("AdminTenantTeamsPage", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links each fetched team to its admin general page", async () => {
    routeFetch({ teams: [TEAM] });
    render(<AdminTenantTeamsPage />);

    const link = await screen.findByRole("link", { name: /Platform/ });
    expect(link).toHaveAttribute("href", "/admin/teams/team-1/general");
  });

  it("shows an em dash when a team has no description", async () => {
    routeFetch({ teams: [TEAM] });
    render(<AdminTenantTeamsPage />);

    expect(await screen.findByText("—")).toBeInTheDocument();
  });

  it("shows the tenant name of a cross-tenant team", async () => {
    routeFetch({ teams: [{ ...TEAM, isCrossTenant: true, tenantName: "Other Corp" }] });
    render(<AdminTenantTeamsPage />);

    expect(await screen.findByText("Other Corp")).toBeInTheDocument();
  });

  it("shows the empty state when the team list is empty", async () => {
    routeFetch({ teams: [] });
    render(<AdminTenantTeamsPage />);

    expect(await screen.findByText("noTeams")).toBeInTheDocument();
  });

  it("shows the empty state when the teams request fails", async () => {
    routeFetch({ teamsStatus: 500 });
    render(<AdminTenantTeamsPage />);

    expect(await screen.findByText("noTeams")).toBeInTheDocument();
  });

  it("ignores a non-array teams payload", async () => {
    routeFetch({ teams: { items: [TEAM] } });
    render(<AdminTenantTeamsPage />);

    expect(await screen.findByText("noTeams")).toBeInTheDocument();
    expect(screen.queryByText("Platform")).toBeNull();
  });

  it("shows the empty state when the teams request throws", async () => {
    mockFetchApi.mockImplementation(async (path: string) => {
      if (path.includes("/tenant/role")) return json({ role: null });
      throw new Error("network");
    });
    render(<AdminTenantTeamsPage />);

    expect(await screen.findByText("noTeams")).toBeInTheDocument();
  });

  it("offers team creation and the ownerless card to a tenant admin", async () => {
    routeFetch({ role: "ADMIN", teams: [] });
    render(<AdminTenantTeamsPage />);

    expect(await screen.findByRole("button", { name: /createTeam/ })).toBeInTheDocument();
    expect(screen.getByTestId("ownerless-card")).toBeInTheDocument();
  });

  it("hides team creation and the ownerless card from a non-admin", async () => {
    routeFetch({ role: "MEMBER", teams: [] });
    render(<AdminTenantTeamsPage />);

    await screen.findByText("noTeams");
    expect(screen.queryByRole("button", { name: /createTeam/ })).toBeNull();
    expect(screen.queryByTestId("ownerless-card")).toBeNull();
  });

  it("refetches the list and announces the change after a team is created", async () => {
    routeFetch({ role: "ADMIN", teams: [] });
    const listener = vi.fn();
    window.addEventListener(TEAM_DATA_CHANGED_EVENT, listener);
    render(<AdminTenantTeamsPage />);
    await screen.findByText("noTeams");

    routeFetch({ role: "ADMIN", teams: [TEAM] });
    fireEvent.click(await screen.findByRole("button", { name: "simulate-created" }));

    expect(await screen.findByText("Platform")).toBeInTheDocument();
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(TEAM_DATA_CHANGED_EVENT, listener);
  });

  it("renders the member count and creation date of a team", async () => {
    routeFetch({ teams: [TEAM] });
    render(<AdminTenantTeamsPage />);

    await waitFor(() => {
      expect(screen.getByText('memberCount({"count":3})')).toBeInTheDocument();
    });
    expect(screen.getByText(/createdAtLabel/)).toBeInTheDocument();
  });
});
