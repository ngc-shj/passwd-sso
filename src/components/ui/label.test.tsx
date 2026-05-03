// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

import { Label } from "./label";

describe("Label", () => {
  it("renders children with the data-slot attribute", () => {
    render(<Label>Email</Label>);

    const label = screen.getByText("Email");
    expect(label).toBeInTheDocument();
    expect(label).toHaveAttribute("data-slot", "label");
  });

  it("associates with a control via htmlFor", () => {
    render(
      <>
        <Label htmlFor="email-input">Email</Label>
        <input id="email-input" />
      </>,
    );

    const input = screen.getByLabelText("Email");
    expect(input).toBeInTheDocument();
  });
});
