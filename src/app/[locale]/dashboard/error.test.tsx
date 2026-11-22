// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

import DashboardError from "./error";

describe("DashboardError", () => {
  it("shows the generic error message, not the error's own message", () => {
    render(<DashboardError error={new Error("secret internal detail")} reset={vi.fn()} />);
    expect(screen.getByText("Error.somethingWentWrong")).toBeInTheDocument();
    expect(screen.queryByText(/secret internal detail/)).not.toBeInTheDocument();
  });

  it("retries the segment through reset when try-again is clicked", () => {
    const reset = vi.fn();
    render(<DashboardError error={new Error("boom")} reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: "Common.tryAgain" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
