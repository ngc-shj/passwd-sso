// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));

import { Toaster } from "./sonner";

describe("Toaster", () => {
  it("renders the sonner toaster region without throwing", () => {
    const { container } = render(<Toaster />);

    // The sonner library renders an "ol" role="region" landmark for toasts.
    // We assert at least one section/element was emitted.
    expect(container.querySelector("section, ol")).not.toBeNull();
  });
});
