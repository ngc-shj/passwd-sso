import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("team-archived-list bulk wiring", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/team/management/team-archived-list.tsx"),
    "utf8"
  );

  it("imports shared bulk hooks", () => {
    expect(src).toContain('import { useBulkSelection');
    expect(src).toContain('import { useBulkAction');
  });

  it("imports EntryListShell", () => {
    expect(src).toContain('import { EntryListShell }');
  });

  it("uses team scope", () => {
    expect(src).toContain('scope: { type: "team"');
  });

  it("fetches from team-specific endpoint with archived param", () => {
    expect(src).toContain("apiPath.teamPasswords(teamId)");
    expect(src).toContain("?archived=true");
    expect(src).not.toContain("TEAMS_ARCHIVED");
  });
});

describe("team-trash-list bulk wiring", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/team/management/team-trash-list.tsx"),
    "utf8"
  );

  it("imports shared bulk hooks", () => {
    expect(src).toContain('import { useBulkSelection');
    expect(src).toContain('import { useBulkAction');
  });

  it("imports EntryListShell", () => {
    expect(src).toContain('import { EntryListShell');
  });

  it("uses team scope", () => {
    expect(src).toContain('scope: { type: "team"');
  });

  it("wires up restore action", () => {
    expect(src).toContain('requestAction("restore")');
  });

  it("fetches from team-specific endpoint with trash param", () => {
    expect(src).toContain("apiPath.teamPasswords(teamId)");
    expect(src).toContain("?trash=true");
    expect(src).not.toContain("TEAMS_TRASH");
  });
});

describe("team-dashboard bulk wiring", () => {
  const src = readFileSync(
    join(
      process.cwd(),
      "src/app/[locale]/dashboard/teams/[teamId]/page.tsx"
    ),
    "utf8"
  );

  it("imports shared bulk hooks", () => {
    expect(src).toContain('import { useBulkSelection');
    expect(src).toContain('import { useBulkAction');
  });

  it("imports EntryListShell", () => {
    expect(src).toContain('import { EntryListShell }');
  });

  it("uses team scope", () => {
    expect(src).toContain('scope: { type: "team"');
  });
});
