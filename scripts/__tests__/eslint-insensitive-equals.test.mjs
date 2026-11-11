// Pins the ESLint rule that forbids `equals` with mode: "insensitive" (an
// unescaped ILIKE, see src/lib/prisma/prisma-filters.ts) through the real
// eslint.config.mjs, including the components/hooks block, which replaces
// no-restricted-syntax for the files it matches.
import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function ruleHits(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter(
    (m) => m.ruleId === "no-restricted-syntax" && m.message.includes("unescaped ILIKE"),
  ).length;
}

describe("no-restricted-syntax: insensitive equals", () => {
  it.each([
    ["equals before mode", 'export const w = { email: { equals: "a", mode: "insensitive" } };'],
    ["mode before equals", 'export const w = { email: { mode: "insensitive", equals: "a" } };'],
    ["quoted keys", 'export const w = { email: { "equals": "a", "mode": "insensitive" } };'],
    ["nested in a where", 'export const w = { where: { user: { is: { email: { equals: "a", mode: "insensitive" } } } } };'],
  ])("reports %s", async (_label, code) => {
    expect(await ruleHits(code, "src/lib/example.ts")).toBe(1);
  });

  it("reports in client components, whose block replaces no-restricted-syntax", async () => {
    const code = 'export const w = { email: { equals: "a", mode: "insensitive" } };';
    expect(await ruleHits(code, "src/components/example.tsx")).toBe(1);
  });

  it("reports in scripts", async () => {
    const code = 'export const w = { email: { equals: "a", mode: "insensitive" } };';
    expect(await ruleHits(code, "scripts/example.ts")).toBe(1);
  });

  it.each([
    ["the in-form exact match", 'export const w = { email: { in: ["a"], mode: "insensitive" } };'],
    ["an escaped contains", 'export const w = { email: { contains: "a", mode: "insensitive" } };'],
    ["a case-sensitive equals", 'export const w = { email: { equals: "a" } };'],
    ["mode on a sibling object", 'export const w = { email: { equals: "a" }, name: { mode: "insensitive" } };'],
  ])("does not report %s", async (_label, code) => {
    expect(await ruleHits(code, "src/lib/example.ts")).toBe(0);
  });
});
