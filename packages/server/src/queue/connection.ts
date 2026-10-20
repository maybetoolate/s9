import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/**
 * Redis connections.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it uses for
 * blocking commands, otherwise a job in flight fails when the connection is
 * briefly interrupted.
 */

let publisher: Redis | undefined;
let blocking: Redis | undefined;

export function createRedisConnection(url: string = env().REDIS_URL): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
}

/** Connection used by queue producers and plain commands. */
export function getRedis(): Redis {
  publisher ??= createRedisConnection();
  return publisher;
}

/** Connection used by the BullMQ worker (blocking commands). */
export function getBlockingRedis(): Redis {
  blocking ??= createRedisConnection();
  return blocking;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([publisher?.quit(), blocking?.quit()]);
  publisher = undefined;
  blocking = undefined;
}
