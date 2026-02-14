import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("trash list bulk restore wiring", () => {
  it("contains bulk restore API and labels", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/passwords/trash-list.tsx"),
      "utf8"
    );

    expect(src).toContain("passwordsBulkRestore()");
    expect(src).toContain('t("restoreSelected")');
    expect(src).toContain('t("bulkRestored"');
    expect(src).toContain('t("bulkRestoreFailed"');
    expect(src).toContain('tl("selectAll")');
    expect(src).toContain('tl("clearSelection")');
    expect(src).toContain("sticky top-4");
  });
});
