import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";

export const runtime = "nodejs";

// GET /api/webauthn/credentials — list user's WebAuthn credentials
async function handleGET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  const rows = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.findMany({
      where: { userId },
      select: {
        id: true,
        credentialId: true,
        nickname: true,
        deviceType: true,
        backedUp: true,
        discoverable: true,
        minPinLength: true,
        largeBlobSupported: true,
        transports: true,
        prfSupported: true,
        // Selected only to derive `prfWrappingPresent` below — the ciphertext
        // itself is NEVER returned to the client. UI uses the derived boolean
        // to decide whether to prompt for PRF re-bootstrap after a key
        // rotation cleared the wrapping. See plan #433 / F9.
        prfEncryptedSecretKey: true,
        registeredDevice: true,
        lastUsedDevice: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  // Strip the ciphertext — only expose the derived boolean. `prfSupported`
  // remains the authoritative "authenticator supports PRF capability" flag;
  // `prfWrappingPresent` indicates whether the server currently holds wrapping
  // for this credential (cleared by rotation until re-bootstrapped).
  const credentials = rows.map(({ prfEncryptedSecretKey, ...rest }) => ({
    ...rest,
    prfWrappingPresent: prfEncryptedSecretKey != null,
  }));

  return NextResponse.json(credentials);
}

export const GET = withRequestLog(handleGET);
