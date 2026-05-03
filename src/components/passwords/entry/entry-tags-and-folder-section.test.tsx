// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

const layoutMock = vi.fn();
const tagInputMock = vi.fn();

vi.mock("@/components/passwords/entry/entry-tags-and-folder-layout", () => ({
  EntryTagsAndFolderLayout: (props: Record<string, unknown>) => {
    layoutMock(props);
    return <div data-testid="layout" />;
  },
}));

vi.mock("@/components/tags/tag-input", () => ({
  TagInput: (props: Record<string, unknown>) => {
    tagInputMock(props);
    return <div data-testid="tag-input" />;
  },
}));

import type { ReactElement } from "react";

import { EntryTagsAndFolderSection } from "./entry-tags-and-folder-section";

describe("EntryTagsAndFolderSection", () => {
  it("forwards props to layout and wires TagInput as tagsInput", () => {
    const onTagsChange = vi.fn();
    const onFolderChange = vi.fn();
    const folders = [{ id: "f1", name: "F", parentId: null }];
    const selectedTags = [{ id: "t1", name: "x", color: null }];

    render(
      <EntryTagsAndFolderSection
        tagsTitle="Tags"
        tagsHint="Hint"
        selectedTags={selectedTags}
        onTagsChange={onTagsChange}
        folders={folders}
        folderId="f1"
        onFolderChange={onFolderChange}
        sectionCardClass="flat"
      />,
    );

    expect(screen.getByTestId("layout")).toBeInTheDocument();
    expect(layoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tagsTitle: "Tags",
        tagsHint: "Hint",
        folders,
        folderId: "f1",
        sectionCardClass: "flat",
      }),
    );
    // The mocked layout doesn't render tagsInput, so TagInput is never invoked.
    // Instead we inspect the React element passed as `tagsInput` prop.
    const layoutArgs = layoutMock.mock.calls[0][0] as { tagsInput: ReactElement };
    const tagsInputProps = layoutArgs.tagsInput.props as {
      selectedTags: typeof selectedTags;
      onChange: typeof onTagsChange;
    };
    expect(tagsInputProps.selectedTags).toBe(selectedTags);
    expect(tagsInputProps.onChange).toBe(onTagsChange);
  });
});
