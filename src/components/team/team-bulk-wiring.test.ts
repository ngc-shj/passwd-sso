import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("team archived list bulk wiring", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/team/team-archived-list.tsx"),
    "utf8"
  );

  it("uses shared bulk hooks and components", () => {
    expect(src).toContain("useBulkSelection");
    expect(src).toContain("useBulkAction");
    expect(src).toContain('scope: { type: "team"');
    expect(src).toContain("EntryListShell");
  });

  it("fetches from team-specific endpoint with archived param", () => {
    expect(src).toContain("apiPath.teamPasswords(teamId)");
    expect(src).toContain("?archived=true");
    expect(src).not.toContain("TEAMS_ARCHIVED");
  });
});

describe("team trash list bulk wiring", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/team/team-trash-list.tsx"),
    "utf8"
  );

  it("uses shared bulk hooks and components", () => {
    expect(src).toContain("useBulkSelection");
    expect(src).toContain("useBulkAction");
    expect(src).toContain('scope: { type: "team"');
    expect(src).toContain("EntryListShell");
    expect(src).toContain('requestAction("restore")');
  });

  it("fetches from team-specific endpoint with trash param", () => {
    expect(src).toContain("apiPath.teamPasswords(teamId)");
    expect(src).toContain("?trash=true");
    expect(src).not.toContain("TEAMS_TRASH");
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
    expect(src).toContain("EntryListShell");
  });
});
