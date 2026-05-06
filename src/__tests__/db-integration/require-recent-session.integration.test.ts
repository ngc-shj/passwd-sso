/**
 * Integration test (real DB): requireRecentSession contract against Auth.js
 * Session.createdAt semantics.
 *
 * Run:
 *   docker compose up -d db
 *   npm run test:integration -- require-recent-session.integration
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { requireRecentSession, STEP_UP_WINDOW_MS } from "@/lib/auth/session/step-up";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

const hasDatabase = !!process.env.DATABASE_URL;

describe.skipIf(!hasDatabase)(
  "requireRecentSession (real DB)",
  () => {
    let ctx: TestContext;
    let tenantId: string;
    let userId: string;

    beforeAll(async () => {
      ctx = await createTestContext();
      vi.stubEnv("AUTH_URL", "http://localhost:3000");
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      await ctx.cleanup();
    });

    beforeEach(async () => {
      tenantId = await ctx.createTenant();
      userId = await ctx.createUser(tenantId);
    });

    afterEach(async () => {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `DELETE FROM sessions WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      });
      await ctx.deleteTestData(tenantId);
    });

    async function insertSession(createdAt: Date): Promise<string> {
      const token = `sess-${randomUUID()}`;
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO sessions (
             id, session_token, user_id, tenant_id, expires, created_at, last_active_at
           ) VALUES (
             $1::uuid, $2, $3::uuid, $4::uuid,
             now() + interval '1 day', $5, now()
           )`,
          randomUUID(),
          token,
          userId,
          tenantId,
          createdAt,
        );
      });
      return token;
    }

    function makeRequest(sessionToken?: string): NextRequest {
      const headers = new Headers();
      if (sessionToken) {
        headers.set("cookie", `authjs.session-token=${sessionToken}`);
      }
      return new NextRequest("http://localhost:3000/api/test-sensitive", {
        method: "POST",
        headers,
      });
    }

    it("allows a recent Auth.js session row", async () => {
      const sessionToken = await insertSession(
        new Date(Date.now() - STEP_UP_WINDOW_MS + 30_000),
      );

      const result = await requireRecentSession(makeRequest(sessionToken));

      expect(result).toBeNull();
    });

    it("rejects a stale Auth.js session row", async () => {
      const sessionToken = await insertSession(
        new Date(Date.now() - STEP_UP_WINDOW_MS - 30_000),
      );

      const result = await requireRecentSession(makeRequest(sessionToken));

      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
      const body = await result!.json();
      expect(body.error).toBe("SESSION_STEP_UP_REQUIRED");
    });

    it("returns 401 when the session cookie is missing", async () => {
      const result = await requireRecentSession(makeRequest());

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it("returns 401 when the session row does not exist", async () => {
      const result = await requireRecentSession(makeRequest(`missing-${randomUUID()}`));

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });
  },
);
