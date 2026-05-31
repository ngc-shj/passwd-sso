import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_ACTION_VALUES, AUDIT_ACTION_GROUP } from "@/lib/constants/audit/audit";

function readAuditLog(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "messages", locale, "AuditLog.json"),
      "utf8",
    ),
  ) as Record<string, string>;
}

describe("audit i18n coverage", () => {
  const enMessages = readAuditLog("en");
  const jaMessages = readAuditLog("ja");
  const enKeys = new Set(Object.keys(enMessages));
  const jaKeys = new Set(Object.keys(jaMessages));

  it("every AUDIT_ACTION_VALUES entry has an en label", () => {
    const missing = AUDIT_ACTION_VALUES.filter((a) => !enKeys.has(a));
    expect(missing).toEqual([]);
  });

  it("every AUDIT_ACTION_VALUES entry has a ja label", () => {
    const missing = AUDIT_ACTION_VALUES.filter((a) => !jaKeys.has(a));
    expect(missing).toEqual([]);
  });

  it("every AUDIT_ACTION_GROUP has an en label (groupXxx key)", () => {
    const groupValues = Object.values(AUDIT_ACTION_GROUP);
    const missing = groupValues.filter((g) => {
      // "group:auth" → "groupAuth", "group:directorySync" → "groupDirectorySync"
      const key = g.replace(/^group:(\w)/, (_, c: string) => `group${c.toUpperCase()}`);
      return !enKeys.has(key);
    });
    expect(missing).toEqual([]);
  });

  it("every AUDIT_ACTION_GROUP has a ja label (groupXxx key)", () => {
    const groupValues = Object.values(AUDIT_ACTION_GROUP);
    const missing = groupValues.filter((g) => {
      const key = g.replace(/^group:(\w)/, (_, c: string) => `group${c.toUpperCase()}`);
      return !jaKeys.has(key);
    });
    expect(missing).toEqual([]);
  });

  it("en and ja have the same set of action keys", () => {
    const enActionKeys = AUDIT_ACTION_VALUES.filter((a) => enKeys.has(a));
    const jaActionKeys = AUDIT_ACTION_VALUES.filter((a) => jaKeys.has(a));
    expect(enActionKeys).toEqual(jaActionKeys);
  });

  // Orphan-label guard: any UPPER_SNAKE_CASE key in the JSON that is not in
  // AUDIT_ACTION_VALUES is a forgotten label from a removed audit action.
  // Meta/UI keys use camelCase, so the UPPER_SNAKE pattern is sufficient to
  // identify action labels vs UI strings.
  const ACTION_KEY_PATTERN = /^[A-Z][A-Z0-9_]+$/;
  const actionValuesSet = new Set<string>(AUDIT_ACTION_VALUES);

  it("no orphan action labels in en AuditLog.json (removed actions leave no forgotten labels)", () => {
    const orphans = [...enKeys].filter(
      (k) => ACTION_KEY_PATTERN.test(k) && !k.startsWith("group") && !actionValuesSet.has(k),
    );
    expect(orphans).toEqual([]);
  });

  it("no orphan action labels in ja AuditLog.json (removed actions leave no forgotten labels)", () => {
    const orphans = [...jaKeys].filter(
      (k) => ACTION_KEY_PATTERN.test(k) && !k.startsWith("group") && !actionValuesSet.has(k),
    );
    expect(orphans).toEqual([]);
  });
});
