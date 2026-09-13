/**
 * SCIM against users filed under another tenant — the real database, the app
 * role, RLS in force.
 *
 * Three claims the SCIM fixes of audit-tenant-adjudicator rounds 4 and 5 rest on
 * were until now asserted only against mocks, and a mock returns whatever the cell
 * seeds — including rows a tenant context never returns. The directory-sync engine
 * showed what that costs: its refusal arms were unreachable on the real database
 * while their unit cells passed. These cells run the real service and route code:
 *
 *   - a SCIM Group's member read excludes a team guest whose users row this tenant
 *     cannot see, by its relation filter, before any email is read;
 *   - the user list, read under a bypass, shows this tenant's departed member and
 *     no one else's;
 *   - POST refuses a user another tenant owns (round-5 S1) and still attaches a
 *     user this tenant owns;
 *   - PATCH refuses to reactivate a departed member another tenant now owns
 *     (round-6 R6-S2) and still reactivates one this tenant owns.
 *
 * Only token validation is mocked: it is not the subject, and it needs a real
 * token row the cells have no other use for.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { assertRlsApplies, createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

const { scimTenant } = vi.hoisted(() => ({ scimTenant: { id: "" } }));

vi.mock("@/lib/scim/with-scim-auth", async () => {
  const { SYSTEM_ACTOR_ID } = await import("@/lib/constants/app");
  const { ACTOR_TYPE } = await import("@/lib/constants/audit/audit");
  return {
    authorizeScim: async () => ({
      ok: true,
      data: {
        tokenId: "token-under-test",
        tenantId: scimTenant.id,
        createdById: null,
        auditUserId: SYSTEM_ACTOR_ID,
        actorType: ACTOR_TYPE.SYSTEM,
      },
    }),
  };
});

import { GET, POST } from "@/app/api/scim/v2/Users/route";
import { PATCH } from "@/app/api/scim/v2/Users/[id]/route";
import { fetchScimGroup } from "@/lib/services/scim-group-service";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";

const BASE_URL = "http://localhost:3000/api/scim/v2";

describe("SCIM — users filed under another tenant (real DB)", () => {
  let ctx: TestContext;
  let here: string;
  let elsewhere: string;

  async function asSuperuser<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return fn(tx);
    });
  }

  async function userRow(userId: string) {
    const [row] = await asSuperuser((tx) =>
      tx.$queryRawUnsafe<{ email: string; tenant_id: string }[]>(
        `SELECT email, tenant_id FROM users WHERE id = $1::uuid`,
        userId,
      ),
    );
    return row;
  }

  async function membershipsIn(tenantId: string, userId: string) {
    return asSuperuser((tx) =>
      tx.$queryRawUnsafe<{ deactivated: boolean }[]>(
        `SELECT deactivated_at IS NOT NULL AS deactivated FROM tenant_members
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        tenantId,
        userId,
      ),
    );
  }

  function scimGet(filter: string) {
    const url = new URL("http://localhost/api/scim/v2/Users");
    url.searchParams.set("filter", filter);
    return GET(new NextRequest(url.toString()));
  }

  function scimPost(userName: string) {
    return POST(
      new NextRequest("http://localhost/api/scim/v2/Users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName }),
      }),
    );
  }

  function scimReactivate(userId: string) {
    return PATCH(
      new NextRequest(`http://localhost/api/scim/v2/Users/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: true }],
        }),
      }),
      { params: Promise.resolve({ id: userId }) },
    );
  }

  beforeAll(async () => {
    await assertRlsApplies(prisma);
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    here = await ctx.createTenant();
    elsewhere = await ctx.createTenant();
    scimTenant.id = here;
  });

  afterEach(async () => {
    await ctx.deleteTestData(here);
    await ctx.deleteTestData(elsewhere);
    vi.unstubAllEnvs();
  });

  it("reports a group's own active member and excludes a team guest filed under another tenant", async () => {
    const member = await ctx.createUser(here); // ACTIVE membership here
    const guest = await ctx.createUser(elsewhere); // ACTIVE only in the other tenant
    const teamId = randomUUID();
    await asSuperuser(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO teams (id, tenant_id, name, slug, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'core', 'core', now(), now())`,
        teamId,
        here,
      );
      for (const userId of [member, guest]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MEMBER', now(), now())`,
          randomUUID(),
          teamId,
          userId,
          here,
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO scim_group_mappings (id, tenant_id, team_id, external_group_id, role, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'grp-core', 'MEMBER', now(), now())`,
        randomUUID(),
        here,
        teamId,
      );
    });

    // Without the filter the guest's REQUIRED user relation comes back null here,
    // and reading its email failed the whole group.
    const group = await withTenantRls(prisma, here, (tx) => fetchScimGroup(here, "grp-core", BASE_URL, tx));

    expect(group?.members?.map((m) => m.value)).toEqual([member]);
  });

  it("lists this tenant's departed member, filed under another tenant, in the page and the count", async () => {
    const departed = await ctx.createUser(elsewhere);
    await asSuperuser((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now(), now())`,
        randomUUID(),
        here,
        departed,
      ),
    );
    const { email } = await userRow(departed);

    const body = await (await scimGet(`userName eq "${email}"`)).json();

    // A tenant context evaluates the email filter through users RLS, which drops
    // this member from Resources AND totalResults.
    expect(body.totalResults).toBe(1);
    expect(body.Resources).toEqual([expect.objectContaining({ id: departed, active: false })]);
  });

  it("lists no member of another tenant, though the bypass could see them", async () => {
    const outsider = await ctx.createUser(elsewhere); // no membership here at all
    const { email } = await userRow(outsider);

    const body = await (await scimGet(`userName eq "${email}"`)).json();

    expect(body.totalResults).toBe(0);
    expect(body.Resources).toEqual([]);
  });

  it("refuses to provision a user another tenant released, leaving them untouched", async () => {
    // Round-5 S1: active nowhere is not unowned.
    const released = await ctx.createUser(elsewhere);
    await asSuperuser((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE tenant_members SET deactivated_at = now() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        elsewhere,
        released,
      ),
    );
    const { email } = await userRow(released);

    const res = await scimPost(email);

    expect(res.status).toBe(409);
    // The refusal, not a users_email_key collision, which is also a 409.
    expect(JSON.stringify(await res.json())).toContain("cannot be provisioned by this organization");
    expect(await membershipsIn(here, released)).toEqual([]);
    expect((await userRow(released)).tenant_id).toBe(elsewhere);
  });

  it("refuses to reactivate a departed member another tenant now owns, leaving them untouched", async () => {
    // Round-6 R6-S2: the user left this tenant and joined the other; that tenant
    // then suspended them, so no second active membership stops a reactivation.
    const departed = await ctx.createUser(elsewhere);
    await asSuperuser(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE tenant_members SET deactivated_at = now() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        elsewhere,
        departed,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now(), now())`,
        randomUUID(),
        here,
        departed,
      );
    });

    const res = await scimReactivate(departed);

    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("cannot be provisioned by this organization");
    expect(await membershipsIn(here, departed)).toEqual([{ deactivated: true }]);
    expect((await userRow(departed)).tenant_id).toBe(elsewhere);
  });

  it("reactivates a deactivated member this tenant owns", async () => {
    const own = await ctx.createUser(here);
    await asSuperuser((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE tenant_members SET deactivated_at = now() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        here,
        own,
      ),
    );

    const res = await scimReactivate(own);

    expect(res.status).toBe(200);
    expect(await membershipsIn(here, own)).toEqual([{ deactivated: false }]);
  });

  it("attaches a user this tenant owns, active, without creating another", async () => {
    const own = await ctx.createUser(here);
    await asSuperuser((tx) =>
      tx.$executeRawUnsafe(`DELETE FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, here, own),
    );
    const { email } = await userRow(own);

    const res = await scimPost(email);

    expect(res.status).toBe(201);
    expect(await membershipsIn(here, own)).toEqual([{ deactivated: false }]);
  });

  it("creates a user for an email no one holds, filed under this tenant", async () => {
    const email = `scim-new-${randomUUID().slice(0, 8)}@example.com`;

    const res = await scimPost(email);

    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect((await userRow(id)).tenant_id).toBe(here);
  });
});
