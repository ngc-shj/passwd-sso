import { describe, expect, it } from "vitest";
import { buildOrgPasswordPresenterArgs } from "@/hooks/org-password-form-presenter-args";
import type { OrgPasswordFormState } from "@/hooks/use-org-password-form-state";

describe("buildOrgPasswordPresenterArgs", () => {
  it("maps entry kind state and translations into presenter args", () => {
    const formState = {} as OrgPasswordFormState;
    const args = buildOrgPasswordPresenterArgs({
      isEdit: true,
      entryKindState: {
        entryKind: "creditCard",
        isLoginEntry: false,
        isNote: false,
        isCreditCard: true,
        isIdentity: false,
        isPasskey: false,
      },
      translations: {
        t: (k) => k,
        ti: (k) => k,
        tn: (k) => k,
        tcc: (k) => k,
        tpk: (k) => k,
        tGen: (k) => k,
      },
      formState,
    });

    expect(args.isEdit).toBe(true);
    expect(args.entryKind).toBe("creditCard");
    expect(args.formState).toBe(formState);
    expect(args.t("x")).toBe("x");
    expect(args.tcc("y")).toBe("y");
  });
});
