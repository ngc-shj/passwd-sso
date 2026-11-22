// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock("@/i18n/navigation", async () =>
  (await import("@/__tests__/helpers/mock-app-navigation")).mockI18nNavigation(),
);

import NotFound from "./not-found";

describe("NotFound", () => {
  it("shows the not-found title and description", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { name: "NotFound.title" })).toBeInTheDocument();
    expect(screen.getByText("NotFound.description")).toBeInTheDocument();
  });

  it("links back to the dashboard", () => {
    render(<NotFound />);
    expect(screen.getByRole("link", { name: "NotFound.goToDashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });
});
