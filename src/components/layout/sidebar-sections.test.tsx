// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href, onClick }: { children: React.ReactNode; href: string; onClick?: () => void }) => (
    <a href={href} onClick={onClick}>{children}</a>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, asChild, ...rest }: React.ComponentProps<"button"> & { asChild?: boolean }) =>
    asChild ? <>{children}</> : <button {...rest}>{children}</button>,
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

vi.mock("@/components/layout/sidebar-shared", () => ({
  CollapsibleSectionHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  FolderTreeNode: ({ folder }: { folder: { name: string } }) => <div>{folder.name}</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/lib/dynamic-styles", () => ({
  getTagColorClass: () => "",
}));

import {
  VaultManagementSection,
  OrganizeSection,
} from "./sidebar-sections";

describe("VaultManagementSection", () => {
  it("renders personal links", () => {
    render(
      <VaultManagementSection
        t={(k) => k}
        vaultContext={{ type: "personal" }}
        isSelectedVaultArchive={false}
        isSelectedVaultTrash={false}
        isShareLinks={false}
        isPersonalAuditLog={false}
        activeAuditOrgId={null}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "archive" })).toHaveAttribute("href", "/dashboard/archive");
    expect(screen.getByRole("link", { name: "trash" })).toHaveAttribute("href", "/dashboard/trash");
    expect(screen.getByRole("link", { name: "shareLinks" })).toHaveAttribute("href", "/dashboard/share-links");
    expect(screen.getByRole("link", { name: "auditLog" })).toHaveAttribute("href", "/dashboard/audit-logs");
  });

  it("renders org scoped links", () => {
    render(
      <VaultManagementSection
        t={(k) => k}
        vaultContext={{ type: "org", orgId: "org-1" }}
        isSelectedVaultArchive={false}
        isSelectedVaultTrash={false}
        isShareLinks={false}
        isPersonalAuditLog={false}
        activeAuditOrgId="org-1"
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "archive" })).toHaveAttribute("href", "/dashboard/orgs/org-1?scope=archive");
    expect(screen.getByRole("link", { name: "trash" })).toHaveAttribute("href", "/dashboard/orgs/org-1?scope=trash");
    expect(screen.getByRole("link", { name: "shareLinks" })).toHaveAttribute("href", "/dashboard/share-links?org=org-1");
    expect(screen.getByRole("link", { name: "auditLog" })).toHaveAttribute("href", "/dashboard/orgs/org-1/audit-logs");
  });
});

describe("OrganizeSection", () => {
  it("calls onCreateFolder when plus button is clicked", () => {
    const onCreateFolder = vi.fn();

    render(
      <OrganizeSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        canCreateFolder
        folders={[]}
        activeFolderId={null}
        linkHref={() => "/dashboard"}
        showFolderMenu={false}
        tags={[]}
        activeTagId={null}
        tagHref={() => "/dashboard"}
        onCreateFolder={onCreateFolder}
        onEditFolder={() => {}}
        onDeleteFolder={() => {}}
        onEditTag={() => {}}
        onDeleteTag={() => {}}
        showTagMenu
        onNavigate={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "createFolder" }));
    expect(onCreateFolder).toHaveBeenCalledTimes(1);
  });
});
