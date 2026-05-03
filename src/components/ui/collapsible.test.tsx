// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";

describe("Collapsible", () => {
  it("hides content when closed and shows it after the trigger is clicked", async () => {
    const user = userEvent.setup();
    render(
      <Collapsible>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>Hidden body</CollapsibleContent>
      </Collapsible>,
    );

    // Closed by default; Radix removes content from the DOM (or hides it).
    expect(screen.queryByText("Hidden body")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Toggle" }));

    expect(screen.getByText("Hidden body")).toBeInTheDocument();
  });

  it("renders open by default when defaultOpen is true", () => {
    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>Always</CollapsibleContent>
      </Collapsible>,
    );

    expect(screen.getByText("Always")).toBeInTheDocument();
  });
});
