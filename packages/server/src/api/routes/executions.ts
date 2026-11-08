import type { App } from '../context.js';
import { z } from 'zod';
import {
  listAuditEvents,
  listExecutions,
  listStepAttempts,
  listStepExecutions,
  getExecutionWithWorkflow,
  getStepExecution,
} from '../../db/repo.js';
import { getDb } from '../../db/client.js';
import { requireContext } from '../context.js';
import { ApiError, jsonRoute, paginated, parseDate, parsePagination, readJson } from '../http.js';
import { toAuditEventDto, toExecutionSummary, toStepExecutionDto } from '../mappers.js';
import {
  cancelExecution,
  rerunExecution,
  resolveOutcomeUnknown,
  retryStep,
} from '../../engine/execution-service.js';
import { ACTION_METADATA } from '@s9/core';
import type { ExecutionRow } from '../../db/rows.js';

/**
 * Execution routes.
 *
 * The execution history is the product: every run is inspectable, and the
 * recovery operations are explicit.
 */

const RetryBody = z.object({
  stepKey: z.string().min(1),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

const RerunBody = z.object({
  useCurrentVersion: z.boolean().default(false),
  input: z.record(z.string(), z.unknown()).optional(),
});

const ResolveBody = z.object({
  outcome: z.enum(['succeeded', 'failed']),
  reason: z.string().min(3, 'a reason is required').max(1_000),
});

export async function registerExecutionRoutes(app: App): Promise<void> {
  app.get('/api/executions', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['read'] });
    const query = c.req.query();
    const pagination = parsePagination(query);

    const { rows, total } = await listExecutions(getDb(), ctx.workspaceId, {
      workflowId: typeof query.workflowId === 'string' ? query.workflowId : undefined,
      status: (query.status as never) ?? 'all',
      triggerType: (query.triggerType as never) ?? 'all',
      isTest: (query.isTest as never) ?? 'all',
      search: typeof query.search === 'string' ? query.search : undefined,
      from: parseDate(query.from),
      to: parseDate(query.to),
      page: pagination.page,
      pageSize: pagination.pageSize,
    });

    return paginated(rows.map(toExecutionSummary), total, pagination);
  }));

  app.get('/api/executions/:id', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['read'] });
    const { id } = c.req.param() as { id: string };

    const db = getDb();
    const execution = await getExecutionWithWorkflow(db, ctx.workspaceId, id);
    if (!execution) throw ApiError.notFound('execution not found');

    const steps = await listStepExecutions(db, id);
    const details = [];
    for (const step of steps) {
      const attempts = await listStepAttempts(db, step.id);
      const metadata = ACTION_METADATA[step.type as keyof typeof ACTION_METADATA];
      details.push(toStepExecutionDto(step, attempts, metadata?.defaultSafeToRepeat ?? false));
    }

    const audit = await listAuditEvents(db, ctx.workspaceId, {
      targetType: 'execution',
      targetId: id,
      page: 1,
      pageSize: 100,
    });

    const hasUnknownOutcome = details.some((step) => step.status === 'outcome_unknown');
    const failedStep = details.find((step) => step.status === 'failed');

    return {
      ...toExecutionSummary(execution),
      input: execution.input ?? {},
      output: execution.output,
      steps: details,
      timeline: buildTimeline(execution, details),
      audit: audit.rows.map(toAuditEventDto),
      availableActions: {
        retryStep: execution.status === 'failed' && Boolean(failedStep || hasUnknownOutcome),
        rerun: execution.status === 'failed' || execution.status === 'succeeded',
        cancel: execution.status === 'queued' || execution.status === 'running' || execution.status === 'retrying',
        resolveOutcomeUnknown: hasUnknownOutcome,
      },
    };
  }));

  app.post('/api/executions/:id/retry', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['retry'] });
    const { id } = c.req.param() as { id: string };
    const body = RetryBody.parse(await readJson(c));

    const idempotencyKey =
      body.idempotencyKey ?? c.req.header('idempotency-key') ?? `retry:${id}:${body.stepKey}:${Date.now()}`;

    const result = await retryStep({
      workspaceId: ctx.workspaceId,
      executionId: id,
      stepKey: body.stepKey,
      idempotencyKey,
      actorId: ctx.userId,
    });

    c.status(result.duplicate ? 200 : 202);
    return {
      executionId: id,
      stepKey: body.stepKey,
      accepted: result.accepted,
      duplicate: result.duplicate,
    };
  }));

  app.post('/api/executions/:id/rerun', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['retry'] });
    const { id } = c.req.param() as { id: string };
    const body = RerunBody.parse(await readJson(c));

    const result = await rerunExecution({
      workspaceId: ctx.workspaceId,
      executionId: id,
      actorId: ctx.userId,
      useCurrentVersion: body.useCurrentVersion,
      ...(body.input ? { correctedInput: body.input } : {}),
    });

    c.status(202);
    // A rerun repeats every step, including the ones that already succeeded.
    return {
      executionId: result.id,
      rerunOfExecutionId: id,
      status: 'queued',
      warning: 'a rerun repeats every step, including the ones that already succeeded',
    };
  }));

  app.post('/api/executions/:id/cancel', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['retry'] });
    const { id } = c.req.param() as { id: string };

    await cancelExecution({ workspaceId: ctx.workspaceId, executionId: id, actorId: ctx.userId });
    return { executionId: id, status: 'cancelled' };
  }));

  app.post('/api/executions/:id/steps/:stepKey/resolve', jsonRoute(async (c) => {
    const ctx = await requireContext(c, { capabilities: ['retry'] });
    const { id, stepKey } = c.req.param() as { id: string; stepKey: string };
    const body = ResolveBody.parse(await readJson(c));

    const result = await resolveOutcomeUnknown({
      workspaceId: ctx.workspaceId,
      executionId: id,
      stepKey,
      outcome: body.outcome,
      reason: body.reason,
      actorId: ctx.userId,
    });

    return {
      executionId: id,
      stepKey,
      status: body.outcome,
      continued: result.continued,
    };
  }));
}

interface StepDetail {
  stepKey: string;
  status: string;
  attemptCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: { message: string } | null;
}

function buildTimeline(
  execution: ExecutionRow,
  steps: StepDetail[],
): {
  at: string;
  type: 'execution' | 'step';
  stepKey?: string;
  message: string;
  status?: string;
}[] {
  const timeline: {
    at: string;
    type: 'execution' | 'step';
    stepKey?: string;
    message: string;
    status?: string;
  }[] = [];

  timeline.push({
    at: execution.created_at.toISOString(),
    type: 'execution',
    message: `the execution was created by the ${execution.trigger_type} trigger`,
    status: 'queued',
  });

  for (const step of steps) {
    if (step.startedAt) {
      timeline.push({
        at: step.startedAt,
        type: 'step',
        stepKey: step.stepKey,
        message: `step "${step.stepKey}" started`,
        status: 'running',
      });
    }
    if (step.finishedAt) {
      timeline.push({
        at: step.finishedAt,
        type: 'step',
        stepKey: step.stepKey,
        message: `step "${step.stepKey}" ${step.status}`,
        status: step.status,
      });
    }
  }

  if (execution.finished_at) {
    timeline.push({
      at: execution.finished_at.toISOString(),
      type: 'execution',
      message: `the execution ${execution.status}`,
      status: execution.status,
    });
  }

  return timeline.sort((a, b) => a.at.localeCompare(b.at));
}

export { getStepExecution };
