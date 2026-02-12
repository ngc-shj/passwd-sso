/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Toast } from "../../popup/components/Toast";

describe("Toast", () => {
  it("does not render when hidden", () => {
    render(<Toast message="Hi" visible={false} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders success toast", () => {
    render(<Toast message="Saved" visible type="success" />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("renders error toast", () => {
    render(<Toast message="Failed" visible type="error" />);
    expect(screen.getByRole("status")).toHaveTextContent("Failed");
  });
});
