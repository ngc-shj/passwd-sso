import { describe, expect, it } from "vitest";
import { normalizeAuditActionKey } from "./audit-action-key";

describe("normalizeAuditActionKey", () => {
  it("removes AuditLog prefix", () => {
    expect(normalizeAuditActionKey("AuditLog.ENTRY_CREATE")).toBe("ENTRY_CREATE");
  });

  it("keeps non-prefixed keys unchanged", () => {
    expect(normalizeAuditActionKey("ENTRY_CREATE")).toBe("ENTRY_CREATE");
  });
});
