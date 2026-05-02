/**
 * Reverse-direction i18n sentinel — ensures OLD admin keys removed by the
 * admin-IA redesign are:
 *   1. Not present in AdminConsole.json (en + ja).
 *   2. Not referenced in src/ via t("<key>") calls.
 *
 * Exclusions: __tests__ dirs and *.test.ts(x) files are excluded so the
 * test file itself does not produce false hits.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const DEPRECATED_KEYS = [
  "navProvisioning",
  "navMcp",
  "navOperatorTokens",
  "navServiceAccounts",
  "navSaAccounts",
  "navAccessRequests",
  "navMcpClients",
  "navScim",
  "navDirectorySync",
  "navSecurity",
  "navGroupAuthentication",
  "navGroupPolicy",
  "navGroupNetwork",
  "navGroupMachineIdentity",
  "navSessionPolicy",
  "navPasskeyPolicy",
  "navLockoutPolicy",
  "navPasswordPolicy",
  "navRetentionPolicy",
  "navAccessRestriction",
  "navWebhooks",
  "navTokenPolicy",
  "navDelegationPolicy",
  "navMemberList",
  "navAddMember",
  "navTransferOwnership",
  "navAuditLogsLogs",
  "navAuditLogsBreakglass",
  "navAuditDelivery",
  "navPolicy",
  "navKeyRotation",
  "sectionSecurity",
  "sectionProvisioning",
  "sectionMcp",
  "sectionServiceAccounts",
  "sectionOperatorTokens",
  "teamSectionSecurity",
];

const KEY_PATTERN = /^(nav|section|subTab|teamSection)[A-Z][a-zA-Z]+$/;

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

describe("admin-ia i18n deprecated key guard", () => {
  const jaMessages = readAdminConsole("ja");
  const enMessages = readAdminConsole("en");
  const srcFiles = collectSrcFiles(join(ROOT, "src"));

  it("deprecated key list is non-empty", () => {
    expect(DEPRECATED_KEYS.length).toBeGreaterThan(0);
  });

  it("every deprecated key matches the expected pattern", () => {
    const invalid = DEPRECATED_KEYS.filter((k) => !KEY_PATTERN.test(k));
    expect(invalid).toEqual([]);
  });

  for (const key of DEPRECATED_KEYS) {
    it(`"${key}" is absent from ja AdminConsole.json`, () => {
      expect(Object.keys(jaMessages)).not.toContain(key);
    });

    it(`"${key}" is absent from en AdminConsole.json`, () => {
      expect(Object.keys(enMessages)).not.toContain(key);
    });

    it(`"${key}" is not called via t() in src/`, () => {
      const tSingleQuote = `t('${key}'`;
      const tDoubleQuote = `t("${key}"`;
      const hits = srcFiles.filter((filePath) => {
        const content = readFileSync(filePath, "utf8");
        return content.includes(tSingleQuote) || content.includes(tDoubleQuote);
      });
      expect(
        hits,
        `Deprecated key "${key}" is still called via t() in: ${hits.join(", ")}`,
      ).toEqual([]);
    });
  }
});
