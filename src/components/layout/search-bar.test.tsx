// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { SearchBar } from "./search-bar";

describe("SearchBar", () => {
  it("renders placeholder and calls onChange when typing", () => {
    const onChange = vi.fn();
    render(<SearchBar value="" onChange={onChange} />);

    const input = screen.getByPlaceholderText("placeholder");
    fireEvent.change(input, { target: { value: "vault" } });

    expect(onChange).toHaveBeenCalledWith("vault");
  });

  it("shows clear button when value exists and clears on click", () => {
    const onChange = vi.fn();
    render(<SearchBar value="abc" onChange={onChange} />);

    const clearButton = screen.getByRole("button");
    fireEvent.click(clearButton);

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("shows keyboard hint when empty", () => {
    const onChange = vi.fn();
    render(<SearchBar value="" onChange={onChange} />);

    expect(screen.getByText(/K$/)).toBeInTheDocument();
  });
});
