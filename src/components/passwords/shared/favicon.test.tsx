// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render } from "@testing-library/react";

import { Favicon } from "./favicon";

describe("Favicon", () => {
  it("renders a globe icon when host is null", () => {
    const { container } = render(<Favicon host={null} />);
    // Lucide icons render as SVG elements
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("renders an img with google favicon URL when host is provided", () => {
    const { container } = render(<Favicon host="example.com" size={32} />);
    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img?.getAttribute("src")).toContain("example.com");
    expect(img?.getAttribute("src")).toContain("sz=64");
    expect(img?.getAttribute("referrerPolicy")).toBe("no-referrer");
  });

  it("falls back to globe icon when img onError fires", () => {
    const { container } = render(<Favicon host="bad.example" />);
    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();

    fireEvent.error(img as HTMLImageElement);

    // After error, img is replaced with svg fallback
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
