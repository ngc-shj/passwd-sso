// @vitest-environment jsdom

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DuplicateSection } from "@/components/watchtower/issue-section";
import type { DuplicateGroup } from "@/hooks/use-watchtower";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("DuplicateSection", () => {
  const groups: DuplicateGroup[] = [
    {
      hostname: "example.com",
      username: "alice",
      entries: [
        { id: "e1", title: "Work Login", username: "alice" },
        { id: "e2", title: "Old Login", username: "alice" },
      ],
    },
  ];

  it("renders title and description", () => {
    render(
      <DuplicateSection
        title="Duplicate Entries"
        description="Multiple entries with same site"
        groups={groups}
        formatCount={(count, hostname) => `${count} entries for ${hostname}`}
      />,
    );

    expect(screen.getByText("Duplicate Entries")).toBeTruthy();
    expect(screen.getByText("Multiple entries with same site")).toBeTruthy();
  });

  it("displays badge with group count", () => {
    render(
      <DuplicateSection
        title="Duplicates"
        description="desc"
        groups={groups}
        formatCount={(count, hostname) => `${count} for ${hostname}`}
      />,
    );

    expect(screen.getByText("1")).toBeTruthy();
  });

  it("displays entry titles and usernames within group", () => {
    render(
      <DuplicateSection
        title="Duplicates"
        description="desc"
        groups={groups}
        formatCount={(count, hostname) => `${count} for ${hostname}`}
      />,
    );

    expect(screen.getByText("Work Login")).toBeTruthy();
    expect(screen.getByText("Old Login")).toBeTruthy();
    expect(screen.getAllByText("alice")).toHaveLength(2);
  });

  it("shows formatted count with hostname", () => {
    render(
      <DuplicateSection
        title="Duplicates"
        description="desc"
        groups={groups}
        formatCount={(count, hostname) => `${count} entries for ${hostname}`}
      />,
    );

    expect(screen.getByText("2 entries for example.com")).toBeTruthy();
  });

  it("renders badge 0 when no groups", () => {
    render(
      <DuplicateSection
        title="Duplicates"
        description="desc"
        groups={[]}
        formatCount={(count, hostname) => `${count} for ${hostname}`}
      />,
    );

    expect(screen.getByText("0")).toBeTruthy();
  });

  it("collapses when header is clicked", () => {
    render(
      <DuplicateSection
        title="Duplicates"
        description="desc"
        groups={groups}
        formatCount={(count, hostname) => `${count} for ${hostname}`}
      />,
    );

    // Initially expanded (groups.length > 0)
    expect(screen.getByText("Work Login")).toBeTruthy();

    // Click to collapse
    fireEvent.click(screen.getByText("Duplicates"));
    expect(screen.queryByText("Work Login")).toBeNull();
  });

  it("displays correct badge count for multiple groups", () => {
    const multiGroups: DuplicateGroup[] = [
      {
        hostname: "a.com",
        username: "u1",
        entries: [
          { id: "1", title: "A1", username: "u1" },
          { id: "2", title: "A2", username: "u1" },
        ],
      },
      {
        hostname: "b.com",
        username: "u2",
        entries: [
          { id: "3", title: "B1", username: "u2" },
          { id: "4", title: "B2", username: "u2" },
        ],
      },
    ];
    render(
      <DuplicateSection
        title="Duplicates"
        description="desc"
        groups={multiGroups}
        formatCount={(count, hostname) => `${count} for ${hostname}`}
      />,
    );

    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("A1")).toBeTruthy();
    expect(screen.getByText("B1")).toBeTruthy();
  });

  it("does not render username when null", () => {
    const groupWithNull: DuplicateGroup[] = [
      {
        hostname: "example.com",
        username: "alice",
        entries: [{ id: "e1", title: "No-User Login", username: null }],
      },
    ];
    render(
      <DuplicateSection
        title="Duplicates"
        description="desc"
        groups={groupWithNull}
        formatCount={(count, hostname) => `${count} for ${hostname}`}
      />,
    );

    expect(screen.getByText("No-User Login")).toBeTruthy();
    // username text "alice" should not appear as entry-level username
    expect(screen.queryByText("alice")).toBeNull();
  });
});
