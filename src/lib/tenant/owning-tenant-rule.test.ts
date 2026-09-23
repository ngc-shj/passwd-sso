import { describe, it, expect } from "vitest";
import { owningTenantOf } from "./owning-tenant-rule";

// A-C4-1. The rule itself, pinned independently of either caller
// (`resolveOwningTenantIdFromClient` in tenant-context.ts,
// `backfill-owning-column` in scripts/tenant-domain.ts) so a change here shows
// up as a failure in this file rather than only in whichever caller's test
// happened to exercise the case.
describe("owningTenantOf", () => {
  it("falls back to the column when there is no active membership", () => {
    expect(owningTenantOf("column-tenant", [])).toBe("column-tenant");
  });

  it("returns the one active membership's tenant", () => {
    expect(owningTenantOf("column-tenant", [{ tenantId: "member-tenant" }])).toBe("member-tenant");
  });

  it("returns the OLDEST of several active memberships, not the column and not the newest", () => {
    // Callers pass memberships already ordered oldest-first (orderBy createdAt
    // asc); the rule itself just takes the first element, so this pins that it
    // does not, say, take the last one instead.
    expect(
      owningTenantOf("column-tenant", [
        { tenantId: "oldest-tenant" },
        { tenantId: "newest-tenant" },
      ]),
    ).toBe("oldest-tenant");
  });
});
