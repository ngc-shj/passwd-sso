// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
