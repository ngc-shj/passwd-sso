import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  createSendFileMetaSchema,
  SEND_MAX_FILE_SIZE,
  SEND_MAX_ACTIVE_TOTAL_BYTES,
  isValidSendFilename,
} from "@/lib/validations";
import {
  generateShareToken,
  hashToken,
  encryptShareData,
  encryptShareBinary,
  generateAccessPassword,
  hashAccessPassword,
} from "@/lib/crypto/crypto-server";
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, rateLimited, unauthorized, validationError, zodValidationError } from "@/lib/http/api-response";
import {
  AUDIT_TARGET_TYPE,
  AUDIT_ACTION,
  SEND_EXPIRY_MAP,
  SHARE_TYPE,
} from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { rejectOversizedMultipart } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

const sendFileLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 5 });

// POST /api/sends/file — Create a file Send
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await sendFileLimiter.check(`rl:send_file:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // Early rejection before buffering the multipart body into memory. Requires a
  // declared Content-Length and caps it — fail-closed on a missing header so a
  // chunked / no-Content-Length body cannot bypass the cap (req.formData() has
  // no streaming cap of its own). file.size is re-checked post-parse below.
  const oversized = rejectOversizedMultipart(req, SEND_MAX_FILE_SIZE * 2);
  if (oversized) return oversized;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return errorResponse(API_ERROR.INVALID_FORM_DATA);
  }

  // Extract fields
  const name = formData.get("name");
  const file = formData.get("file");
  const expiresIn = formData.get("expiresIn");
  const maxViewsRaw = formData.get("maxViews");

  if (!(file instanceof File)) {
    return validationError({ file: "File is required" });
  }

  // Validate metadata
  const requirePasswordRaw = formData.get("requirePassword");
  const parsed = createSendFileMetaSchema.safeParse({
    name: typeof name === "string" ? name : "",
    expiresIn: typeof expiresIn === "string" ? expiresIn : "",
    maxViews: maxViewsRaw != null ? maxViewsRaw : undefined,
    requirePassword: requirePasswordRaw != null ? requirePasswordRaw : undefined,
  });
  if (!parsed.success) {
    return zodValidationError(parsed.error);
  }

  const meta = parsed.data;

  // Validate filename
  const filename = file.name;
  if (!isValidSendFilename(filename)) {
    return validationError({ file: "Invalid filename" });
  }

  // Check file size
  if (file.size > SEND_MAX_FILE_SIZE) {
    return errorResponse(API_ERROR.SEND_FILE_TOO_LARGE);
  }

  // Read file bytes
  const fileBuffer = Buffer.from(await file.arrayBuffer());

  // H5: Magic-byte verification + active-content denylist.
  //
  // Prior shape `declaredType === "application/octet-stream"` was a hole:
  // a client could upload an SVG (or anything else) with
  // Content-Type: application/octet-stream to skip the MIME consistency
  // check entirely. We now require detected.mime === declared (or accept
  // detected.mime when declared is missing/octet-stream), AND deny known
  // active-content types regardless of how they're labeled.
  //
  // The download route already hard-codes Content-Type: application/octet-stream
  // + X-Content-Type-Options: nosniff + Content-Disposition: attachment,
  // so the practical XSS path is closed there too. This is the upload-side
  // defense-in-depth.
  const { fileTypeFromBuffer } = await import("file-type");
  const detected = await fileTypeFromBuffer(fileBuffer);

  // Active-content MIME types we refuse to host as a Send, even if the
  // bytes look benign on the surface. Adding more here is cheap; removing
  // requires understanding why something showed up on the list.
  const ACTIVE_CONTENT_MIME = new Set([
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/javascript",
    "text/javascript",
    "application/x-msdownload", // .exe / .dll
    "application/x-mach-binary",
  ]);
  // Filename-extension allowlist mirror — a renamed .html → .txt could still
  // smuggle markup past the magic-byte check (text/* has no signature).
  const ACTIVE_CONTENT_EXT = /\.(html?|xhtml|svg|js|mjs|wasm|exe|dll|sh|bat|ps1)$/i;

  if (ACTIVE_CONTENT_EXT.test(filename)) {
    return errorResponse(API_ERROR.SEND_FILE_TYPE_NOT_ALLOWED);
  }
  if (detected && ACTIVE_CONTENT_MIME.has(detected.mime)) {
    return errorResponse(API_ERROR.SEND_FILE_TYPE_NOT_ALLOWED);
  }
  if (detected) {
    // Strict consistency: when we have a magic-byte answer, the declared
    // type must match it OR be unspecified (empty / octet-stream is the
    // browser's "I don't know" answer, not an authorization to skip the
    // check). detected.mime is then the source of truth for storage.
    const declaredType = file.type;
    if (
      declaredType &&
      declaredType !== "application/octet-stream" &&
      declaredType !== detected.mime
    ) {
      return errorResponse(API_ERROR.SEND_FILE_TYPE_NOT_ALLOWED);
    }
  }
  // If detected is undefined (plain-text .txt/.csv/.json with no signature),
  // we already enforced the active-content extension denylist above.

  // Storage limit check and actor (tenantId) lookup are independent — run in parallel
  const now = new Date();
  const [activeTotal, actor] = await Promise.all([
    withUserTenantRls(session.user.id, async () =>
      prisma.passwordShare.aggregate({
        where: {
          createdById: session.user.id,
          shareType: SHARE_TYPE.FILE,
          revokedAt: null,
          expiresAt: { gt: now },
          sendSizeBytes: { not: null },
        },
        _sum: { sendSizeBytes: true },
      }),
    ),
    withUserTenantRls(session.user.id, async () =>
      prisma.user.findUnique({
        where: { id: session.user.id },
        select: { tenantId: true },
      }),
    ),
  ]);

  const currentTotal = activeTotal._sum.sendSizeBytes ?? 0;
  if (currentTotal + file.size > SEND_MAX_ACTIVE_TOTAL_BYTES) {
    return errorResponse(API_ERROR.SEND_STORAGE_LIMIT_EXCEEDED);
  }
  if (!actor) {
    return unauthorized();
  }

  // Generate access password if requested
  let accessPassword: string | undefined;
  let accessPasswordHash: string | null = null;
  let accessPasswordHashVersion: number = VERIFIER_VERSION;
  if (meta.requirePassword) {
    accessPassword = generateAccessPassword();
    const r = hashAccessPassword(accessPassword);
    accessPasswordHash = r.hash;
    accessPasswordHashVersion = r.version;
  }

  // Encrypt metadata with master key (AAD-bound to tenant)
  const encryptedMeta = encryptShareData(JSON.stringify({ name: meta.name }), actor.tenantId);

  // Encrypt file binary with master key (AAD-bound to tenant)
  const encryptedFile = encryptShareBinary(fileBuffer, actor.tenantId);
  fileBuffer.fill(0); // Clear plaintext from memory

  // Generate token
  const token = generateShareToken();
  const tokenHash = hashToken(token);

  const expiresAt = new Date(Date.now() + SEND_EXPIRY_MAP[meta.expiresIn]);
  // Always prefer the magic-byte-derived MIME. When unavailable (text-like
  // files with no signature), fall back to a generic safe value rather than
  // trusting the client-declared header — the download route forces
  // application/octet-stream anyway, so this is only used for UI display.
  const contentType = detected?.mime ?? "application/octet-stream";

  const share = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordShare.create({
      data: {
        tokenHash,
        shareType: SHARE_TYPE.FILE,
        entryType: null,
        sendName: meta.name,
        sendFilename: filename,
        sendContentType: contentType,
        sendSizeBytes: file.size,
        encryptedData: encryptedMeta.ciphertext,
        dataIv: encryptedMeta.iv,
        dataAuthTag: encryptedMeta.authTag,
        encryptedFile: new Uint8Array(encryptedFile.ciphertext),
        fileIv: encryptedFile.iv,
        fileAuthTag: encryptedFile.authTag,
        masterKeyVersion: encryptedMeta.masterKeyVersion,
        expiresAt,
        maxViews: meta.maxViews ?? null,
        accessPasswordHash,
        accessPasswordHashVersion,
        createdById: session.user.id,
        tenantId: actor.tenantId,
      },
    }),
  );

  // Audit log
  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.SEND_CREATE,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
    targetId: share.id,
    metadata: { sendType: SHARE_TYPE.FILE, filename, sizeBytes: file.size },
  });

  return NextResponse.json({
    id: share.id,
    token,
    url: `/s/${token}`,
    expiresAt: share.expiresAt,
    ...(accessPassword ? { accessPassword } : {}),
  }, { status: 201, headers: { ...NO_STORE_HEADERS } });
}

export const POST = withRequestLog(handlePOST);
