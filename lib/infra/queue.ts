import { type Processor, Queue, Worker } from 'bullmq';

import { createLogger, wasLogged } from '@/core/lib/infra/logger';
import { disconnectAll, getRedis } from '@/core/lib/infra/redis';

const log = createLogger('queue');

/**
 * BullMQ key prefix. Override with BULLMQ_PREFIX to isolate queues sharing one
 * Redis instance (e.g. a test server or a worktree slot next to the main dev
 * server — otherwise both consume each other's jobs).
 */
export const BULLMQ_PREFIX = process.env.BULLMQ_PREFIX || 'bull';

/**
 * Queue-wide defaults. Without `removeOnComplete`/`removeOnFail`, BullMQ keeps
 * every finished job forever and Redis grows without bound in production —
 * keep the last N for inspection only. Per-job options (e.g. the email retry
 * policy) override these on `queue.add()`.
 */
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

const queues: Queue[] = [];
const workers: Worker[] = [];

/** Create a BullMQ queue with shared Redis connection */
export function createQueue(name: string): Queue | null {
  const conn = getRedis();
  if (!conn) return null;

  const queue = new Queue(name, {
    connection: conn,
    prefix: BULLMQ_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  queues.push(queue);
  return queue;
}

/** Create a BullMQ worker with shared Redis connection */
export function createWorker(
  name: string,
  processor: Processor,
  concurrency?: number,
  opts?: { limiter?: { max: number; duration: number } }
): Worker | null {
  const conn = getRedis();
  if (!conn) return null;

  const worker = new Worker(name, processor, {
    connection: conn,
    prefix: BULLMQ_PREFIX,
    concurrency: concurrency ?? 1,
    limiter: opts?.limiter,
  });

  worker.on('failed', (job, err) => {
    // Catch-all for handlers that don't log their own failure. When the handler
    // already did (with ids this layer can't see) logging again would double
    // every failure — keep a debug breadcrumb so jobId↔queue stays recoverable.
    if (wasLogged(err)) {
      log.debug('Job failed (logged by handler)', {
        queue: name,
        jobId: job?.id,
      });
      return;
    }
    log.error('Job failed', {
      queue: name,
      jobId: job?.id,
      jobName: job?.name,
      attempt: job?.attemptsMade,
      error: err.message,
    });
  });

  worker.on('error', (err) => {
    // Connection-level errors (Redis blips). BullMQ reconnects itself; an
    // unhandled 'error' event would otherwise crash the process.
    log.warn('Worker error', { queue: name, error: err.message });
  });

  workers.push(worker);
  return worker;
}

/** Get all registered queues (for monitoring) */
export function getQueues(): Queue[] {
  return queues;
}

/** Gracefully shutdown all workers and queues */
export async function shutdownAllWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(queues.map((q) => q.close()));
  await disconnectAll();
}
