import { describe, expect, it } from "vitest";
import { effectiveRole, parseSetBypassGucs } from "./rls-grant-evidence-recorder";

// The statement setBypassGucs sends (src/lib/tenant-rls-grants.ts), as Prisma binds it.
const STATEMENT = `SELECT set_config('app.bypass_rls', 'on', true),
                              set_config('app.bypass_purpose', $1, true),
                              set_config('app.tenant_id', $2, true),
                              set_config('app.bypass_tables', $3, true)`;

describe("parseSetBypassGucs", () => {
  it("reads the purpose and the table list from the bound values, never the tenant id", () => {
    expect(parseSetBypassGucs([STATEMENT, ["system_maintenance", "00000000-0000-0000-0000-000000000000", "a,b"]])).toEqual({
      purpose: "system_maintenance",
      tables: "a,b",
    });
  });

  it("reads a query config object", () => {
    expect(parseSetBypassGucs([{ text: STATEMENT, values: ["audit_write", "tenant", "t"] }])).toEqual({ purpose: "audit_write", tables: "t" });
  });

  it("ignores any other statement, including one that sets the bypass differently", () => {
    expect(parseSetBypassGucs(["SELECT 1", []])).toBeNull();
    expect(
      parseSetBypassGucs([
        `SELECT set_config('app.bypass_rls', 'on', true), set_config('app.bypass_purpose', $1, true), set_config('app.bypass_tables', $2, true)`,
        ["p", "t"],
      ]),
    ).toBeNull();
  });

  it("ignores the statement with the wrong number of values", () => {
    expect(parseSetBypassGucs([STATEMENT, ["p", "t"]])).toBeNull();
    expect(parseSetBypassGucs([STATEMENT])).toBeNull();
  });
});

describe("effectiveRole", () => {
  it("is the role set through the connection's options when present", () => {
    expect(effectiveRole({ user: "passwd_user", options: "-c role=rls_probe_1_ab" })).toBe("rls_probe_1_ab");
    expect(effectiveRole({ user: "passwd_user", options: "-c search_path=public -c role=probe" })).toBe("probe");
  });

  it("is the connection user otherwise", () => {
    expect(effectiveRole({ user: "passwd_app" })).toBe("passwd_app");
    expect(effectiveRole({ user: "passwd_app", options: "-c search_path=public" })).toBe("passwd_app");
  });
});

