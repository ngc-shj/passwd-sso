/**
 * Session-cookie requests for real-DB cells that drive a session-authenticated
 * mint route. The C5 foothold gate (src/lib/tenant/foothold-write-gate.ts)
 * re-reads the request's own session row under the user's credential lock, so
 * a route cell must seed that row and send its cookie — mocking `auth()` alone
 * answers 401. Shaped after sessionCookieRequest / postAs in
 * user-auth-serialization.integration.test.ts.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { configuredSessionCookieName } from "@/lib/auth/session/cookie-name";
import { setBypassRlsGucs, type TestContext } from "./helpers";

/** Insert a live sessions row for the user; returns the raw cookie value. */
export async function seedSession(
  ctx: Pick<TestContext, "su">,
  userId: string,
  tenantId: string,
): Promise<string> {
  const raw = randomUUID();
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
      randomUUID(),
      hashSessionToken(raw),
      userId,
      tenantId,
    );
  });
  return raw;
}

/** Delete the session rows behind a cookie, as containment's revocation does. */
export async function deleteSession(ctx: Pick<TestContext, "su">, rawCookie: string): Promise<void> {
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(`DELETE FROM sessions WHERE session_token = $1`, hashSessionToken(rawCookie));
  });
}

/** A request carrying the session cookie (and the Origin a form or JSON POST sends). */
export function requestWithSession(
  rawCookie: string,
  url: string,
  init: { method?: string; body?: unknown; form?: URLSearchParams } = {},
): NextRequest {
  const headers: Record<string, string> = {
    cookie: `${configuredSessionCookieName()}=${rawCookie}`,
    origin: new URL(url).origin,
  };
  let body: string | undefined;
  if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = init.form.toString();
  } else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  return new NextRequest(url, { method: init.method ?? "POST", headers, body });
}
