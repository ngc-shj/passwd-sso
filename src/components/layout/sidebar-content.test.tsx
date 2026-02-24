// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/layout/vault-selector", () => ({
  VaultSelector: ({ onValueChange }: { onValueChange: (v: string) => void }) => (
    <button onClick={() => onValueChange("org-1")}>vault-selector</button>
  ),
}));

vi.mock("@/components/layout/sidebar-section-security", () => ({
  SecuritySection: () => <div>security</div>,
  UtilitiesSection: () => <div>utilities</div>,
}));

vi.mock("@/components/layout/sidebar-sections", () => ({
  VaultSection: () => <div>vault</div>,
  CategoriesSection: () => <div>categories</div>,
  VaultManagementSection: () => <div>vault-management</div>,
  OrganizeSection: ({ onCreateFolder, onCreateTag }: { onCreateFolder: () => void; onCreateTag: () => void }) => (
    <>
      <button onClick={onCreateFolder}>create-folder</button>
      <button onClick={onCreateTag}>create-tag</button>
    </>
  ),
}));

import { SidebarContent, type SidebarContentProps } from "./sidebar-content";

function baseProps(overrides: Partial<SidebarContentProps> = {}): SidebarContentProps {
  return {
    t: (k: string) => k,
    tOrg: (k: string) => k,
    vaultContext: { type: "personal" },
    orgs: [{ id: "org-1", name: "Acme", slug: "acme", role: "ADMIN" }],
    selectedOrg: null,
    selectedOrgCanManageFolders: false,
    selectedOrgCanManageTags: false,
    selectedTypeFilter: null,
    selectedFolderId: null,
    selectedTagId: null,
    isSelectedVaultAll: true,
    isSelectedVaultFavorites: false,
    isSelectedVaultArchive: false,
    isSelectedVaultTrash: false,
    isWatchtower: false,
    isShareLinks: false,
    isEmergencyAccess: false,
    isPersonalAuditLog: false,
    activeAuditOrgId: null,
    selectedFolders: [],
    selectedTags: [],
    isOpen: vi.fn(() => true),
    toggleSection: vi.fn(() => vi.fn()),
    onVaultChange: vi.fn(),
    onCreateFolder: vi.fn(),
    onCreateTag: vi.fn(),
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

    expect(props.onVaultChange).toHaveBeenCalledWith("org-1");
  });

  it("calls onCreateFolder without orgId in personal context", () => {
    const props = baseProps({ vaultContext: { type: "personal" } });
    render(<SidebarContent {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "create-folder" }));

    expect(props.onCreateFolder).toHaveBeenCalledWith();
  });

  it("calls onCreateFolder with orgId in org context", () => {
    const props = baseProps({ vaultContext: { type: "org", orgId: "org-1" } });
    render(<SidebarContent {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "create-folder" }));

    expect(props.onCreateFolder).toHaveBeenCalledWith("org-1");
  });

  it("calls onCreateTag without orgId in personal context", () => {
    const props = baseProps({ vaultContext: { type: "personal" } });
    render(<SidebarContent {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "create-tag" }));

    expect(props.onCreateTag).toHaveBeenCalledWith();
  });

  it("calls onCreateTag with orgId in org context", () => {
    const props = baseProps({ vaultContext: { type: "org", orgId: "org-1" } });
    render(<SidebarContent {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "create-tag" }));

    expect(props.onCreateTag).toHaveBeenCalledWith("org-1");
  });
});
