// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
  it("renders a checkbox with the data-slot attribute", () => {
    render(<Checkbox aria-label="agree" />);

    const cb = screen.getByRole("checkbox", { name: "agree" });
    expect(cb).toBeInTheDocument();
    expect(cb).toHaveAttribute("data-slot", "checkbox");
  });

  it("invokes onCheckedChange when clicked", async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Checkbox onCheckedChange={onCheckedChange} aria-label="opt" />,
    );

    await user.click(screen.getByRole("checkbox", { name: "opt" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  // R26 — disabled-state visual cue. Radix sets data-disabled on the root.
  it("renders disabled with a visible cue", () => {
    render(<Checkbox disabled aria-label="opt" />);

    const cb = screen.getByRole("checkbox", { name: "opt" });
    expect(cb).toBeDisabled();
    expect(cb).toHaveAttribute("data-disabled");
  });
});
