import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * The execution queue.
 *
 * One BullMQ job per execution continuation. The job id is
 * `execution_id:run_sequence`, so a later re-enqueue is not deduplicated
 * against a retained completed job.
 */

export const EXECUTION_QUEUE = 's9-executions';

export interface ExecutionJobData {
  executionId: string;
  runSequence: number;
  workspaceId?: string;
  workflowId?: string;
}

/**
 * The job id of a continuation.
 *
 * The blueprint describes the id as `execution_id:run_sequence`. BullMQ
 * rejects a custom job id that contains a colon, so the separator is a dash;
 * the shape (`<execution id><separator><run sequence>`) is unchanged.
 */
export function executionJobId(executionId: string, runSequence: number): string {
  return `${executionId}-${runSequence}`;
}

export function getExecutionQueue(connection: Redis): Queue<ExecutionJobData> {
  return new Queue<ExecutionJobData>(EXECUTION_QUEUE, {
    connection,
    defaultJobOptions: {
      // The workflow owns the retry policy; BullMQ only retries the delivery
      // of the job itself (a worker crash), never the business operation.
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    },
  });
}

export interface EnqueueExecutionOptions {
  executionId: string;
  runSequence: number;
  workspaceId?: string;
  workflowId?: string;
  delayMs?: number;
}

/**
 * Publishes a continuation.
 *
 * Publishing twice with the same job id is harmless: BullMQ ignores the
 * duplicate, and the database lease plus guarded transitions make a duplicate
 * delivery harmless to s9 state.
 */
export async function enqueueExecution(
  queue: Queue<ExecutionJobData>,
  options: EnqueueExecutionOptions,
): Promise<void> {
  const jobOptions: JobsOptions = {
    jobId: executionJobId(options.executionId, options.runSequence),
  };
  if (options.delayMs && options.delayMs > 0) jobOptions.delay = options.delayMs;

  await queue.add(
    'execute',
    {
      executionId: options.executionId,
      runSequence: options.runSequence,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.workflowId ? { workflowId: options.workflowId } : {}),
    },
    jobOptions,
  );
}
