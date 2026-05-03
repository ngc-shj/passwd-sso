// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/passwords/entry/entry-tags-and-folder-layout", () => ({
  EntryTagsAndFolderLayout: ({
    tagsTitle,
    tagsHint,
    tagsInput,
    folders,
  }: {
    tagsTitle: string;
    tagsHint: string;
    tagsInput: React.ReactNode;
    folders: { id: string; name: string }[];
  }) => (
    <div data-testid="layout">
      <span data-testid="title">{tagsTitle}</span>
      <span data-testid="hint">{tagsHint}</span>
      <span data-testid="folder-count">{folders.length}</span>
      {tagsInput}
    </div>
  ),
}));

vi.mock("@/components/team/forms/team-tag-input", () => ({
  TeamTagInput: ({ teamId }: { teamId: string }) => (
    <div data-testid="tag-input" data-team={teamId} />
  ),
}));

import { TeamTagsAndFolderSection } from "./team-tags-and-folder-section";

describe("TeamTagsAndFolderSection", () => {
  it("renders nothing when teamId is missing", () => {
    const { container } = render(
      <TeamTagsAndFolderSection
        tagsTitle="Tags"
        tagsHint="hint"
        teamId={undefined}
        selectedTags={[]}
        onTagsChange={vi.fn()}
        folders={[]}
        folderId={null}
        onFolderChange={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders layout with tag input wired to teamId when teamId present", () => {
    render(
      <TeamTagsAndFolderSection
        tagsTitle="Tags"
        tagsHint="hint"
        teamId="team-7"
        selectedTags={[]}
        onTagsChange={vi.fn()}
        folders={[
          { id: "f1", name: "Work", parentId: null, sortOrder: 0, entryCount: 0 },
        ]}
        folderId={null}
        onFolderChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("layout")).toBeInTheDocument();
    expect(screen.getByTestId("title")).toHaveTextContent("Tags");
    expect(screen.getByTestId("hint")).toHaveTextContent("hint");
    expect(screen.getByTestId("folder-count")).toHaveTextContent("1");
    expect(screen.getByTestId("tag-input")).toHaveAttribute("data-team", "team-7");
  });
});
