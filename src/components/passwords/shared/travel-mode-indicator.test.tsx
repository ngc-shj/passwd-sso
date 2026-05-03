// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { TravelModeIndicator } from "./travel-mode-indicator";

describe("TravelModeIndicator", () => {
  it("renders nothing when active is false", () => {
    const { container } = render(<TravelModeIndicator active={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the enabled banner when active is true", () => {
    render(<TravelModeIndicator active={true} />);
    expect(screen.getByText("enabled")).toBeInTheDocument();
  });
});
