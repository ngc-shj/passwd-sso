import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-string smoke tests verifying that the shared bulk hooks and
 * EntryListShell are wired in the shared EntryListView component (C3),
 * and that the personal adapter provides the personal bulk scope (C5).
 *
 * Updated for Batch 2: bulk wiring moved from password-list.tsx → entry-list-view.tsx;
 * personal scope moved from password-list.tsx → personal-vault-list-adapter.ts.
 */
describe("password-list bulk wiring", () => {
  const entryListViewSrc = readFileSync(
    join(process.cwd(), "src/components/passwords/detail/entry-list-view.tsx"),
    "utf8"
  );
  const personalAdapterSrc = readFileSync(
    join(process.cwd(), "src/lib/vault/personal-vault-list-adapter.ts"),
    "utf8"
  );

  it("imports shared bulk hooks", () => {
    expect(entryListViewSrc).toContain('import { useBulkSelection');
    expect(entryListViewSrc).toContain('import { useBulkAction');
  });

  it("imports EntryListShell", () => {
    expect(entryListViewSrc).toContain('import { EntryListShell }');
  });

  it("uses personal scope", () => {
    // Personal scope is now returned by the adapter's bulkScope method.
    expect(personalAdapterSrc).toContain('type: "personal"');
  });

  it("wires up bulk actions", () => {
    expect(entryListViewSrc).toContain('requestAction("archive")');
    expect(entryListViewSrc).toContain('requestAction("unarchive")');
    expect(entryListViewSrc).toContain('requestAction("trash")');
  });
});
