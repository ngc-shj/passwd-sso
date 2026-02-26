import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { hashToken, decryptShareData } from "@/lib/crypto-server";
import { ShareEntryView } from "@/components/share/share-entry-view";
import { ShareE2EEntryView } from "@/components/share/share-e2e-entry-view";
import { ShareSendView } from "@/components/share/share-send-view";
import { ShareError } from "@/components/share/share-error";
import { createRateLimiter } from "@/lib/rate-limit";

const sharePageLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

type Props = {
  params: Promise<{ token: string }>;
};

export default async function SharePage({ params }: Props) {
  const { token } = await params;

  // Rate limit by IP
  const headersList = await headers();
  const forwarded = headersList.get("x-forwarded-for");
  const rateLimitIp = forwarded
    ? forwarded.split(",")[0].trim()
    : headersList.get("x-real-ip") ?? "unknown";
  if (!(await sharePageLimiter.check(`rl:share_page:${rateLimitIp}`))) {
    return <ShareError reason="rateLimited" />;
  }

  // Validate token format (must be 64 hex chars)
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return <ShareError reason="notFound" />;
  }

  const tokenHash = hashToken(token);

  const share = await prisma.passwordShare.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      shareType: true,
      entryType: true,
      encryptedData: true,
      dataIv: true,
      dataAuthTag: true,
      sendName: true,
      sendFilename: true,
      sendSizeBytes: true,
      masterKeyVersion: true,
      expiresAt: true,
      maxViews: true,
      viewCount: true,
      revokedAt: true,
    },
  });

  if (!share) {
    return <ShareError reason="notFound" />;
  }

  if (share.revokedAt) {
    return <ShareError reason="revoked" />;
  }

  if (share.expiresAt < new Date()) {
    return <ShareError reason="expired" />;
  }

  // Atomically check maxViews and increment viewCount in a single query
  // to prevent race conditions between concurrent requests
  const updated: number = await prisma.$executeRaw`
    UPDATE "password_shares"
    SET "view_count" = "view_count" + 1
    WHERE "id" = ${share.id}
      AND ("max_views" IS NULL OR "view_count" < "max_views")`;

  if (updated === 0) {
    return <ShareError reason="maxViews" />;
  }

  // Record access log (async nonblocking)
  const ip = rateLimitIp === "unknown" ? null : rateLimitIp;
  const ua = headersList.get("user-agent");
  prisma.shareAccessLog
    .create({
      data: {
        shareId: share.id,
        ip,
        userAgent: ua?.slice(0, 512) ?? null,
      },
    })
    .catch(() => {});

  // E2E share (team entries): client-side decryption via URL fragment key
  if (share.masterKeyVersion === 0) {
    return (
      <ShareE2EEntryView
        encryptedData={share.encryptedData}
        dataIv={share.dataIv}
        dataAuthTag={share.dataAuthTag}
        entryType={share.entryType!}
        expiresAt={share.expiresAt.toISOString()}
        viewCount={share.viewCount + 1}
        maxViews={share.maxViews}
      />
    );
  }

  // Server-encrypted share: decrypt with master key
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(
      decryptShareData({
        ciphertext: share.encryptedData,
        iv: share.dataIv,
        authTag: share.dataAuthTag,
      }, share.masterKeyVersion)
    );
  } catch {
    return <ShareError reason="notFound" />;
  }

  // Branch on shareType
  if (share.shareType === "TEXT") {
    return (
      <ShareSendView
        sendType="TEXT"
        name={String(data.name ?? share.sendName ?? "")}
        text={String(data.text ?? "")}
        token={token}
        expiresAt={share.expiresAt.toISOString()}
        viewCount={share.viewCount + 1}
        maxViews={share.maxViews}
      />
    );
  }

  if (share.shareType === "FILE") {
    return (
      <ShareSendView
        sendType="FILE"
        name={String(data.name ?? share.sendName ?? "")}
        filename={share.sendFilename}
        sizeBytes={share.sendSizeBytes}
        token={token}
        expiresAt={share.expiresAt.toISOString()}
        viewCount={share.viewCount + 1}
        maxViews={share.maxViews}
      />
    );
  }

  // ENTRY_SHARE (default)
  return (
    <ShareEntryView
      data={data}
      entryType={share.entryType!}
      expiresAt={share.expiresAt.toISOString()}
      viewCount={share.viewCount + 1}
      maxViews={share.maxViews}
    />
  );
}
