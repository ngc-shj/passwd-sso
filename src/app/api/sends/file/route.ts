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
} from "@/lib/crypto-server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, validationError } from "@/lib/api-response";
import {
  AUDIT_TARGET_TYPE,
  AUDIT_ACTION,
  AUDIT_SCOPE,
  SEND_EXPIRY_MAP,
} from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";

const sendFileLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

// POST /api/sends/file — Create a file Send
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  if (!(await sendFileLimiter.check(`rl:send_file:${session.user.id}`)).allowed) {
    return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429);
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return errorResponse(API_ERROR.INVALID_FORM_DATA, 400);
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
    return validationError(parsed.error.flatten());
  }

  const meta = parsed.data;

  // Validate filename
  const filename = file.name;
  if (!isValidSendFilename(filename)) {
    return validationError({ file: "Invalid filename" });
  }

  // Check file size
  if (file.size > SEND_MAX_FILE_SIZE) {
    return errorResponse(API_ERROR.SEND_FILE_TOO_LARGE, 400);
  }

  // Read file bytes
  const fileBuffer = Buffer.from(await file.arrayBuffer());

  // Magic byte verification
  const { fileTypeFromBuffer } = await import("file-type");
  const detected = await fileTypeFromBuffer(fileBuffer);
  // If file-type detects a type, verify against declared content type
  if (detected) {
    const declaredType = file.type || "application/octet-stream";
    if (declaredType !== detected.mime && declaredType !== "application/octet-stream") {
      return errorResponse(API_ERROR.SEND_FILE_TYPE_NOT_ALLOWED, 400);
    }
  }
  // If detected is undefined (text files like .txt, .csv, .json), trust declared content type

  // Storage limit check: sum of active (non-revoked, non-expired) Send files
  const now = new Date();
  const activeTotal = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordShare.aggregate({
      where: {
        createdById: session.user.id,
        shareType: "FILE",
        revokedAt: null,
        expiresAt: { gt: now },
        sendSizeBytes: { not: null },
      },
      _sum: { sendSizeBytes: true },
    }),
  );
  const currentTotal = activeTotal._sum.sendSizeBytes ?? 0;
  if (currentTotal + file.size > SEND_MAX_ACTIVE_TOTAL_BYTES) {
    return errorResponse(API_ERROR.SEND_STORAGE_LIMIT_EXCEEDED, 400);
  }

  // Generate access password if requested
  let accessPassword: string | undefined;
  let accessPasswordHash: string | null = null;
  if (meta.requirePassword) {
    accessPassword = generateAccessPassword();
    accessPasswordHash = hashAccessPassword(accessPassword);
  }

  // Encrypt metadata with master key
  const encryptedMeta = encryptShareData(JSON.stringify({ name: meta.name }));

  // Encrypt file binary with master key
  const encryptedFile = encryptShareBinary(fileBuffer);
  fileBuffer.fill(0); // Clear plaintext from memory

  // Generate token
  const token = generateShareToken();
  const tokenHash = hashToken(token);

  const expiresAt = new Date(Date.now() + SEND_EXPIRY_MAP[meta.expiresIn]);
  const contentType = detected?.mime ?? file.type ?? "application/octet-stream";
  const actor = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenantId: true },
    }),
  );
  if (!actor) {
    return unauthorized();
  }

  const share = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordShare.create({
      data: {
        tokenHash,
        shareType: "FILE",
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
        createdById: session.user.id,
        tenantId: actor.tenantId,
      },
    }),
  );

  // Audit log
  const { ip, userAgent } = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.SEND_CREATE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
    targetId: share.id,
    metadata: { sendType: "FILE", filename, sizeBytes: file.size },
    ip,
    userAgent,
  });

  return NextResponse.json({
    id: share.id,
    token,
    url: `/s/${token}`,
    expiresAt: share.expiresAt,
    ...(accessPassword ? { accessPassword } : {}),
  }, { status: 201 });
}

export const POST = withRequestLog(handlePOST);
