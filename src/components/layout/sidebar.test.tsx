// @vitest-environment jsdom
/**
 * Sidebar — orchestrator smoke test
 *
 * The sidebar composes ~6 hooks + sub-components. The granular logic lives
 * in the underlying hooks (already tested via use-sidebar-* sibling tests)
 * and SidebarContent (sidebar-content.test.tsx). This test verifies
 * orchestration: dialogs render at the right times, mobile sheet opens on
 * the `open` prop, dialogs route to the right consumer hooks.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  mockNextNavigation,
  mockI18nNavigation,
} from "@/__tests__/helpers/mock-app-navigation";

const {
  mockUseSidebarData,
  mockUseSidebarFolderCrud,
  mockUseSidebarTagCrud,
  mockUseSidebarNavigationState,
  mockUseSidebarSectionsState,
  mockUseSidebarViewModel,
  mockUseTeamVaultContext,
  mockUseSetActiveVault,
  mockUseTenantRole,
} = vi.hoisted(() => ({
  mockUseSidebarData: vi.fn(),
  mockUseSidebarFolderCrud: vi.fn(),
  mockUseSidebarTagCrud: vi.fn(),
  mockUseSidebarNavigationState: vi.fn(),
  mockUseSidebarSectionsState: vi.fn(),
  mockUseSidebarViewModel: vi.fn(),
  mockUseTeamVaultContext: vi.fn(),
  mockUseSetActiveVault: vi.fn(),
  mockUseTenantRole: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

vi.mock("next/navigation", () => mockNextNavigation());
vi.mock("@/i18n/navigation", () => mockI18nNavigation());

vi.mock("@/hooks/sidebar/use-sidebar-data", () => ({
  useSidebarData: () => mockUseSidebarData(),
}));
vi.mock("@/hooks/sidebar/use-sidebar-folder-crud", () => ({
  useSidebarFolderCrud: () => mockUseSidebarFolderCrud(),
}));
vi.mock("@/hooks/sidebar/use-sidebar-tag-crud", () => ({
  useSidebarTagCrud: () => mockUseSidebarTagCrud(),
}));
vi.mock("@/hooks/sidebar/use-sidebar-navigation-state", () => ({
  useSidebarNavigationState: () => mockUseSidebarNavigationState(),
}));
vi.mock("@/hooks/sidebar/use-sidebar-sections-state", () => ({
  useSidebarSectionsState: () => mockUseSidebarSectionsState(),
}));
vi.mock("@/hooks/sidebar/use-sidebar-view-model", () => ({
  useSidebarViewModel: () => mockUseSidebarViewModel(),
}));
vi.mock("@/hooks/vault/use-vault-context", () => ({
  useTeamVaultContext: () => mockUseTeamVaultContext(),
}));
vi.mock("@/lib/vault/active-vault-context", () => ({
  useSetActiveVault: () => mockUseSetActiveVault(),
}));
vi.mock("@/hooks/use-tenant-role", () => ({
  useTenantRole: () => mockUseTenantRole(),
}));

vi.mock("@/components/layout/sidebar-content", () => ({
  SidebarContent: () => <div data-testid="sidebar-content" />,
}));

vi.mock("@/components/folders/folder-dialog", () => ({
  FolderDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="folder-dialog" /> : null,
}));

vi.mock("@/components/tags/tag-dialog", () => ({
  TagDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="tag-dialog" /> : null,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="sheet">{children}</div> : null),
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("radix-ui", () => ({
  VisuallyHidden: { Root: ({ children }: { children: React.ReactNode }) => <>{children}</> },
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="alert-dialog">{children}</div> : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));

import { Sidebar } from "./sidebar";

function setDefaultMocks() {
  mockUseSidebarData.mockReturnValue({
    tags: [],
    folders: [],
    teams: [],
    teamTagGroups: [],
    teamFolderGroups: [],
    refreshData: vi.fn(),
  });
  mockUseSidebarFolderCrud.mockReturnValue({
    folderDialogOpen: false,
    setFolderDialogOpen: vi.fn(),
    editingFolder: null,
    deletingFolder: null,
    dialogFolders: [],
    handleFolderCreate: vi.fn(),
    handleFolderEdit: vi.fn(),
    handleFolderDeleteClick: vi.fn(),
    handleFolderSubmit: vi.fn(),
    handleFolderDelete: vi.fn(),
    clearDeletingFolder: vi.fn(),
  });
  mockUseSidebarTagCrud.mockReturnValue({
    tagDialogOpen: false,
    setTagDialogOpen: vi.fn(),
    editingTag: null,
    deletingTag: null,
    tagTeamId: null,
    handleTagCreate: vi.fn(),
    handleTagEdit: vi.fn(),
    handleTagDeleteClick: vi.fn(),
    handleTagSubmit: vi.fn(),
    handleTagDelete: vi.fn(),
    clearDeletingTag: vi.fn(),
  });
  mockUseSidebarNavigationState.mockReturnValue({
    isAdminActive: false,
    isTeamsManage: false,
    isSettings: false,
    isExport: false,
    isImport: false,
    isWatchtower: false,
    isShareLinks: false,
    isEmergencyAccess: false,
    isAuditLog: false,
    isPersonalAuditLog: false,
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
    selectedFolders: [],
    selectedTags: [],
  });
  mockUseSidebarSectionsState.mockReturnValue({
    isOpen: () => false,
    toggleSection: vi.fn(),
  });
  mockUseSidebarViewModel.mockReturnValue({});
  mockUseTeamVaultContext.mockReturnValue({ type: "personal" });
  mockUseSetActiveVault.mockReturnValue(vi.fn());
  mockUseTenantRole.mockReturnValue({ isAdmin: false });
}

describe("Sidebar", () => {
  it("renders desktop SidebarContent always; mobile Sheet only when open", () => {
    setDefaultMocks();
    const { rerender } = render(
      <Sidebar open={false} onOpenChange={vi.fn()} />,
    );

    // Two SidebarContent instances are rendered (desktop + sheet template)
    // but the sheet is gated by open=false → only desktop visible.
    expect(screen.getByTestId("sidebar-content")).toBeInTheDocument();
    expect(screen.queryByTestId("sheet")).toBeNull();

    rerender(<Sidebar open={true} onOpenChange={vi.fn()} />);
    expect(screen.getByTestId("sheet")).toBeInTheDocument();
  });

  it("opens FolderDialog when folderDialogOpen is true", () => {
    setDefaultMocks();
    mockUseSidebarFolderCrud.mockReturnValue({
      folderDialogOpen: true,
      setFolderDialogOpen: vi.fn(),
      editingFolder: null,
      deletingFolder: null,
      dialogFolders: [],
      handleFolderCreate: vi.fn(),
      handleFolderEdit: vi.fn(),
      handleFolderDeleteClick: vi.fn(),
      handleFolderSubmit: vi.fn(),
      handleFolderDelete: vi.fn(),
      clearDeletingFolder: vi.fn(),
    });

    render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    expect(screen.getByTestId("folder-dialog")).toBeInTheDocument();
  });

  it("opens TagDialog when tagDialogOpen is true", () => {
    setDefaultMocks();
    mockUseSidebarTagCrud.mockReturnValue({
      tagDialogOpen: true,
      setTagDialogOpen: vi.fn(),
      editingTag: null,
      deletingTag: null,
      tagTeamId: null,
      handleTagCreate: vi.fn(),
      handleTagEdit: vi.fn(),
      handleTagDeleteClick: vi.fn(),
      handleTagSubmit: vi.fn(),
      handleTagDelete: vi.fn(),
      clearDeletingTag: vi.fn(),
    });

    render(<Sidebar open={false} onOpenChange={vi.fn()} />);
    expect(screen.getByTestId("tag-dialog")).toBeInTheDocument();
  });

  it("opens delete confirmation when deletingFolder is set; firing delete calls handleFolderDelete", () => {
    setDefaultMocks();
    const handleFolderDelete = vi.fn();
    mockUseSidebarFolderCrud.mockReturnValue({
      folderDialogOpen: false,
      setFolderDialogOpen: vi.fn(),
      editingFolder: null,
      deletingFolder: { id: "f1", name: "ToDelete" },
      dialogFolders: [],
      handleFolderCreate: vi.fn(),
      handleFolderEdit: vi.fn(),
      handleFolderDeleteClick: vi.fn(),
      handleFolderSubmit: vi.fn(),
      handleFolderDelete,
      clearDeletingFolder: vi.fn(),
    });

    render(<Sidebar open={false} onOpenChange={vi.fn()} />);

    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
    expect(screen.getByText(/folderDeleteConfirm/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("delete"));
    expect(handleFolderDelete).toHaveBeenCalled();
  });
});
