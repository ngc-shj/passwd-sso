// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { useTeamPasswordFormModel } from "@/hooks/use-team-password-form-model";

const useTeamPasswordFormStateMock = vi.fn();
const useTeamAttachmentsMock = vi.fn();
const useTeamFoldersMock = vi.fn();
const useTeamPasswordFormLifecycleMock = vi.fn();
const useTeamPasswordFormControllerMock = vi.fn();

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/use-team-password-form-state", () => ({
  useTeamPasswordFormState: (...args: unknown[]) => useTeamPasswordFormStateMock(...args),
}));

vi.mock("@/hooks/use-team-attachments", () => ({
  useTeamAttachments: (...args: unknown[]) => useTeamAttachmentsMock(...args),
}));

vi.mock("@/hooks/use-team-folders", () => ({
  useTeamFolders: (...args: unknown[]) => useTeamFoldersMock(...args),
}));

vi.mock("@/hooks/use-team-password-form-lifecycle", () => ({
  useTeamPasswordFormLifecycle: (...args: unknown[]) => useTeamPasswordFormLifecycleMock(...args),
}));

vi.mock("@/hooks/use-team-password-form-controller", () => ({
  useTeamPasswordFormController: (...args: unknown[]) => useTeamPasswordFormControllerMock(...args),
}));

describe("useTeamPasswordFormModel", () => {
  beforeEach(() => {
    useTeamPasswordFormStateMock.mockReset();
    useTeamAttachmentsMock.mockReset();
    useTeamFoldersMock.mockReset();
    useTeamPasswordFormLifecycleMock.mockReset();
    useTeamPasswordFormControllerMock.mockReset();

    useTeamPasswordFormStateMock.mockReturnValue({
      values: {
        saving: false,
        title: "t",
        selectedTags: [],
        customFields: [],
        totp: null,
        showTotpInput: false,
        teamFolderId: null,
      },
      setters: {
        setTitle: vi.fn(),
        setSelectedTags: vi.fn(),
        setCustomFields: vi.fn(),
        setTotp: vi.fn(),
        setShowTotpInput: vi.fn(),
        setOrgFolderId: vi.fn(),
      },
    });
    useTeamAttachmentsMock.mockReturnValue({ attachments: [], setAttachments: vi.fn() });
    useTeamFoldersMock.mockReturnValue({ folders: [], fetchError: null });
    useTeamPasswordFormLifecycleMock.mockReturnValue({ handleOpenChange: vi.fn() });
    useTeamPasswordFormControllerMock.mockReturnValue({
      entryCopy: { dialogLabel: "x", titleLabel: "y", tagsTitle: "z" },
      entrySpecificFieldsProps: { a: 1 },
      handleSubmit: vi.fn(),
      hasChanges: false,
      submitDisabled: false,
    });
  });

  it("wires dependencies and exposes model values", () => {
    const { result } = renderHook(() =>
      useTeamPasswordFormModel({
        orgId: "org-1",
        open: true,
        onOpenChange: vi.fn(),
        onSaved: vi.fn(),
        entryType: ENTRY_TYPE.LOGIN,
        editData: null,
      }),
    );

    expect(useTeamPasswordFormStateMock).toHaveBeenCalledWith(null);
    expect(useTeamAttachmentsMock).toHaveBeenCalledWith(true, "org-1", undefined);
    expect(useTeamFoldersMock).toHaveBeenCalledWith(true, "org-1");
    expect(useTeamPasswordFormControllerMock).toHaveBeenCalledTimes(1);
    expect(result.current.formState.values.title).toBe("t");
    expect(result.current.entryCopy.dialogLabel).toBe("x");
    expect(result.current.hasChanges).toBe(false);
  });

  it("passes attachment setter into lifecycle setters", () => {
    const setAttachments = vi.fn();
    useTeamAttachmentsMock.mockReturnValue({ attachments: [], setAttachments });

    renderHook(() =>
      useTeamPasswordFormModel({
        orgId: "org-1",
        open: true,
        onOpenChange: vi.fn(),
        onSaved: vi.fn(),
        entryType: ENTRY_TYPE.LOGIN,
        editData: null,
      }),
    );

    const lifecycleArgs = useTeamPasswordFormLifecycleMock.mock.calls[0]?.[0] as
      | { setters?: { setAttachments?: unknown } }
      | undefined;
    expect(lifecycleArgs?.setters?.setAttachments).toBe(setAttachments);
  });

  it("prefers editData entryType and forwards derived kind flags to controller", () => {
    renderHook(() =>
      useTeamPasswordFormModel({
        orgId: "org-1",
        open: true,
        onOpenChange: vi.fn(),
        onSaved: vi.fn(),
        entryType: ENTRY_TYPE.LOGIN,
        editData: {
          id: "entry-1",
          entryType: ENTRY_TYPE.CREDIT_CARD,
          title: "t",
          username: null,
          password: "p",
          url: null,
          notes: null,
        },
      }),
    );

    const controllerArgs = useTeamPasswordFormControllerMock.mock.calls[0]?.[0] as
      | {
          effectiveEntryType?: string;
          entryKindState?: {
            entryKind?: string;
            isCreditCard?: boolean;
            isLoginEntry?: boolean;
          };
        }
      | undefined;

    expect(controllerArgs?.effectiveEntryType).toBe(ENTRY_TYPE.CREDIT_CARD);
    expect(controllerArgs?.entryKindState?.entryKind).toBe("creditCard");
    expect(controllerArgs?.entryKindState?.isCreditCard).toBe(true);
    expect(controllerArgs?.entryKindState?.isLoginEntry).toBe(false);
  });
});
