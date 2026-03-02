// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTeamBaseFormModel } from "@/hooks/use-team-base-form-model";

const { mockPolicy, mockGetTeamKeyInfo } = vi.hoisted(() => ({
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
}));

vi.mock("@/hooks/use-entry-form-translations", () => ({
  useEntryFormTranslations: () => ({
    t: (key: string) => key,
    tc: (key: string) => key,
  }),
  toTeamPasswordFormTranslations: () => ({
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
  });

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
});
