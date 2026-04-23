import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("trash-list bulk wiring", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/passwords/shared/trash-list.tsx"),
    "utf8"
  );

  it("imports shared bulk hooks", () => {
    expect(src).toContain('import { useBulkSelection');
    expect(src).toContain('import { useBulkAction');
  });

  it("imports EntryListShell", () => {
    expect(src).toContain('import { EntryListShell');
  });

  it("uses personal scope", () => {
    expect(src).toContain('scope: { type: "personal" }');
  });

  it("wires up restore action", () => {
    expect(src).toContain('requestAction("restore")');
  });
});
