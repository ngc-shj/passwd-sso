import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("audit log page group values", () => {
  it("does not hardcode group:* values in audit log pages", () => {
    const personalPage = readFileSync(
      join(process.cwd(), "src/app/[locale]/dashboard/audit-logs/page.tsx"),
      "utf8"
    );
    // The personal page's action groups live in its hook.
    const personalHook = readFileSync(
      join(process.cwd(), "src/hooks/vault/use-personal-audit-logs.ts"),
      "utf8"
    );
    const teamPage = readFileSync(
      join(
        process.cwd(),
        "src/app/[locale]/admin/teams/[teamId]/audit-logs/page.tsx"
      ),
      "utf8"
    );
    const tenantPage = readFileSync(
      join(
        process.cwd(),
        "src/app/[locale]/admin/tenant/audit-logs/page.tsx"
      ),
      "utf8"
    );

    expect(personalPage).not.toMatch(/value:\s*"group:[^"]+"/);
    expect(personalHook).toMatch(/value:\s*AUDIT_ACTION_GROUP\./);
    expect(personalHook).not.toMatch(/value:\s*"group:[^"]+"/);
    expect(teamPage).not.toMatch(/value:\s*"group:[^"]+"/);
    expect(tenantPage).not.toMatch(/value:\s*"group:[^"]+"/);
  });
});
