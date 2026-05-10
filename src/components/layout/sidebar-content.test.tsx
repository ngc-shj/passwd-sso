// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href, onClick }: { children: React.ReactNode; href: string; onClick?: () => void }) => (
    <a href={href} onClick={onClick}>{children}</a>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, asChild, ...rest }: React.ComponentProps<"button"> & { asChild?: boolean }) =>
    asChild ? <>{children}</> : <button {...rest}>{children}</button>,
}));

vi.mock("@/components/layout/vault-selector", () => ({
  VaultSelector: ({ onValueChange }: { onValueChange: (v: string) => void }) => (
    <button onClick={() => onValueChange("team-1")}>vault-selector</button>
  ),
}));

const settingsNavSpy = vi.fn();
vi.mock("@/components/layout/sidebar-section-security", () => ({
  InsightsSection: () => <div>insights</div>,
  SettingsNavSection: (props: { adminConsoleHref?: string; isAdmin?: boolean }) => {
    settingsNavSpy(props);
    return <div data-testid="settings-nav" data-href={props.adminConsoleHref}>settings-nav</div>;
  },
  ToolsSection: () => <div>tools</div>,
}));

vi.mock("@/components/layout/sidebar-sections", () => ({
  VaultSection: () => <div>vault</div>,
  CategoriesSection: () => <div>categories</div>,
  VaultManagementSection: () => <div>vault-management</div>,
  FoldersSection: ({ onCreate }: { onCreate: () => void }) => (
    <button onClick={onCreate}>create-folder</button>
  ),
  TagsSection: () => <div>tags</div>,
}));

import { SidebarContent, type SidebarContentProps } from "./sidebar-content";

function baseProps(overrides: Partial<SidebarContentProps> = {}): SidebarContentProps {
  return {
    t: (k: string) => k,
    tTeam: (k: string) => k,
    vaultContext: { type: "personal" },
    teams: [{ id: "team-1", name: "Acme", slug: "acme", role: "ADMIN", tenantName: "Acme Corp", isCrossTenant: false }],
    selectedTeam: null,
    selectedTeamCanManageFolders: false,
    selectedTeamCanManageTags: false,
    selectedTypeFilter: null,
    selectedFolderId: null,
    selectedTagId: null,
    isSelectedVaultAll: true,
    isSelectedVaultFavorites: false,
    isSelectedVaultArchive: false,
    isSelectedVaultTrash: false,
    isAdminActive: false,
    isSettingsActive: false,
    isExportActive: false,
    isImportActive: false,
    isAdmin: false,
    isTenantAdmin: false,
    isWatchtower: false,
    isShareLinks: false,
    isEmergencyAccess: false,
    isPersonalAuditLog: false,
    selectedFolders: [],
    selectedTags: [],
    isOpen: vi.fn(() => true),
    toggleSection: vi.fn(() => vi.fn()),
    onVaultChange: vi.fn(),
    onCreateFolder: vi.fn(),
    onEditFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onEditTag: vi.fn(),
    onDeleteTag: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };
}

describe("SidebarContent", () => {
  beforeEach(() => {
    settingsNavSpy.mockClear();
  });

  it("calls onVaultChange from VaultSelector", () => {
    const props = baseProps();
    render(<SidebarContent {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "vault-selector" }));

    expect(props.onVaultChange).toHaveBeenCalledWith("team-1");
  });

  it("calls onCreateFolder without teamId in personal context", () => {
    const props = baseProps({ vaultContext: { type: "personal" } });
    render(<SidebarContent {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "create-folder" }));

    expect(props.onCreateFolder).toHaveBeenCalledWith();
  });

  it("calls onCreateFolder with teamId in team context", () => {
    const props = baseProps({ vaultContext: { type: "team", teamId: "team-1" } });
    render(<SidebarContent {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "create-folder" }));

    expect(props.onCreateFolder).toHaveBeenCalledWith("team-1");
  });

  it("renders SettingsNavSection for team vault (admin console stays accessible)", () => {
    const props = baseProps({ vaultContext: { type: "team", teamId: "team-1", teamRole: "ADMIN" } });
    render(<SidebarContent {...props} />);

    expect(screen.queryByText("settings-nav")).not.toBeNull();
  });

  it("does not render InsightsSection for team Viewer", () => {
    const props = baseProps({ vaultContext: { type: "team", teamId: "team-1", teamRole: "VIEWER" } });
    render(<SidebarContent {...props} />);

    expect(screen.queryByText("insights")).toBeNull();
  });

  it("renders InsightsSection for team non-Viewer", () => {
    const props = baseProps({ vaultContext: { type: "team", teamId: "team-1", teamRole: "OWNER" } });
    render(<SidebarContent {...props} />);

    expect(screen.getByText("insights")).toBeInTheDocument();
  });

  it("renders SettingsNavSection for personal vault", () => {
    const props = baseProps({ vaultContext: { type: "personal" } });
    render(<SidebarContent {...props} />);

    expect(screen.getByText("settings-nav")).toBeInTheDocument();
  });

  it("routes admin console to team admin when team vault is selected", () => {
    const props = baseProps({
      vaultContext: { type: "team", teamId: "team-1", teamRole: "ADMIN" },
      isAdmin: true,
      isTenantAdmin: true,
    });
    render(<SidebarContent {...props} />);

    expect(settingsNavSpy).toHaveBeenCalledWith(
      expect.objectContaining({ adminConsoleHref: "/admin/teams/team-1/general" }),
    );
  });

  it("routes admin console to tenant admin for tenant admin in personal vault", () => {
    const props = baseProps({
      vaultContext: { type: "personal" },
      isAdmin: true,
      isTenantAdmin: true,
    });
    render(<SidebarContent {...props} />);

    expect(settingsNavSpy).toHaveBeenCalledWith(
      expect.objectContaining({ adminConsoleHref: "/admin/tenant/members" }),
    );
  });

  it("routes admin console to first admin team for team-only admin in personal vault", () => {
    // Reproduces F1 finding: a user who is a team admin but NOT a tenant admin
    // would 404 if sent to /admin/tenant/members, so personal-vault context
    // should fall back to their first admin team's general page.
    const props = baseProps({
      vaultContext: { type: "personal" },
      teams: [
        { id: "team-1", name: "Acme", slug: "acme", role: "ADMIN", tenantName: "Acme", isCrossTenant: false },
      ],
      isAdmin: true,
      isTenantAdmin: false,
    });
    render(<SidebarContent {...props} />);

    expect(settingsNavSpy).toHaveBeenCalledWith(
      expect.objectContaining({ adminConsoleHref: "/admin/teams/team-1/general" }),
    );
  });

  it("renders emergency access link at top level for personal vault", () => {
    const props = baseProps({ vaultContext: { type: "personal" } });
    render(<SidebarContent {...props} />);

    expect(screen.getByRole("link", { name: "emergencyAccess" })).toHaveAttribute("href", "/dashboard/emergency-access");
  });

  it("does not render emergency access top-level link for team vault", () => {
    const props = baseProps({ vaultContext: { type: "team", teamId: "team-1", teamRole: "MEMBER" } });
    render(<SidebarContent {...props} />);

    expect(screen.queryByRole("link", { name: "emergencyAccess" })).toBeNull();
  });

});
