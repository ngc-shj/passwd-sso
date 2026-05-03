// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

import { AppIcon } from "./app-icon";

describe("AppIcon", () => {
  it("renders an SVG with the passwd-sso accessible name", () => {
    render(<AppIcon />);

    const svg = screen.getByRole("img", { name: "passwd-sso" });
    expect(svg.tagName.toLowerCase()).toBe("svg");
  });

  it("forwards SVG props to the root element", () => {
    render(<AppIcon className="custom-class" data-testid="app-icon" width={64} />);

    const svg = screen.getByTestId("app-icon");
    expect(svg).toHaveClass("custom-class");
    expect(svg).toHaveAttribute("width", "64");
  });
});
