// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AuditLogItemRow } from "./audit-log-item-row";

describe("AuditLogItemRow", () => {
  it("renders the action label, timestamp and ip", () => {
    render(
      <AuditLogItemRow
        id="r1"
        icon={<span data-testid="row-icon" />}
        actionLabel="Sign in"
        timestamp="2025-01-01 12:34"
        ip="10.0.0.1"
      />,
    );
    expect(screen.getByText("Sign in")).toBeInTheDocument();
    expect(screen.getByText("2025-01-01 12:34")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.1")).toBeInTheDocument();
    expect(screen.getByTestId("row-icon")).toBeInTheDocument();
  });

  it("renders badges and detail when provided", () => {
    render(
      <AuditLogItemRow
        id="r2"
        icon={<span />}
        actionLabel="Sign in"
        timestamp="-"
        badges={<span data-testid="badge" />}
        detail={<span data-testid="detail" />}
      />,
    );
    expect(screen.getByTestId("badge")).toBeInTheDocument();
    expect(screen.getByTestId("detail")).toBeInTheDocument();
  });

  it("does NOT render an IP paragraph when ip is null/undefined", () => {
    const { container } = render(
      <AuditLogItemRow
        id="r3"
        icon={<span />}
        actionLabel="Action"
        timestamp="-"
        ip={null}
      />,
    );
    // Only one <p> for timestamp; the ip <p> should be absent.
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2); // actionLabel + timestamp
  });
});
