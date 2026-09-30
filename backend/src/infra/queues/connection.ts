/* Redis connections for BullMQ. Workers need `maxRetriesPerRequest: null` (blocking commands). */
import { Redis } from "ioredis";

export function createQueueConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
