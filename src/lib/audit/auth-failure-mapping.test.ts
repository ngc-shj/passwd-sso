import { describe, expect, it } from "vitest";
import { AUDIT_PROVIDER_BY_ID, CLAIM_REFUSAL_REASON, toAuditProvider } from "./auth-failure-mapping";

describe("toAuditProvider", () => {
  // Derived from the table, not hand-copied (round-4 T6): a provider id added
  // to the source map joins this test by existing.
  it.each(Object.entries(AUDIT_PROVIDER_BY_ID))("maps the %s provider id", (id, expected) => {
    expect(toAuditProvider(id)).toBe(expected);
  });

  it("covers the provider ids the deployment actually issues", () => {
    // The derivation above cannot notice a member DELETED from the source
    // map — it would simply stop testing it. `saml-jackson` is the id this
    // deployment's Jackson container sends and `boxyhq-saml` the one Auth.js
    // documents; dropping either silently downgrades every SAML denial to
    // provider "unknown".
    expect(Object.keys(AUDIT_PROVIDER_BY_ID).sort()).toEqual([
      "boxyhq-saml",
      "credentials",
      "google",
      "nodemailer",
      "saml-jackson",
    ]);
  });

  it.each([null, undefined, "", "passkey", "totally-unknown"])(
    "falls back to unknown for %s",
    (id) => {
      expect(toAuditProvider(id)).toBe("unknown");
    },
  );

  // Round-3 S3-3. An object literal inherits from Object.prototype, so a bare
  // index lookup on these names returns an inherited FUNCTION — truthy, so the
  // `?? "unknown"` fallback never fired and the function returned something
  // that is not an AuthProvider at all, straight into an audit row's provider
  // field. The provider id reaching this function comes from the Auth.js
  // callback, so these are reachable inputs.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "__defineGetter__"])(
    "returns unknown for the inherited property name %s",
    (id) => {
      expect(toAuditProvider(id)).toBe("unknown");
    },
  );
});

describe("CLAIM_REFUSAL_REASON", () => {
  // Every arm that can deny a sign-in over a claim, from BOTH adjudicators:
  // the three refusals findOrCreateTenantForClaim can return, plus the ingest
  // boundary's refusal of the asserted value (round-3 M1). The `satisfies` in
  // the source makes a missing arm a compile error; this pins the CHOICE each
  // arm was given, which the type cannot.
  it("maps every refusal arm to the reason its remedy matches", () => {
    expect(CLAIM_REFUSAL_REASON).toEqual({
      // Registering the claim IS the remedy, and tenant_claim_unmapped is what
      // `tenant-domain unmapped` filters on — so these two must be visible there.
      claim_taken: "tenant_claim_unmapped",
      claim_collision: "tenant_claim_unmapped",
      // Nothing is registrable, so pointing the operator at `add` would point
      // them at a command that must refuse.
      claim_invalid: "tenant_mismatch",
      claim_malformed: "tenant_mismatch",
    });
  });

});
