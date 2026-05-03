// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button } from "./button";

describe("Button", () => {
  it("renders a button with the given children", () => {
    render(<Button>Save</Button>);

    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("data-slot", "button");
    expect(btn).toHaveAttribute("data-variant", "default");
    expect(btn).toHaveAttribute("data-size", "default");
  });

  it("applies variant and size as data attributes", () => {
    render(
      <Button variant="destructive" size="sm">
        Delete
      </Button>,
    );

    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn).toHaveAttribute("data-variant", "destructive");
    expect(btn).toHaveAttribute("data-size", "sm");
  });

  it("invokes onClick when clicked", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Click</Button>);

    await user.click(screen.getByRole("button", { name: "Click" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // R26 — disabled-state visual cue (Tailwind class `disabled:opacity-50` +
  // `disabled:pointer-events-none` are both encoded in buttonVariants).
  it("renders disabled with a visible cue when disabled is true", () => {
    render(<Button disabled>Submit</Button>);

    const btn = screen.getByRole("button", { name: "Submit" });
    expect(btn).toBeDisabled();
    expect(btn.className).toMatch(/disabled:opacity-/);
    expect(btn.className).toMatch(/disabled:pointer-events-none/);
  });

  it("does not invoke onClick while disabled", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button onClick={onClick} disabled>
        Disabled
      </Button>,
    );

    await user.click(screen.getByRole("button", { name: "Disabled" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders as a child element when asChild is true", () => {
    render(
      <Button asChild>
        {/* External URL avoids @next/next/no-html-link-for-pages — test verifies Slot.Root forwarding, not actual nav */}
        <a href="https://example.com/dest">Anchor</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Anchor" });
    expect(link).toHaveAttribute("data-slot", "button");
    expect(link).toHaveAttribute("href", "https://example.com/dest");
  });
});
