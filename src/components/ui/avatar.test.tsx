// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "./avatar";

describe("Avatar", () => {
  it("renders fallback content while no image is available", () => {
    render(
      <Avatar data-testid="avatar">
        <AvatarImage src="https://example.com/x.png" alt="user" />
        <AvatarFallback>AB</AvatarFallback>
      </Avatar>,
    );

    // In jsdom, images do not load — Radix shows the fallback.
    expect(screen.getByText("AB")).toHaveAttribute(
      "data-slot",
      "avatar-fallback",
    );
    expect(screen.getByTestId("avatar")).toHaveAttribute("data-slot", "avatar");
    expect(screen.getByTestId("avatar")).toHaveAttribute("data-size", "default");
  });

  it("propagates the size prop as data-size", () => {
    render(
      <Avatar size="lg" data-testid="avatar">
        <AvatarFallback>CD</AvatarFallback>
      </Avatar>,
    );

    expect(screen.getByTestId("avatar")).toHaveAttribute("data-size", "lg");
  });

  it("renders AvatarBadge as a sibling element", () => {
    render(
      <Avatar>
        <AvatarFallback>EF</AvatarFallback>
        <AvatarBadge data-testid="badge">!</AvatarBadge>
      </Avatar>,
    );

    expect(screen.getByTestId("badge")).toHaveAttribute(
      "data-slot",
      "avatar-badge",
    );
  });

  it("renders AvatarGroup and AvatarGroupCount", () => {
    render(
      <AvatarGroup data-testid="group">
        <Avatar>
          <AvatarFallback>A</AvatarFallback>
        </Avatar>
        <AvatarGroupCount data-testid="count">+3</AvatarGroupCount>
      </AvatarGroup>,
    );

    expect(screen.getByTestId("group")).toHaveAttribute(
      "data-slot",
      "avatar-group",
    );
    expect(screen.getByTestId("count")).toHaveAttribute(
      "data-slot",
      "avatar-group-count",
    );
  });
});
