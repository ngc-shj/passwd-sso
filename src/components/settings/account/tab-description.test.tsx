// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { TabDescription } from "./tab-description";

describe("TabDescription", () => {
  it("renders children text inside a paragraph", () => {
    render(<TabDescription>Test description text</TabDescription>);
    const p = screen.getByText("Test description text");
    expect(p).toBeInTheDocument();
    expect(p.tagName).toBe("P");
  });
});
