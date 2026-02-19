// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/collapsible", () => ({
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { FolderTreeNode, CollapsibleSectionHeader, SectionLabel } from "./sidebar-shared";

describe("FolderTreeNode", () => {
  it("expands when active folder is a descendant", () => {
    const folders = [
      { id: "parent", name: "Parent", parentId: null, sortOrder: 0, entryCount: 0 },
      { id: "child", name: "Child", parentId: "parent", sortOrder: 1, entryCount: 1 },
    ];

    render(
      <FolderTreeNode
        folder={folders[0]}
        folders={folders}
        activeFolderId="child"
        depth={0}
        linkHref={(id) => `/dashboard?folder=${id}`}
        onNavigate={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: "Collapse Parent" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /Child/ })).toBeInTheDocument();
  });

  it("does not render expand button when node has no children", () => {
    const folders = [
      { id: "leaf", name: "Leaf", parentId: null, sortOrder: 0, entryCount: 0 },
    ];

    render(
      <FolderTreeNode
        folder={folders[0]}
        folders={folders}
        activeFolderId={null}
        depth={0}
        linkHref={(id) => `/dashboard?folder=${id}`}
        onNavigate={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    );

    expect(screen.queryByRole("button", { name: /Expand Leaf|Collapse Leaf/ })).toBeNull();
  });

  it("toggles children visibility by clicking expand button", () => {
    const folders = [
      { id: "parent", name: "Parent", parentId: null, sortOrder: 0, entryCount: 0 },
      { id: "child", name: "Child", parentId: "parent", sortOrder: 1, entryCount: 1 },
    ];

    render(
      <FolderTreeNode
        folder={folders[0]}
        folders={folders}
        activeFolderId={null}
        depth={0}
        linkHref={(id) => `/dashboard?folder=${id}`}
        onNavigate={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    );

    expect(screen.queryByRole("link", { name: /Child/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand Parent" }));
    expect(screen.getByRole("link", { name: /Child/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse Parent" }));
    expect(screen.queryByRole("link", { name: /Child/ })).toBeNull();
  });

  it("invokes edit and delete callbacks from folder menu", () => {
    const folder = { id: "parent", name: "Parent", parentId: null, sortOrder: 0, entryCount: 0 };
    const onEdit = vi.fn();
    const onDelete = vi.fn();

    render(
      <FolderTreeNode
        folder={folder}
        folders={[folder]}
        activeFolderId={null}
        depth={0}
        linkHref={(id) => `/dashboard?folder=${id}`}
        onNavigate={() => {}}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "deleteFolder" }));

    expect(onEdit).toHaveBeenCalledWith(folder);
    expect(onDelete).toHaveBeenCalledWith(folder);
  });

  it("applies depth based padding", () => {
    const folder = { id: "parent", name: "Parent", parentId: null, sortOrder: 0, entryCount: 0 };

    render(
      <FolderTreeNode
        folder={folder}
        folders={[folder]}
        activeFolderId={null}
        depth={2}
        linkHref={(id) => `/dashboard?folder=${id}`}
        onNavigate={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    );

    expect(screen.getByRole("link", { name: /Parent/ }).closest("div")).toHaveStyle({
      paddingLeft: "24px",
    });
  });
});

describe("sidebar shared headers", () => {
  it("renders collapsible header with aria-expanded", () => {
    render(<CollapsibleSectionHeader isOpen>{"section"}</CollapsibleSectionHeader>);
    expect(screen.getByRole("button", { name: /section/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("renders section label", () => {
    render(<SectionLabel>{"label"}</SectionLabel>);
    expect(screen.getByText("label")).toBeInTheDocument();
  });
});
