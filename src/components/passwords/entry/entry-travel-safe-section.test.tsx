// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EntryTravelSafeSection } from "./entry-travel-safe-section";

describe("EntryTravelSafeSection", () => {
  it("renders title and description", () => {
    render(
      <EntryTravelSafeSection
        checked={false}
        onCheckedChange={vi.fn()}
        title="Travel safe"
        description="Available offline during travel"
      />,
    );

    expect(screen.getByText("Travel safe")).toBeInTheDocument();
    expect(
      screen.getByText("Available offline during travel"),
    ).toBeInTheDocument();
  });

  it("reflects the checked state via the checkbox role", () => {
    render(
      <EntryTravelSafeSection
        checked={true}
        onCheckedChange={vi.fn()}
        title="t"
        description="d"
      />,
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("data-state", "checked");
  });

  it("calls onCheckedChange when the label is clicked", async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();

    render(
      <EntryTravelSafeSection
        checked={false}
        onCheckedChange={onCheckedChange}
        title="t"
        description="d"
      />,
    );

    await user.click(screen.getByRole("checkbox"));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});
