// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Shield, Globe } from "lucide-react";

vi.mock("@/components/settings/account/section-nav", () => ({
  SectionNav: ({
    items,
  }: {
    items: Array<{ href: string; label: string }>;
  }) => (
    <nav data-testid="section-nav">
      {items.map((item) => (
        <a key={item.href} href={item.href}>
          {item.label}
        </a>
      ))}
    </nav>
  ),
}));

import { SectionLayout } from "./section-layout";

describe("SectionLayout", () => {
  it("renders title, description, and children", () => {
    render(
      <SectionLayout
        icon={Shield}
        title="Account"
        description="Account settings"
      >
        <div>Body content</div>
      </SectionLayout>,
    );
    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByText("Account settings")).toBeInTheDocument();
    expect(screen.getByText("Body content")).toBeInTheDocument();
  });

  it("does not render description when omitted", () => {
    render(
      <SectionLayout icon={Shield} title="Account">
        <div>Body</div>
      </SectionLayout>,
    );
    expect(screen.queryByText("Account settings")).toBeNull();
  });

  it("renders SectionNav when navItems is non-empty", () => {
    render(
      <SectionLayout
        icon={Shield}
        title="Account"
        navItems={[
          { href: "/a", label: "Tab A", icon: Globe },
          { href: "/b", label: "Tab B", icon: Globe },
        ]}
      >
        <div>Body</div>
      </SectionLayout>,
    );
    expect(screen.getByTestId("section-nav")).toBeInTheDocument();
    expect(screen.getByText("Tab A")).toBeInTheDocument();
    expect(screen.getByText("Tab B")).toBeInTheDocument();
  });

  it("does not render SectionNav when navItems is empty", () => {
    render(
      <SectionLayout icon={Shield} title="Account" navItems={[]}>
        <div>Body</div>
      </SectionLayout>,
    );
    expect(screen.queryByTestId("section-nav")).toBeNull();
  });

  it("renders headerExtra when provided", () => {
    render(
      <SectionLayout
        icon={Shield}
        title="Account"
        headerExtra={<button>Action</button>}
      >
        <div>Body</div>
      </SectionLayout>,
    );
    expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument();
  });
});
