import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("password list bulk actions", () => {
  it("contains bulk archive and trash action wiring", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/passwords/password-list.tsx"),
      "utf8"
    );

    expect(src).toContain("passwordsBulkArchive()");
    expect(src).toContain("passwordsBulkTrash()");
    expect(src).toContain('setBulkAction("archive")');
    expect(src).toContain('setBulkAction("trash")');
    expect(src).toContain('t("moveSelectedToArchive")');
    expect(src).toContain('t("bulkArchiveConfirm"');
  });
});
