import { describe, expect, it } from "vitest";
import { buildOrgEntrySpecificTextProps } from "@/hooks/org-entry-specific-fields-text-props";

describe("buildOrgEntrySpecificTextProps", () => {
  it("maps translation namespaces and entry copy values", () => {
    const props = buildOrgEntrySpecificTextProps(
      {
        t: (k) => `t.${k}`,
        tn: (k) => `tn.${k}`,
        tcc: (k, values) => `tcc.${k}${values ? `:${JSON.stringify(values)}` : ""}`,
        ti: (k) => `ti.${k}`,
        tpk: (k) => `tpk.${k}`,
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
  });
});
