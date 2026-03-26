// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FloatingActionBar } from "@/components/bulk/floating-action-bar";

describe("FloatingActionBar", () => {
  it("renders null when visible is false", () => {
    const { container } = render(
      <FloatingActionBar visible={false}>
        <button>action</button>
      </FloatingActionBar>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders children when visible is true", () => {
    const { container } = render(
      <FloatingActionBar visible={true}>
        <button>action</button>
      </FloatingActionBar>,
    );
    expect(container.querySelector("button")).not.toBeNull();
  });

  it("uses sticky positioning with bottom-4", () => {
    const { container } = render(
      <FloatingActionBar visible={true}>
        <button>action</button>
      </FloatingActionBar>,
    );
    const bar = container.firstChild as HTMLElement;
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("bottom-4");
  });
});
