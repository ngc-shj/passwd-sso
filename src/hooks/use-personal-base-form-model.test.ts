// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePersonalBaseFormModel } from "@/hooks/use-personal-base-form-model";
import type { TagData } from "@/components/tags/tag-input";

/* ------------------------------------------------------------------ */
/*  Hoisted mocks                                                      */
/* ------------------------------------------------------------------ */

const {
  mockEncryptionKey,
  mockUserId,
  mockFolders,
  mockRouterBack,
  mockExecutePersonalEntrySubmit,
  mockUseVault,
} = vi.hoisted(() => ({
  mockEncryptionKey: { fake: "CryptoKey" } as unknown as CryptoKey,
  mockUserId: "user-1",
  mockFolders: [{ id: "f-1", name: "Folder 1", parentId: null, depth: 0 }],
  mockRouterBack: vi.fn(),
  mockExecutePersonalEntrySubmit: vi.fn().mockResolvedValue(undefined),
  mockUseVault: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  Module mocks                                                       */
/* ------------------------------------------------------------------ */

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ back: mockRouterBack }),
}));

vi.mock("@/lib/vault-context", () => ({
  useVault: mockUseVault,
}));

vi.mock("@/hooks/use-personal-folders", () => ({
  usePersonalFolders: () => ({
    folders: mockFolders,
  }),
}));

vi.mock("@/components/passwords/personal-entry-submit", () => ({
  executePersonalEntrySubmit: mockExecutePersonalEntrySubmit,
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const TAG_A: TagData = { id: "t-1", name: "Work", color: "#ff0000" };
const TAG_B: TagData = { id: "t-2", name: "Personal", color: null };

function makeTranslator() {
  return ((key: string) => key) as unknown as Parameters<
    ReturnType<typeof usePersonalBaseFormModel>["submitEntry"]
  > extends [infer A]
    ? A extends { t: infer T }
      ? T
      : never
    : never;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("usePersonalBaseFormModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseVault.mockReturnValue({
      encryptionKey: mockEncryptionKey,
      userId: mockUserId,
    });
  });

  /* ────────────────────────────────────────────────────────────────── */
  /*  Initial state                                                     */
  /* ────────────────────────────────────────────────────────────────── */

  describe("initial state", () => {
    it("returns default initial values when no options given", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({ mode: "create" }),
      );

      expect(result.current.title).toBe("");
      expect(result.current.selectedTags).toEqual([]);
      expect(result.current.folderId).toBeNull();
      expect(result.current.requireReprompt).toBe(false);
      expect(result.current.expiresAt).toBeNull();
      expect(result.current.submitting).toBe(false);
      expect(result.current.isDialogVariant).toBe(false);
      expect(result.current.folders).toEqual(mockFolders);
    });

    it("uses initialTitle / initialTags / initialFolderId when provided", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({
          mode: "edit",
          initialTitle: "My Entry",
          initialTags: [TAG_A],
          initialFolderId: "f-1",
          initialRequireReprompt: true,
          initialExpiresAt: "2026-12-31",
        }),
      );

      expect(result.current.title).toBe("My Entry");
      expect(result.current.selectedTags).toEqual([TAG_A]);
      expect(result.current.folderId).toBe("f-1");
      expect(result.current.requireReprompt).toBe(true);
      expect(result.current.expiresAt).toBe("2026-12-31");
    });

    it("isDialogVariant is true when variant='dialog'", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({ mode: "create", variant: "dialog" }),
      );

      expect(result.current.isDialogVariant).toBe(true);
    });
  });

  /* ────────────────────────────────────────────────────────────────── */
  /*  defaultTags / defaultFolderId fallback                            */
  /* ────────────────────────────────────────────────────────────────── */

  describe("defaultTags / defaultFolderId fallback", () => {
    it("uses defaultTags when initialTags is not provided", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({
          mode: "create",
          defaultTags: [TAG_B],
        }),
      );

      expect(result.current.selectedTags).toEqual([TAG_B]);
    });

    it("prefers initialTags over defaultTags", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({
          mode: "create",
          initialTags: [TAG_A],
          defaultTags: [TAG_B],
        }),
      );

      expect(result.current.selectedTags).toEqual([TAG_A]);
    });

    it("uses defaultFolderId when initialFolderId is not provided", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({
          mode: "create",
          defaultFolderId: "f-default",
        }),
      );

      expect(result.current.folderId).toBe("f-default");
    });

    it("prefers initialFolderId over defaultFolderId", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({
          mode: "create",
          initialFolderId: "f-initial",
          defaultFolderId: "f-default",
        }),
      );

      expect(result.current.folderId).toBe("f-initial");
    });
  });

  /* ────────────────────────────────────────────────────────────────── */
  /*  handleCancel / handleBack — variant behaviour                     */
  /* ────────────────────────────────────────────────────────────────── */

  describe("handleCancel / handleBack with variant='page'", () => {
    it("handleCancel calls router.back when variant is page", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({ mode: "create", variant: "page" }),
      );

      act(() => result.current.handleCancel());
      expect(mockRouterBack).toHaveBeenCalledTimes(1);
    });

    it("handleBack always calls router.back", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({ mode: "create", variant: "page" }),
      );

      act(() => result.current.handleBack());
      expect(mockRouterBack).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleCancel / handleBack with variant='dialog'", () => {
    it("handleCancel calls onCancel callback instead of router.back", () => {
      const onCancel = vi.fn();
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({
          mode: "create",
          variant: "dialog",
          onCancel,
        }),
      );

      act(() => result.current.handleCancel());
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(mockRouterBack).not.toHaveBeenCalled();
    });

    it("handleCancel falls back to router.back when no onCancel is given even in dialog variant", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({
          mode: "create",
          variant: "dialog",
        }),
      );

      act(() => result.current.handleCancel());
      expect(mockRouterBack).toHaveBeenCalledTimes(1);
    });

    it("handleBack calls router.back regardless of variant", () => {
      const onCancel = vi.fn();
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({
          mode: "create",
          variant: "dialog",
          onCancel,
        }),
      );

      act(() => result.current.handleBack());
      expect(mockRouterBack).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  /* ────────────────────────────────────────────────────────────────── */
  /*  submitEntry                                                       */
  /* ────────────────────────────────────────────────────────────────── */

  describe("submitEntry", () => {
    it("delegates to executePersonalEntrySubmit with correct args", async () => {
      const onSaved = vi.fn();
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({
          mode: "create",
          initialTags: [TAG_A],
          initialFolderId: null,
          onSaved,
        }),
      );

      await act(async () => {
        await result.current.submitEntry({
          t: makeTranslator(),
          fullBlob: "encrypted-full",
          overviewBlob: "encrypted-overview",
          entryType: "login" as never,
        });
      });

      expect(mockExecutePersonalEntrySubmit).toHaveBeenCalledTimes(1);
      const args = mockExecutePersonalEntrySubmit.mock.calls[0][0];
      expect(args.mode).toBe("create");
      expect(args.encryptionKey).toBe(mockEncryptionKey);
      expect(args.fullBlob).toBe("encrypted-full");
      expect(args.overviewBlob).toBe("encrypted-overview");
      expect(args.tagIds).toEqual(["t-1"]);
      expect(args.onSaved).toBe(onSaved);
    });

    it("passes initialId and userId for edit mode", async () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({
          mode: "edit",
          initialId: "entry-42",
        }),
      );

      await act(async () => {
        await result.current.submitEntry({
          t: makeTranslator(),
          fullBlob: "blob-full",
          overviewBlob: "blob-overview",
          entryType: "login" as never,
        });
      });

      const args = mockExecutePersonalEntrySubmit.mock.calls[0][0];
      expect(args.mode).toBe("edit");
      expect(args.initialId).toBe("entry-42");
      expect(args.userId).toBe(mockUserId);
    });

    it("returns early without calling execute when encryptionKey is null", async () => {
      mockUseVault.mockReturnValue({
        encryptionKey: null,
        userId: mockUserId,
      });

      const { result } = renderHook(() =>
        usePersonalBaseFormModel({ mode: "create" }),
      );

      await act(async () => {
        await result.current.submitEntry({
          t: makeTranslator(),
          fullBlob: "blob",
          overviewBlob: "overview",
          entryType: "login" as never,
        });
      });

      expect(mockExecutePersonalEntrySubmit).not.toHaveBeenCalled();
    });

    it("returns early without calling execute when userId is null", async () => {
      mockUseVault.mockReturnValue({
        encryptionKey: mockEncryptionKey,
        userId: null,
      });

      const { result } = renderHook(() =>
        usePersonalBaseFormModel({ mode: "create" }),
      );

      await act(async () => {
        await result.current.submitEntry({
          t: makeTranslator(),
          fullBlob: "blob",
          overviewBlob: "overview",
          entryType: "login" as never,
        });
      });

      expect(mockExecutePersonalEntrySubmit).not.toHaveBeenCalled();
    });

    it("sends current folderId and requireReprompt state", async () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({
          mode: "create",
          initialFolderId: "f-1",
          initialRequireReprompt: true,
          initialExpiresAt: "2026-06-30",
        }),
      );

      await act(async () => {
        await result.current.submitEntry({
          t: makeTranslator(),
          fullBlob: "fb",
          overviewBlob: "ob",
          entryType: "login" as never,
        });
      });

      const args = mockExecutePersonalEntrySubmit.mock.calls[0][0];
      expect(args.folderId).toBe("f-1");
      expect(args.requireReprompt).toBe(true);
      expect(args.expiresAt).toBe("2026-06-30");
    });
  });

  /* ────────────────────────────────────────────────────────────────── */
  /*  State setters                                                     */
  /* ────────────────────────────────────────────────────────────────── */

  describe("state setters", () => {
    it("setTitle updates title", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({ mode: "create" }),
      );

      act(() => result.current.setTitle("New Title"));
      expect(result.current.title).toBe("New Title");
    });

    it("setSelectedTags updates selectedTags", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({ mode: "create" }),
      );

      act(() => result.current.setSelectedTags([TAG_A, TAG_B]));
      expect(result.current.selectedTags).toEqual([TAG_A, TAG_B]);
    });

    it("setFolderId updates folderId", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({ mode: "create" }),
      );

      act(() => result.current.setFolderId("f-2"));
      expect(result.current.folderId).toBe("f-2");
    });

    it("setRequireReprompt updates requireReprompt", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({ mode: "create" }),
      );

      act(() => result.current.setRequireReprompt(true));
      expect(result.current.requireReprompt).toBe(true);
    });

    it("setExpiresAt updates expiresAt", () => {
      const { result } = renderHook(() =>
        usePersonalBaseFormModel({ mode: "create" }),
      );

      act(() => result.current.setExpiresAt("2027-01-01"));
      expect(result.current.expiresAt).toBe("2027-01-01");
    });
  });
});
