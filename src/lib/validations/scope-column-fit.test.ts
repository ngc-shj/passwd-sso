/**
 * C5 (CF16) — I5.1: the accepted value at each bounded scope-ingress site is a
 * subset of a closed enum whose FULL join is `M` characters against a
 * `VarChar(W)` column with `M < W`. This is a derivation, not a runtime cap
 * (see audit-sentinel-carried-forward-plan.md's C5) — these tests assert the
 * derivation still holds by reading both sides from source: the enum from its
 * constants module, the width from prisma/schema.prisma.
 *
 * `PasswordShare.permissions` (site 7) is `String[]` with no width and is
 * excluded — it gets the dedup with no bound.
 */
import { describe, expect, it } from "vitest";
import { MCP_SCOPES } from "@/lib/constants/auth/mcp";
import { SA_TOKEN_SCOPES } from "@/lib/constants/auth/service-account";
import { API_KEY_SCOPES } from "@/lib/constants/auth/api-key";
import { varCharWidth } from "@/__tests__/helpers/schema-column-width";

describe.each([
  ["MCP_SCOPES", MCP_SCOPES, "McpClient", "allowedScopes"],
  ["SA_TOKEN_SCOPES", SA_TOKEN_SCOPES, "ServiceAccountToken", "scope"],
  ["API_KEY_SCOPES", API_KEY_SCOPES, "ApiKey", "scope"],
] as const)("%s -> %s.%s column fit (I5.1)", (enumName, scopes, model, field) => {
  it("the enum is non-empty (fail loudly rather than vacuously pass)", () => {
    expect(scopes.length, `${enumName} could not be read`).toBeGreaterThan(0);
  });

  it("the full enum, comma-joined, fits inside the column width", () => {
    const width = varCharWidth(model, field);
    const joined = [...scopes].join(",");
    expect(
      joined.length,
      `${enumName}.join(",") is ${joined.length} chars, ${model}.${field} is VarChar(${width})`,
    ).toBeLessThan(width);
  });
});
