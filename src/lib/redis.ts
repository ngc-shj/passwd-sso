import { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

const globalForRedis = globalThis as unknown as {
  redisClient?: RedisClient;
};

export function getRedis(): RedisClient | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  if (!globalForRedis.redisClient) {
    const client = createClient({ url });
    client.on("error", () => {});
    client.connect().catch(() => {});
    globalForRedis.redisClient = client;
  }

  return globalForRedis.redisClient;
}

/**
 * Validate Redis availability.
 * In production, REDIS_URL is required for distributed rate limiting.
 * In development/test, in-memory fallback is acceptable.
 */
export function validateRedisConfig(): void {
  if (process.env.NODE_ENV === "production" && !process.env.REDIS_URL) {
    throw new Error(
      "REDIS_URL is required in production for rate limiting. " +
      "Set REDIS_URL or use NODE_ENV=development for in-memory fallback."
    );
  }
}
