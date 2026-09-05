import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAuth,
  mockWithBypassRls,
  mockFindFirst,
  mockFindUnique,
  mockCreateAuthorizationCode,
  mockLogAudit,
  mockMcpClientCount,
  mockMcpClientUpdateMany,
  mockMcpClientFindUnique,
  mockTxFindFirst,
  mockTxDelete,
  mockExecuteRaw,
  mockRequireRecentCurrentAuthMethod,
  mockDerivePasskeyState,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockWithBypassRls: vi.fn(),
  mockFindFirst: vi.fn(),
  mockFindUnique: vi.fn(),
  mockCreateAuthorizationCode: vi.fn(),
  mockLogAudit: vi.fn(),
  mockMcpClientCount: vi.fn().mockResolvedValue(0),
  mockMcpClientUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  mockMcpClientFindUnique: vi.fn(),
  mockTxFindFirst: vi.fn().mockResolvedValue(null),
  mockTxDelete: vi.fn().mockResolvedValue({}),
  mockExecuteRaw: vi.fn().mockResolvedValue(0),
  mockRequireRecentCurrentAuthMethod: vi.fn().mockResolvedValue(null),
  mockDerivePasskeyState: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpClient: {
      findFirst: mockFindFirst,
      findUnique: mockMcpClientFindUnique,
      count: mockMcpClientCount,
      updateMany: mockMcpClientUpdateMany,
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: mockFindUnique },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        mcpClient: {
          count: mockMcpClientCount,
          findFirst: mockTxFindFirst,
          updateMany: mockMcpClientUpdateMany,
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          delete: mockTxDelete,
        },
      }),
    ),
  },
}));

// withBypassRls runs its callback on a bypass-RLS transaction client. The route
// uses that tx directly for both simple cross-tenant lookups (mcpClient.findFirst
// / user.findUnique / mcpClient.findUnique) AND the DCR claim sequence (count →
// exclusion findFirst → delete → CAS updateMany). This impl passes a tx mock
// serving all of them. Defined as a named helper (re-applied in beforeEach
// because vi.clearAllMocks() wipes mock implementations between tests).
function bypassRlsImpl(_p: unknown, fn: (tx: unknown) => unknown) {
  return fn({
    // The claim callback acquires a per-tenant advisory lock (advisoryXactLock)
    // before the count → cap → updateMany-claim sequence, so the bypass tx must
    // serve $executeRaw. Captured by mockExecuteRaw to assert the lock is taken.
    $executeRaw: mockExecuteRaw,
    mcpClient: {
      // The route issues two distinct findFirst shapes on the bypass tx: the
      // initial client lookup keys on `clientId`; the DCR claim-exclusion
      // lookups key on `name`/`isDcr` (no clientId). Dispatch by shape so the
      // claim path keeps using mockTxFindFirst while the client lookup uses
      // mockFindFirst — preserving the per-call assertions in the tests.
      findFirst: (args: { where?: Record<string, unknown> }) =>
        args?.where && "clientId" in args.where
          ? mockFindFirst(args)
          : mockTxFindFirst(args),
      findUnique: mockMcpClientFindUnique,
      count: mockMcpClientCount,
      updateMany: mockMcpClientUpdateMany,
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: mockTxDelete,
    },
    user: { findUnique: mockFindUnique },
  });
}

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/mcp/oauth-server", () => ({
  createAuthorizationCode: mockCreateAuthorizationCode,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  personalAuditBase: (_req: unknown, userId: string) => ({ scope: "PERSONAL", userId, ip: "127.0.0.1", userAgent: "test-agent", acceptLanguage: null }),
  teamAuditBase: (_req: unknown, userId: string, teamId: string) => ({ scope: "TEAM", userId, teamId, ip: "127.0.0.1", userAgent: "test-agent", acceptLanguage: null }),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({ scope: "TENANT", userId, tenantId, ip: "127.0.0.1", userAgent: "test-agent", acceptLanguage: null }),
}));

vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentCurrentAuthMethod,
}));

vi.mock("@/lib/url-helpers", () => ({
  serverAppUrl: (path: string) => `https://example.test${path}`,
  getAppOrigin: () => "https://example.test",
}));

vi.mock("@/lib/auth/policy/passkey-enforcement", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/policy/passkey-enforcement")>();
  return {
    ...real,
    derivePasskeyState: mockDerivePasskeyState,
  };
});

import { POST } from "@/app/api/mcp/authorize/consent/route";
import { Prisma } from "@prisma/client";
import { _resetPasskeyAuditForTests } from "@/lib/auth/policy/passkey-enforcement";
import { MCP_SCOPES } from "@/lib/constants/auth/mcp";
import { API_PATH } from "@/lib/constants/auth/api-path";
import { PKCE_CODE_CHALLENGE_SCHEMA } from "@/lib/validations/common.server";

const VALID_SESSION = { user: { id: "user-uuid-123" } };

const VALID_CLIENT = {
  id: "client-db-uuid",
  clientId: "mcpc_testclient",
  isActive: true,
  tenantId: "tenant-uuid-123",
  redirectUris: ["https://example.com/callback"],
  allowedScopes: "credentials:list,credentials:use,passwords:read",
};

const VALID_USER = {
  tenantId: "tenant-uuid-123",
};

function buildFormBody(fields: Record<string, string>): string {
  // The consent UI submits a hidden-input <form> POST, which the browser sends
  // as application/x-www-form-urlencoded — match that wire shape here.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, value);
  }
  return params.toString();
}

function createFormRequest(url: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const urlObj = new URL(url);
  return new Request(url, {
    method: "POST",
    body: buildFormBody(fields),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: urlObj.origin,
      host: urlObj.host,
      ...headers,
    },
  });
}

// 43 chars — the real base64url(SHA-256(verifier)) length (RFC 7636 §4.2),
// and the floor PKCE_CODE_CHALLENGE_SCHEMA (C4/CF15) now enforces at this
// route. A shorter placeholder (as this fixture used to be) is rejected.
const VALID_CODE_CHALLENGE = "A".repeat(43);

const VALID_FORM_FIELDS = {
  client_id: "mcpc_testclient",
  redirect_uri: "https://example.com/callback",
  scope: "credentials:list credentials:use",
  code_challenge: VALID_CODE_CHALLENGE,
  code_challenge_method: "S256",
  state: "random-state-value",
};

describe("POST /api/mcp/authorize/consent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPasskeyAuditForTests();
    mockAuth.mockResolvedValue(VALID_SESSION);
    // withBypassRls: execute callback on the bypass tx mock (may be called 2+
    // times for claiming). Re-applied each test because clearAllMocks wipes it.
    mockWithBypassRls.mockImplementation(bypassRlsImpl);
    mockFindFirst.mockResolvedValue(VALID_CLIENT);
    mockFindUnique.mockResolvedValue(VALID_USER);
    mockTxFindFirst.mockResolvedValue(null); // default: no existing same-name client
    mockTxDelete.mockResolvedValue({});
    mockMcpClientCount.mockResolvedValue(0);
    mockMcpClientUpdateMany.mockResolvedValue({ count: 1 });
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(null);
    mockCreateAuthorizationCode.mockResolvedValue({
      code: "auth-code-abc123",
      expiresAt: new Date(Date.now() + 60000),
    });
    // Default: passkey enforcement off (does not block).
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
  });

  it("returns 403 when Origin header is missing (CSRF check)", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
      { origin: "" },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("INVALID_ORIGIN");
  });

  it("returns 302 redirect with code and state on valid consent", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.searchParams.get("code")).toBe("auth-code-abc123");
    expect(url.searchParams.get("state")).toBe("random-state-value");
    expect(url.searchParams.has("error")).toBe(false);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  // @browser-redirect-recovery-test
  it("redirects to the authorize entry when session step-up is required (stale session, not a JSON 403 dead-end)", async () => {
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(Response.json(
      { error: "SESSION_STEP_UP_REQUIRED" },
      { status: 403 },
    ));

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    // The consent form is a native browser POST (full-page navigation), so a JSON
    // 403 would strand the user on a raw error page. Bounce (303, POST→GET) back to
    // the authorize entry — which re-runs auth + step-up and redirects to sign-in —
    // with the OAuth params reconstructed from the validated form fields. The
    // callback target is a self-origin app path, never the client redirect_uri.
    expect(res.status).toBe(303);
    const url = new URL(res.headers.get("location") ?? "");
    // API_PATH, not the literal: the route builds this URL from the same
    // constant, so asserting the string pins a second spelling of one route
    // path rather than the property under test — that the stale step-up
    // bounce lands on the authorize endpoint.
    expect(url.pathname).toBe(API_PATH.MCP_AUTHORIZE);
    expect(url.searchParams.get("client_id")).toBe(VALID_FORM_FIELDS.client_id);
    expect(url.searchParams.get("redirect_uri")).toBe(VALID_FORM_FIELDS.redirect_uri);
    expect(url.searchParams.get("code_challenge")).toBe(VALID_FORM_FIELDS.code_challenge);
    expect(url.searchParams.get("state")).toBe(VALID_FORM_FIELDS.state);
    // No credential-issuance work runs on a stale session.
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
    // Gate called with the request ONLY — a custom maxAgeMs here would diverge
    // from the sign-in page's freshness evaluation and re-open the loop.
    expect(mockRequireRecentCurrentAuthMethod).toHaveBeenCalledTimes(1);
    expect(mockRequireRecentCurrentAuthMethod.mock.calls[0]).toHaveLength(1);
  });

  it("returns 400 when client_id is missing", async () => {
    const { client_id: _removed, ...fields } = VALID_FORM_FIELDS;
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      fields,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_request");
  });

  it("returns 400 when redirect_uri is missing", async () => {
    const { redirect_uri: _removed, ...fields } = VALID_FORM_FIELDS;
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      fields,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_request");
  });

  it("returns 400 when client is not found", async () => {
    mockFindFirst.mockResolvedValue(null);

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_client");
  });

  it("returns 400 when redirect_uri is not in client's registered URIs", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, redirect_uri: "https://evil.example.com/callback" },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_request");
  });

  it("returns 403 when client belongs to a different tenant", async () => {
    // Client has a different tenantId than the user
    mockFindFirst.mockResolvedValue({
      ...VALID_CLIENT,
      tenantId: "different-tenant-uuid",
    });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("access_denied");
  });

  it("returns 403 when user has no tenant", async () => {
    mockFindUnique.mockResolvedValue({ tenantId: null });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("access_denied");
  });

  // C4: the client-independent gate refuses a scope set that cannot overlap
  // MCP_SCOPES at all, BEFORE any client is looked up — "admin:delete" is not
  // a member of MCP_SCOPES, so this is that gate, not the residual
  // (post-claim) invalid_scope arm below.
  it("returns 400 invalid_scope when no requested scope is a member of MCP_SCOPES (client-independent gate, before any client lookup)", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, scope: "admin:delete" },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_scope");
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  // The residual arm: "vault:status" IS a member of MCP_SCOPES (passes the
  // client-independent gate above) but is NOT in VALID_CLIENT.allowedScopes,
  // so grantedScopes is empty only after the post-claim intersection —
  // I4.1's one stated exception, because it reads effectiveClient.
  it("returns 302 with error=invalid_scope when the requested scope is MCP_SCOPES-valid but not in this client's allowlist (residual arm)", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, scope: "vault:status" },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.searchParams.get("error")).toBe("invalid_scope");
    expect(url.searchParams.get("state")).toBe("random-state-value");
  });

  it("residual invalid_scope (after claim) still consumes exactly one client slot — the invariant's one stated exception", async () => {
    mockFindFirst.mockResolvedValueOnce({ ...VALID_CLIENT, isDcr: true, tenantId: null });
    mockTxFindFirst.mockResolvedValueOnce(null);
    mockMcpClientCount.mockResolvedValueOnce(0);
    mockMcpClientUpdateMany.mockResolvedValueOnce({ count: 1 });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, scope: "vault:status" },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect(url.searchParams.get("error")).toBe("invalid_scope");
    // Exactly one slot consumed: the CAS claim ran once — unlike the
    // pre-claim scope=openid-only refusal, which never reaches it at all.
    expect(mockMcpClientUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });

  // The consent-time S256 check is BACK, and above the DCR claim. CFP2 removed
  // it on the ground that redemption enforces the method unconditionally; that
  // is true and decides only whether a code can be USED. It says nothing about
  // what the request commits on the way to minting one, and the claim commits
  // first.
  it.each([
    ["a short non-S256 method mints an unredeemable code", "plain"],
    ["a method longer than the VarChar(10) column", "S256-but-far-too-long"],
  ])("refuses %s before the DCR claim, consuming no slot", async (_label, method) => {
    // An UNCLAIMED DCR client, not VALID_CLIENT. The CAS claim only runs for
    // `isDcr && !tenantId`, so with the default (claimed, non-DCR) fixture the
    // zero-CAS assertion below is satisfied whatever the gate's position — it
    // could move below the claim block and this test would stay green. The DCR
    // fixture is what makes the assertion bite: the request WOULD claim if it
    // got that far, so zero calls is evidence of position, not of fixture shape.
    mockFindFirst.mockResolvedValueOnce({ ...VALID_CLIENT, isDcr: true, tenantId: null });
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, code_challenge_method: method },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    // The mutation, not only the verdict, and it is the whole point of the
    // position: the CAS claim must not have run. Before this gate moved above
    // the claim block, `plain` spent a slot on a code that could never be
    // redeemed, and the over-length value spent one and then 500'd when the
    // uncaught 22001 came back from a VarChar(10) column.
    expect(mockMcpClientUpdateMany).not.toHaveBeenCalled();
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });

  it("accepts an ABSENT code_challenge_method as S256 and mints a code", async () => {
    // The allow arm, and the boundary the gate has to get right: RFC 7636 makes
    // an absent method mean `plain`, this deployment reads it as S256, and every
    // real client of this endpoint omits it. A gate that refused the absent case
    // would satisfy both deny arms above and break every caller.
    const { code_challenge_method: _omitted, ...withoutMethod } = VALID_FORM_FIELDS;
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      withoutMethod,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    expect(mockCreateAuthorizationCode).toHaveBeenCalledWith(
      expect.objectContaining({ codeChallengeMethod: "S256" }),
    );
  });

  // ── C4 (CF15): PKCE code_challenge validated at this ingress ─────────────

  it("returns 400 invalid_request when code_challenge fails PKCE_CODE_CHALLENGE_SCHEMA, before any client lookup", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, code_challenge: "too-short" },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_request");
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });

  it("deny + stale step-up bounces to the authorize GET without validating code_challenge, and writes no MCP_CONSENT_DENY row", async () => {
    // The deny arm is exempt from the PKCE gate (action === "deny"), so a
    // malformed code_challenge rides along unvalidated in the stale-session
    // echo — the authorize GET is what refuses it (see the co-located
    // GET route.test.ts), and MCP_CONSENT_DENY is never written because the
    // deny arm itself never runs on a stale session.
    mockRequireRecentCurrentAuthMethod.mockResolvedValue(Response.json(
      { error: "SESSION_STEP_UP_REQUIRED" },
      { status: 403 },
    ));
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      {
        action: "deny",
        client_id: "mcpc_testclient",
        redirect_uri: "https://example.com/callback",
        state: "random-state-value",
        code_challenge: "too-short",
      },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(303);
    const url = new URL(res.headers.get("location") ?? "");
    // API_PATH, not the literal: the route builds this URL from the same
    // constant, so asserting the string pins a second spelling of one route
    // path rather than the property under test — that the stale step-up
    // bounce lands on the authorize endpoint.
    expect(url.pathname).toBe(API_PATH.MCP_AUTHORIZE);
    expect(url.searchParams.get("code_challenge")).toBe("too-short");
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });

  // ── C4: scope cap + client-independent gate (both at the same ingress) ───

  it("accepts the full MCP_SCOPES set as requested scope (at, not over, the cap)", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, scope: MCP_SCOPES.join(" ") },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=");
  });

  it("accepts MCP_SCOPES plus one standard OAuth scope", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, scope: `${MCP_SCOPES.join(" ")} openid` },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=");
  });

  it("accepts exactly MCP_SCOPES + all 3 standard OAuth extras (AT the cap)", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, scope: `${MCP_SCOPES.join(" ")} openid profile offline_access` },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=");
  });

  it("rejects one scope token over the cap (MCP_SCOPES + 3 standard extras) with 400 and no slot consumed", async () => {
    // Same MCP scope repeated past the cap — the cap counts RAW tokens, no
    // dedup (SC's own withdrawal ground: after the cap, grantedScopes is
    // already a subset of a 9-member set, so a dedup criterion could never
    // red on removal).
    const overCap = Array(MCP_SCOPES.length + 4).fill(MCP_SCOPES[0]).join(" ");
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, scope: overCap },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_request");
    // Before ANY client interaction — proves no slot could have been consumed.
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("refuses scope=openid alone BEFORE the claim, asserted by client count (no DCR claim attempted)", async () => {
    // Note: no client fixture is even set up as unclaimed-DCR here — the
    // point is that the gate refuses before the client lookup runs at all.
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      { ...VALID_FORM_FIELDS, scope: "openid" },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_scope");
    // By client count: the claim's count-check and CAS update never ran, so
    // zero clients were claimed — not merely "the response looks refused".
    expect(mockMcpClientCount).not.toHaveBeenCalled();
    expect(mockMcpClientUpdateMany).not.toHaveBeenCalled();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  // ── C4: pre-mint gate ordering (passkey gate is now BEFORE the claim) ────

  it("a passkey-enforced user with no passkey is refused BEFORE any DCR client is claimed, asserted by client count", async () => {
    mockFindFirst.mockResolvedValueOnce({ ...VALID_CLIENT, isDcr: true, tenantId: null });
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect(url.searchParams.get("error")).toBe("access_denied");
    // By client count: the claim's count-check and CAS update never ran.
    expect(mockMcpClientCount).not.toHaveBeenCalled();
    expect(mockMcpClientUpdateMany).not.toHaveBeenCalled();
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });

  // ── C4 acceptance 7: all three PKCE ingress points share ONE schema object ──

  it("consent POST validates code_challenge through the shared PKCE_CODE_CHALLENGE_SCHEMA object (reference identity)", async () => {
    const spy = vi.spyOn(PKCE_CODE_CHALLENGE_SCHEMA, "safeParse");
    try {
      const req = createFormRequest(
        "http://localhost/api/mcp/authorize/consent",
        VALID_FORM_FIELDS,
      );
      await POST(req as unknown as import("next/server").NextRequest);
      // If this route held its own copy of the schema (same min/max/regex,
      // different object) rather than importing this exported binding, the
      // spy on the SHARED object would never fire.
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("calls createAuthorizationCode with correct params", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    await POST(req as unknown as import("next/server").NextRequest);

    expect(mockCreateAuthorizationCode).toHaveBeenCalledOnce();
    expect(mockCreateAuthorizationCode).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: VALID_CLIENT.id,
        tenantId: VALID_USER.tenantId,
        userId: VALID_SESSION.user.id,
        redirectUri: "https://example.com/callback",
        codeChallenge: VALID_CODE_CHALLENGE,
        scope: expect.stringContaining("credentials:list"),
      }),
    );
  });

  it("calls logAuditAsync after successful consent", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    await POST(req as unknown as import("next/server").NextRequest);

    expect(mockLogAudit).toHaveBeenCalledOnce();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: VALID_SESSION.user.id,
        tenantId: VALID_USER.tenantId,
        targetId: VALID_CLIENT.id,
      }),
    );
  });

  it("claims DCR client on Allow and issues authorization code", async () => {
    // mockFindFirst: client lookup → unclaimed DCR client
    // mockTxFindFirst: $transaction existing same-name check → null (no conflict)
    mockFindFirst.mockResolvedValueOnce({ ...VALID_CLIENT, isDcr: true, tenantId: null });
    mockTxFindFirst.mockResolvedValueOnce(null);
    mockMcpClientCount.mockResolvedValueOnce(0);
    mockMcpClientUpdateMany.mockResolvedValueOnce({ count: 1 });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("code=");

    // S1: the claim must serialize under a per-tenant advisory lock, taken
    // BEFORE the count→cap→updateMany-claim, keyed on the user's tenantId (so it
    // shares lock identity with the admin-create mirror). Without this ordering
    // two concurrent Allow POSTs can both read count < MAX and both claim.
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const lockArgs = mockExecuteRaw.mock.calls[0];
    expect(lockArgs.slice(1)).toContain(VALID_USER.tenantId);
    expect(mockExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockMcpClientCount.mock.invocationCallOrder[0],
    );
    expect(mockExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockMcpClientUpdateMany.mock.invocationCallOrder[0],
    );
  });

  it("redirects with error=access_denied and calls logAuditAsync on deny action", async () => {
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      {
        action: "deny",
        client_id: "mcpc_testclient",
        redirect_uri: "https://example.com/callback",
        state: "random-state-value",
      },
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("random-state-value");

    expect(mockLogAudit).toHaveBeenCalledOnce();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: VALID_SESSION.user.id,
        tenantId: VALID_USER.tenantId,
        targetId: VALID_CLIENT.id,
      }),
    );
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });

  // C7 acceptance tests

  // (a) User B consenting with a name matching user A's DCR client does NOT
  //     delete A's client and gets a consent error.
  it("C7(a): foreign-owned same-name DCR client blocks consent without deleting the owner's client", async () => {
    const userBSession = { user: { id: "user-b-uuid" } };
    mockAuth.mockResolvedValue(userBSession);
    // Unclaimed DCR client registered by nobody yet (tenantId null)
    mockFindFirst.mockResolvedValueOnce({ ...VALID_CLIENT, isDcr: true, tenantId: null });
    mockMcpClientCount.mockResolvedValueOnce(0);
    // tx.findFirst with createdById = user-b-uuid → null (user B has no own same-name client)
    // tx.findFirst without createdById → foreign-owned client exists
    const foreignClient = { id: "user-a-client-id", createdById: "user-a-uuid" };
    mockTxFindFirst
      .mockResolvedValueOnce(null)         // createdById check: user B owns nothing
      .mockResolvedValueOnce(foreignClient); // foreign-owned check: user A's client

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_client");
    expect(json.error_description).toBe("name_conflict");
    // User A's client must not have been deleted
    expect(mockTxDelete).not.toHaveBeenCalled();
    expect(mockMcpClientUpdateMany).not.toHaveBeenCalled();
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });

  // (b) User A re-claiming their own DCR client still replaces their own row.
  it("C7(b): user re-claiming own DCR client name replaces the old row and succeeds", async () => {
    mockFindFirst.mockResolvedValueOnce({ ...VALID_CLIENT, isDcr: true, tenantId: null });
    mockMcpClientCount.mockResolvedValueOnce(0);
    // tx.findFirst with createdById = session.user.id → user's own existing client
    mockTxFindFirst.mockResolvedValueOnce({ id: "old-client-id", createdById: VALID_SESSION.user.id });
    mockMcpClientUpdateMany.mockResolvedValueOnce({ count: 1 });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("code=");
    expect(mockCreateAuthorizationCode).toHaveBeenCalledOnce();
    // The old client row must have been deleted
    expect(mockTxDelete).toHaveBeenCalledOnce();
    expect(mockTxDelete).toHaveBeenCalledWith({ where: { id: "old-client-id" } });
  });

  // T2: owner-scoped findFirst must include createdById + shared id:not guard
  it("T2: owner-scoped findFirst where includes createdById and shared id:not guard", async () => {
    const claimTarget = { ...VALID_CLIENT, id: "claim-target-id", isDcr: true, tenantId: null };
    mockFindFirst.mockResolvedValueOnce(claimTarget);
    mockMcpClientCount.mockResolvedValueOnce(0);
    mockTxFindFirst.mockResolvedValueOnce(null);
    mockMcpClientUpdateMany.mockResolvedValueOnce({ count: 1 });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    await POST(req as unknown as import("next/server").NextRequest);

    // Assert owner-scoped findFirst was called with createdById + id:not guard
    expect(mockTxFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdById: VALID_SESSION.user.id,
          id: expect.objectContaining({ not: "claim-target-id" }),
        }),
      }),
    );
  });

  // T2 red-green: temporarily removing createdById from the route's where must
  // make the above assertion fail. This test documents the regression-guard.
  // Verification: edit route to remove createdById → T2 test turns red → restore.

  // T2: self-target — claiming when the only same-name own client IS the claim
  // target (id matches) must NOT delete anything (the id:not guard excludes it).
  it("T2: same-target self-claim does not delete the claim target itself", async () => {
    // claimTarget IS the client being claimed (same id)
    const claimTarget = { ...VALID_CLIENT, id: "claim-target-id", isDcr: true, tenantId: null };
    mockFindFirst.mockResolvedValueOnce(claimTarget);
    mockMcpClientCount.mockResolvedValueOnce(0);
    // tx.findFirst with id:{ not: "claim-target-id" } → returns null (no OTHER same-name own client)
    mockTxFindFirst.mockResolvedValueOnce(null);
    mockMcpClientUpdateMany.mockResolvedValueOnce({ count: 1 });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("code=");
    // No delete must have been called — the claim target itself is excluded
    expect(mockTxDelete).not.toHaveBeenCalled();
    expect(mockCreateAuthorizationCode).toHaveBeenCalledOnce();
  });

  // F6: same-user double-submit — the claim target is already claimed by this user.
  // The foreignOwned lookup must also exclude the claim target (via sameNameWhereBase),
  // so the flow reaches already_claimed recovery, NOT name_conflict.
  it("F6: same-user double-submit reaches already_claimed recovery, not name_conflict", async () => {
    // Unclaimed DCR client (the new registration attempt)
    const claimTarget = { ...VALID_CLIENT, id: "claim-target-id", isDcr: true, tenantId: null };
    mockFindFirst.mockResolvedValueOnce(claimTarget);
    mockMcpClientCount.mockResolvedValueOnce(0);
    // owner-scoped findFirst: no OTHER same-name own client (null — claim target excluded by id:not)
    mockTxFindFirst.mockResolvedValueOnce(null);
    // foreignOwned findFirst: also null — claim target excluded by id:not,
    // and no other same-name row exists
    mockTxFindFirst.mockResolvedValueOnce(null);
    // CAS updateMany returns 0 — already claimed by this user
    mockMcpClientUpdateMany.mockResolvedValueOnce({ count: 0 });
    // already_claimed refetch: returns this user's already-claimed client
    mockMcpClientFindUnique.mockResolvedValueOnce({
      ...VALID_CLIENT,
      id: "claim-target-id",
      isDcr: true,
      tenantId: VALID_USER.tenantId,
    });

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    // Must NOT respond with name_conflict — must reach the already_claimed path
    // and succeed with an authorization code redirect
    const json = res.status !== 302 ? await res.json() : null;
    expect(json?.error_description).not.toBe("name_conflict");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("code=");
    // No delete of any foreign client
    expect(mockTxDelete).not.toHaveBeenCalled();
    expect(mockCreateAuthorizationCode).toHaveBeenCalledOnce();

    // Verify the SECOND mockTxFindFirst call (foreignOwned lookup) explicitly
    // contains { id: { not: "claim-target-id" }, isDcr: true } and does NOT
    // include createdById — confirming sameNameWhereBase is used without the
    // owner-scoped createdById filter.
    expect(mockTxFindFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: "claim-target-id" },
          isDcr: true,
        }),
      }),
    );
    const secondCallArgs = mockTxFindFirst.mock.calls[1][0] as { where: Record<string, unknown> };
    expect(secondCallArgs.where).not.toHaveProperty("createdById");
  });

  // (c) P2002 unique-violation race maps to consent error (not a 500).
  it("C7(c): P2002 unique violation during claim maps to name_conflict consent error", async () => {
    mockFindFirst.mockResolvedValueOnce({ ...VALID_CLIENT, isDcr: true, tenantId: null });
    // The claim CAS updateMany throws P2002 — a concurrent foreign claim won the
    // race and tripped the (tenantId, name) unique constraint on the write.
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.0.0",
    });
    mockMcpClientUpdateMany.mockRejectedValueOnce(p2002);

    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_client");
    expect(json.error_description).toBe("name_conflict");
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });

  // ── C6 (POST): Passkey enforcement gate ──────────────────────────────────

  it("C6 POST: off (requirePasskey=false) → authorization code issued", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: false,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("code=");
    // Non-vacuity: createAuthorizationCode was called.
    expect(mockCreateAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it("C6 POST: on + hasPasskey → authorization code issued", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: true,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=");
    expect(mockCreateAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it("C6 POST: on + no passkey + within grace → authorization code issued", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=");
    expect(mockCreateAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it("C6 POST: on + no passkey + grace expired → 302 access_denied+passkey_required, no code, audit emitted once", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      passkeyGracePeriodDays: 7,
    });
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    const url = new URL(location);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("error_description")).toBe("passkey_required");
    expect(url.searchParams.get("state")).toBe(VALID_FORM_FIELDS.state);
    // Non-vacuity: createAuthorizationCode must NOT have been called.
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
    // Exactly one PASSKEY_ENFORCEMENT_BLOCKED audit emit.
    const blockedCalls = mockLogAudit.mock.calls.filter(
      (c) => c[0].action === "PASSKEY_ENFORCEMENT_BLOCKED",
    );
    expect(blockedCalls).toHaveLength(1);
    expect(blockedCalls[0][0]).toMatchObject({
      action: "PASSKEY_ENFORCEMENT_BLOCKED",
      metadata: { blockedPath: "/api/mcp/authorize/consent" },
    });
  });

  it("C6 POST: enabledAt=null → immediate 302 access_denied", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: 7,
    });
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    const url = new URL(location);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });

  it("C6 POST: audit dedup — second blocked attempt does not emit a second audit", async () => {
    mockDerivePasskeyState.mockResolvedValue({
      requirePasskey: true,
      hasPasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });
    const makeReq = () => createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    ) as unknown as import("next/server").NextRequest;
    await POST(makeReq());
    await POST(makeReq());
    const blockedCalls = mockLogAudit.mock.calls.filter(
      (c) => c[0].action === "PASSKEY_ENFORCEMENT_BLOCKED",
    );
    expect(blockedCalls).toHaveLength(1);
  });

  it("C6 POST: derivePasskeyState throws → fail closed (no code, error propagates)", async () => {
    mockDerivePasskeyState.mockRejectedValue(new Error("DB error"));
    const req = createFormRequest(
      "http://localhost/api/mcp/authorize/consent",
      VALID_FORM_FIELDS,
    );
    await expect(
      POST(req as unknown as import("next/server").NextRequest),
    ).rejects.toThrow("DB error");
    expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
  });
});
