// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

import { EntryTagsSection } from "./entry-tags-section";

describe("EntryTagsSection", () => {
  it("renders title, hint, and children", () => {
    render(
      <EntryTagsSection title="Tags" hint="Pick some tags">
        <input aria-label="tag-input" />
      </EntryTagsSection>,
    );

    expect(screen.getByText("Tags")).toBeInTheDocument();
    expect(screen.getByText("Pick some tags")).toBeInTheDocument();
    expect(screen.getByLabelText("tag-input")).toBeInTheDocument();
  });
});
