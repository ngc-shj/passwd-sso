// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
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

vi.mock("@/components/layout/sidebar-section-security", () => ({
  InsightsSection: () => <div>insights</div>,
  SettingsNavSection: () => <div>settings-nav</div>,
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
