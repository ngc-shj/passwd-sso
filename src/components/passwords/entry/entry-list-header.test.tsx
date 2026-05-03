// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

import { EntryListHeader } from "./entry-list-header";

describe("EntryListHeader", () => {
  it("renders the title as a heading", () => {
    render(<EntryListHeader title="My Vault" />);
    expect(
      screen.getByRole("heading", { name: "My Vault", level: 1 }),
    ).toBeInTheDocument();
  });

  it("renders subtitle only when showSubtitle is true and subtitle is present", () => {
    const { rerender } = render(
      <EntryListHeader title="X" subtitle="sub" showSubtitle={false} />,
    );
    expect(screen.queryByText("sub")).not.toBeInTheDocument();

    rerender(<EntryListHeader title="X" subtitle="sub" showSubtitle={true} />);
    expect(screen.getByText("sub")).toBeInTheDocument();
  });

  it("renders actions when provided", () => {
    render(
      <EntryListHeader
        title="X"
        actions={<button type="button">Add</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("wraps title in a bdi element when truncateStart is true", () => {
    const { container } = render(
      <EntryListHeader title="My Title" truncateStart />,
    );
    expect(container.querySelector("bdi")).toBeInTheDocument();
  });
});
