/**
 * Forward-direction i18n sentinel — ensures every new AdminConsole key
 * introduced by the admin-IA redesign has at least one consumer in src/.
 *
 * Exclusions: __tests__ dirs and *.test.ts(x) files are excluded so the
 * test file itself (which contains the literal key strings) does not make
 * the test vacuously pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function readAdminConsole(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(join(ROOT, "messages", locale, "AdminConsole.json"), "utf8"),
  ) as Record<string, string>;
}

// Walk src/ recursively, collecting .ts/.tsx file paths.
// Excludes __tests__ directories and *.test.ts(x) files.
function collectSrcFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      results.push(...collectSrcFiles(full));
    } else if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.(ts|tsx)$/.test(entry.name)
    ) {
      results.push(full);
    }
  }
  return results;
}

// Regex patterns capture both singular and plural forms (e.g. `sectionPolicy*`
// AND `sectionPolicies*`) — broader than `startsWith` to prevent the
// "Polic vs Policies" prefix gap that caused two dead keys to slip through
// in the initial implementation (round-1 finding F1/T1).
const NEW_KEY_PATTERNS: RegExp[] = [
  /^nav(MachineIdentity|Polic|Integration|Breakglass)/,
  /^navTeam(Policy|KeyRotation|Webhooks)$/,
  /^subTab/,
  /^section(MachineIdentity|Polic|Integration|Breakglass)/,
  /^teamSection(Policy|KeyRotation|Webhooks)(Desc)?$/,
  /^(memberAddButton|memberTransferOwnershipLink)$/,
];

function isNewKey(key: string): boolean {
  return NEW_KEY_PATTERNS.some((pat) => pat.test(key));
}

describe("admin-ia i18n forward coverage", () => {
  const jaMessages = readAdminConsole("ja");
  const enMessages = readAdminConsole("en");
  const newKeys = Object.keys(jaMessages).filter(isNewKey);
  const srcFiles = collectSrcFiles(join(ROOT, "src"));

  it("has at least one new key to check", () => {
    expect(newKeys.length).toBeGreaterThan(0);
  });

  it("en has the same set of new keys as ja", () => {
    const enNewKeys = Object.keys(enMessages).filter(isNewKey);
    expect(new Set(enNewKeys)).toEqual(new Set(newKeys));
  });

  for (const key of newKeys) {
    it(`"${key}" is used in at least one src file`, () => {
      const hit = srcFiles.some((filePath) => {
        const content = readFileSync(filePath, "utf8");
        return content.includes(key);
      });
      expect(
        hit,
        `Key "${key}" is declared in AdminConsole.json but has no consumer in src/ (excluding test files)`,
      ).toBe(true);
    });
  }
});

// ── Terminology lock (round-1 finding F5; round-1 code-review T4) ────────────
// Pin specific Japanese values to prevent silent translation drift. Without
// this, a future PR could change `運用者トークン` → `オペレータートークン` and
// only the manual review (the same review that caught the original drift)
// would catch it.
describe("admin-ia ja terminology lock", () => {
  const ja = readAdminConsole("ja");
  const expectedTerminology: Record<string, string> = {
    // "operator tokens" — kanji form mandatory; matches OperatorToken.json,
    // AuditLog.json, and other 8+ existing references in the codebase.
    navMachineIdentityOperatorTokens: "運用者トークン",
    sectionMachineIdentityOperatorTokens: "運用者トークン",
    // "vault" never appears in AdminConsole.json today, but in case a future
    // key adds it, the same convention applies (per project memory:
    // feedback_ja_vault_translation — must be `保管庫`, never カタカナ).
  };

  for (const [key, expected] of Object.entries(expectedTerminology)) {
    it(`"${key}" uses canonical Japanese form "${expected}"`, () => {
      expect(ja[key]).toBe(expected);
    });
  }
});
