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

import { FolderTreeNode, TagTreeNode, CollapsibleSectionHeader, SectionLabel } from "./sidebar-shared";
import type { SidebarTeamTagItem } from "@/hooks/sidebar/use-sidebar-data";

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

describe("FolderTreeNode menu and counts", () => {
  const folder = { id: "f1", name: "Work", parentId: null, sortOrder: 0, entryCount: 3 };

  function renderFolder(props: Partial<React.ComponentProps<typeof FolderTreeNode>> = {}) {
    return render(
      <FolderTreeNode
        folder={folder}
        folders={[folder]}
        activeFolderId={null}
        depth={0}
        linkHref={(id) => `/dashboard?folder=${id}`}
        onNavigate={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        {...props}
      />,
    );
  }

  it("shows the entry count next to the folder menu", () => {
    renderFolder();
    expect(screen.getByRole("button", { name: "Work menu" })).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("hides the menu but keeps the count when showMenu is false", () => {
    renderFolder({ showMenu: false });
    expect(screen.queryByRole("button", { name: "Work menu" })).not.toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders neither menu nor count for an empty folder when showMenu is false", () => {
    renderFolder({ showMenu: false, folder: { ...folder, entryCount: 0 } });
    expect(screen.queryByRole("button", { name: "Work menu" })).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("navigates through the folder link", () => {
    const onNavigate = vi.fn();
    renderFolder({ onNavigate });
    const link = screen.getByRole("link", { name: /Work/ });
    expect(link).toHaveAttribute("href", "/dashboard?folder=f1");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("expands children without navigating", () => {
    const onNavigate = vi.fn();
    const child = { id: "f2", name: "Sub", parentId: "f1", sortOrder: 1, entryCount: 0 };
    renderFolder({ folders: [folder, child], onNavigate });

    fireEvent.click(screen.getByRole("button", { name: "Expand Work" }));

    expect(screen.getByRole("link", { name: /Sub/ })).toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("expands every ancestor of a deeply nested active folder", () => {
    const mid = { id: "f2", name: "Mid", parentId: "f1", sortOrder: 1, entryCount: 0 };
    const leaf = { id: "f3", name: "Leaf", parentId: "f2", sortOrder: 2, entryCount: 0 };
    renderFolder({ folders: [folder, mid, leaf], activeFolderId: "f3" });

    expect(screen.getByRole("link", { name: /Leaf/ })).toBeInTheDocument();
  });
});

describe("TagTreeNode", () => {
  const parent: SidebarTeamTagItem = { id: "t1", name: "Infra", color: "#ff0000", parentId: null, count: 2 };
  const child: SidebarTeamTagItem = { id: "t2", name: "DB", color: null, parentId: "t1", count: 0 };
  const grandchild: SidebarTeamTagItem = { id: "t3", name: "Replica", color: null, parentId: "t2", count: 0 };

  function renderTag(props: Partial<React.ComponentProps<typeof TagTreeNode>> = {}) {
    return render(
      <TagTreeNode
        tag={parent}
        tags={[parent, child, grandchild]}
        activeTagId={null}
        depth={0}
        linkHref={(id) => `/dashboard/teams/x?tag=${id}`}
        showMenu
        onNavigate={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        {...props}
      />,
    );
  }

  it("starts collapsed and toggles its children", () => {
    renderTag();
    expect(screen.queryByRole("link", { name: /DB/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand Infra" }));
    expect(screen.getByRole("link", { name: /DB/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse Infra" }));
    expect(screen.queryByRole("link", { name: /DB/ })).toBeNull();
  });

  it("expands every ancestor of a deeply nested active tag", () => {
    renderTag({ activeTagId: "t3" });
    expect(screen.getByRole("button", { name: "Collapse Infra" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /Replica/ })).toBeInTheDocument();
  });

  it("links to the tag and reports navigation", () => {
    const onNavigate = vi.fn();
    renderTag({ onNavigate });
    const link = screen.getByRole("link", { name: /Infra/ });
    expect(link).toHaveAttribute("href", "/dashboard/teams/x?tag=t1");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("invokes edit and delete callbacks from the tag menu", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    renderTag({ tags: [parent], onEdit, onDelete });

    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "deleteTag" }));

    expect(onEdit).toHaveBeenCalledWith(parent);
    expect(onDelete).toHaveBeenCalledWith(parent);
  });

  it("shows the count without a menu when showMenu is false", () => {
    renderTag({ tags: [parent], showMenu: false });
    expect(screen.queryByRole("button", { name: "Infra menu" })).not.toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows the menu and count when showMenu is true", () => {
    renderTag({ tags: [parent] });
    expect(screen.getByRole("button", { name: "Infra menu" })).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders nothing beside an unused tag when showMenu is false", () => {
    const { container } = renderTag({ tag: child, tags: [child], showMenu: false });
    expect(container.querySelector(".w-7")).toBeNull();
  });

  it("applies the tag color class and depth padding", () => {
    renderTag({ tags: [parent], depth: 1 });
    const link = screen.getByRole("link", { name: /Infra/ });
    expect(link.querySelector(".tag-color-ff0000")).not.toBeNull();
    expect(link.closest("div")).toHaveStyle({ paddingLeft: "12px" });
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

  it("marks a closed collapsible header as not expanded", () => {
    render(<CollapsibleSectionHeader isOpen={false}>{"section"}</CollapsibleSectionHeader>);
    expect(screen.getByRole("button", { name: /section/ })).toHaveAttribute("aria-expanded", "false");
  });
});

