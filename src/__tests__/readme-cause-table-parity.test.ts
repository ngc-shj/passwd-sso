/**
 * The lockout cause table in README.md and README.ja.md, row for row.
 *
 * Round 4 of the claim-binding review found the ja table with a row replaced
 * instead of added: seven rows under text that said eight, "the first two and
 * the last two" naming the wrong rows, and a paragraph pointing at a row that
 * was gone. Both tables must have the same rows in the same order, and the
 * count each README states must be its own table's.
 *
 * Round 5 (T26): `tenant_mismatch` heads four rows, so a row is keyed on its
 * reason and the code spans its cells carry, which are the same in both
 * languages but for `<placeholder>` text. And the number of headings each
 * README says `unmapped` prints is held to the `printGroup` calls in
 * `cmdUnmapped`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SyntaxKind } from "ts-morph";
import { parseRouteSource } from "@/__tests__/proxy/ast-guards";

const SECTIONS = [
  {
    file: "README.md",
    heading: "### IdP domain changed / tenant locked out",
    count: /There are \*\*(\w+)\*\* causes/,
    headings: /causes under (\w+) headings/,
  },
  {
    file: "README.ja.md",
    heading: "### IdP のドメインが変わった / テナントがロックアウトされた",
    count: /原因は \*\*(\d+) つ\*\*/,
    headings: /原因を (\d+) つの見出しで報告します/,
  },
] as const;

const WORDS: Record<string, number> = { three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function statedNumber(text: string, pattern: RegExp, what: string, heading: string): number {
  const match = pattern.exec(text);
  if (!match) throw new Error(`no stated ${what} under "${heading}"`);
  const stated = WORDS[match[1]] ?? Number(match[1]);
  if (!Number.isInteger(stated)) throw new Error(`unreadable ${what} "${match[1]}" under "${heading}"`);
  return stated;
}

/** A row's key: every code span in it, in order, with `<placeholder>` text (translated) blanked. */
function rowKey(row: string): string {
  return [...row.matchAll(/`([^`]*)`/g)].map((m) => m[1].replace(/<[^>]*>/g, "<>")).join(" ");
}

/** The section's first table: its data rows' keys, and the counts its text states. */
function causeTable(
  markdown: string,
  heading: string,
  count: RegExp,
  headings: RegExp = /$^/,
): { keys: string[]; stated: number; statedHeadings: number | null } {
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
  const keys = table.slice(2).map((row) => {
    const reason = row.split("|")[1].trim();
    if (!/^`[a-z_]+`$/.test(reason)) throw new Error(`row without a \`reason\` first cell under "${heading}": ${row.slice(0, 60)}`);
    return rowKey(row);
  });
  const stated = statedNumber(section.slice(0, first).join("\n"), count, "cause count", heading);
  const body = section.join("\n");
  const statedHeadings = headings.test(body) ? statedNumber(body, headings, "heading count", heading) : null;
  return { keys, stated, statedHeadings };
}

/** How many headings `cmdUnmapped` can print: its `printGroup` calls. */
function printGroupCalls(): number {
  const sf = parseRouteSource(readFileSync(join(process.cwd(), "scripts/tenant-domain.ts"), "utf8"), "scripts/tenant-domain.ts");
  return sf
    .getFunctionOrThrow("cmdUnmapped")
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getText() === "printGroup").length;
}

describe("README lockout cause tables", () => {
  const tables = SECTIONS.map(({ file, heading, count, headings }) =>
    causeTable(readFileSync(join(process.cwd(), file), "utf8"), heading, count, headings),
  );

  it("have the same rows in the same order in both languages", () => {
    expect(tables[0].keys.length).toBeGreaterThan(0);
    expect(tables[1].keys).toEqual(tables[0].keys);
  });

  it("key every row apart from the others", () => {
    for (const table of tables) expect(new Set(table.keys).size).toBe(table.keys.length);
  });

  it("state their own table's row count", () => {
    for (const table of tables) expect(table.stated).toBe(table.keys.length);
  });

  it("state as many headings as cmdUnmapped prints", () => {
    const calls = printGroupCalls();
    expect(calls).toBeGreaterThan(0);
    for (const table of tables) expect(table.statedHeadings).toBe(calls);
  });

  it("refuses a section or a table it cannot find", () => {
    expect(() => causeTable("# x\n", SECTIONS[0].heading, SECTIONS[0].count)).toThrow("not found");
    expect(() => causeTable(`${SECTIONS[0].heading}\n\nThere are **eight** causes.\n`, SECTIONS[0].heading, SECTIONS[0].count)).toThrow(
      "no table",
    );
    expect(() =>
      causeTable(
        `${SECTIONS[0].heading}\n\nThere are **one** causes.\n\n| a | b |\n|---|---|\n| \`x\` | y |\n`,
        SECTIONS[0].heading,
        SECTIONS[0].count,
      ),
    ).toThrow("unreadable cause count");
  });
});
