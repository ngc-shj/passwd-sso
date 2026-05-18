/**
 * C10: real-key DPoP integration test for /api/mobile/token.
 *
 * Sentinel against the C6 regression class: an iOS-side `device_jkt` value
 * MUST equal the RFC 7638 JWK thumbprint that `verifyDpopProof` computes
 * from the proof header's `jwk`. If the protocol ever drifts (e.g., a
 * developer re-introduces `device_pubkey = base64url(SPKI-DER)` and hashes
 * the string), this test fails at the binding-check layer.
 *
 * Mocking policy (I-C10-1): verifyDpopProof runs UNMOCKED. Supporting
 * infrastructure (Prisma, JTI cache, audit, rate-limit, logger) may use
 * test doubles — the unit under test is the production verifier.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { textEncode } from "@/lib/crypto/crypto-utils";
import { jwkThumbprint } from "@/lib/auth/dpop/verify";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// Real verifyDpopProof — intentionally NOT mocked.
// Supporting infra:
process.env.APP_URL = process.env.APP_URL ?? "https://app.example.test";

const {
  mockMobileBridgeCodeFindUnique,
  mockMobileBridgeCodeUpdateMany,
  mockIssueIosToken,
  mockWithBypassRls,
  mockCheck,
  mockVerifyPkceS256,
  mockLogAuditAsync,
} = vi.hoisted(() => ({
  mockMobileBridgeCodeFindUnique: vi.fn(),
  mockMobileBridgeCodeUpdateMany: vi.fn(),
  mockIssueIosToken: vi.fn(),
  mockWithBypassRls: vi.fn(async (_p: unknown, _fn: unknown) => undefined),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockVerifyPkceS256: vi.fn(() => true),
  mockLogAuditAsync: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mobileBridgeCode: {
      findUnique: mockMobileBridgeCodeFindUnique,
      updateMany: mockMobileBridgeCodeUpdateMany,
    },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));

vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: () => "f".repeat(64),
  hashToken: (s: string) => createHash("sha256").update(s).digest("hex"),
}));

vi.mock("@/lib/auth/tokens/mobile-token", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  issueIosToken: mockIssueIosToken,
}));

vi.mock("@/lib/auth/dpop/jti-cache", () => ({
  getJtiCache: () => ({ hasOrRecord: vi.fn().mockResolvedValue(false) }),
}));

vi.mock("@/lib/mcp/oauth-server", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  verifyPkceS256: mockVerifyPkceS256,
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAuditAsync,
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: "1.2.3.4",
    userAgent: "test",
    acceptLanguage: null,
  }),
}));

vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: () => "1.2.3.4",
  rateLimitKeyFromIp: (ip: string) => ip,
}));

vi.mock("@/lib/url-helpers", () => ({
  getAppOrigin: () => "https://app.example.test",
}));

vi.mock("@/lib/logger", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const inst = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    child: vi.fn(),
  };
  inst.child.mockReturnValue(inst);
  return {
    default: inst,
    getLogger: () => inst,
    requestContext: new AsyncLocalStorage(),
  };
});

import { POST } from "@/app/api/mobile/token/route";

const USER_ID = randomUUID();
const TENANT_ID = randomUUID();
const TOKEN_ID = randomUUID();

interface TestKeypair {
  privateKey: CryptoKey;
  publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  jkt: string;
}

async function generateKeypair(): Promise<TestKeypair> {
  const kp = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as {
    kty: string; crv: string; x: string; y: string;
  };
  const publicJwk = {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: exported.x,
    y: exported.y,
  };
  return { privateKey: kp.privateKey, publicJwk, jkt: jwkThumbprint(publicJwk) };
}

async function makeProof(
  kp: TestKeypair,
  claims: { jti: string; htm: string; htu: string; iat: number },
): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: kp.publicJwk };
  const h64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${h64}.${p64}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    kp.privateKey,
    textEncode(signingInput),
  );
  return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
}

describe("POST /api/mobile/token — real-key DPoP (C10 sentinel for C6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockVerifyPkceS256.mockReturnValue(true);
    mockMobileBridgeCodeUpdateMany.mockResolvedValue({ count: 1 });
    mockIssueIosToken.mockResolvedValue({
      accessToken: "acc-tok",
      refreshToken: "ref-tok",
      expiresAt: new Date(Date.now() + 86_400_000),
      familyId: "fam-1",
      familyCreatedAt: new Date(),
      tokenId: TOKEN_ID,
    });
    // withBypassRls callback runs against the tx — give it a tx-shape that
    // routes both findUnique (called via prisma directly) and updateMany
    // (called via tx.mobileBridgeCode). For tests, both point at the same
    // mocks.
    mockWithBypassRls.mockImplementation(async (_p, fn) =>
      typeof fn === "function"
        ? fn({
            mobileBridgeCode: {
              findUnique: mockMobileBridgeCodeFindUnique,
              updateMany: mockMobileBridgeCodeUpdateMany,
            },
          })
        : undefined,
    );
  });

  it("succeeds end-to-end when iOS-side device_jkt equals jwkThumbprint(proof.jwk)", async () => {
    // The iOS app and the server use the SAME jwkThumbprint algorithm
    // (RFC 7638 over the JCS-canonicalised P-256 JWK). If they ever drift,
    // this test fails. Drift was the entire C6 bug class.
    const kp = await generateKeypair();
    const codePlain = randomBytes(32).toString("hex");
    const codeHash = createHash("sha256").update(codePlain).digest("hex");

    mockMobileBridgeCodeFindUnique.mockResolvedValueOnce({
      userId: USER_ID,
      tenantId: TENANT_ID,
      state: "state-value",
      codeChallenge: "challenge-value",
      deviceJkt: kp.jkt,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const htu = canonicalHtu({ route: "/api/mobile/token" });
    const proof = await makeProof(kp, {
      jti: randomUUID(),
      htm: "POST",
      htu,
      iat: Math.floor(Date.now() / 1000),
    });

    const req = createRequest("POST", htu, {
      body: {
        code: codePlain,
        code_verifier: "v".repeat(43),
        device_jkt: kp.jkt,
      },
      headers: { dpop: proof },
    });

    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.access_token).toBe("acc-tok");
    expect(json.token_type).toBe("DPoP");
    // CAS was reached only because the binding actually verified.
    expect(mockMobileBridgeCodeUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockIssueIosToken).toHaveBeenCalledWith(
      expect.objectContaining({ cnfJkt: kp.jkt }),
    );
  });

  it("REGRESSION SENTINEL: fails uniformly when device_jkt is the legacy SHA-256(SPKI-DER) string", async () => {
    // If a future change re-introduces the C6 bug — i.e. the iOS app sends
    // device_pubkey/SHA-256(SPKI) instead of the RFC 7638 thumbprint — the
    // value won't match jwkThumbprint(proof.jwk) and the route MUST refuse.
    const kp = await generateKeypair();
    // Simulate the broken legacy value: an arbitrary 43-char base64url that
    // is NOT the JWK thumbprint.
    const wrongJkt = "Z".repeat(43);
    expect(wrongJkt).not.toBe(kp.jkt);

    const codePlain = randomBytes(32).toString("hex");
    mockMobileBridgeCodeFindUnique.mockResolvedValueOnce({
      userId: USER_ID,
      tenantId: TENANT_ID,
      state: "state-value",
      codeChallenge: "challenge-value",
      deviceJkt: wrongJkt,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const htu = canonicalHtu({ route: "/api/mobile/token" });
    const proof = await makeProof(kp, {
      jti: randomUUID(),
      htm: "POST",
      htu,
      iat: Math.floor(Date.now() / 1000),
    });

    const req = createRequest("POST", htu, {
      body: {
        code: codePlain,
        code_verifier: "v".repeat(43),
        // Client sends the WRONG (legacy-style) jkt → matches stored, but
        // doesn't match the real proof.jwk thumbprint.
        device_jkt: wrongJkt,
      },
      headers: { dpop: proof },
    });

    const res = await POST(req);
    const { status, json } = await parseResponse(res);
    // Uniform-error per S7. Internal cause: DPoP CNF_JKT_MISMATCH.
    expect(status).toBe(400);
    expect(json.error).toBe("MOBILE_BRIDGE_CODE_INVALID");
    expect(mockMobileBridgeCodeUpdateMany).not.toHaveBeenCalled();
    expect(mockIssueIosToken).not.toHaveBeenCalled();
  });
});
