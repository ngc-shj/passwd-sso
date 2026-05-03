// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

// Radix Slider relies on ResizeObserver, which jsdom does not implement.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { Slider } from "./slider";

describe("Slider", () => {
  it("renders a single thumb when given a scalar default value", () => {
    render(<Slider defaultValue={[50]} min={0} max={100} />);

    const thumb = screen.getByRole("slider");
    expect(thumb).toBeInTheDocument();
    expect(thumb).toHaveAttribute("aria-valuenow", "50");
    expect(thumb).toHaveAttribute("aria-valuemin", "0");
    expect(thumb).toHaveAttribute("aria-valuemax", "100");
    expect(thumb).toHaveAttribute("data-slot", "slider-thumb");
  });

  it("renders multiple thumbs for a range value", () => {
    render(
      <Slider defaultValue={[20, 80]} min={0} max={100} />,
    );

    expect(screen.getAllByRole("slider")).toHaveLength(2);
  });

  // R26 — disabled-state visual cue. Radix sets data-disabled on the root.
  it("renders disabled with a visible cue on the root", () => {
    render(
      <Slider
        disabled
        defaultValue={[10]}
        min={0}
        max={100}
        data-testid="slider"
      />,
    );

    const root = screen.getByTestId("slider");
    expect(root).toHaveAttribute("data-disabled");
  });
});
