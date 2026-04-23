import { describe, expect, it, vi } from "vitest";
import { getActionLabel } from "./audit-action-label";
import { AUDIT_ACTION } from "@/lib/constants";

// Mock translation function: returns the key as a string
function makeMockT() {
  const t = vi.fn((key: string) => key) as unknown as {
    (key: never): string;
    has(key: never): boolean;
  };
  (t as unknown as { has: (key: never) => boolean }).has = () => true;
  return t;
}

describe("getActionLabel", () => {
  it("returns ENTRY_BULK_TRASH translation key", () => {
    const t = makeMockT();
    const result = getActionLabel(t, AUDIT_ACTION.ENTRY_BULK_TRASH, () => "fallback");
    expect(result).toBe("ENTRY_BULK_TRASH");
  });

  it("returns ENTRY_EMPTY_TRASH translation key", () => {
    const t = makeMockT();
    const result = getActionLabel(t, AUDIT_ACTION.ENTRY_EMPTY_TRASH, () => "fallback");
    expect(result).toBe("ENTRY_EMPTY_TRASH");
  });

  it("returns ENTRY_BULK_ARCHIVE translation key", () => {
    const t = makeMockT();
    const result = getActionLabel(t, AUDIT_ACTION.ENTRY_BULK_ARCHIVE, () => "fallback");
    expect(result).toBe("ENTRY_BULK_ARCHIVE");
  });

  it("returns ENTRY_BULK_UNARCHIVE translation key", () => {
    const t = makeMockT();
    const result = getActionLabel(t, AUDIT_ACTION.ENTRY_BULK_UNARCHIVE, () => "fallback");
    expect(result).toBe("ENTRY_BULK_UNARCHIVE");
  });

  it("returns ENTRY_BULK_RESTORE translation key", () => {
    const t = makeMockT();
    const result = getActionLabel(t, AUDIT_ACTION.ENTRY_BULK_RESTORE, () => "fallback");
    expect(result).toBe("ENTRY_BULK_RESTORE");
  });

  it("returns ENTRY_TRASH translation key", () => {
    const t = makeMockT();
    const result = getActionLabel(t, AUDIT_ACTION.ENTRY_TRASH, () => "fallback");
    expect(result).toBe("ENTRY_TRASH");
  });

  it("returns ENTRY_PERMANENT_DELETE translation key", () => {
    const t = makeMockT();
    const result = getActionLabel(t, AUDIT_ACTION.ENTRY_PERMANENT_DELETE, () => "fallback");
    expect(result).toBe("ENTRY_PERMANENT_DELETE");
  });

  it("falls through to actionLabel callback for unhandled actions", () => {
    const t = makeMockT();
    const actionLabel = vi.fn(() => "resolved-label");
    const result = getActionLabel(t, AUDIT_ACTION.ENTRY_CREATE, actionLabel);
    expect(result).toBe("resolved-label");
    expect(actionLabel).toHaveBeenCalledWith(AUDIT_ACTION.ENTRY_CREATE);
  });

  it("falls through to actionLabel callback for AUTH_LOGIN", () => {
    const t = makeMockT();
    const actionLabel = vi.fn((action: string) => `label:${action}`);
    const result = getActionLabel(t, AUDIT_ACTION.AUTH_LOGIN, actionLabel);
    expect(result).toBe("label:AUTH_LOGIN");
  });

  it("falls through to actionLabel callback for unknown action string", () => {
    const t = makeMockT();
    const actionLabel = vi.fn(() => "unknown-fallback");
    const result = getActionLabel(t, "TOTALLY_UNKNOWN_ACTION", actionLabel);
    expect(result).toBe("unknown-fallback");
    expect(actionLabel).toHaveBeenCalledWith("TOTALLY_UNKNOWN_ACTION");
  });

  it("does not call t for default cases", () => {
    const t = makeMockT();
    getActionLabel(t, AUDIT_ACTION.ENTRY_UPDATE, () => "x");
    expect(t).not.toHaveBeenCalled();
  });
});
