// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { EntryIcon } from "./entry-icon";
import { ENTRY_TYPE } from "@/lib/constants";

// Mock Favicon so the LOGIN/default branch is identifiable without network.
vi.mock("../shared/favicon", () => ({
  Favicon: () => <span data-testid="favicon" />,
}));

describe("EntryIcon", () => {
  // Each entry type maps to a distinct lucide icon (a wrong/dropped mapping would
  // regress the row + detail-pane header which both rely on this single component).
  const typeIconCases = [
    ENTRY_TYPE.BANK_ACCOUNT,
    ENTRY_TYPE.SOFTWARE_LICENSE,
    ENTRY_TYPE.PASSKEY,
    ENTRY_TYPE.IDENTITY,
    ENTRY_TYPE.CREDIT_CARD,
    ENTRY_TYPE.SECURE_NOTE,
  ];

  // For non-login types a lucide <svg> icon renders, NOT the Favicon. This catches the
  // regression the reviewer flagged: a type accidentally falling through to the favicon
  // default (e.g. IDENTITY losing its IdCard mapping).
  it.each(typeIconCases)("renders a type icon (not the favicon) for %s", (entryType) => {
    const { container } = render(<EntryIcon entryType={entryType} urlHost={null} />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector('[data-testid="favicon"]')).toBeNull();
  });

  it("renders a distinct icon per type (no two types share the same rendered icon)", () => {
    const htmls = typeIconCases.map((entryType) => {
      const { container } = render(<EntryIcon entryType={entryType} urlHost={null} />);
      return container.innerHTML;
    });
    expect(new Set(htmls).size).toBe(typeIconCases.length);
  });

  it("renders the Favicon for LOGIN (default) entries", () => {
    const { getByTestId } = render(<EntryIcon entryType={ENTRY_TYPE.LOGIN} urlHost="example.com" />);
    expect(getByTestId("favicon")).toBeInTheDocument();
  });

  it("falls back to the Favicon when entryType is undefined", () => {
    const { getByTestId } = render(<EntryIcon urlHost="example.com" />);
    expect(getByTestId("favicon")).toBeInTheDocument();
  });
});
