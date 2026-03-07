import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_ACTION, AUDIT_ACTION_GROUP } from "@/lib/constants/audit";

function readAuditLog(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "messages", locale, "AuditLog.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

describe("audit log i18n keys", () => {
  const en = readAuditLog("en");
  const ja = readAuditLog("ja");

  it("every AUDIT_ACTION has an i18n entry in en and ja", () => {
    const allActions = Object.values(AUDIT_ACTION);
    const missingEn: string[] = [];
    const missingJa: string[] = [];

    for (const action of allActions) {
      if (typeof en[action] !== "string") missingEn.push(action);
      if (typeof ja[action] !== "string") missingJa.push(action);
    }

    expect(missingEn, `Missing en keys: ${missingEn.join(", ")}`).toEqual([]);
    expect(missingJa, `Missing ja keys: ${missingJa.join(", ")}`).toEqual([]);
  });

  it("every AUDIT_ACTION_GROUP has a group label in en and ja", () => {
    const allGroups = Object.values(AUDIT_ACTION_GROUP);
    const missingEn: string[] = [];
    const missingJa: string[] = [];

    for (const group of allGroups) {
      // group values are "group:auth" → i18n key is "groupAuth"
      const suffix = group.split(":")[1];
      const key = "group" + suffix.charAt(0).toUpperCase() + suffix.slice(1);
      if (typeof en[key] !== "string") missingEn.push(key);
      if (typeof ja[key] !== "string") missingJa.push(key);
    }

    expect(missingEn, `Missing en group keys: ${missingEn.join(", ")}`).toEqual([]);
    expect(missingJa, `Missing ja group keys: ${missingJa.join(", ")}`).toEqual([]);
  });

  it("has metadata / display keys in both locales", () => {
    const required = [
      "bulkDeleteMeta",
      "bulkTrashMeta",
      "emptyTrashMeta",
      "bulkArchiveMeta",
      "bulkUnarchiveMeta",
      "bulkRestoreMeta",
      "importMeta",
      "exportMeta",
      "exportMetaTeam",
    ];

    for (const key of required) {
      expect(en[key], `en.${key}`).toBeTypeOf("string");
      expect(ja[key], `ja.${key}`).toBeTypeOf("string");
    }
  });
});
