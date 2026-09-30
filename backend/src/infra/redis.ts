/* Redis client for rate limits and locks. BullMQ connections are created separately (P0-T05). */
import { Redis } from "ioredis";

export type RedisClient = Redis;

export function createRedis(url: string): RedisClient {
  return new Redis(url, {
    /*
     * Commands issued while connecting are queued, but fail after one reconnect attempt,
     * so a Redis outage surfaces quickly in /api/ready and rate limits fail open.
     */
    maxRetriesPerRequest: 1,
  });
}

export async function pingRedis(redis: RedisClient): Promise<void> {
  const reply = await redis.ping();
  if (reply !== "PONG") throw new Error(`Unexpected PING reply: ${reply}`);
}
