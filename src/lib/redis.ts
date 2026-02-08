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
