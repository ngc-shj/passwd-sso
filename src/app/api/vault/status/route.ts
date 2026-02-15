import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";

export const runtime = "nodejs";

/**
 * GET /api/vault/status
 * Returns whether the user has set up their vault (passphrase + secret key).
 */
async function handleGET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      vaultSetupAt: true,
      accountSalt: true,
      keyVersion: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: API_ERROR.USER_NOT_FOUND }, { status: 404 });
  }

  return NextResponse.json({
    setupRequired: !user.vaultSetupAt,
    accountSalt: user.accountSalt,
    keyVersion: user.keyVersion,
  });
}

export const GET = withRequestLog(handleGET);
