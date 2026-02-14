import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("audit log target labels", () => {
  it("uses parentAction and bulk delete/archive/unarchive meta in personal/org pages", () => {
    const personalPage = readFileSync(
      join(process.cwd(), "src/app/[locale]/dashboard/audit-logs/page.tsx"),
      "utf8"
    );
    const orgPage = readFileSync(
      join(
        process.cwd(),
        "src/app/[locale]/dashboard/orgs/[orgId]/audit-logs/page.tsx"
      ),
      "utf8"
    );

    for (const page of [personalPage, orgPage]) {
      expect(page).toContain("log.action === AUDIT_ACTION.ENTRY_BULK_DELETE");
      expect(page).toContain("log.action === AUDIT_ACTION.ENTRY_BULK_ARCHIVE");
      expect(page).toContain("log.action === AUDIT_ACTION.ENTRY_BULK_UNARCHIVE");
      expect(page).toContain('t("bulkDeleteMeta"');
      expect(page).toContain('t("bulkArchiveMeta"');
      expect(page).toContain('t("bulkUnarchiveMeta"');
      expect(page).toContain("meta?.parentAction");
      expect(page).toContain('t("fromAction"');
    }
  });
});
