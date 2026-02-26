import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("audit log target labels", () => {
  it("uses parentAction and bulk trash/archive/unarchive/restore meta in personal/team pages", () => {
    const personalPage = readFileSync(
      join(process.cwd(), "src/app/[locale]/dashboard/audit-logs/page.tsx"),
      "utf8"
    );
    const teamPage = readFileSync(
      join(
        process.cwd(),
        "src/app/[locale]/dashboard/teams/[teamId]/audit-logs/page.tsx"
      ),
      "utf8"
    );

    for (const page of [personalPage, teamPage]) {
      expect(page).toContain("log.action === AUDIT_ACTION.ENTRY_BULK_TRASH");
      expect(page).toContain("log.action === AUDIT_ACTION.ENTRY_EMPTY_TRASH");
      expect(page).toContain("log.action === AUDIT_ACTION.ENTRY_BULK_ARCHIVE");
      expect(page).toContain("log.action === AUDIT_ACTION.ENTRY_BULK_UNARCHIVE");
      expect(page).toContain("log.action === AUDIT_ACTION.ENTRY_BULK_RESTORE");
      expect(page).toContain('t("bulkTrashMeta"');
      expect(page).toContain('t("emptyTrashMeta"');
      expect(page).toContain('t("bulkArchiveMeta"');
      expect(page).toContain('t("bulkUnarchiveMeta"');
      expect(page).toContain('t("bulkRestoreMeta"');
      expect(page).toContain("meta?.parentAction");
      expect(page).toContain('t("fromAction"');
    }
  });

  it("has i18n fallback when action key translation is missing", () => {
    const personalPage = readFileSync(
      join(process.cwd(), "src/app/[locale]/dashboard/audit-logs/page.tsx"),
      "utf8"
    );
    const teamPage = readFileSync(
      join(
        process.cwd(),
        "src/app/[locale]/dashboard/teams/[teamId]/audit-logs/page.tsx"
      ),
      "utf8"
    );

    for (const page of [personalPage, teamPage]) {
      expect(page).toContain("const key = normalizeAuditActionKey(String(action));");
      expect(page).toContain("return t.has(key as never) ? t(key as never) : String(action);");
    }
  });
});
