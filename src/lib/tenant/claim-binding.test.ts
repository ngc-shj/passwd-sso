import { describe, expect, it } from "vitest";
import { isUnusableUnderStrict, type ClaimRow } from "./claim-binding";

const TENANT = "0b6f8f2e-6a43-4c5e-9d7a-2b0d3f1e4a51";
const CONFIGURED = ["google", "saml-jackson-alpha"];

function claimRow(provider: string | null, revokedAt: Date | null = null): ClaimRow {
  return { tenantId: TENANT, revokedAt, provider };
}

describe("isUnusableUnderStrict", () => {
  it.each([
    ["an unbound row", claimRow(null), true],
    ["a row bound to a provider no longer configured", claimRow("saml-jackson-gone"), true],
    ["a row bound to a configured provider (the negative control)", claimRow("saml-jackson-alpha"), false],
    ["a revoked unbound row — `add` restores it, not bind", claimRow(null, new Date()), false],
  ] as const)("%s -> %s", (_label, row, expected) => {
    expect(isUnusableUnderStrict(row, CONFIGURED)).toBe(expected);
  });

  it("counts every row unusable when no claim provider is configured", () => {
    expect(isUnusableUnderStrict(claimRow("google"), [])).toBe(true);
  });
});
