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

vi.mock("@/components/layout/sidebar-shared", () => ({
  CollapsibleSectionHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  FolderTreeNode: ({ folder }: { folder: { name: string } }) => <div>{folder.name}</div>,
  TagTreeNode: ({ tag, showMenu, onEdit, onDelete }: { tag: { id: string; name: string }; showMenu?: boolean; onEdit: (t: unknown) => void; onDelete: (t: unknown) => void }) => (
    <div>
      <span>{tag.name}</span>
      {showMenu !== false && (
        <>
          <button type="button" onClick={() => onEdit(tag)}>editTag</button>
          <button type="button" onClick={() => onDelete(tag)}>deleteTag</button>
        </>
      )}
    </div>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/lib/ui/dynamic-styles", () => ({
  getTagColorClass: () => "",
}));

import {
  CategoriesSection,
  VaultSection,
  VaultManagementSection,
  FoldersSection,
  TagsSection,
} from "./sidebar-sections";

describe("VaultSection", () => {
  it("renders personal vault links", () => {
    render(
      <VaultSection
        t={(k) => k}
        vaultContext={{ type: "personal" }}
        isSelectedVaultAll
        isSelectedVaultFavorites={false}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "passwords" })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: "favorites" })).toHaveAttribute("href", "/dashboard/favorites");
  });

  it("renders team vault links", () => {
    render(
      <VaultSection
        t={(k) => k}
        vaultContext={{ type: "team", teamId: "team-1" }}
        isSelectedVaultAll={false}
        isSelectedVaultFavorites
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "passwords" })).toHaveAttribute("href", "/dashboard/teams/team-1");
    expect(screen.getByRole("link", { name: "favorites" })).toHaveAttribute(
      "href",
      "/dashboard/teams/team-1?scope=favorites"
    );
  });
});

describe("CategoriesSection", () => {
  it("renders all category links with personal scope", () => {
    render(
      <CategoriesSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        vaultContext={{ type: "personal" }}
        selectedTypeFilter={null}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "catLogin" })).toHaveAttribute("href", "/dashboard?type=LOGIN");
    expect(screen.getByRole("link", { name: "catSecureNote" })).toHaveAttribute("href", "/dashboard?type=SECURE_NOTE");
    expect(screen.getByRole("link", { name: "catCreditCard" })).toHaveAttribute("href", "/dashboard?type=CREDIT_CARD");
    expect(screen.getByRole("link", { name: "catIdentity" })).toHaveAttribute("href", "/dashboard?type=IDENTITY");
    expect(screen.getByRole("link", { name: "catPasskey" })).toHaveAttribute("href", "/dashboard?type=PASSKEY");
  });

  it("renders team scoped category links", () => {
    render(
      <CategoriesSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        vaultContext={{ type: "team", teamId: "team-1" }}
        selectedTypeFilter={null}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "catLogin" })).toHaveAttribute(
      "href",
      "/dashboard/teams/team-1?type=LOGIN"
    );
  });
});

describe("VaultManagementSection", () => {
  it("renders personal links", () => {
    render(
      <VaultManagementSection
        t={(k) => k}
        vaultContext={{ type: "personal" }}
        isSelectedVaultArchive={false}
        isSelectedVaultTrash={false}
        isShareLinks={false}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "archive" })).toHaveAttribute("href", "/dashboard/archive");
    expect(screen.getByRole("link", { name: "trash" })).toHaveAttribute("href", "/dashboard/trash");
    expect(screen.getByRole("link", { name: "shareLinks" })).toHaveAttribute("href", "/dashboard/share-links");
    expect(screen.queryByRole("link", { name: "auditLog" })).toBeNull();
  });

  it("renders team scoped links", () => {
    render(
      <VaultManagementSection
        t={(k) => k}
        vaultContext={{ type: "team", teamId: "team-1" }}
        isSelectedVaultArchive={false}
        isSelectedVaultTrash={false}
        isShareLinks={false}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: "archive" })).toHaveAttribute("href", "/dashboard/teams/team-1?scope=archive");
    expect(screen.getByRole("link", { name: "trash" })).toHaveAttribute("href", "/dashboard/teams/team-1?scope=trash");
    expect(screen.getByRole("link", { name: "shareLinks" })).toHaveAttribute("href", "/dashboard/share-links?team=team-1");
  });
});

describe("FoldersSection", () => {
  it("calls onCreate when plus button is clicked", () => {
    const onCreate = vi.fn();

    render(
      <FoldersSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        canCreate
        folders={[]}
        activeFolderId={null}
        linkHref={() => "/dashboard"}
        showMenu={false}
        onCreate={onCreate}
        onEdit={() => {}}
        onDelete={() => {}}
        onNavigate={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "createFolder" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("disables plus button when canCreate is false", () => {
    render(
      <FoldersSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        canCreate={false}
        folders={[]}
        activeFolderId={null}
        linkHref={() => "/dashboard"}
        showMenu={false}
        onCreate={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onNavigate={() => {}}
      />
    );

    expect(screen.getByRole("button")).toBeDisabled();
  });
});

describe("TagsSection", () => {
  it("calls tag menu callbacks", () => {
    const onEditTag = vi.fn();
    const onDeleteTag = vi.fn();

    render(
      <TagsSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        tags={[{ id: "tag-1", name: "work", color: "#111111", parentId: null, count: 2 }]}
        activeTagId={null}
        tagHref={(id) => `/dashboard/tags/${id}`}
        showMenu
        onEdit={onEditTag}
        onDelete={onDeleteTag}
        onNavigate={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "editTag" }));
    fireEvent.click(screen.getByRole("button", { name: "deleteTag" }));

    expect(onEditTag).toHaveBeenCalledWith({ id: "tag-1", name: "work", color: "#111111", parentId: null, count: 2 });
    expect(onDeleteTag).toHaveBeenCalledWith({ id: "tag-1", name: "work", color: "#111111", parentId: null, count: 2 });
  });

  it("renders no create button", () => {
    render(
      <TagsSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        tags={[]}
        activeTagId={null}
        tagHref={() => "/dashboard"}
        showMenu={false}
        onEdit={() => {}}
        onDelete={() => {}}
        onNavigate={() => {}}
      />
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("hides edit/delete menu when showMenu is false", () => {
    render(
      <TagsSection
        isOpen
        onOpenChange={() => {}}
        t={(k) => k}
        tags={[{ id: "tag-1", name: "work", color: "#111111", parentId: null, count: 2 }]}
        activeTagId={null}
        tagHref={(id) => `/dashboard/tags/${id}`}
        showMenu={false}
        onEdit={() => {}}
        onDelete={() => {}}
        onNavigate={() => {}}
      />
    );

    expect(screen.queryByRole("button", { name: "editTag" })).toBeNull();
    expect(screen.queryByRole("button", { name: "deleteTag" })).toBeNull();
  });
});
