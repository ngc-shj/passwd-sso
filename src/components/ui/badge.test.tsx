// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

import { Badge } from "./badge";

describe("Badge", () => {
  it("renders children with default variant", () => {
    render(<Badge>New</Badge>);

    const badge = screen.getByText("New");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("data-slot", "badge");
    expect(badge).toHaveAttribute("data-variant", "default");
  });

  it("applies the destructive variant via data-variant", () => {
    render(<Badge variant="destructive">Error</Badge>);

    expect(screen.getByText("Error")).toHaveAttribute(
      "data-variant",
      "destructive",
    );
  });

  it("renders as a child element when asChild is true", () => {
    render(
      <Badge asChild>
        <a href="/x">Link</a>
      </Badge>,
    );

    const link = screen.getByRole("link", { name: "Link" });
    expect(link).toHaveAttribute("data-slot", "badge");
    expect(link).toHaveAttribute("href", "/x");
  });
});
