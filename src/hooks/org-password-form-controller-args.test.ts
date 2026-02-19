import { describe, expect, it, vi } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { getOrgEntryKindState } from "@/components/org/org-entry-kind";
import { buildOrgPasswordControllerArgs } from "@/hooks/org-password-form-controller-args";
import type { OrgPasswordFormTranslations } from "@/hooks/org-password-form-translations";
import type { OrgPasswordFormState } from "@/hooks/use-org-password-form-state";

describe("buildOrgPasswordControllerArgs", () => {
  it("maps model state into controller args payload", () => {
    const onSaved = vi.fn();
    const handleOpenChange = vi.fn();
    const args = buildOrgPasswordControllerArgs({
      orgId: "org-1",
      onSaved,
      isEdit: false,
      editData: null,
      effectiveEntryType: ENTRY_TYPE.LOGIN,
      entryKindState: getOrgEntryKindState(ENTRY_TYPE.LOGIN),
      translations: {
        t: (key) => key,
        ti: (key) => key,
        tn: (key) => key,
        tcc: (key) => key,
        tpk: (key) => key,
        tGen: (key) => key,
      } satisfies OrgPasswordFormTranslations,
      formState: {} as OrgPasswordFormState,
      handleOpenChange,
    });

    expect(args.orgId).toBe("org-1");
    expect(args.onSaved).toBe(onSaved);
    expect(args.isEdit).toBe(false);
    expect(args.editData).toBeNull();
    expect(args.effectiveEntryType).toBe(ENTRY_TYPE.LOGIN);
    expect(args.handleOpenChange).toBe(handleOpenChange);
  });

  it("keeps editData undefined when omitted", () => {
    const args = buildOrgPasswordControllerArgs({
      orgId: "org-1",
      onSaved: vi.fn(),
      isEdit: false,
      effectiveEntryType: ENTRY_TYPE.LOGIN,
      entryKindState: getOrgEntryKindState(ENTRY_TYPE.LOGIN),
      translations: {
        t: (key) => key,
        ti: (key) => key,
        tn: (key) => key,
        tcc: (key) => key,
        tpk: (key) => key,
        tGen: (key) => key,
      } satisfies OrgPasswordFormTranslations,
      formState: {} as OrgPasswordFormState,
      handleOpenChange: vi.fn(),
    });

    expect(args.editData).toBeUndefined();
  });
});
