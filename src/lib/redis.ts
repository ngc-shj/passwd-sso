import Redis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redisClient?: Redis;
};

export function getRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  if (!globalForRedis.redisClient) {
    let client: Redis;

    if (process.env.REDIS_SENTINEL === "true") {
      const hosts = process.env.REDIS_SENTINEL_HOSTS ?? "";
      const masterName = process.env.REDIS_SENTINEL_MASTER_NAME ?? "mymaster";
      const sentinelPassword = process.env.REDIS_SENTINEL_PASSWORD;
      const useTls = process.env.REDIS_SENTINEL_TLS === "true";

      const sentinels = hosts.split(",").map((h) => {
        const [host, port] = h.trim().split(":");
        return { host, port: parseInt(port || "26379", 10) };
      });

      client = new Redis({
        sentinels,
        name: masterName,
        sentinelPassword: sentinelPassword || undefined,
        ...(useTls ? { tls: {}, sentinelTLS: {} } : {}),
        lazyConnect: true,
      });
    } else {
      client = new Redis(url, { lazyConnect: true });
    }

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
