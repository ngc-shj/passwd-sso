import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertDistinctProviderRefs,
  deriveIdentifierPepper,
  findProviderRefCollision,
  getIdentifierPepper,
  providerRef,
  providerRefOf,
  resetIdentifierPepperForTests,
} from "@/lib/audit/identifier-pepper";

// The same literals as auth-failure.test.ts's golden vectors, recorded before
// the derivation moved here.
const GOLDEN_PEPPER = "golden-explicit-pepper-0123456789abcdef";
const GOLDEN_AUTH_SECRET = "golden-auth-secret-0123456789abcdef-xyz";
const GOLDEN_DERIVED_PEPPER_HEX =
  "6913dee096fe9fda88ae802b9eb9799e32e219c65a00d96f06b795d3d56ed4f2";

describe("deriveIdentifierPepper — golden vectors", () => {
  it("explicit pepper wins over AUTH_SECRET, verbatim as UTF-8", () => {
    expect(
      deriveIdentifierPepper({ AUDIT_IDENTIFIER_PEPPER: GOLDEN_PEPPER, AUTH_SECRET: GOLDEN_AUTH_SECRET }),
    ).toEqual(Buffer.from(GOLDEN_PEPPER, "utf8"));
  });

  it("AUTH_SECRET fallback is the recorded HKDF output", () => {
    expect(deriveIdentifierPepper({ AUTH_SECRET: GOLDEN_AUTH_SECRET })?.toString("hex")).toBe(
      GOLDEN_DERIVED_PEPPER_HEX,
    );
  });

  it("a below-floor pepper falls through to a usable AUTH_SECRET", () => {
    expect(
      deriveIdentifierPepper({
        AUDIT_IDENTIFIER_PEPPER: GOLDEN_PEPPER.slice(0, 31),
        AUTH_SECRET: GOLDEN_AUTH_SECRET,
      })?.toString("hex"),
    ).toBe(GOLDEN_DERIVED_PEPPER_HEX);
  });

  it("below-floor pepper and secret: no key material", () => {
    expect(
      deriveIdentifierPepper({
        AUDIT_IDENTIFIER_PEPPER: GOLDEN_PEPPER.slice(0, 31),
        AUTH_SECRET: GOLDEN_AUTH_SECRET.slice(0, 31),
      }),
    ).toBeNull();
  });
});

describe("getIdentifierPepper", () => {
  beforeEach(() => {
    resetIdentifierPepperForTests();
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", "");
    vi.stubEnv("AUTH_SECRET", "");
  });

  it("memoises the first derivation until reset", () => {
    vi.stubEnv("AUTH_SECRET", GOLDEN_AUTH_SECRET);
    expect(getIdentifierPepper()?.toString("hex")).toBe(GOLDEN_DERIVED_PEPPER_HEX);
    vi.stubEnv("AUTH_SECRET", "");
    expect(getIdentifierPepper()?.toString("hex")).toBe(GOLDEN_DERIVED_PEPPER_HEX);
    resetIdentifierPepperForTests();
    expect(getIdentifierPepper()).toBeNull();
  });
});

describe("providerRef", () => {
  const pepper = Buffer.from(GOLDEN_PEPPER, "utf8");

  it("is a stable 16-hex ref, distinct per provider id", () => {
    const a = providerRef("saml-jackson-a", pepper);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(providerRef("saml-jackson-a", pepper)).toBe(a);
    expect(providerRef("saml-jackson-b", pepper)).not.toBe(a);
  });

  it("is domain-separated from an HMAC keyed with the pepper itself", () => {
    // The email hash's key is the pepper; a ref keyed the same way would make a
    // provider id and an identifier input of the same bytes share a digest.
    const sameKey = createHmac("sha256", pepper).update("saml-jackson-a").digest("hex").slice(0, 16);
    expect(providerRef("saml-jackson-a", pepper)).not.toBe(sameKey);
  });

  it("never contains the provider id", () => {
    expect(providerRef("google", pepper)).not.toContain("google");
  });

  it("providerRefOf stores no ref without a pepper, and the keyed ref with one", () => {
    resetIdentifierPepperForTests();
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", "");
    vi.stubEnv("AUTH_SECRET", "");
    expect(providerRefOf("google")).toBeNull();

    resetIdentifierPepperForTests();
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", GOLDEN_PEPPER);
    expect(providerRefOf("google")).toBe(providerRef("google", pepper));
  });
});

describe("provider ref distinctness", () => {
  it("refuses a synthetic duplicate ref", () => {
    expect(
      findProviderRefCollision([
        { id: "google", ref: "aaaa" },
        { id: "saml-jackson-a", ref: "bbbb" },
        { id: "saml-jackson-b", ref: "aaaa" },
      ]),
    ).toEqual(["google", "saml-jackson-b"]);
  });

  it("allows refs that share a long prefix (distinctness, not a prefix test)", () => {
    expect(
      findProviderRefCollision([
        { id: "google", ref: "aaaa0000aaaa0000" },
        { id: "saml-jackson-a", ref: "aaaa0000aaaa0001" },
      ]),
    ).toBeNull();
  });

  it("allows a distinct list", () => {
    expect(
      findProviderRefCollision([
        { id: "google", ref: "aaaa" },
        { id: "saml-jackson-a", ref: "bbbb" },
      ]),
    ).toBeNull();
  });

  it("the boot assertion passes for real refs of distinct ids, and is skipped without a pepper", () => {
    const ids = ["google", "saml-jackson", "saml-jackson-a", "saml-jackson-b"];
    expect(() => assertDistinctProviderRefs(ids, Buffer.from(GOLDEN_PEPPER, "utf8"))).not.toThrow();
    expect(() => assertDistinctProviderRefs(ids, null)).not.toThrow();
  });
});
