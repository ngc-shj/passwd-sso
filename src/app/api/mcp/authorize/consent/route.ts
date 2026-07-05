import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE, advisoryXactLock } from "@/lib/tenant-rls";
import { createAuthorizationCode } from "@/lib/mcp/oauth-server";
import { MCP_SCOPES, MAX_MCP_CLIENTS_PER_TENANT } from "@/lib/constants/auth/mcp";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { readFormWithCap } from "@/lib/http/parse-body";
import { MAX_JSON_BODY_BYTES } from "@/lib/validations/common.server";
import { requireRecentSession } from "@/lib/auth/session/step-up";
import {
  derivePasskeyState,
  passkeyEnforcementBlocks,
  recordPasskeyAuditEmit,
} from "@/lib/auth/policy/passkey-enforcement";

export async function POST(req: NextRequest) {
  // Origin presence guard (early return / defense-in-depth).
  // Primary CSRF protection happens in the proxy CSRF gate at
  // src/lib/proxy/csrf-gate.ts, which value-compares Origin against the
  // app's own origin for every cookie-bearing mutating request. By the time
  // we reach this handler the value comparison has already passed; this
  // remaining check is presence-only — a request reaching the route handler
  // with no Origin header at all is a misconfigured caller and we 403 fast
  // rather than walking through the consent processing.
  const origin = req.headers.get("origin");
  if (!origin) {
    return errorResponse(API_ERROR.INVALID_ORIGIN);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const stepUpError = await requireRecentSession(req);
  if (stepUpError) return stepUpError;

  // Stream-read the consent form under the byte cap. The form is submitted as
  // application/x-www-form-urlencoded (hidden-input form POST, no file upload),
  // so the streaming text cap is authoritative against oversized/chunked bodies.
  const read = await readFormWithCap(req, MAX_JSON_BODY_BYTES);
  if (!read.ok) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const formData = new URLSearchParams(read.text);
  const clientId = formData.get("client_id") ?? "";
  const redirectUri = formData.get("redirect_uri") ?? "";
  const state = formData.get("state") ?? "";
  const action = formData.get("action") ?? "";

  if (!clientId || !redirectUri) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Validate client (must happen before redirect to prevent open redirect)
  const foundClient = await withBypassRls(prisma, async (tx) =>
    tx.mcpClient.findFirst({ where: { clientId, isActive: true } }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!foundClient) {
    return NextResponse.json({ error: "invalid_client" }, { status: 400 });
  }

  // Validate redirect_uri (must happen before redirect to prevent open redirect)
  if (!foundClient.redirectUris.includes(redirectUri)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Tenant check
  const userRecord = await withBypassRls(prisma, async (tx) =>
    tx.user.findUnique({
      where: { id: session.user.id },
      select: { tenantId: true },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  const userTenantId = userRecord?.tenantId;
  if (!userTenantId || (foundClient.tenantId && foundClient.tenantId !== userTenantId)) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }

  // Handle deny action (before claiming — deny should not bind the client)
  if (action === "deny") {
    await logAuditAsync({
      ...tenantAuditBase(req, session.user.id, userTenantId),
      action: AUDIT_ACTION.MCP_CONSENT_DENY,
      targetType: "McpClient",
      targetId: foundClient.id,
      metadata: { clientId },
    });
    const denyUrl = new URL(redirectUri);
    denyUrl.searchParams.set("error", "access_denied");
    if (state) denyUrl.searchParams.set("state", state);
    return NextResponse.redirect(denyUrl.toString(), 302);
  }

  const scope = formData.get("scope") ?? "";
  const codeChallenge = formData.get("code_challenge") ?? "";
  const codeChallengeMethod = formData.get("code_challenge_method") || "S256";

  if (!scope || !codeChallenge) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (codeChallengeMethod !== "S256") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // The effective client for authorization — may be replaced by reuse during claiming
  let effectiveClient = foundClient;

  // DCR claiming: bind unclaimed client to user's tenant on Allow (not on page load)
  if (foundClient.isDcr && !foundClient.tenantId) {
    const clientIdDb = foundClient.id;
    const clientName = foundClient.name;

    let claimResult: { error: "tenant_cap" | "name_conflict" | "already_claimed" | null };
    try {
      // withBypassRls already runs the callback inside a transaction with the
      // RLS-bypass GUC set. The claim sequence (count → exclusion lookup → CAS
      // update) runs directly on that tx — a nested prisma.$transaction would
      // open a second connection WITHOUT the bypass config, so it must not be
      // reintroduced here.
      claimResult = await withBypassRls(
        prisma,
        async (tx) => {
          // Serialize count → cap-check → claim under a per-tenant advisory
          // lock. The claim below is a create-equivalent (it flips an unclaimed
          // client's tenantId null → userTenantId, bumping this tenant's client
          // count), so without the lock two concurrent Allow POSTs can both read
          // count < MAX and both claim, exceeding MAX_MCP_CLIENTS_PER_TENANT.
          // Keyed on userTenantId so it shares lock identity with the admin-create
          // mirror in api/tenant/mcp-clients (locks on actor.tenantId) — the two
          // surfaces enforce the same per-tenant cap and must serialize together.
          await advisoryXactLock(tx, userTenantId);
          const tenantClientCount = await tx.mcpClient.count({
            where: { tenantId: userTenantId },
          });
          if (tenantClientCount >= MAX_MCP_CLIENTS_PER_TENANT) {
            return { error: "tenant_cap" as const };
          }
          // Shared exclusion: same-tenant, same-name DCR client that is NOT the
          // claim target itself. Spread into both owner-scoped and foreign-owned
          // lookups so the exclusion is defined once and cannot diverge.
          const sameNameWhereBase = {
            tenantId: userTenantId,
            name: clientName,
            isDcr: true,
            id: { not: clientIdDb },
          } as const;
          // If the requester's own same-name DCR client exists, replace it.
          // Claude Code registers a new client on each auth attempt — without
          // replacement, deny → retry would always hit a name conflict.
          // We delete the OLD client and claim the NEW one so that Claude Code's
          // client_id matches (it only knows the latest registered client_id).
          // C7: only delete a row owned by this user (createdById === session.user.id).
          const existing = await tx.mcpClient.findFirst({
            where: { ...sameNameWhereBase, createdById: session.user.id },
          });
          if (existing) {
            await tx.mcpClient.delete({ where: { id: existing.id } });
          } else {
            // C7: detect foreign-owned name collision — the unique constraint
            // (tenantId, name) would make the claim write fail at the DB level.
            // Reject early with a user-facing consent error instead of a 500.
            // Also excludes the claim target itself (via sameNameWhereBase) so that
            // a same-user double-submit is not misreported as name_conflict.
            const foreignOwned = await tx.mcpClient.findFirst({
              where: sameNameWhereBase,
            });
            if (foreignOwned) {
              return { error: "name_conflict" as const };
            }
          }
          // Atomic CAS: only claim if still unclaimed
          const updated = await tx.mcpClient.updateMany({
            where: { id: clientIdDb, tenantId: { equals: null } },
            data: { tenantId: userTenantId, createdById: session.user.id, dcrExpiresAt: null },
          });
          if (updated.count === 0) {
            return { error: "already_claimed" as const };
          }
          return { error: null as null };
        },
        BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
      );
    } catch (err) {
      // C7: a concurrent foreign claim can win the race and cause a P2002 unique
      // violation on (tenantId, name). Map to the same consent error — not a 500.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        claimResult = { error: "name_conflict" as const };
      } else {
        throw err;
      }
    }

    if (claimResult.error === "tenant_cap") {
      return NextResponse.json(
        { error: "invalid_client", error_description: "tenant_cap" },
        { status: 400 },
      );
    }
    // C7: foreign-owned name collision — reject without deleting the other user's client.
    if (claimResult.error === "name_conflict") {
      return NextResponse.json(
        { error: "invalid_client", error_description: "name_conflict" },
        { status: 400 },
      );
    }
    if (claimResult.error === "already_claimed") {
      const refetched = await withBypassRls(prisma, async (tx) =>
        tx.mcpClient.findUnique({ where: { id: clientIdDb } }),
      BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
      if (!refetched || refetched.tenantId !== userTenantId) {
        return NextResponse.json({ error: "access_denied" }, { status: 403 });
      }
      effectiveClient = refetched;
    } else {
      // Freshly claimed — userAgent is added by helper (forensic upgrade per plan §Functional 2 EXCEPTION)
      await logAuditAsync({
        ...tenantAuditBase(req, session.user.id, userTenantId),
        action: AUDIT_ACTION.MCP_CLIENT_DCR_CLAIM,
        targetType: "McpClient",
        targetId: clientIdDb,
        metadata: { clientId: foundClient.clientId },
      });
    }
  }

  // Validate scopes (use effectiveClient which may differ from foundClient after reuse)
  const allowedScopes = effectiveClient.allowedScopes.split(",").filter(Boolean);
  const requestedScopes = scope.split(" ").filter(Boolean);
  const grantedScopes = requestedScopes.filter(
    (s) => allowedScopes.includes(s) && (MCP_SCOPES as readonly string[]).includes(s),
  );

  if (grantedScopes.length === 0) {
    const url = new URL(redirectUri);
    url.searchParams.set("error", "invalid_scope");
    if (state) url.searchParams.set("state", state);
    return NextResponse.redirect(url.toString(), 302);
  }

  // Passkey enforcement gate — authoritative boundary for MCP OAuth issuance.
  // Re-derives from DB (fail-closed); a throw propagates and refuses issuance.
  const pkState = await derivePasskeyState({ userId: session.user.id, tenantId: userTenantId });
  if (passkeyEnforcementBlocks(pkState)) {
    if (recordPasskeyAuditEmit(session.user.id, "/api/mcp/authorize/consent", Date.now())) {
      await logAuditAsync({
        ...tenantAuditBase(req, session.user.id, userTenantId),
        action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
        metadata: { blockedPath: "/api/mcp/authorize/consent" },
      });
    }
    const denyUrl = new URL(redirectUri);
    denyUrl.searchParams.set("error", "access_denied");
    denyUrl.searchParams.set("error_description", "passkey_required");
    if (state) denyUrl.searchParams.set("state", state);
    return NextResponse.redirect(denyUrl.toString(), 302);
  }

  // Create authorization code
  const { code } = await createAuthorizationCode({
    clientId: effectiveClient.id,
    tenantId: userTenantId,
    userId: session.user.id,
    redirectUri,
    scope: grantedScopes.join(","),
    codeChallenge,
    codeChallengeMethod,
  });

  // Audit the consent grant
  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, userTenantId),
    action: AUDIT_ACTION.MCP_CONSENT_GRANT,
    targetType: "McpClient",
    targetId: effectiveClient.id,
    metadata: { clientId: effectiveClient.clientId, scopes: grantedScopes },
  });

  // Redirect back to the OAuth client with the authorization code
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return NextResponse.redirect(url.toString(), 302);
}
