import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("password list bulk actions", () => {
  it("uses shared bulk hooks and components", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/passwords/password-list.tsx"),
      "utf8"
    );

    // Uses shared hooks
    expect(src).toContain("useBulkSelection");
    expect(src).toContain("useBulkAction");
    expect(src).toContain('scope: { type: "personal" }');

    // Uses shared components
    expect(src).toContain("FloatingActionBar");
    expect(src).toContain("BulkActionConfirmDialog");

    // Wires up bulk actions
    expect(src).toContain('requestAction("archive")');
    expect(src).toContain('requestAction("unarchive")');
    expect(src).toContain('requestAction("trash")');
  });
});
