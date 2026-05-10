// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { TeamScopeOption } from "./team-scope-option";

describe("TeamScopeOption", () => {
  it("renders only the team name for same-tenant teams", () => {
    render(<TeamScopeOption name="Security" tenantName="Home Tenant" isCrossTenant={false} />);

    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.queryByText("Home Tenant")).toBeNull();
  });

  it("renders tenant name for cross-tenant teams", () => {
    render(<TeamScopeOption name="Security" tenantName="Guest Tenant" isCrossTenant />);

    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.getByText("Guest Tenant")).toBeInTheDocument();
  });
});
