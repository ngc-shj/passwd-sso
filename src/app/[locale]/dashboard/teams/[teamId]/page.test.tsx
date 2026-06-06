// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { Suspense } from "react";

const { search, listViewProps, teamKey, perms, fetchOk } = vi.hoisted(() => ({
  search: { current: new URLSearchParams() },
  listViewProps: { current: undefined as Record<string, unknown> | undefined },
  teamKey: { current: {} as CryptoKey | null },
  perms: { current: { canCreate: true, canEdit: true, canDelete: true, canShare: true } },
  fetchOk: { current: true },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => search.current,
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/url-helpers", () => ({
  fetchApi: vi.fn(async (url: string) => {
    if (url.includes("/teams/") && !url.includes("/passwords") && !url.includes("/folders") && !url.includes("/tags")) {
      return { ok: fetchOk.current, json: async () => ({ id: "team-1", name: "Acme", slug: "acme", role: "OWNER", memberCount: 1, passwordCount: 0 }) };
    }
    return { ok: true, json: async () => [] };
  }),
}));
vi.mock("@/lib/team/team-vault-context", () => ({
  useTeamVault: () => ({ getTeamEncryptionKey: async () => teamKey.current }),
}));
vi.mock("@/lib/vault/team-vault-list-adapter", () => ({
  useTeamVaultListAdapter: () => ({
    kind: "team",
    teamId: "team-1",
    availability: { ready: true, reason: "key-pending" },
    permissions: perms.current,
    supportsFavorite: true,
  }),
}));
vi.mock("@/components/passwords/detail/entry-list-view", () => ({
  EntryListView: (props: Record<string, unknown>) => {
    listViewProps.current = props;
    const d = props.descriptor as { kind: string };
    return <div data-testid="entry-list-view" data-descriptor-kind={d.kind} />;
  },
}));
vi.mock("@/components/team/management/team-new-dialog", () => ({ TeamNewDialog: () => <div data-testid="new-dialog" /> }));
vi.mock("@/components/team/management/team-edit-dialog-loader", () => ({ TeamEditDialogLoader: () => <div data-testid="edit-dialog" /> }));
vi.mock("@/components/team/management/team-role-badge", () => ({ TeamRoleBadge: () => <span /> }));
vi.mock("@/components/passwords/entry/entry-list-header", () => ({
  EntryListHeader: ({ actions }: { actions: React.ReactNode }) => <div data-testid="header">{actions}</div>,
}));
vi.mock("@/components/passwords/entry/entry-sort-menu", () => ({ EntrySortMenu: () => <div /> }));
vi.mock("@/components/layout/search-bar", () => ({ SearchBar: () => <div /> }));
vi.mock("@/hooks/use-layout-mode", () => ({ useLayoutMode: () => "accordion" }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import TeamDashboardPage from "./page";

async function renderPage(scope?: Record<string, string>) {
  search.current = new URLSearchParams(scope);
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <TeamDashboardPage params={Promise.resolve({ teamId: "team-1" })} />
      </Suspense>,
    );
  });
}

describe("TeamDashboardPage (delegated to EntryListView)", () => {
  beforeEach(() => {
    teamKey.current = {} as CryptoKey;
    perms.current = { canCreate: true, canEdit: true, canDelete: true, canShare: true };
    fetchOk.current = true;
    listViewProps.current = undefined;
  });

  it("selects the descriptor by scope (favorites)", async () => {
    await renderPage({ scope: "favorites" });
    await waitFor(() => expect(screen.getByTestId("entry-list-view")).toHaveAttribute("data-descriptor-kind", "favorites"));
  });

  it("selects ARCHIVE_VIEW for scope=archive and clears the query filters", async () => {
    await renderPage({ scope: "archive", folder: "fd", tag: "tg" });
    await waitFor(() => expect(screen.getByTestId("entry-list-view")).toHaveAttribute("data-descriptor-kind", "archive"));
    expect(listViewProps.current?.query).toEqual({ tagId: null, folderId: null, entryType: null });
  });

  it("selects TRASH_VIEW for scope=trash", async () => {
    await renderPage({ scope: "trash" });
    await waitFor(() => expect(screen.getByTestId("entry-list-view")).toHaveAttribute("data-descriptor-kind", "trash"));
  });

  it("selects NORMAL_VIEW and forwards tag/folder/type query when no scope", async () => {
    await renderPage({ folder: "fd", tag: "tg", type: "LOGIN" });
    await waitFor(() => expect(screen.getByTestId("entry-list-view")).toHaveAttribute("data-descriptor-kind", "normal"));
    expect(listViewProps.current?.query).toEqual({ tagId: "tg", folderId: "fd", entryType: "LOGIN" });
  });

  it("shows the New button for a role with create permission", async () => {
    await renderPage();
    await screen.findByTestId("entry-list-view");
    expect(screen.getByText("newItem")).toBeInTheDocument();
  });

  it("hides New + Select for a VIEWER (no permissions)", async () => {
    perms.current = { canCreate: false, canEdit: false, canDelete: false, canShare: false };
    await renderPage();
    await screen.findByTestId("entry-list-view");
    expect(screen.queryByText("newItem")).not.toBeInTheDocument();
    expect(screen.queryByText("select")).not.toBeInTheDocument();
  });

  it("shows the key-pending banner (and no list) when the team key is unavailable", async () => {
    teamKey.current = null;
    await renderPage();
    await waitFor(() => expect(screen.getByText("keyPendingTitle")).toBeInTheDocument());
    expect(screen.queryByTestId("entry-list-view")).not.toBeInTheDocument();
  });

  it("shows the error card when the team fetch fails", async () => {
    fetchOk.current = false;
    await renderPage();
    await waitFor(() => expect(screen.getByText("forbidden")).toBeInTheDocument());
  });
});
