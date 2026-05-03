// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { EntryFolderSelectSection } from "./entry-folder-select-section";

describe("EntryFolderSelectSection", () => {
  it("renders the noFoldersYet message when folders is empty", () => {
    render(
      <EntryFolderSelectSection
        folders={[]}
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("noFoldersYet")).toBeInTheDocument();
  });

  it("renders the select trigger when folders are present", () => {
    render(
      <EntryFolderSelectSection
        folders={[
          { id: "f1", name: "Work", parentId: null },
          { id: "f2", name: "Sub", parentId: "f1" },
        ]}
        value="f1"
        onChange={vi.fn()}
      />,
    );

    // Default value is shown via SelectValue
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});
