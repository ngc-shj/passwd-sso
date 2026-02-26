import { describe, expect, it } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import { getOrgEntryKindState } from "@/components/team/team-entry-kind";

describe("getOrgEntryKindState", () => {
  it("maps LOGIN to password kind", () => {
    const result = getOrgEntryKindState(ENTRY_TYPE.LOGIN);
    expect(result.entryKind).toBe("password");
    expect(result.isLoginEntry).toBe(true);
    expect(result.isPasskey).toBe(false);
  });

  it("maps PASSKEY to passkey kind", () => {
    const result = getOrgEntryKindState(ENTRY_TYPE.PASSKEY);
    expect(result.entryKind).toBe("passkey");
    expect(result.isPasskey).toBe(true);
    expect(result.isLoginEntry).toBe(false);
  });

  it("maps CREDIT_CARD to credit card kind", () => {
    const result = getOrgEntryKindState(ENTRY_TYPE.CREDIT_CARD);
    expect(result.entryKind).toBe("creditCard");
    expect(result.isCreditCard).toBe(true);
    expect(result.isLoginEntry).toBe(false);
  });
});
