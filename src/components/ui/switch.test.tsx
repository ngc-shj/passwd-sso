// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Switch } from "./switch";

describe("Switch", () => {
  it("renders a switch with the data-slot attribute", () => {
    render(<Switch aria-label="enable" />);

    const sw = screen.getByRole("switch", { name: "enable" });
    expect(sw).toBeInTheDocument();
    expect(sw).toHaveAttribute("data-slot", "switch");
    expect(sw).toHaveAttribute("data-size", "default");
  });

  it("invokes onCheckedChange when clicked", async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();
    render(<Switch onCheckedChange={onCheckedChange} aria-label="toggle" />);

    await user.click(screen.getByRole("switch", { name: "toggle" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  // R26 — disabled-state visual cue. Radix sets data-disabled on the root.
  it("renders disabled with a visible cue", () => {
    render(<Switch disabled aria-label="t" />);

    const sw = screen.getByRole("switch", { name: "t" });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute("data-disabled");
  });

  it("supports the sm size variant", () => {
    render(<Switch size="sm" aria-label="t" />);

    expect(screen.getByRole("switch", { name: "t" })).toHaveAttribute(
      "data-size",
      "sm",
    );
  });
});
