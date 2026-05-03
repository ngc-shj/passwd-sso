// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Input } from "./input";

describe("Input", () => {
  it("renders a text input by default", () => {
    render(<Input placeholder="email" />);

    const input = screen.getByPlaceholderText("email");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("data-slot", "input");
  });

  it("forwards the type attribute", () => {
    render(<Input type="password" data-testid="pw" />);

    expect(screen.getByTestId("pw")).toHaveAttribute("type", "password");
  });

  it("invokes onChange when the user types", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Input onChange={onChange} data-testid="x" />);

    await user.type(screen.getByTestId("x"), "abc");
    expect(onChange).toHaveBeenCalled();
    expect((screen.getByTestId("x") as HTMLInputElement).value).toBe("abc");
  });

  // R26 — disabled-state visual cue.
  it("applies a disabled visual cue when disabled", () => {
    render(<Input disabled data-testid="d" />);

    const input = screen.getByTestId("d");
    expect(input).toBeDisabled();
    expect(input.className).toMatch(/disabled:opacity-/);
  });
});
