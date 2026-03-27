/**
 * MCP OAuth 2.1 Authorization Code + PKCE server.
 *
 * Handles:
 * - Authorization code generation (for /api/mcp/authorize)
 * - PKCE verification (S256)
 * - Token exchange (for /api/mcp/token)
 * - Token validation (for /api/mcp tool calls)
 */

import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import { withBypassRls } from "@/lib/tenant-rls";
import {
  MCP_TOKEN_PREFIX,
  MCP_CODE_EXPIRY_SEC,
  MCP_TOKEN_EXPIRY_SEC,
  type McpScope,
} from "@/lib/constants/mcp";

export interface McpTokenData {
  tokenId: string;
  tenantId: string;
  clientId: string;
  userId: string | null;
  serviceAccountId: string | null;
  scopes: McpScope[];
}

export type McpTokenValidationResult =
  | { ok: true; data: McpTokenData }
  | { ok: false; error: string };

// ─── PKCE helpers ────────────────────────────────────────────

/** Compute S256 code challenge from plain verifier. */
export function computeS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Verify PKCE S256: challenge must equal base64url(SHA-256(verifier)). */
export function verifyPkceS256(challenge: string, verifier: string): boolean {
  const expected = computeS256Challenge(verifier);
  // Constant-time comparison
  if (expected.length !== challenge.length) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ─── Authorization code ───────────────────────────────────────

export interface CreateAuthCodeParams {
  clientId: string; // McpClient.id (UUID)
  tenantId: string;
  userId?: string;
  serviceAccountId?: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod?: string;
}

export interface AuthCodeResult {
  code: string; // plaintext
  expiresAt: Date;
}

export async function createAuthorizationCode(
  params: CreateAuthCodeParams,
): Promise<AuthCodeResult> {
  const plainCode = randomBytes(32).toString("base64url");
  const codeHash = hashToken(plainCode);
  const expiresAt = new Date(Date.now() + MCP_CODE_EXPIRY_SEC * 1000);

  await withBypassRls(prisma, async () =>
    prisma.mcpAuthorizationCode.create({
      data: {
        codeHash,
        clientId: params.clientId,
        tenantId: params.tenantId,
        userId: params.userId ?? null,
        serviceAccountId: params.serviceAccountId ?? null,
        redirectUri: params.redirectUri,
        scope: params.scope,
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: params.codeChallengeMethod ?? "S256",
        expiresAt,
      },
    }),
  );

  return { code: plainCode, expiresAt };
}

// ─── Token exchange ───────────────────────────────────────────

export interface ExchangeCodeParams {
  code: string;
  clientId: string; // McpClient.clientId (not UUID)
  clientSecretHash: string;
  redirectUri: string;
  codeVerifier: string;
  tokenExpirySeconds?: number;
}

export interface TokenExchangeResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  scope: string;
}

export type TokenExchangeError =
  | "invalid_grant"
  | "invalid_client"
  | "invalid_request";

export type TokenExchangeOutcome =
  | { ok: true; data: TokenExchangeResult }
  | { ok: false; error: TokenExchangeError; errorDescription?: string };

export async function exchangeCodeForToken(
  params: ExchangeCodeParams,
): Promise<TokenExchangeOutcome> {
  const codeHash = hashToken(params.code);

  const result = await withBypassRls(prisma, async () =>
    prisma.$transaction(async (tx) => {
      const authCode = await tx.mcpAuthorizationCode.findUnique({
        where: { codeHash },
        include: { mcpClient: true },
      });

      if (!authCode) return { error: "invalid_grant" as const };
      if (authCode.usedAt) return { error: "invalid_grant" as const };
      if (authCode.expiresAt < new Date()) return { error: "invalid_grant" as const };

      // Verify client identity
      if (authCode.mcpClient.clientId !== params.clientId)
        return { error: "invalid_client" as const };
      if (authCode.mcpClient.clientSecretHash !== params.clientSecretHash)
        return { error: "invalid_client" as const };
      if (!authCode.mcpClient.isActive) return { error: "invalid_client" as const };

      // Tenant boundary guard
      if (authCode.tenantId !== authCode.mcpClient.tenantId)
        return { error: "invalid_grant" as const };

      // Verify redirect_uri matches
      if (authCode.redirectUri !== params.redirectUri)
        return { error: "invalid_grant" as const };

      // PKCE S256 verification
      if (authCode.codeChallengeMethod !== "S256")
        return { error: "invalid_request" as const };
      if (!verifyPkceS256(authCode.codeChallenge, params.codeVerifier))
        return { error: "invalid_grant" as const };

      // Mark code as used (atomic within transaction)
      await tx.mcpAuthorizationCode.update({
        where: { id: authCode.id },
        data: { usedAt: new Date() },
      });

      // Issue access token
      const plainToken = MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
      const tokenHash = hashToken(plainToken);
      const expirySeconds = Math.min(
        params.tokenExpirySeconds ?? MCP_TOKEN_EXPIRY_SEC,
        MCP_TOKEN_EXPIRY_SEC,
      );
      const expiresAt = new Date(Date.now() + expirySeconds * 1000);

      await tx.mcpAccessToken.create({
        data: {
          tokenHash,
          clientId: authCode.clientId,
          tenantId: authCode.tenantId,
          userId: authCode.userId,
          serviceAccountId: authCode.serviceAccountId,
          scope: authCode.scope,
          expiresAt,
        },
      });

      return {
        ok: true as const,
        accessToken: plainToken,
        expiresIn: expirySeconds,
        scope: authCode.scope,
      };
    }),
  );

  if ("error" in result) {
    return { ok: false, error: result.error as TokenExchangeError };
  }
  return {
    ok: true,
    data: {
      accessToken: result.accessToken,
      tokenType: "Bearer",
      expiresIn: result.expiresIn,
      scope: result.scope,
    },
  };
}

// ─── Token validation ─────────────────────────────────────────

export async function validateMcpToken(
  token: string,
): Promise<McpTokenValidationResult> {
  if (!token.startsWith(MCP_TOKEN_PREFIX)) {
    return { ok: false, error: "invalid_token" };
  }

  const tokenHash = hashToken(token);

  const record = await withBypassRls(prisma, async () =>
    prisma.mcpAccessToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        userId: true,
        serviceAccountId: true,
        scope: true,
        expiresAt: true,
        revokedAt: true,
      },
    }),
  );

  if (!record) return { ok: false, error: "invalid_token" };
  if (record.revokedAt) return { ok: false, error: "token_revoked" };
  if (record.expiresAt < new Date()) return { ok: false, error: "token_expired" };

  return {
    ok: true,
    data: {
      tokenId: record.id,
      tenantId: record.tenantId,
      clientId: record.clientId,
      userId: record.userId,
      serviceAccountId: record.serviceAccountId,
      scopes: record.scope.split(",").map((s) => s.trim()).filter(Boolean) as McpScope[],
    },
  };
}
