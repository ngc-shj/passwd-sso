// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/components/ui/button", () => ({
  // The component uses asChild → wraps the Link directly. Render children.
  Button: ({ children, variant }: React.ComponentProps<"button"> & { variant?: string }) => (
    <span data-variant={variant}>{children}</span>
  ),
}));

// next/link mock — render plain anchor that propagates onClick
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    href,
    children,
    onClick,
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}));

import { FolderTree, type FolderItem } from "./folder-tree";

const flat: FolderItem[] = [
  { id: "f1", name: "Work", parentId: null, sortOrder: 0, entryCount: 3 },
  { id: "f2", name: "Subfolder", parentId: "f1", sortOrder: 1, entryCount: 0 },
  { id: "f3", name: "Personal", parentId: null, sortOrder: 2, entryCount: 1 },
];

describe("FolderTree", () => {
  it("returns null when there are no folders", () => {
    const { container } = render(
      <FolderTree folders={[]} activeFolderId={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders root folders", () => {
    render(<FolderTree folders={flat} activeFolderId={null} />);

    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
  });

  it("renders child folders nested under parents", () => {
    render(<FolderTree folders={flat} activeFolderId={null} />);
    expect(screen.getByText("Subfolder")).toBeInTheDocument();
  });

  it("renders entry count for folders that have entries", () => {
    render(<FolderTree folders={flat} activeFolderId={null} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("highlights active folder via secondary variant", () => {
    render(<FolderTree folders={flat} activeFolderId="f1" />);

    const wrappers = screen
      .getAllByText(/Work|Personal|Subfolder/)
      .map((el) => el.closest("[data-variant]"));

    const activeWrapper = wrappers.find((w) => w?.getAttribute("data-variant") === "secondary");
    expect(activeWrapper).toBeTruthy();
  });

  it("calls onNavigate when a link is clicked", () => {
    const onNavigate = vi.fn();
    render(<FolderTree folders={flat} activeFolderId={null} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText("Work"));
    expect(onNavigate).toHaveBeenCalled();
  });

  it("uses correct dashboard href for each folder link", () => {
    render(<FolderTree folders={flat} activeFolderId={null} />);

    const workLink = screen.getByText("Work").closest("a");
    expect(workLink).toHaveAttribute("href", "/dashboard/folders/f1");

    const subLink = screen.getByText("Subfolder").closest("a");
    expect(subLink).toHaveAttribute("href", "/dashboard/folders/f2");
  });

  it("treats folders whose parentId references a missing folder as roots (orphan tolerance)", () => {
    const withOrphan: FolderItem[] = [
      { id: "f1", name: "Visible", parentId: null, sortOrder: 0, entryCount: 0 },
      { id: "orphan", name: "Orphan", parentId: "missing-parent", sortOrder: 1, entryCount: 0 },
    ];
    render(<FolderTree folders={withOrphan} activeFolderId={null} />);

    expect(screen.getByText("Orphan")).toBeInTheDocument();
  });
});
