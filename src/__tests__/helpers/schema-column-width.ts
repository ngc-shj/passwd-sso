/**
 * Read a `@db.VarChar(N)` width out of `prisma/schema.prisma`.
 *
 * One reader, because two tests bound their assertions on the SAME column and a
 * literal in either is a second spelling of one schema decision: widen
 * `ServiceAccountToken.scope` and a hardcoded `1024` keeps asserting the old
 * bound — silently, and in the direction that makes an "this value overflows the
 * column" case stop being true while staying green.
 *
 * Throws rather than returning null. A renamed or removed column must fail
 * loudly: a reader that returns null hands its caller a reason to skip, and a
 * skipped bound is indistinguishable from a satisfied one.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const schema = readFileSync(
  resolve(__dirname, "../../../prisma/schema.prisma"),
  "utf-8",
);

export function varCharWidth(modelName: string, fieldName: string): number {
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
