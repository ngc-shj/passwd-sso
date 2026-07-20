// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { mockMatchMedia } from "@/__tests__/helpers/mock-match-media";
import { DashboardBanner } from "./dashboard-banner";

describe("DashboardBanner", () => {
  beforeEach(() => {
    mockMatchMedia();
  });

  it("uses the master-detail max-width when the viewport is >=1024px", () => {
    mockMatchMedia(true);
    render(
      <DashboardBanner>
        <div data-testid="content" />
      </DashboardBanner>,
    );

    const inner = screen.getByTestId("content").parentElement;
    expect(inner).toHaveClass("max-w-[1024px]");
    expect(inner).not.toHaveClass("max-w-4xl");
  });

  it("uses the accordion max-width when the viewport is <1024px", () => {
    mockMatchMedia(false);
    render(
      <DashboardBanner>
        <div data-testid="content" />
      </DashboardBanner>,
    );

    const inner = screen.getByTestId("content").parentElement;
    expect(inner).toHaveClass("max-w-4xl");
    expect(inner).not.toHaveClass("max-w-[1024px]");
  });
});
