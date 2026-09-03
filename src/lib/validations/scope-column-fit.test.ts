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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_SCOPES } from "@/lib/constants/auth/mcp";
import { SA_TOKEN_SCOPES } from "@/lib/constants/auth/service-account";
import { API_KEY_SCOPES } from "@/lib/constants/auth/api-key";

const schema = readFileSync(
  resolve(__dirname, "../../../prisma/schema.prisma"),
  "utf-8",
);

/** Extracts the VarChar(N) width for model.field from schema.prisma. Throws — never returns null — so a renamed/removed column fails loudly instead of silently skipping the check. */
function getVarCharWidth(modelName: string, fieldName: string): number {
  const modelRegex = new RegExp(
    `model\\s+${modelName}\\s+\\{([^}]+(?:\\{[^}]*\\}[^}]*)*)\\}`,
    "s",
  );
  const modelMatch = schema.match(modelRegex);
  if (!modelMatch) {
    throw new Error(`model ${modelName} not found in prisma/schema.prisma`);
  }
  const fieldRegex = new RegExp(
    `^\\s+${fieldName}\\s+\\S.*?@db\\.VarChar\\((\\d+)\\)`,
    "m",
  );
  const fieldMatch = modelMatch[1].match(fieldRegex);
  if (!fieldMatch) {
    throw new Error(
      `${modelName}.${fieldName} has no @db.VarChar(N) annotation in prisma/schema.prisma`,
    );
  }
  return parseInt(fieldMatch[1], 10);
}

describe.each([
  ["MCP_SCOPES", MCP_SCOPES, "McpClient", "allowedScopes"],
  ["SA_TOKEN_SCOPES", SA_TOKEN_SCOPES, "ServiceAccountToken", "scope"],
  ["API_KEY_SCOPES", API_KEY_SCOPES, "ApiKey", "scope"],
] as const)("%s -> %s.%s column fit (I5.1)", (enumName, scopes, model, field) => {
  it("the enum is non-empty (fail loudly rather than vacuously pass)", () => {
    expect(scopes.length, `${enumName} could not be read`).toBeGreaterThan(0);
  });

  it("the full enum, comma-joined, fits inside the column width", () => {
    const width = getVarCharWidth(model, field);
    const joined = [...scopes].join(",");
    expect(
      joined.length,
      `${enumName}.join(",") is ${joined.length} chars, ${model}.${field} is VarChar(${width})`,
    ).toBeLessThan(width);
  });
});
