import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readAuditLog(localeFile: string): Record<string, unknown> {
  const json = JSON.parse(
    readFileSync(join(process.cwd(), "messages", localeFile), "utf8")
  ) as Record<string, unknown>;
  return (json.AuditLog ?? {}) as Record<string, unknown>;
}

describe("audit log i18n keys", () => {
  it("has required keys in ja/en", () => {
    const ja = readAuditLog("ja.json");
    const en = readAuditLog("en.json");
    const required = [
      "ENTRY_IMPORT",
      "ENTRY_EXPORT",
      "ENTRY_TRASH",
      "ENTRY_PERMANENT_DELETE",
      "ENTRY_BULK_TRASH",
      "ENTRY_EMPTY_TRASH",
      "ENTRY_BULK_ARCHIVE",
      "ENTRY_BULK_UNARCHIVE",
      "ENTRY_BULK_RESTORE",
      "bulkDeleteMeta",
      "bulkTrashMeta",
      "emptyTrashMeta",
      "bulkArchiveMeta",
      "bulkUnarchiveMeta",
      "bulkRestoreMeta",
      "fromAction",
      "importMeta",
      "exportMeta",
      "exportMetaOrg",
    ];

    for (const key of required) {
      expect(ja[key]).toBeTypeOf("string");
      expect(en[key]).toBeTypeOf("string");
    }
  });
});
