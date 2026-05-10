// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { InactiveItemsSection } from "./inactive-items-section";

describe("InactiveItemsSection", () => {
  // (a) Renders triggerLabel content as the trigger's accessible name verbatim.
  it("renders the supplied triggerLabel as the trigger's accessible name", () => {
    render(
      <InactiveItemsSection
        triggerLabel="Inactive (3)"
        open={false}
        onOpenChange={vi.fn()}
      >
        <div data-testid="inactive-row">item-1</div>
      </InactiveItemsSection>,
    );

    expect(
      screen.getByRole("button", { name: /Inactive \(3\)/ }),
    ).toBeInTheDocument();
  });

  // (b) Clicking the trigger fires onOpenChange with the toggled value.
  it("calls onOpenChange(true) when clicked while closed", () => {
    const onOpenChange = vi.fn();
    render(
      <InactiveItemsSection
        triggerLabel="Inactive (1)"
        open={false}
        onOpenChange={onOpenChange}
      >
        <div data-testid="inactive-row">item-1</div>
      </InactiveItemsSection>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Inactive \(1\)/ }));

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("calls onOpenChange(false) when clicked while open", () => {
    const onOpenChange = vi.fn();
    render(
      <InactiveItemsSection
        triggerLabel="Inactive (1)"
        open={true}
        onOpenChange={onOpenChange}
      >
        <div data-testid="inactive-row">item-1</div>
      </InactiveItemsSection>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Inactive \(1\)/ }));

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // (c) aria-expanded reflects open.
  it("sets aria-expanded to false when open=false and true when open=true", () => {
    const { rerender } = render(
      <InactiveItemsSection
        triggerLabel="Inactive (2)"
        open={false}
        onOpenChange={vi.fn()}
      >
        <div data-testid="inactive-row">item-1</div>
      </InactiveItemsSection>,
    );

    expect(
      screen.getByRole("button", { name: /Inactive \(2\)/ }),
    ).toHaveAttribute("aria-expanded", "false");

    rerender(
      <InactiveItemsSection
        triggerLabel="Inactive (2)"
        open={true}
        onOpenChange={vi.fn()}
      >
        <div data-testid="inactive-row">item-1</div>
      </InactiveItemsSection>,
    );

    expect(
      screen.getByRole("button", { name: /Inactive \(2\)/ }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  // (d) When open=false, child-marker is not.toBeInTheDocument; when open=true, it is.
  // Radix Collapsible short-circuits via `isOpen && children` — children are not rendered
  // at all when closed, so toBeVisible would throw on a null element; the correct
  // assertion is not.toBeInTheDocument.
  it("does not render children when open=false and renders them when open=true", () => {
    const { rerender } = render(
      <InactiveItemsSection
        triggerLabel="Inactive (1)"
        open={false}
        onOpenChange={vi.fn()}
      >
        <div data-testid="inactive-row">item-1</div>
      </InactiveItemsSection>,
    );

    expect(screen.queryByTestId("inactive-row")).not.toBeInTheDocument();

    rerender(
      <InactiveItemsSection
        triggerLabel="Inactive (1)"
        open={true}
        onOpenChange={vi.fn()}
      >
        <div data-testid="inactive-row">item-1</div>
      </InactiveItemsSection>,
    );

    expect(screen.getByTestId("inactive-row")).toBeInTheDocument();
  });

  // (e) Controlled-open contract: clicking when open=false fires onOpenChange but
  // does NOT internally show children. Children stay hidden until the parent
  // re-renders with open=true. Guards against a future regression that turns
  // the helper uncontrolled.
  it("does not show children after click until parent re-renders with open=true", () => {
    const onOpenChange = vi.fn();
    render(
      <InactiveItemsSection
        triggerLabel="Inactive (1)"
        open={false}
        onOpenChange={onOpenChange}
      >
        <div data-testid="inactive-row">item-1</div>
      </InactiveItemsSection>,
    );

    expect(screen.queryByTestId("inactive-row")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Inactive \(1\)/ }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    // Parent has not re-rendered with open=true yet — children must remain hidden.
    expect(screen.queryByTestId("inactive-row")).not.toBeInTheDocument();
  });

  // (f) Helper does not wrap children in extra list-role wrappers (no <ul>/<ol>/role="list").
  // The caller's a11y semantics for children must pass through unchanged.
  it("does not inject any list-role wrapper around children", () => {
    render(
      <InactiveItemsSection
        triggerLabel="Inactive (1)"
        open={true}
        onOpenChange={vi.fn()}
      >
        <div data-testid="inactive-row">item-1</div>
      </InactiveItemsSection>,
    );

    const child = screen.getByTestId("inactive-row");
    // Walk up from the child marker; if the helper had inserted a <ul>, <ol>,
    // or role="list" wrapper, one of these ancestors would match.
    let ancestor: HTMLElement | null = child.parentElement;
    while (ancestor) {
      const tag = ancestor.tagName;
      const role = ancestor.getAttribute("role");
      expect(tag).not.toBe("UL");
      expect(tag).not.toBe("OL");
      expect(role).not.toBe("list");
      ancestor = ancestor.parentElement;
    }
  });
});
