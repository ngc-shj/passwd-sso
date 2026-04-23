import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("audit log target labels", () => {
  it("uses parentAction and bulk trash/archive/unarchive/restore meta in shared target label helper", () => {
    // Personal and team pages delegate bulk/trash actions to getCommonTargetLabel
    const sharedHelper = readFileSync(
      join(process.cwd(), "src/lib/audit/audit-target-label.ts"),
      "utf8"
    );

    expect(sharedHelper).toContain("log.action === AUDIT_ACTION.ENTRY_BULK_TRASH");
    expect(sharedHelper).toContain("log.action === AUDIT_ACTION.ENTRY_EMPTY_TRASH");
    expect(sharedHelper).toContain("log.action === AUDIT_ACTION.ENTRY_BULK_ARCHIVE");
    expect(sharedHelper).toContain("log.action === AUDIT_ACTION.ENTRY_BULK_UNARCHIVE");
    expect(sharedHelper).toContain("log.action === AUDIT_ACTION.ENTRY_BULK_RESTORE");
    expect(sharedHelper).toContain('t("bulkTrashMeta"');
    expect(sharedHelper).toContain('t("emptyTrashMeta"');
    expect(sharedHelper).toContain('t("bulkArchiveMeta"');
    expect(sharedHelper).toContain('t("bulkUnarchiveMeta"');
    expect(sharedHelper).toContain('t("bulkRestoreMeta"');
  });

  it("has i18n fallback when action key translation is missing", () => {
    // The canonical actionLabel fallback implementation lives in use-audit-logs.ts
    const hook = readFileSync(
      join(process.cwd(), "src/hooks/use-audit-logs.ts"),
      "utf8"
    );

    expect(hook).toContain("const key = normalizeAuditActionKey(String(action));");
    expect(hook).toContain("return t.has(key as never) ? t(key as never) : String(action);");
  });
});
