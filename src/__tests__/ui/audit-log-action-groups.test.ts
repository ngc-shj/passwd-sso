import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("audit log page group values", () => {
  it("does not hardcode group:* values in audit log pages", () => {
    const personalPage = readFileSync(
      join(process.cwd(), "src/app/[locale]/dashboard/audit-logs/page.tsx"),
      "utf8"
    );
    const teamPage = readFileSync(
      join(
        process.cwd(),
        "src/app/[locale]/dashboard/teams/[teamId]/audit-logs/page.tsx"
      ),
      "utf8"
    );

    expect(personalPage).not.toMatch(/value:\s*"group:[^"]+"/);
    expect(teamPage).not.toMatch(/value:\s*"group:[^"]+"/);
  });
});
