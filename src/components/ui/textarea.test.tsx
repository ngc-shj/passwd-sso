// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Textarea } from "./textarea";

describe("Textarea", () => {
  it("renders a textarea with the given placeholder", () => {
    render(<Textarea placeholder="Notes" />);

    const ta = screen.getByPlaceholderText("Notes");
    expect(ta).toBeInTheDocument();
    expect(ta).toHaveAttribute("data-slot", "textarea");
  });

  it("invokes onChange when the user types", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Textarea onChange={onChange} data-testid="ta" />);

    await user.type(screen.getByTestId("ta"), "hello");
    expect(onChange).toHaveBeenCalled();
    expect((screen.getByTestId("ta") as HTMLTextAreaElement).value).toBe("hello");
  });

  // R26 — disabled-state visual cue.
  it("applies a disabled visual cue when disabled", () => {
    render(<Textarea disabled data-testid="ta" />);

    const ta = screen.getByTestId("ta");
    expect(ta).toBeDisabled();
    expect(ta.className).toMatch(/disabled:opacity-/);
  });
});
