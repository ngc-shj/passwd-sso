import { expect, it, type Mock } from "vitest";
import { TenantAuthError } from "@/lib/auth/access/tenant-auth";
import { UserAuthRevokedError } from "@/lib/auth/session/user-auth-serialization";
import { TenantMemberLockTimeoutError } from "@/lib/team/tenant-row-lock";

/**
 * The route cells every C5 site shares (member-foothold-containment plan): the
 * gate is called with the actor and permission, and each of its refusals maps
 * to the documented status with no write. The test file mocks
 * `@/lib/tenant/foothold-write-gate` and passes its `lockFootholdWriter` mock.
 * `arrange` makes the happy path reach the gate; `call` invokes the route.
 */
export function footholdGateCells(opts: {
  gate: Mock;
  permission: string | null;
  actorId: string;
  tenantId: string;
  okStatus: number;
  arrange: () => void;
  call: () => Promise<Response>;
  assertNoWrite: () => void;
  /** Extra assertions after each refusal (e.g. which limiter keys were cleared). */
  afterRefusal?: () => void;
  /** Status of a TenantAuthError refusal; the consent route answers 403 access_denied. */
  refusalStatus?: number;
}) {
  const { gate, arrange, call, assertNoWrite } = opts;

  it("takes the foothold write gate for the actor with the site's permission", async () => {
    arrange();
    expect((await call()).status).toBe(opts.okStatus);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        tenantId: opts.tenantId,
        actorId: opts.actorId,
        permission: opts.permission,
      }),
    );
  });

  it("returns 403 and writes nothing when the gate refuses the actor", async () => {
    arrange();
    gate.mockRejectedValueOnce(new TenantAuthError("FORBIDDEN", 403));
    expect((await call()).status).toBe(opts.refusalStatus ?? 403);
    assertNoWrite();
    opts.afterRefusal?.();
  });

  it("returns 401 and writes nothing when the gate finds the session revoked", async () => {
    arrange();
    gate.mockRejectedValueOnce(new UserAuthRevokedError("session"));
    expect((await call()).status).toBe(401);
    assertNoWrite();
    opts.afterRefusal?.();
  });

  it("returns 409 and writes nothing on a membership lock conflict", async () => {
    arrange();
    gate.mockRejectedValueOnce(new TenantMemberLockTimeoutError());
    expect((await call()).status).toBe(409);
    assertNoWrite();
    opts.afterRefusal?.();
  });
}
