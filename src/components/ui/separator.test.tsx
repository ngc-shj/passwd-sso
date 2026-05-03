// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

import { Separator } from "./separator";

describe("Separator", () => {
  it("renders horizontally by default", () => {
    render(<Separator data-testid="sep" />);

    const sep = screen.getByTestId("sep");
    expect(sep).toHaveAttribute("data-slot", "separator");
    expect(sep).toHaveAttribute("data-orientation", "horizontal");
  });

  it("renders vertically when orientation is 'vertical'", () => {
    render(<Separator orientation="vertical" data-testid="sep" />);

    expect(screen.getByTestId("sep")).toHaveAttribute(
      "data-orientation",
      "vertical",
    );
  });
});
