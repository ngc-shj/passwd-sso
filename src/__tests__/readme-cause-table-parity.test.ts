/**
 * The lockout cause table in README.md and README.ja.md, row for row.
 *
 * Round 4 of the claim-binding review found the ja table with a row replaced
 * instead of added: seven rows under text that said eight, "the first two and
 * the last two" naming the wrong rows, and a paragraph pointing at a row that
 * was gone. Both tables must have the same `metadata.reason` sequence, and the
 * count each README states must be its own table's.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SECTIONS = [
  { file: "README.md", heading: "### IdP domain changed / tenant locked out", count: /There are \*\*(\w+)\*\* causes/ },
  { file: "README.ja.md", heading: "### IdP のドメインが変わった / テナントがロックアウトされた", count: /原因は \*\*(\d+) つ\*\*/ },
] as const;

const WORDS: Record<string, number> = { six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** The section's first table: its data rows' first cells, and the count its text states. */
function causeTable(markdown: string, heading: string, count: RegExp): { reasons: string[]; stated: number } {
  const lines = markdown.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`section "${heading}" not found`);
  const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  const first = section.findIndex((l) => l.startsWith("|"));
  if (first < 0) throw new Error(`no table under "${heading}"`);
  const after = section.slice(first).findIndex((l) => !l.startsWith("|"));
  const table = section.slice(first, after < 0 ? undefined : first + after);
  if (table.length < 3 || !/^\|[-| ]+\|$/.test(table[1])) throw new Error(`the table under "${heading}" has no header and rows`);
  const reasons = table.slice(2).map((row) => row.split("|")[1].trim());
  const match = count.exec(section.slice(0, first).join("\n"));
  if (!match) throw new Error(`no stated cause count under "${heading}"`);
  const stated = WORDS[match[1]] ?? Number(match[1]);
  if (!Number.isInteger(stated)) throw new Error(`unreadable cause count "${match[1]}" under "${heading}"`);
  return { reasons, stated };
}

describe("README lockout cause tables", () => {
  const tables = SECTIONS.map(({ file, heading, count }) =>
    causeTable(readFileSync(join(process.cwd(), file), "utf8"), heading, count),
  );

  it("have the same reasons in the same order in both languages", () => {
    expect(tables[0].reasons.length).toBeGreaterThan(0);
    expect(tables[1].reasons).toEqual(tables[0].reasons);
  });

  it("state their own table's row count", () => {
    for (const table of tables) expect(table.stated).toBe(table.reasons.length);
  });

  it("refuses a section or a table it cannot find", () => {
    expect(() => causeTable("# x\n", SECTIONS[0].heading, SECTIONS[0].count)).toThrow("not found");
    expect(() => causeTable(`${SECTIONS[0].heading}\n\nThere are **eight** causes.\n`, SECTIONS[0].heading, SECTIONS[0].count)).toThrow(
      "no table",
    );
  });
});
