// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    className,
    variant,
  }: {
    children: React.ReactNode;
    className?: string;
    variant?: string;
  }) => (
    <span data-testid="badge" data-variant={variant} className={className}>
      {children}
    </span>
  ),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/lib/ui/dynamic-styles", () => ({
  getTagColorClass: (color: string | null) =>
    color ? `tag-color-${color}` : null,
}));

import { TagBadge } from "./tag-badge";

describe("TagBadge", () => {
  it("renders the tag name", () => {
    render(<TagBadge name="work" color={null} />);
    expect(screen.getByText("work")).toBeInTheDocument();
  });

  it("uses outline variant", () => {
    render(<TagBadge name="work" color={null} />);
    expect(screen.getByTestId("badge")).toHaveAttribute("data-variant", "outline");
  });

  it("applies tag-color class when color is provided", () => {
    render(<TagBadge name="urgent" color="red" />);
    const badge = screen.getByTestId("badge");
    expect(badge.className).toContain("tag-color-red");
    expect(badge.className).toContain("tag-color");
  });

  it("does not apply tag-color class when color is null", () => {
    render(<TagBadge name="plain" color={null} />);
    const badge = screen.getByTestId("badge");
    expect(badge.className).not.toContain("tag-color-");
  });
});
