// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import DashboardLoading from "./loading";

describe("DashboardLoading", () => {
  it("shows a spinning loader centred in the viewport", () => {
    const { container } = render(<DashboardLoading />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain("h-screen");
    expect(wrapper?.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
  });
});
