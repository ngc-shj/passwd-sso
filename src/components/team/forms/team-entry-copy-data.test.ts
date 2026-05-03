// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { buildTeamEntryCopyData } from "./team-entry-copy-data";

function makeTranslator(prefix: string) {
  return vi.fn((key: string) => `${prefix}:${key}`);
}

describe("buildTeamEntryCopyData", () => {
  it("returns a record keyed by every supported entry kind", () => {
    const result = buildTeamEntryCopyData({
      t: makeTranslator("p"),
      tn: makeTranslator("n"),
      tcc: makeTranslator("cc"),
      ti: makeTranslator("i"),
      tpk: makeTranslator("pk"),
      tba: makeTranslator("ba"),
      tsl: makeTranslator("sl"),
      tsk: makeTranslator("sk"),
    });

    expect(Object.keys(result).sort()).toEqual(
      [
        "bankAccount",
        "creditCard",
        "identity",
        "passkey",
        "password",
        "secureNote",
        "softwareLicense",
        "sshKey",
      ].sort(),
    );
  });

  it("applies the password translator to password copy", () => {
    const t = makeTranslator("p");
    const result = buildTeamEntryCopyData({
      t,
      tn: makeTranslator("n"),
      tcc: makeTranslator("cc"),
      ti: makeTranslator("i"),
      tpk: makeTranslator("pk"),
      tba: makeTranslator("ba"),
      tsl: makeTranslator("sl"),
      tsk: makeTranslator("sk"),
    });

    expect(result.password.edit).toBe("p:editPassword");
    expect(result.password.create).toBe("p:newPassword");
    expect(result.password.titleLabel).toBe("p:title");
    expect(result.password.tagsTitle).toBe("p:tags");
  });

  it("applies the secureNote translator only to secureNote copy", () => {
    const tn = makeTranslator("n");
    const t = makeTranslator("p");
    const result = buildTeamEntryCopyData({
      t,
      tn,
      tcc: makeTranslator("cc"),
      ti: makeTranslator("i"),
      tpk: makeTranslator("pk"),
      tba: makeTranslator("ba"),
      tsl: makeTranslator("sl"),
      tsk: makeTranslator("sk"),
    });

    expect(result.secureNote.edit).toBe("n:editNote");
    expect(result.secureNote.create).toBe("n:newNote");
    // password copy should NOT be touched by tn
    expect(result.password.edit).not.toContain("n:");
  });

  it("applies bankAccount/softwareLicense/sshKey/passkey/identity/creditCard translators independently", () => {
    const result = buildTeamEntryCopyData({
      t: makeTranslator("p"),
      tn: makeTranslator("n"),
      tcc: makeTranslator("cc"),
      ti: makeTranslator("i"),
      tpk: makeTranslator("pk"),
      tba: makeTranslator("ba"),
      tsl: makeTranslator("sl"),
      tsk: makeTranslator("sk"),
    });

    expect(result.bankAccount.edit).toBe("ba:editBankAccount");
    expect(result.softwareLicense.edit).toBe("sl:editLicense");
    expect(result.sshKey.edit).toBe("sk:editSshKey");
    expect(result.passkey.edit).toBe("pk:editPasskey");
    expect(result.identity.edit).toBe("i:editIdentity");
    expect(result.creditCard.edit).toBe("cc:editCard");
  });

  it("does not call translators for unrelated kinds", () => {
    const tba = makeTranslator("ba");
    buildTeamEntryCopyData({
      t: makeTranslator("p"),
      tn: makeTranslator("n"),
      tcc: makeTranslator("cc"),
      ti: makeTranslator("i"),
      tpk: makeTranslator("pk"),
      tba,
      tsl: makeTranslator("sl"),
      tsk: makeTranslator("sk"),
    });

    // tba should only be called with bankAccount translation keys
    const calledKeys = tba.mock.calls.map((c) => c[0] as string);
    expect(calledKeys.every((k) => k.includes("BankAccount") || ["title", "titlePlaceholder", "notes", "notesPlaceholder", "tags"].includes(k))).toBe(true);
  });
});
