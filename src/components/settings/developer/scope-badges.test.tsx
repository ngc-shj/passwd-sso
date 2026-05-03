// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ScopeBadges } from "./scope-badges";

describe("ScopeBadges", () => {
  it("renders nothing when scopes is empty", () => {
    const { container } = render(<ScopeBadges scopes="" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders all scopes when count is at or below limit", () => {
    render(<ScopeBadges scopes="read,list,status" />);
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText("list")).toBeInTheDocument();
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it("renders +N indicator when scope count exceeds display limit", () => {
    render(<ScopeBadges scopes="a,b,c,d,e" />);
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText("c")).toBeInTheDocument();
    expect(screen.queryByText("d")).toBeNull();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("expands the hidden scopes when +N is clicked", () => {
    render(<ScopeBadges scopes="a,b,c,d,e" />);
    fireEvent.click(screen.getByText("+2"));
    expect(screen.getByText("d")).toBeInTheDocument();
    expect(screen.getByText("e")).toBeInTheDocument();
  });

  it("supports a custom separator", () => {
    render(<ScopeBadges scopes="a b c" separator=" " />);
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText("c")).toBeInTheDocument();
  });
});
