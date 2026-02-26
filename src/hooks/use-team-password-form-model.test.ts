// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { useOrgPasswordFormModel } from "@/hooks/use-team-password-form-model";

const useOrgPasswordFormStateMock = vi.fn();
const useOrgAttachmentsMock = vi.fn();
const useOrgFoldersMock = vi.fn();
const useOrgPasswordFormLifecycleMock = vi.fn();
const useOrgPasswordFormControllerMock = vi.fn();

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/use-team-password-form-state", () => ({
  useOrgPasswordFormState: (...args: unknown[]) => useOrgPasswordFormStateMock(...args),
}));

vi.mock("@/hooks/use-team-attachments", () => ({
  useOrgAttachments: (...args: unknown[]) => useOrgAttachmentsMock(...args),
}));

vi.mock("@/hooks/use-team-folders", () => ({
  useOrgFolders: (...args: unknown[]) => useOrgFoldersMock(...args),
}));

vi.mock("@/hooks/use-team-password-form-lifecycle", () => ({
  useOrgPasswordFormLifecycle: (...args: unknown[]) => useOrgPasswordFormLifecycleMock(...args),
}));

vi.mock("@/hooks/use-team-password-form-controller", () => ({
  useOrgPasswordFormController: (...args: unknown[]) => useOrgPasswordFormControllerMock(...args),
}));

describe("useOrgPasswordFormModel", () => {
  beforeEach(() => {
    useOrgPasswordFormStateMock.mockReset();
    useOrgAttachmentsMock.mockReset();
    useOrgFoldersMock.mockReset();
    useOrgPasswordFormLifecycleMock.mockReset();
    useOrgPasswordFormControllerMock.mockReset();

    useOrgPasswordFormStateMock.mockReturnValue({
      values: {
        saving: false,
        title: "t",
        selectedTags: [],
        customFields: [],
        totp: null,
        showTotpInput: false,
        orgFolderId: null,
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
    useOrgAttachmentsMock.mockReturnValue({ attachments: [], setAttachments: vi.fn() });
    useOrgFoldersMock.mockReturnValue([]);
    useOrgPasswordFormLifecycleMock.mockReturnValue({ handleOpenChange: vi.fn() });
    useOrgPasswordFormControllerMock.mockReturnValue({
      entryCopy: { dialogLabel: "x", titleLabel: "y", tagsTitle: "z" },
      entrySpecificFieldsProps: { a: 1 },
      handleSubmit: vi.fn(),
      hasChanges: false,
      submitDisabled: false,
    });
  });

  it("wires dependencies and exposes model values", () => {
    const { result } = renderHook(() =>
      useOrgPasswordFormModel({
        orgId: "org-1",
        open: true,
        onOpenChange: vi.fn(),
        onSaved: vi.fn(),
        entryType: ENTRY_TYPE.LOGIN,
        editData: null,
      }),
    );

    expect(useOrgPasswordFormStateMock).toHaveBeenCalledWith(null);
    expect(useOrgAttachmentsMock).toHaveBeenCalledWith(true, "org-1", undefined);
    expect(useOrgFoldersMock).toHaveBeenCalledWith(true, "org-1");
    expect(useOrgPasswordFormControllerMock).toHaveBeenCalledTimes(1);
    expect(result.current.formState.values.title).toBe("t");
    expect(result.current.entryCopy.dialogLabel).toBe("x");
    expect(result.current.hasChanges).toBe(false);
  });

  it("passes attachment setter into lifecycle setters", () => {
    const setAttachments = vi.fn();
    useOrgAttachmentsMock.mockReturnValue({ attachments: [], setAttachments });

    renderHook(() =>
      useOrgPasswordFormModel({
        orgId: "org-1",
        open: true,
        onOpenChange: vi.fn(),
        onSaved: vi.fn(),
        entryType: ENTRY_TYPE.LOGIN,
        editData: null,
      }),
    );

    const lifecycleArgs = useOrgPasswordFormLifecycleMock.mock.calls[0]?.[0] as
      | { setters?: { setAttachments?: unknown } }
      | undefined;
    expect(lifecycleArgs?.setters?.setAttachments).toBe(setAttachments);
  });

  it("prefers editData entryType and forwards derived kind flags to controller", () => {
    renderHook(() =>
      useOrgPasswordFormModel({
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

    const controllerArgs = useOrgPasswordFormControllerMock.mock.calls[0]?.[0] as
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
