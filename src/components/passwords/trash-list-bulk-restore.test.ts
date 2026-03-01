import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("trash list bulk restore wiring", () => {
  it("uses shared bulk hooks and components", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/passwords/trash-list.tsx"),
      "utf8"
    );

    // Uses shared hooks
    expect(src).toContain("useBulkSelection");
    expect(src).toContain("useBulkAction");
    expect(src).toContain('scope: { type: "personal" }');

    // Uses shared components
    expect(src).toContain("FloatingActionBar");
    expect(src).toContain("BulkActionConfirmDialog");

    // Wires up restore action
    expect(src).toContain('requestAction("restore")');
  });
});
