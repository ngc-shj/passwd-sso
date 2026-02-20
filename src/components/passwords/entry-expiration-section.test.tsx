// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryExpirationSection } from "@/components/passwords/entry-expiration-section";

describe("EntryExpirationSection", () => {
  it("renders title and description", () => {
    render(
      <EntryExpirationSection
        value={null}
        onChange={vi.fn()}
        title="Expiration Date"
        description="Set a reminder date"
      />,
    );

    expect(screen.getByText("Expiration Date")).toBeTruthy();
    expect(screen.getByText("Set a reminder date")).toBeTruthy();
  });

  it("displays date input with current value", () => {
    render(
      <EntryExpirationSection
        value="2026-06-01T00:00:00.000Z"
        onChange={vi.fn()}
        title="Expiration"
        description="desc"
      />,
    );

    const input = screen.getByDisplayValue("2026-06-01");
    expect(input).toBeTruthy();
  });

  it("calls onChange with ISO string when date is selected", () => {
    const onChange = vi.fn();
    render(
      <EntryExpirationSection
        value={null}
        onChange={onChange}
        title="Expiration"
        description="desc"
      />,
    );

    const input = document.querySelector("input[type='date']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-07-15" } });
    expect(onChange).toHaveBeenCalledWith("2026-07-15T00:00:00.000Z");
  });

  it("calls onChange with null when date is cleared via input", () => {
    const onChange = vi.fn();
    render(
      <EntryExpirationSection
        value="2026-06-01T00:00:00.000Z"
        onChange={onChange}
        title="Expiration"
        description="desc"
      />,
    );

    const input = document.querySelector("input[type='date']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows clear button when value is set and clears on click", () => {
    const onChange = vi.fn();
    render(
      <EntryExpirationSection
        value="2026-06-01T00:00:00.000Z"
        onChange={onChange}
        title="Expiration"
        description="desc"
      />,
    );

    // The X clear button should be visible
    const clearBtn = screen.getByRole("button");
    expect(clearBtn).toBeTruthy();
    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("does not show clear button when value is null", () => {
    render(
      <EntryExpirationSection
        value={null}
        onChange={vi.fn()}
        title="Expiration"
        description="desc"
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sets min attribute to today's local date", () => {
    render(
      <EntryExpirationSection
        value={null}
        onChange={vi.fn()}
        title="Expiration"
        description="desc"
      />,
    );

    const input = document.querySelector("input[type='date']") as HTMLInputElement;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(input.min).toBe(today);
  });
});
