// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTeamLoginFormModel } from "@/hooks/use-team-login-form-model";

const {
  mockPolicy,
  mockGetTeamKeyInfo,
  mockOnOpenChange,
  mockOnSaved,
} = vi.hoisted(() => ({
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
  mockOnOpenChange: vi.fn(),
  mockOnSaved: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/use-entry-form-translations", () => ({
  useEntryFormTranslations: () => ({
    t: (key: string) => key,
    tc: (key: string) => key,
    tGen: (key: string) => key,
    ttm: (key: string) => key,
  }),
  toTeamLoginFormTranslations: () => ({
    t: (key: string) => key,
    tn: (key: string) => key,
    tcc: (key: string) => key,
    ti: (key: string) => key,
    tpk: (key: string) => key,
    tba: (key: string) => key,
    tsl: (key: string) => key,
  }),
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
  buildTeamEntryCopy: () => ({
    dialogLabel: "dialog",
    titleLabel: "title",
    titlePlaceholder: "placeholder",
    notesLabel: "notes",
    notesPlaceholder: "notes-placeholder",
    tagsTitle: "tags",
  }),
}));

vi.mock("@/components/team/team-entry-copy-data", () => ({
  buildTeamEntryCopyData: () => ({}),
}));

describe("useTeamLoginFormModel", () => {
  const baseProps = {
    teamId: "team-1",
    open: true,
    onOpenChange: mockOnOpenChange,
    onSaved: mockOnSaved,
  };

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
    mockOnOpenChange.mockReset();
    mockOnSaved.mockReset();
  });

  it("returns correct structure without editData", () => {
    const { result } = renderHook(() =>
      useTeamLoginFormModel(baseProps),
    );

    // base fields
    expect(result.current.base).toBeDefined();
    expect(result.current.base.title).toBe("");
    expect(result.current.base.notes).toBe("");
    expect(result.current.base.saving).toBe(false);

    // login state
    expect(result.current.loginState.username).toBe("");
    expect(result.current.loginState.password).toBe("");
    expect(result.current.loginState.url).toBe("");
    expect(result.current.loginState.showPassword).toBe(false);
    expect(result.current.loginState.showGenerator).toBe(false);

    // presenter output
    expect(result.current.loginMainFieldsProps).toBeDefined();

    // section props
    expect(result.current.tagsAndFolderProps).toBeDefined();
    expect(result.current.customFieldsTotpProps).toBeDefined();
    expect(result.current.repromptSectionProps).toBeDefined();
    expect(result.current.expirationSectionProps).toBeDefined();
    expect(result.current.actionBarProps).toBeDefined();

    // controller
    expect(typeof result.current.handleFormSubmit).toBe("function");
  });

  it("populates initial values from editData", () => {
    const { result } = renderHook(() =>
      useTeamLoginFormModel({
        ...baseProps,
        editData: {
          id: "entry-1",
          title: "GitHub",
          username: "user@example.com",
          password: "secret123",
          url: "https://github.com",
          notes: "my note",
          tags: [{ id: "t1", name: "Dev", color: "#ff0000" }],
          teamFolderId: "folder-1",
          requireReprompt: true,
          totp: { secret: "ABCDEF", digits: 6, period: 30 },
          customFields: [{ label: "key", value: "val", type: "text" as const }],
        },
      }),
    );

    expect(result.current.base.title).toBe("GitHub");
    expect(result.current.base.notes).toBe("my note");
    expect(result.current.base.selectedTags).toEqual([
      { id: "t1", name: "Dev", color: "#ff0000" },
    ]);
    expect(result.current.base.teamFolderId).toBe("folder-1");
    expect(result.current.base.requireReprompt).toBe(true);
    expect(result.current.loginState.username).toBe("user@example.com");
    expect(result.current.loginState.password).toBe("secret123");
    expect(result.current.loginState.url).toBe("https://github.com");
    expect(result.current.loginState.totp).toEqual({
      secret: "ABCDEF",
      digits: 6,
      period: 30,
    });
    expect(result.current.loginState.customFields).toEqual([
      { label: "key", value: "val", type: "text" },
    ]);
  });

  it("passes through teamId and editData to return value", () => {
    const editData = {
      id: "entry-2",
      title: "Test",
      username: "u",
      password: "p",
      url: null,
      notes: null,
    };
    const { result } = renderHook(() =>
      useTeamLoginFormModel({
        ...baseProps,
        editData,
      }),
    );

    expect(result.current.teamId).toBe("team-1");
    expect(result.current.editData).toBe(editData);
  });

  it("applies defaultFolderId and defaultTags when no editData", () => {
    const defaultTags = [{ id: "t1", name: "Default", color: null }];
    const { result } = renderHook(() =>
      useTeamLoginFormModel({
        ...baseProps,
        defaultFolderId: "default-folder",
        defaultTags,
      }),
    );

    expect(result.current.base.teamFolderId).toBe("default-folder");
    expect(result.current.base.selectedTags).toEqual(defaultTags);
  });
});
