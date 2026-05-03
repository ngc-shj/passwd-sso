// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ENTRY_NOTES_MAX } from "@/lib/validations";
import {
  NotesField,
  TwoColumnFields,
  VisibilityToggleInput,
} from "./form-fields";

describe("VisibilityToggleInput", () => {
  it("uses type=password when show=false (R26: hidden state cue)", () => {
    const { container } = render(
      <VisibilityToggleInput
        show={false}
        onToggle={vi.fn()}
        inputProps={{ value: "abc", onChange: () => {} }}
      />,
    );
    expect(container.querySelector("input")).toHaveAttribute("type", "password");
  });

  it("uses type=text when show=true", () => {
    const { container } = render(
      <VisibilityToggleInput
        show={true}
        onToggle={vi.fn()}
        inputProps={{ value: "abc", onChange: () => {} }}
      />,
    );
    expect(container.querySelector("input")).toHaveAttribute("type", "text");
  });

  it("invokes onToggle when the toggle button is clicked", () => {
    const onToggle = vi.fn();
    render(
      <VisibilityToggleInput
        show={false}
        onToggle={onToggle}
        inputProps={{ value: "", onChange: () => {} }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("TwoColumnFields", () => {
  it("renders both left and right children", () => {
    render(
      <TwoColumnFields
        left={<span data-testid="left">L</span>}
        right={<span data-testid="right">R</span>}
      />,
    );
    expect(screen.getByTestId("left")).toBeInTheDocument();
    expect(screen.getByTestId("right")).toBeInTheDocument();
  });
});

describe("NotesField", () => {
  it("renders label, textarea, and propagates onChange (RT3: maxLength == ENTRY_NOTES_MAX)", () => {
    const onChange = vi.fn();
    render(
      <NotesField
        label="Notes"
        value=""
        onChange={onChange}
        placeholder="placeholder"
      />,
    );
    expect(screen.getByText("Notes")).toBeInTheDocument();
    const ta = screen.getByPlaceholderText("placeholder") as HTMLTextAreaElement;
    expect(ta.maxLength).toBe(ENTRY_NOTES_MAX);
    fireEvent.change(ta, { target: { value: "hello" } });
    expect(onChange).toHaveBeenCalledWith("hello");
  });

  it("renders the supplied number of rows (default 3, override 5)", () => {
    const { container } = render(
      <NotesField
        label="Notes"
        value=""
        onChange={vi.fn()}
        placeholder="x"
        rows={5}
      />,
    );
    expect(container.querySelector("textarea")?.rows).toBe(5);
  });
});
