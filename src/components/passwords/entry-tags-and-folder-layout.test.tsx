// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { FolderLike } from "@/components/passwords/folder-like";
import { EntryTagsAndFolderLayout } from "@/components/passwords/entry-tags-and-folder-layout";

const tagsSectionMock = vi.fn();
const folderSectionMock = vi.fn();

vi.mock("@/components/passwords/entry-tags-section", () => ({
  EntryTagsSection: (props: {
    title: string;
    hint: string;
    sectionCardClass?: string;
    children: ReactNode;
  }) => {
    tagsSectionMock(props);
    return <div data-testid="tags-section">{props.children}</div>;
  },
}));

vi.mock("@/components/passwords/entry-folder-select-section", () => ({
  EntryFolderSelectSection: (props: {
    folders: FolderLike[];
    value: string | null;
    onChange: (next: string | null) => void;
    sectionCardClass?: string;
  }) => {
    folderSectionMock(props);
    return <div data-testid="folder-section" />;
  },
}));

describe("EntryTagsAndFolderLayout", () => {
  it("renders tags and folder sections with forwarded props", () => {
    const onFolderChange = vi.fn();
    const folders = [{ id: "f1", name: "Folder", parentId: null }];

    render(
      <EntryTagsAndFolderLayout
        tagsTitle="Tags"
        tagsHint="Hint"
        tagsInput={<div data-testid="tags-input">input</div>}
        folders={folders}
        folderId="f1"
        onFolderChange={onFolderChange}
        sectionCardClass="flat"
      />,
    );

    expect(screen.getByTestId("tags-section")).toBeTruthy();
    expect(screen.getByTestId("folder-section")).toBeTruthy();
    expect(screen.getByTestId("tags-input")).toBeTruthy();

    expect(tagsSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Tags",
        hint: "Hint",
        sectionCardClass: "flat",
      }),
    );
    expect(folderSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        folders,
        value: "f1",
        sectionCardClass: "flat",
      }),
    );
  });
});
