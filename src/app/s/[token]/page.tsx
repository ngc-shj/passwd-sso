import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { hashToken, decryptShareData } from "@/lib/crypto-server";
import { ShareEntryView } from "@/components/share/share-entry-view";
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
      entryType: true,
      encryptedData: true,
      dataIv: true,
      dataAuthTag: true,
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

  // Record access log (fire-and-forget)
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

  // Decrypt share data
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(
      decryptShareData({
        ciphertext: share.encryptedData,
        iv: share.dataIv,
        authTag: share.dataAuthTag,
      })
    );
  } catch {
    return <ShareError reason="notFound" />;
  }

  return (
    <ShareEntryView
      data={data}
      entryType={share.entryType}
      expiresAt={share.expiresAt.toISOString()}
      viewCount={share.viewCount + 1}
      maxViews={share.maxViews}
    />
  );
}
