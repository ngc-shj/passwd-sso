/**
 * The set of models `revokeUserAuthArtifactsInTx` revokes is derived, not
 * remembered: every user-bound model (prisma/schema.prisma) with a revocation or
 * single-use column (`revokedAt` / `usedAt`) is either revoked by it, or named
 * below with the reason it does not authenticate as the user. A model added
 * later with such a column fails here until someone decides (#974 round 2: the
 * three single-use code tables had been missed, and each exchanges for a fresh
 * token with no session).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { parseSchemaModels, userBoundModels, handleOf } from "@/__tests__/helpers/user-bound-models";
import { revokeUserAuthArtifactsInTx } from "./user-session-invalidation";

/** User-bound rows with such a column that are not a way to act as the user. */
const NOT_AUTH_ARTIFACTS: Record<string, string> = {
  scimToken: "authenticates the IdP's provisioning as the tenant; createdById only records who minted it",
  passwordShare: "a share link authenticates its viewer, not the user who created it",
  emergencyAccessGrant: "a grant between two users; the grantee acts through their own sessions",
  adminVaultReset: "an admin workflow row about the user, not a credential",
  masterKeyRotation: "an admin workflow row, not a credential",
  personalLogAccessGrant: "a read grant on the user's audit log, exercised through the requester's own session",
};

/** Records every model the helper touches on a fake transaction client. */
function recordingTx() {
  const touched = new Set<string>();
  const tx = new Proxy(
    {},
    {
      get: (_t, model: string) => {
        if (model === "$executeRaw") return async () => 0;
        touched.add(model);
        return {
          findMany: async () => [],
          deleteMany: async () => ({ count: 0 }),
          updateMany: async () => ({ count: 0 }),
        };
      },
    },
  );
  return { tx, touched };
}

describe("revokeUserAuthArtifactsInTx member set", () => {
  it("revokes every user-bound model with a revocation or single-use column, except the named non-credentials", async () => {
    const models = parseSchemaModels();
    const candidates = [...userBoundModels(models).keys()]
      .filter((m) => models.get(m)!.fields.has("revokedAt") || models.get(m)!.fields.has("usedAt"))
      .map(handleOf);
    expect(candidates.length).toBeGreaterThan(0);

    const { tx, touched } = recordingTx();
    await revokeUserAuthArtifactsInTx(tx as never, "user-1", { tenantFilter: {} });

    const expected = candidates.filter((h) => !(h in NOT_AUTH_ARTIFACTS));
    expect([...touched].filter((h) => h !== "session").sort()).toEqual(expected.sort());
    // Sessions have no revokedAt: they are deleted, and must be.
    expect(touched.has("session")).toBe(true);
    // And nothing exempted that the schema no longer has.
    expect(Object.keys(NOT_AUTH_ARTIFACTS).filter((h) => !candidates.includes(h))).toEqual([]);
  });
});
