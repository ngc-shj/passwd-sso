// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { IssueSection, ReusedSection } from "./issue-section";
import type { PasswordIssue, ReusedGroup } from "@/hooks/use-watchtower";

describe("IssueSection", () => {
  const baseProps = {
    type: "breached" as const,
    title: "Breached Passwords",
    description: "Passwords found in data breaches",
    formatDetails: (d: string) => `Detail: ${d}`,
  };

  it("renders title and description", () => {
    render(<IssueSection {...baseProps} issues={[]} />);
    expect(screen.getByText("Breached Passwords")).toBeInTheDocument();
    expect(screen.getByText("Passwords found in data breaches")).toBeInTheDocument();
  });

  it("shows count badge with 0 for no issues", () => {
    render(<IssueSection {...baseProps} issues={[]} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("shows count badge with issue count", () => {
    const issues: PasswordIssue[] = [
      { id: "1", title: "Gmail", username: "user@gmail.com", details: "found", severity: "critical" },
      { id: "2", title: "Twitter", username: null, details: "found", severity: "high" },
    ];
    render(<IssueSection {...baseProps} issues={issues} />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders issue list when expanded (default with issues)", () => {
    const issues: PasswordIssue[] = [
      { id: "1", title: "Gmail", username: "user@gmail.com", details: "breached", severity: "critical" },
    ];
    render(<IssueSection {...baseProps} issues={issues} />);
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("user@gmail.com")).toBeInTheDocument();
    expect(screen.getByText("Detail: breached")).toBeInTheDocument();
  });

  it("hides issue list when collapsed via click", () => {
    const issues: PasswordIssue[] = [
      { id: "1", title: "Gmail", username: "u", details: "d", severity: "critical" },
    ];
    render(<IssueSection {...baseProps} issues={issues} />);
    // Click the toggle button to collapse
    fireEvent.click(screen.getByText("Breached Passwords"));
    expect(screen.queryByText("Detail: d")).toBeNull();
  });

  it("does not render chevron when no issues", () => {
    const { container } = render(<IssueSection {...baseProps} issues={[]} />);
    // No chevron icons in empty state
    expect(container.querySelector("svg.lucide-chevron-down")).toBeNull();
    expect(container.querySelector("svg.lucide-chevron-right")).toBeNull();
  });

  it("does not show username when it is null", () => {
    const issues: PasswordIssue[] = [
      { id: "1", title: "Note", username: null, details: "d", severity: "low" },
    ];
    render(<IssueSection {...baseProps} issues={issues} />);
    expect(screen.getByText("Note")).toBeInTheDocument();
    // Only title and details text, no username paragraph
    const detailTexts = screen.getAllByText(/Detail:/);
    expect(detailTexts.length).toBe(1);
  });
});

describe("ReusedSection", () => {
  const baseProps = {
    title: "Reused Passwords",
    description: "Passwords used across multiple accounts",
    formatCount: (n: number) => `${n} entries share this password`,
  };

  it("renders title and badge count", () => {
    const groups: ReusedGroup[] = [
      {
        hash: "abc",
        entries: [
          { id: "1", title: "Gmail", username: "u1" },
          { id: "2", title: "Twitter", username: "u2" },
        ],
      },
    ];
    render(<ReusedSection {...baseProps} groups={groups} />);
    expect(screen.getByText("Reused Passwords")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument(); // 1 group
  });

  it("renders group entries with formatCount", () => {
    const groups: ReusedGroup[] = [
      {
        hash: "abc",
        entries: [
          { id: "1", title: "Gmail", username: "user1" },
          { id: "2", title: "Twitter", username: null },
        ],
      },
    ];
    render(<ReusedSection {...baseProps} groups={groups} />);
    expect(screen.getByText("2 entries share this password")).toBeInTheDocument();
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("Twitter")).toBeInTheDocument();
    expect(screen.getByText("user1")).toBeInTheDocument();
  });

  it("collapses on click", () => {
    const groups: ReusedGroup[] = [
      { hash: "x", entries: [{ id: "1", title: "Site", username: "u" }] },
    ];
    render(<ReusedSection {...baseProps} groups={groups} />);
    fireEvent.click(screen.getByText("Reused Passwords"));
    expect(screen.queryByText("Site")).toBeNull();
  });

  it("shows 0 badge and no list for empty groups", () => {
    render(<ReusedSection {...baseProps} groups={[]} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
