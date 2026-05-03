// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AUDIT_ACTION, type AuditActionValue } from "@/lib/constants";
import { ACTION_ICONS, DEFAULT_AUDIT_ICON } from "./audit-action-icons";

// Source declares ACTION_ICONS as Partial<Record<AuditActionValue, ReactNode>>
// (intentional — actions without a mapping fall back to DEFAULT_AUDIT_ICON at
// the call site). Tests iterate over the actual mapped entries — they must
// render their lucide-react icon SVG.
describe("ACTION_ICONS map (R12)", () => {
  it("each mapped action renders an SVG icon", () => {
    const entries = Object.entries(ACTION_ICONS) as [AuditActionValue, React.ReactNode][];
    expect(entries.length).toBeGreaterThan(0);
    for (const [, node] of entries) {
      const { container, unmount } = render(<>{node}</>);
      // lucide-react components render an <svg> element
      expect(container.querySelector("svg")).not.toBeNull();
      unmount();
    }
  });

  it("includes mappings for the canonical AUDIT_ACTION enum values used in security-critical flows", () => {
    expect(ACTION_ICONS[AUDIT_ACTION.AUTH_LOGIN]).toBeDefined();
    expect(ACTION_ICONS[AUDIT_ACTION.ENTRY_CREATE]).toBeDefined();
    expect(ACTION_ICONS[AUDIT_ACTION.SHARE_CREATE]).toBeDefined();
    expect(ACTION_ICONS[AUDIT_ACTION.EMERGENCY_VAULT_ACCESS]).toBeDefined();
  });
});

describe("DEFAULT_AUDIT_ICON (call-site fallback)", () => {
  it("renders an SVG (used for unmapped actions)", () => {
    const { container } = render(<>{DEFAULT_AUDIT_ICON}</>);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("the call-site pattern (ACTION_ICONS[action] ?? DEFAULT_AUDIT_ICON) returns the default for an unmapped action", () => {
    // Use an unmapped action — pick one not present in the partial map.
    // VAULT_UNLOCK_FAILED is enumerated in AUDIT_ACTION but NOT in ACTION_ICONS.
    const unmapped = AUDIT_ACTION.VAULT_UNLOCK_FAILED as AuditActionValue;
    expect(ACTION_ICONS[unmapped]).toBeUndefined();
    const resolved = ACTION_ICONS[unmapped] ?? DEFAULT_AUDIT_ICON;
    expect(resolved).toBe(DEFAULT_AUDIT_ICON);
  });
});
