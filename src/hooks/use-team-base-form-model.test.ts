// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useTeamBaseFormModel,
  type UseTeamBaseFormModelInput,
} from "@/hooks/use-team-base-form-model";
import type { TeamEntryFormEditData } from "@/components/team/team-entry-form-types";
import type { TeamTagData } from "@/components/team/team-tag-input";

const { mockPolicy, mockGetTeamKeyInfo, mockBuildTeamEntryCopy, stableTranslations, stableTranslationBundle } = vi.hoisted(() => {
  const identity = (key: string) => key;
  return {
    mockPolicy: {
      minPasswordLength: 0,
      requireUppercase: false,
      requireLowercase: false,
      requireNumbers: false,
      requireSymbols: false,
      requireRepromptForAll: false,
      allowExport: true,
      allowSharing: true,
    },
    mockGetTeamKeyInfo: vi.fn(),
    mockBuildTeamEntryCopy: vi.fn((_arg: unknown) => ({
      dialogLabel: "dialog",
      titleLabel: "title",
      titlePlaceholder: "placeholder",
      notesLabel: "notes",
      notesPlaceholder: "notes-placeholder",
      tagsTitle: "tags",
    })),
    stableTranslationBundle: {
      t: identity,
      tc: identity,
    },
    stableTranslations: {
      t: identity,
      tn: identity,
      tcc: identity,
      ti: identity,
      tpk: identity,
      tba: identity,
      tsl: identity,
    },
  };
});

vi.mock("@/hooks/use-entry-form-translations", () => ({
  useEntryFormTranslations: () => stableTranslationBundle,
  toTeamLoginFormTranslations: () => stableTranslations,
}));

vi.mock("@/hooks/use-team-policy", () => ({
  useTeamPolicy: () => ({ policy: mockPolicy }),
}));

vi.mock("@/hooks/use-team-attachments", () => ({
  useTeamAttachments: () => ({
    attachments: [],
    setAttachments: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-team-folders", () => ({
  useTeamFolders: () => ({
    folders: [],
  }),
}));

vi.mock("@/lib/team-vault-context", () => ({
  useTeamVault: () => ({
    getTeamKeyInfo: mockGetTeamKeyInfo,
  }),
}));

vi.mock("@/components/team/team-entry-copy", () => ({
  buildTeamEntryCopy: (arg: unknown) => mockBuildTeamEntryCopy(arg),
}));

vi.mock("@/components/team/team-entry-copy-data", () => ({
  buildTeamEntryCopyData: () => ({}),
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const baseProps = () => ({
  teamId: "team-1",
  open: true,
  onOpenChange: vi.fn(),
  onSaved: vi.fn(),
});

const sampleTags: TeamTagData[] = [
  { id: "tag-1", name: "work", color: "#ff0000" },
  { id: "tag-2", name: "personal", color: null },
];

const sampleEditData: TeamEntryFormEditData = {
  id: "entry-1",
  title: "Edit Title",
  username: "user1",
  password: "secret",
  url: "https://example.com",
  notes: "Some notes",
  tags: [{ id: "tag-3", name: "edited", color: "#00ff00" }],
  teamFolderId: "folder-99",
  requireReprompt: true,
  expiresAt: "2026-12-31T00:00:00.000Z",
};

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("useTeamBaseFormModel", () => {
  beforeEach(() => {
    mockPolicy.minPasswordLength = 0;
    mockPolicy.requireUppercase = false;
    mockPolicy.requireLowercase = false;
    mockPolicy.requireNumbers = false;
    mockPolicy.requireSymbols = false;
    mockPolicy.requireRepromptForAll = false;
    mockPolicy.allowExport = true;
    mockPolicy.allowSharing = true;
    mockGetTeamKeyInfo.mockReset();
    mockBuildTeamEntryCopy.mockClear();
  });

  /* ---- existing test ---- */

  it("forces requireReprompt on when team policy requires it after mount", async () => {
    const { result, rerender } = renderHook(() =>
      useTeamBaseFormModel({
        teamId: "team-1",
        open: true,
        onOpenChange: vi.fn(),
        onSaved: vi.fn(),
      }),
    );

    expect(result.current.requireReprompt).toBe(false);

    mockPolicy.requireRepromptForAll = true;
    rerender();

    await waitFor(() => {
      expect(result.current.requireReprompt).toBe(true);
    });
  });

  /* ---- editData: initial values from editData ---- */

  describe("initial values when editData is provided", () => {
    it("uses editData title, notes, tags, teamFolderId, requireReprompt and expiresAt", () => {
      const { result } = renderHook(() =>
        useTeamBaseFormModel({
          ...baseProps(),
          editData: sampleEditData,
        }),
      );

      expect(result.current.title).toBe("Edit Title");
      expect(result.current.notes).toBe("Some notes");
      expect(result.current.selectedTags).toEqual([
        { id: "tag-3", name: "edited", color: "#00ff00" },
      ]);
      expect(result.current.teamFolderId).toBe("folder-99");
      expect(result.current.requireReprompt).toBe(true);
      expect(result.current.expiresAt).toBe("2026-12-31T00:00:00.000Z");
    });

    it("sets isEdit to true", () => {
      const { result } = renderHook(() =>
        useTeamBaseFormModel({
          ...baseProps(),
          editData: sampleEditData,
        }),
      );

      expect(result.current.isEdit).toBe(true);
    });

    it("uses editData.notes when notes is null", () => {
      const { result } = renderHook(() =>
        useTeamBaseFormModel({
          ...baseProps(),
          editData: { ...sampleEditData, notes: null },
        }),
      );

      expect(result.current.notes).toBe("");
    });

    it("uses editData values even when defaultFolderId and defaultTags are also provided", () => {
      const { result } = renderHook(() =>
        useTeamBaseFormModel({
          ...baseProps(),
          editData: sampleEditData,
          defaultFolderId: "folder-default",
          defaultTags: sampleTags,
        }),
      );

      // editData takes precedence over defaults
      expect(result.current.selectedTags).toEqual(sampleEditData.tags);
      expect(result.current.teamFolderId).toBe("folder-99");
    });
  });

  /* ---- no editData: defaults ---- */

  describe("initial values without editData", () => {
    it("uses empty defaults when no editData and no defaults provided", () => {
      const { result } = renderHook(() =>
        useTeamBaseFormModel(baseProps()),
      );

      expect(result.current.title).toBe("");
      expect(result.current.notes).toBe("");
      expect(result.current.selectedTags).toEqual([]);
      expect(result.current.teamFolderId).toBeNull();
      expect(result.current.requireReprompt).toBe(false);
      expect(result.current.expiresAt).toBeNull();
      expect(result.current.isEdit).toBe(false);
    });

    it("falls back to defaultFolderId when editData is absent", () => {
      const { result } = renderHook(() =>
        useTeamBaseFormModel({
          ...baseProps(),
          defaultFolderId: "folder-default",
        }),
      );

      expect(result.current.teamFolderId).toBe("folder-default");
    });

    it("falls back to defaultTags when editData is absent", () => {
      const { result } = renderHook(() =>
        useTeamBaseFormModel({
          ...baseProps(),
          defaultTags: sampleTags,
        }),
      );

      expect(result.current.selectedTags).toEqual(sampleTags);
    });

    it("falls back to both defaultFolderId and defaultTags together", () => {
      const { result } = renderHook(() =>
        useTeamBaseFormModel({
          ...baseProps(),
          defaultFolderId: "folder-abc",
          defaultTags: sampleTags,
        }),
      );

      expect(result.current.teamFolderId).toBe("folder-abc");
      expect(result.current.selectedTags).toEqual(sampleTags);
    });
  });

  /* ---- entryCopy memoization ---- */

  describe("entryCopy memoization", () => {
    it("does not recompute entryCopy on unrelated rerenders", () => {
      const { rerender } = renderHook(() =>
        useTeamBaseFormModel(baseProps()),
      );

      const callCountAfterMount = mockBuildTeamEntryCopy.mock.calls.length;

      // rerender with same props — entryCopy should be memoized
      rerender();

      // useMemo should not call buildTeamEntryCopy again
      expect(mockBuildTeamEntryCopy).toHaveBeenCalledTimes(callCountAfterMount);
    });

    it("recomputes entryCopy when entryType changes via editData", () => {
      const props: UseTeamBaseFormModelInput = {
        ...baseProps(),
        entryType: "LOGIN",
      };

      const { rerender } = renderHook(
        (p: UseTeamBaseFormModelInput) => useTeamBaseFormModel(p),
        { initialProps: props },
      );

      const callCountAfterMount = mockBuildTeamEntryCopy.mock.calls.length;

      // Change entryType by providing editData with a different entryType
      rerender({
        ...props,
        editData: {
          ...sampleEditData,
          entryType: "SECURE_NOTE",
        },
      });

      // buildTeamEntryCopy should have been called again due to entryKind change
      expect(mockBuildTeamEntryCopy.mock.calls.length).toBeGreaterThan(
        callCountAfterMount,
      );
    });

    it("recomputes entryCopy when switching from create to edit mode", () => {
      const props: UseTeamBaseFormModelInput = baseProps();

      const { rerender } = renderHook(
        (p: UseTeamBaseFormModelInput) => useTeamBaseFormModel(p),
        { initialProps: props },
      );

      const callCountAfterMount = mockBuildTeamEntryCopy.mock.calls.length;

      // Switch to edit mode — isEdit changes from false to true
      rerender({
        ...props,
        editData: sampleEditData,
      });

      expect(mockBuildTeamEntryCopy.mock.calls.length).toBeGreaterThan(
        callCountAfterMount,
      );
    });
  });
});
