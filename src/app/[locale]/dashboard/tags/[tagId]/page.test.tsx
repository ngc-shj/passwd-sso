// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { Suspense } from "react";

vi.mock("@/components/passwords/detail/password-dashboard", () => ({
  PasswordDashboard: (props: Record<string, unknown>) => (
    <div data-testid="dashboard" data-props={JSON.stringify(props)} />
  ),
}));

import TagPage from "./page";

describe("TagPage", () => {
  it("filters the all-entries view by the tagId in the route", async () => {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <TagPage params={Promise.resolve({ tagId: "x-1" })} />
        </Suspense>,
      );
    });
    const dashboard = await screen.findByTestId("dashboard");
    expect(JSON.parse(dashboard.dataset.props ?? "")).toEqual({ view: "all", tagId: "x-1" });
  });
});
