import type { FastifyInstance } from 'fastify';
import {
  buildExecutionIdempotencyKey,
  LIMITS,
  payloadDigest,
  verifyWebhookSignature,
} from '@s9/core';
import { getWebhookEndpointBySlug, getWorkflowById, countRunningExecutions } from '../../db/repo.js';
import type { WebhookEndpointRow } from '../../db/rows.js';
import { getPool } from '../../db/pool.js';
import { ApiError } from '../http.js';
import { createWebhookExecution } from '../../engine/execution-service.js';
import { logger } from '../../lib/logger.js';
import { decrypt } from '../../lib/secrets.js';

/**
 * Webhook intake.
 *
 * The endpoint is public, so it is the most security sensitive surface in the
 * product:
 *  - the body is size limited;
 *  - the HMAC signature is verified with a 5 minute tolerance;
 *  - a repeated delivery inside the deduplication window creates nothing;
 *  - a paused workflow rejects the delivery with 409;
 *  - intake limits answer with 429.
 *
 * The response returns promptly after the event is durably accepted, not
 * after every workflow action finished.
 */

const SIGNATURE_HEADER = 'x-s9-signature';
const IDEMPOTENCY_HEADER = 'idempotency-key';
const EVENT_ID_HEADER = 'x-event-id';

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const db = getPool();

    const endpoint = await getWebhookEndpointBySlug(db, slug);
    if (!endpoint) {
      // Do not leak whether the endpoint exists.
      throw ApiError.notFound('unknown webhook endpoint');
    }

    const workflow = await getWorkflowById(db, endpoint.workflow_id);
    if (!workflow) throw ApiError.notFound('unknown webhook endpoint');

    // The body size is limited before anything else happens.
    const rawBody = request.rawBody;
    const bodySize = rawBody ? rawBody.length : 0;
    if (bodySize > LIMITS.maxWebhookBodyBytes) {
      throw ApiError.payloadTooLarge(
        `the webhook body may not exceed ${Math.floor(LIMITS.maxWebhookBodyBytes / 1024)} KB`,
      );
    }

    const rawText = rawBody ? rawBody.toString('utf8') : '';
    let payload: Record<string, unknown>;
    try {
      const parsed = rawText ? JSON.parse(rawText) : {};
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw ApiError.badRequest('the webhook body must be a JSON object', 'invalid_payload');
      }
      payload = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw ApiError.badRequest('the webhook body is not valid JSON', 'invalid_payload');
    }

    // A paused workflow rejects the delivery so the sender retries later.
    if (workflow.status === 'paused') {
      throw ApiError.conflict('the workflow is paused', 'workflow_paused');
    }
    if (workflow.status !== 'published' || !workflow.current_version_id) {
      throw ApiError.conflict(`the workflow is ${workflow.status}`, 'workflow_not_published');
    }

    // Signature verification.
    if (endpoint.require_signature) {
      const signature = request.headers[SIGNATURE_HEADER];
      if (!signature || typeof signature !== 'string') {
        throw ApiError.unauthorized('the webhook signature header is missing');
      }
      if (!verifyEndpointSignature(endpoint, signature, rawText)) {
        logger.warn({ slug, reason: 'signature mismatch' }, 'a webhook signature was rejected');
        throw ApiError.unauthorized('the webhook signature is not valid');
      }
    }

    const sourceKey =
      headerValue(request.headers[IDEMPOTENCY_HEADER]) ?? headerValue(request.headers[EVENT_ID_HEADER]) ?? null;

    // Backpressure: reject further intake when the workflow is over its limit.
    const queued = await countRunningExecutions(db, workflow.id);
    if (queued >= LIMITS.maxQueuedExecutionsPerWorkflow) {
      throw ApiError.tooManyRequests('the workflow has too many queued executions', 'workflow_queue_full');
    }

    const idempotencyKey = buildExecutionIdempotencyKey({
      workflowId: workflow.id,
      triggerType: 'webhook',
      triggerKey: sourceKey ?? payloadDigest(payload),
      version: 0,
    });

    const result = await createWebhookExecution({
      workspaceId: workflow.workspace_id,
      workflowId: workflow.id,
      workflowVersionId: workflow.current_version_id,
      endpointId: endpoint.id,
      sourceKey,
      payload,
      payloadDigest: payloadDigest(payload),
      idempotencyKey,
    });

    // 202 for a newly accepted event, 200 for a duplicate.
    reply.status(result.duplicate ? 200 : 202);
    return {
      executionId: result.executionId,
      status: result.duplicate ? 'duplicate' : 'accepted',
      accepted: !result.duplicate,
    };
  });
}

function headerValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Verifies the signature against the current secret and, during the overlap
 * window after a rotation, against the previous secret as well.
 */
function verifyEndpointSignature(
  endpoint: WebhookEndpointRow,
  signature: string,
  rawBody: string,
): boolean {
  if (!endpoint.encrypted_secret) return false;

  const candidates: string[] = [decrypt(endpoint.encrypted_secret)];
  if (
    endpoint.previous_encrypted_secret &&
    endpoint.previous_secret_expires_at &&
    endpoint.previous_secret_expires_at.getTime() > Date.now()
  ) {
    candidates.push(decrypt(endpoint.previous_encrypted_secret));
  }

  return candidates.some(
    (secret) =>
      verifyWebhookSignature(secret, signature, rawBody, LIMITS.webhookSignatureToleranceMs).valid,
  );
}
