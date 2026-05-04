import { migrateLimiter } from "@/lib/security/rate-limiters";

export async function clearMigrateLimitForUser(userId: string) {
  await migrateLimiter.clear(`rl:attachment_migrate:${userId}`);
}
