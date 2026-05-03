// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EntrySortMenu } from "./entry-sort-menu";

const labels = {
  updated: "Updated",
  created: "Created",
  title: "Title",
};

describe("EntrySortMenu", () => {
  it("renders the current label based on sortBy", () => {
    render(
      <EntrySortMenu sortBy="title" onSortByChange={vi.fn()} labels={labels} />,
    );
    expect(screen.getByRole("button", { name: /Title/i })).toBeInTheDocument();
  });

  it("falls back to updated label for sortBy=updatedAt", () => {
    render(
      <EntrySortMenu
        sortBy="updatedAt"
        onSortByChange={vi.fn()}
        labels={labels}
      />,
    );
    expect(screen.getByRole("button", { name: /Updated/i })).toBeInTheDocument();
  });

  it("invokes onSortByChange with the chosen option", async () => {
    const onSortByChange = vi.fn();
    const user = userEvent.setup();

    render(
      <EntrySortMenu
        sortBy="updatedAt"
        onSortByChange={onSortByChange}
        labels={labels}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Updated/i }));
    await user.click(screen.getByRole("menuitem", { name: "Title" }));

    expect(onSortByChange).toHaveBeenCalledWith("title");
  });
});
