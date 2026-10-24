import { describe, it, expect } from "vitest";
import { tenantClaimStorage } from "./tenant-claim-storage";
import { AsyncLocalStorage } from "node:async_hooks";

describe("tenantClaimStorage", () => {
  it("is an instance of AsyncLocalStorage", () => {
    expect(tenantClaimStorage).toBeInstanceOf(AsyncLocalStorage);
  });

  it("returns undefined outside any run() context", () => {
    expect(tenantClaimStorage.getStore()).toBeUndefined();
  });

  it("propagates the tenantClaim within a run() context", () => {
    const store = { tenantClaim: "example.com", provider: "google" };
    const observed = tenantClaimStorage.run(store, () =>
      tenantClaimStorage.getStore(),
    );
    expect(observed).toBe(store);
    expect(observed?.tenantClaim).toBe("example.com");
  });

  it("propagates the store across awaits in the same async context", async () => {
    const store = { tenantClaim: "team.example", provider: "google" };

    const observed = await tenantClaimStorage.run(store, async () => {
      await Promise.resolve();
      await Promise.resolve();
      return tenantClaimStorage.getStore();
    });

    expect(observed).toBe(store);
  });

  it("isolates stores between independent run() calls", async () => {
    const a = { tenantClaim: "a.example", provider: "saml-jackson-a" };
    const b = { tenantClaim: "b.example", provider: "saml-jackson-b" };

    const [aObs, bObs] = await Promise.all([
      tenantClaimStorage.run(a, async () => tenantClaimStorage.getStore()),
      tenantClaimStorage.run(b, async () => tenantClaimStorage.getStore()),
    ]);

    expect(aObs?.tenantClaim).toBe("a.example");
    expect(bObs?.tenantClaim).toBe("b.example");
    expect(aObs?.provider).toBe("saml-jackson-a");
    expect(bObs?.provider).toBe("saml-jackson-b");
  });

  it("supports a null tenantClaim and provider, the route's initial store", () => {
    const observed = tenantClaimStorage.run({ tenantClaim: null, provider: null }, () =>
      tenantClaimStorage.getStore(),
    );
    expect(observed?.tenantClaim).toBeNull();
    expect(observed?.provider).toBeNull();
  });
});
