import { describe, expect, it } from "vitest";
import { buildTeamEntrySpecificTextProps } from "@/hooks/team-entry-specific-fields-text-props";

describe("buildTeamEntrySpecificTextProps", () => {
  it("maps translation namespaces and entry copy values", () => {
    const props = buildTeamEntrySpecificTextProps(
      {
        t: ((k: string) => `t.${k}`) as any,
        tn: ((k: string) => `tn.${k}`) as any,
        tcc: ((k: string, values: any) => `tcc.${k}${values ? `:${JSON.stringify(values)}` : ""}`) as any,
        ti: ((k: string) => `ti.${k}`) as any,
        tpk: ((k: string) => `tpk.${k}`) as any,
        tba: ((k: string) => `tba.${k}`) as any,
        tsl: ((k: string) => `tsl.${k}`) as any,
      },
      {
        notesLabel: "notes.label",
        notesPlaceholder: "notes.placeholder",
      },
      "16,19",
    );

    expect(props.notesLabel).toBe("notes.label");
    expect(props.notesPlaceholder).toBe("notes.placeholder");
    expect(props.titleLabel).toBe("t.title");
    expect(props.contentLabel).toBe("tn.content");
    expect(props.lengthHintLabel).toContain("16,19");
    expect(props.creditCardLabels.cardNumber).toBe("tcc.cardNumber");
    expect(props.identityLabels.fullName).toBe("ti.fullName");
    expect(props.passkeyLabels.credentialId).toBe("tpk.credentialId");
    expect(props.bankAccountLabels.bankName).toBe("tba.bankName");
    expect(props.bankAccountLabels.accountNumber).toBe("tba.accountNumber");
    expect(props.softwareLicenseLabels.softwareName).toBe("tsl.softwareName");
    expect(props.softwareLicenseLabels.licenseKey).toBe("tsl.licenseKey");
  });
});
