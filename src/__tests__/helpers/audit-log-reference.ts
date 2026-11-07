import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The metadata keys docs/operations/audit-log-reference.md documents for an
 * action (its table row's `{ a, b, c }` cell), so a route test can hold the
 * keys its audit call writes to the page operators read.
 */
export function documentedMetadataKeys(action: string): string[] {
  const doc = readFileSync(join(process.cwd(), "docs/operations/audit-log-reference.md"), "utf8");
  const row = doc.split("\n").find((line) => line.startsWith(`| \`${action}\` |`));
  if (!row) throw new Error(`audit-log-reference.md has no row for ${action}`);
  const cell = /`\{\s*([^}]*?)\s*\}`/.exec(row);
  if (!cell) throw new Error(`the ${action} row documents no metadata object`);
  return cell[1].split(",").map((key) => key.trim()).filter(Boolean).sort();
}
