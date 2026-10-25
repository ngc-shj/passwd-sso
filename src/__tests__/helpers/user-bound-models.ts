/**
 * The tenant-scoped models that bind a row to a user, read off
 * `prisma/schema.prisma`: every model declaring `tenantId` beside a user column.
 *
 * A user column is the `fields:` column of a relation to `User`, whatever it is
 * called. Round 4 of the claim-binding review found the earlier name list
 * (`userId`, `createdById`, `ownerId`) blind to `OperatorToken.subjectUserId`,
 * `AdminVaultReset.targetUserId`, `PersonalLogAccessGrant.targetUserId` and
 * `AccessRequest.requesterUserId`, so neither `STRANDED_COUNTERS` nor the
 * bootstrap migration had to say anything about them.
 *
 * `FK_LESS_USER_COLUMNS` is the one name list left, for columns that hold a
 * user id with no relation to say so: the MCP token and code rows' `userId`
 * (nullable, no FK) and `AuditLog.userId` (the trail outlives the user).
 *
 * A relation to `User` this line-wise parse cannot read throws rather than
 * contributing no column (round 5, T27): one with no `fields:` on its line, or
 * whose `@relation(` does not close on it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SchemaModel = {
  /** field -> its declared type, without `?` / `[]`. */
  readonly fields: ReadonlyMap<string, string>;
  /** The `fields:` columns of this model's relations to `User`. */
  readonly userRelationColumns: readonly string[];
};

export const FK_LESS_USER_COLUMNS = ["userId"] as const;

/** model -> its fields and user relations, from the schema the app is built from (or `src`). */
export function parseSchemaModels(
  src: string = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8"),
): Map<string, SchemaModel> {
  const models = new Map<string, { fields: Map<string, string>; userRelationColumns: string[] }>();
  let current: { fields: Map<string, string>; userRelationColumns: string[] } | null = null;
  for (const line of src.split("\n")) {
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = { fields: new Map(), userRelationColumns: [] };
      models.set(open[1], current);
      continue;
    }
    if (/^\}/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("@@") || trimmed.startsWith("//")) continue;
    const field = /^[ \t]+(\w+)[ \t]+([A-Za-z_]\w*)(\[\])?/.exec(line);
    if (!field) continue;
    current.fields.set(field[1], field[2]);
    if (field[2] !== "User" || field[3]) continue;
    const relation = line.indexOf("@relation(");
    const rest = relation < 0 ? "" : line.slice(relation);
    if (relation >= 0 && rest.split("(").length !== rest.split(")").length) {
      throw new Error(`user-bound-models: the @relation of ${field[1]} does not close on its line: ${trimmed}`);
    }
    const columns = /\bfields:\s*\[([^\]]*)\]/.exec(rest);
    if (!columns) throw new Error(`user-bound-models: the User relation ${field[1]} names no fields: on its line: ${trimmed}`);
    current.userRelationColumns.push(...columns[1].split(",").map((c) => c.trim()));
  }
  return models;
}

/** The columns of `model` that name the user a row belongs to, by relation or by `FK_LESS_USER_COLUMNS`. */
export function userColumnsOf(model: SchemaModel): string[] {
  const fkLess = FK_LESS_USER_COLUMNS.filter((c) => model.fields.has(c));
  return [...new Set([...model.userRelationColumns, ...fkLess])];
}

/** model -> its user columns, for every model declaring `tenantId` beside at least one. */
export function userBoundModels(models: ReadonlyMap<string, SchemaModel>): Map<string, string[]> {
  const bound = new Map<string, string[]>();
  for (const [name, model] of models) {
    if (!model.fields.has("tenantId")) continue;
    const columns = userColumnsOf(model);
    if (columns.length > 0) bound.set(name, columns);
  }
  return bound;
}

/** `TenantMember` -> `tenantMember`, the Prisma client handle. */
export const handleOf = (model: string) => model[0].toLowerCase() + model.slice(1);
