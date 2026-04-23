import { describe, expect, it, vi } from "vitest";
import { getCommonTargetLabel } from "./audit-target-label";
import { AUDIT_ACTION } from "@/lib/constants";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit-target";

// Mock translation function: returns the key as a string (ignoring params)
function makeMockT() {
  const t = vi.fn((key: string, _params?: Record<string, unknown>) => key) as unknown as {
    (key: never, params?: Record<string, unknown>): string;
    has(key: never): boolean;
  };
  (t as unknown as { has: (key: never) => boolean }).has = () => true;
  return t;
}

const TARGET_TYPE = AUDIT_TARGET_TYPE.PASSWORD_ENTRY;
const TEAM_TARGET_TYPE = AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY;

describe("getCommonTargetLabel", () => {
  describe("ENTRY_BULK_TRASH", () => {
    it("extracts bulk trash metadata and calls t with correct params", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_BULK_TRASH,
        targetType: null,
        targetId: null,
        metadata: { requestedCount: 5, movedCount: 3 },
      };
      const result = getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(result).toBe("bulkTrashMeta");
      expect(t).toHaveBeenCalledWith("bulkTrashMeta" as never, {
        requestedCount: 5,
        movedCount: 3,
        notMovedCount: 2,
      });
    });

    it("uses 0 defaults when metadata fields are missing", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_BULK_TRASH,
        targetType: null,
        targetId: null,
        metadata: {},
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(t).toHaveBeenCalledWith("bulkTrashMeta" as never, {
        requestedCount: 0,
        movedCount: 0,
        notMovedCount: 0,
      });
    });

    it("clamps notMovedCount to 0 when movedCount > requestedCount", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_BULK_TRASH,
        targetType: null,
        targetId: null,
        metadata: { requestedCount: 2, movedCount: 5 },
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(t).toHaveBeenCalledWith("bulkTrashMeta" as never, expect.objectContaining({ notMovedCount: 0 }));
    });

    it("returns null when metadata is null", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_BULK_TRASH,
        targetType: null,
        targetId: null,
        metadata: null,
      };
      const result = getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(result).toBeNull();
    });
  });

  describe("ENTRY_EMPTY_TRASH", () => {
    it("extracts empty trash metadata", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_EMPTY_TRASH,
        targetType: null,
        targetId: null,
        metadata: { deletedCount: 7 },
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(t).toHaveBeenCalledWith("emptyTrashMeta" as never, { deletedCount: 7 });
    });

    it("returns null when metadata is null", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_EMPTY_TRASH,
        targetType: null,
        targetId: null,
        metadata: null,
      };
      expect(getCommonTargetLabel(t, log, {}, TARGET_TYPE)).toBeNull();
    });
  });

  describe("ENTRY_BULK_ARCHIVE", () => {
    it("extracts bulk archive metadata", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_BULK_ARCHIVE,
        targetType: null,
        targetId: null,
        metadata: { requestedCount: 4, archivedCount: 3 },
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(t).toHaveBeenCalledWith("bulkArchiveMeta" as never, {
        requestedCount: 4,
        archivedCount: 3,
        notArchivedCount: 1,
      });
    });
  });

  describe("ENTRY_BULK_UNARCHIVE", () => {
    it("extracts bulk unarchive metadata", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_BULK_UNARCHIVE,
        targetType: null,
        targetId: null,
        metadata: { requestedCount: 6, unarchivedCount: 4 },
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(t).toHaveBeenCalledWith("bulkUnarchiveMeta" as never, {
        requestedCount: 6,
        unarchivedCount: 4,
        alreadyActiveCount: 2,
      });
    });
  });

  describe("ENTRY_BULK_RESTORE", () => {
    it("extracts bulk restore metadata", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_BULK_RESTORE,
        targetType: null,
        targetId: null,
        metadata: { requestedCount: 3, restoredCount: 2 },
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(t).toHaveBeenCalledWith("bulkRestoreMeta" as never, {
        requestedCount: 3,
        restoredCount: 2,
        notRestoredCount: 1,
      });
    });
  });

  describe("ENTRY_IMPORT", () => {
    it("extracts import metadata with all fields", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_IMPORT,
        targetType: null,
        targetId: null,
        metadata: {
          requestedCount: 10,
          successCount: 8,
          failedCount: 2,
          filename: "passwords.csv",
          format: "csv",
          encrypted: false,
        },
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(t).toHaveBeenCalledWith("importMeta" as never, expect.objectContaining({
        requestedCount: 10,
        successCount: 8,
        failedCount: 2,
        filename: "passwords.csv",
        format: "csv",
        encrypted: "no",
      }));
    });

    it("handles encrypted=true by calling t(yes)", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_IMPORT,
        targetType: null,
        targetId: null,
        metadata: {
          requestedCount: 1,
          successCount: 1,
          failedCount: 0,
          filename: "vault.enc",
          format: "json",
          encrypted: true,
        },
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(t).toHaveBeenCalledWith("importMeta" as never, expect.objectContaining({ encrypted: "yes" }));
    });

    it("uses defaults when metadata fields are missing", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_IMPORT,
        targetType: null,
        targetId: null,
        metadata: {},
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(t).toHaveBeenCalledWith("importMeta" as never, expect.objectContaining({
        requestedCount: 0,
        successCount: 0,
        failedCount: 0,
        filename: "-",
        format: "-",
      }));
    });
  });

  describe("ENTRY_EXPORT with exportMeta key", () => {
    it("extracts export metadata including teams (personal)", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_EXPORT,
        targetType: null,
        targetId: null,
        metadata: {
          filename: "export.json",
          format: "json",
          entryCount: 15,
          encrypted: false,
          includeTeams: true,
        },
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE, "exportMeta");
      expect(t).toHaveBeenCalledWith("exportMeta" as never, expect.objectContaining({
        filename: "export.json",
        format: "json",
        entryCount: 15,
        encrypted: "no",
        teams: "included",
      }));
    });

    it("handles encrypted=true in export", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_EXPORT,
        targetType: null,
        targetId: null,
        metadata: { filename: "f.enc", format: "csv", entryCount: 5, encrypted: true, includeTeams: false },
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE, "exportMeta");
      expect(t).toHaveBeenCalledWith("exportMeta" as never, expect.objectContaining({
        encrypted: "yes",
        teams: "notIncluded",
      }));
    });

    it("uses '-' when filename is null", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_EXPORT,
        targetType: null,
        targetId: null,
        metadata: { format: "json", entryCount: 0, encrypted: false, includeTeams: false },
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE, "exportMeta");
      expect(t).toHaveBeenCalledWith("exportMeta" as never, expect.objectContaining({ filename: "-" }));
    });
  });

  describe("ENTRY_EXPORT with exportMetaTeam key", () => {
    it("calls exportMetaTeam translation key (team export)", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_EXPORT,
        targetType: null,
        targetId: null,
        metadata: {
          filename: "team-export.json",
          format: "json",
          entryCount: 8,
          encrypted: false,
        },
      };
      getCommonTargetLabel(t, log, {}, TEAM_TARGET_TYPE, "exportMetaTeam");
      expect(t).toHaveBeenCalledWith("exportMetaTeam" as never, expect.objectContaining({
        filename: "team-export.json",
        format: "json",
        entryCount: 8,
        encrypted: "no",
      }));
    });
  });

  describe("entry name resolution", () => {
    it("resolves entry name from Map", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_UPDATE,
        targetType: TARGET_TYPE,
        targetId: "entry-id-1",
        metadata: null,
      };
      const entryNames = new Map([["entry-id-1", "My Password"]]);
      const result = getCommonTargetLabel(t, log, entryNames, TARGET_TYPE);
      expect(result).toBe("My Password");
    });

    it("resolves entry name from Record", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_UPDATE,
        targetType: TARGET_TYPE,
        targetId: "entry-id-2",
        metadata: null,
      };
      const entryNames = { "entry-id-2": "GitHub" };
      const result = getCommonTargetLabel(t, log, entryNames, TARGET_TYPE);
      expect(result).toBe("GitHub");
    });

    it("falls back to deletedEntry when name not found in Map", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_UPDATE,
        targetType: TARGET_TYPE,
        targetId: "missing-id",
        metadata: null,
      };
      const result = getCommonTargetLabel(t, log, new Map(), TARGET_TYPE);
      expect(result).toBe("deletedEntry");
    });

    it("falls back to deletedEntry when name not found in Record", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_UPDATE,
        targetType: TARGET_TYPE,
        targetId: "missing-id",
        metadata: null,
      };
      const result = getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(result).toBe("deletedEntry");
    });
  });

  describe("permanent delete annotation", () => {
    it("appends permanentDelete annotation for ENTRY_PERMANENT_DELETE action", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_PERMANENT_DELETE,
        targetType: TARGET_TYPE,
        targetId: "entry-id-3",
        metadata: null,
      };
      const entryNames = new Map([["entry-id-3", "Secret Key"]]);
      const result = getCommonTargetLabel(t, log, entryNames, TARGET_TYPE);
      expect(result).toBe("Secret Key（permanentDelete）");
    });

    it("appends permanentDelete annotation when ENTRY_DELETE with permanent=true in metadata", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_DELETE,
        targetType: TARGET_TYPE,
        targetId: "entry-id-4",
        metadata: { permanent: true },
      };
      const entryNames = new Map([["entry-id-4", "Old Entry"]]);
      const result = getCommonTargetLabel(t, log, entryNames, TARGET_TYPE);
      expect(result).toBe("Old Entry（permanentDelete）");
    });

    it("does not append permanentDelete for regular ENTRY_DELETE", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_DELETE,
        targetType: TARGET_TYPE,
        targetId: "entry-id-5",
        metadata: { permanent: false },
      };
      const entryNames = new Map([["entry-id-5", "Normal Entry"]]);
      const result = getCommonTargetLabel(t, log, entryNames, TARGET_TYPE);
      expect(result).toBe("Normal Entry");
    });
  });

  describe("attachment filename", () => {
    it("returns filename string from metadata when targetType does not match", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ATTACHMENT_UPLOAD,
        targetType: AUDIT_TARGET_TYPE.ATTACHMENT,
        targetId: "att-id-1",
        metadata: { filename: "document.pdf" },
      };
      const result = getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(result).toBe("document.pdf");
    });
  });

  describe("role change", () => {
    it("calls roleChange translation with from/to params", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.TEAM_ROLE_UPDATE,
        targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
        targetId: "member-id-1",
        metadata: { previousRole: "MEMBER", newRole: "ADMIN" },
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(t).toHaveBeenCalledWith("roleChange" as never, { from: "MEMBER", to: "ADMIN" });
    });

    it("returns null when role metadata fields are missing", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.TEAM_ROLE_UPDATE,
        targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
        targetId: "member-id-2",
        metadata: {},
      };
      const result = getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(result).toBeNull();
    });
  });

  describe("unknown / unmatched actions", () => {
    it("returns null for unhandled action with no matching conditions", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.AUTH_LOGIN,
        targetType: null,
        targetId: null,
        metadata: null,
      };
      const result = getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(result).toBeNull();
    });

    it("returns null when targetType does not match and no metadata", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_CREATE,
        targetType: AUDIT_TARGET_TYPE.FOLDER,
        targetId: "folder-id",
        metadata: null,
      };
      const result = getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(result).toBeNull();
    });

    it("returns null when targetId is null", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_CREATE,
        targetType: TARGET_TYPE,
        targetId: null,
        metadata: null,
      };
      const result = getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(result).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("uses default exportKey=exportMeta when not specified", () => {
      const t = makeMockT();
      const log = {
        action: AUDIT_ACTION.ENTRY_EXPORT,
        targetType: null,
        targetId: null,
        metadata: { filename: "f.json", format: "json", entryCount: 1, encrypted: false, includeTeams: false },
      };
      getCommonTargetLabel(t, log, {}, TARGET_TYPE);
      expect(t).toHaveBeenCalledWith("exportMeta" as never, expect.any(Object));
    });
  });
});
