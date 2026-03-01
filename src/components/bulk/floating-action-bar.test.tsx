// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FloatingActionBar } from "@/components/bulk/floating-action-bar";

describe("FloatingActionBar", () => {
  it("renders null when visible is false", () => {
    const { container } = render(
      <FloatingActionBar visible={false} position="sticky">
        <button>action</button>
      </FloatingActionBar>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders children when visible is true (sticky)", () => {
    const { getByText } = render(
      <FloatingActionBar visible={true} position="sticky">
        <button>action</button>
      </FloatingActionBar>,
    );
    expect(getByText("action")).toBeDefined();
  });

  it("renders children when visible is true (fixed)", () => {
    const { getByText } = render(
      <FloatingActionBar visible={true} position="fixed">
        <button>action</button>
      </FloatingActionBar>,
    );
    expect(getByText("action")).toBeDefined();
  });

  it("uses sticky class for sticky position", () => {
    const { container } = render(
      <FloatingActionBar visible={true} position="sticky">
        <button>action</button>
      </FloatingActionBar>,
    );
    expect(container.querySelector(".sticky")).not.toBeNull();
  });

  it("uses fixed class for fixed position", () => {
    const { container } = render(
      <FloatingActionBar visible={true} position="fixed">
        <button>action</button>
      </FloatingActionBar>,
    );
    expect(container.querySelector(".fixed")).not.toBeNull();
  });
});
