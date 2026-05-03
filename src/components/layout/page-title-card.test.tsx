// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: React.ComponentProps<"div">) => (
    <div className={className}>{children}</div>
  ),
}));

import { PageTitleCard } from "./page-title-card";

describe("PageTitleCard", () => {
  it("renders icon and title", () => {
    render(
      <PageTitleCard
        icon={<span data-testid="icon">icon</span>}
        title="My Page"
      />,
    );

    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /My Page/ })).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(
      <PageTitleCard
        icon={<span>icon</span>}
        title="Title"
        description="some description"
      />,
    );

    expect(screen.getByText("some description")).toBeInTheDocument();
  });

  it("does not render a description paragraph when omitted", () => {
    render(<PageTitleCard icon={<span>icon</span>} title="Title" />);
    expect(screen.queryByText(/description/)).toBeNull();
  });
});
