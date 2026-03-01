import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("team archived list bulk wiring", () => {
  it("uses shared bulk hooks and components", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/team/team-archived-list.tsx"),
      "utf8"
    );

    expect(src).toContain("useBulkSelection");
    expect(src).toContain("useBulkAction");
    expect(src).toContain('scope: { type: "team"');
    expect(src).toContain("FloatingActionBar");
    expect(src).toContain("BulkActionConfirmDialog");
  });
});

describe("team trash list bulk wiring", () => {
  it("uses shared bulk hooks and components", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/team/team-trash-list.tsx"),
      "utf8"
    );

    expect(src).toContain("useBulkSelection");
    expect(src).toContain("useBulkAction");
    expect(src).toContain('scope: { type: "team"');
    expect(src).toContain("FloatingActionBar");
    expect(src).toContain("BulkActionConfirmDialog");
    expect(src).toContain('requestAction("restore")');
  });
});

describe("team dashboard bulk wiring", () => {
  it("uses shared bulk hooks and components", () => {
    const src = readFileSync(
      join(
        process.cwd(),
        "src/app/[locale]/dashboard/teams/[teamId]/page.tsx"
      ),
      "utf8"
    );

    expect(src).toContain("useBulkSelection");
    expect(src).toContain("useBulkAction");
    expect(src).toContain('scope: { type: "team"');
    expect(src).toContain("FloatingActionBar");
    expect(src).toContain("BulkActionConfirmDialog");
  });
});
