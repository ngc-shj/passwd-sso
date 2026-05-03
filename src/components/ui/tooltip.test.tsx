// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

// Radix Tooltip relies on ResizeObserver, which jsdom does not implement.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

describe("Tooltip", () => {
  it("renders the trigger and exposes content when forced open", () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>hover me</TooltipTrigger>
          <TooltipContent>Helpful hint</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(
      screen.getByRole("button", { name: "hover me" }),
    ).toHaveAttribute("data-slot", "tooltip-trigger");

    // Tooltip content renders both visually-positioned content and a sr-only
    // copy with role="tooltip". The role-based query is unambiguous.
    expect(screen.getByRole("tooltip")).toHaveTextContent("Helpful hint");
  });

  it("hides content while closed", () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>hover</TooltipTrigger>
          <TooltipContent>Hidden</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
  });
});
