import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("password-list bulk wiring", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/passwords/password-list.tsx"),
    "utf8"
  );

  it("imports shared bulk hooks", () => {
    expect(src).toContain('import { useBulkSelection');
    expect(src).toContain('import { useBulkAction');
  });

  it("imports EntryListShell", () => {
    expect(src).toContain('import { EntryListShell }');
  });

  it("uses personal scope", () => {
    expect(src).toContain('scope: { type: "personal" }');
  });

  it("wires up bulk actions", () => {
    expect(src).toContain('requestAction("archive")');
    expect(src).toContain('requestAction("unarchive")');
    expect(src).toContain('requestAction("trash")');
  });
});
