import { z } from 'zod';
import {
  classifyHttpStatus,
  S9Error,
  LIMITS,
  NotificationConfigSchema,
  sanitizeErrorSummary,
  validateHttpDestination,
  validateResolvedAddress,
  type ActionContext,
  type ActionExecutor,
  type ActionResult,
  type ClassifiedError,
} from '@s9/core';
import { lookup } from 'node:dns/promises';
import { allowedPrivateHosts } from '../lib/allowed-hosts.js';

/**
 * The notification action.
 *
 * A Slack style incoming webhook. The destination URL is a secret: it is
 * either stored in a credential (provider `notification`) or configured
 * directly on the step, and the resolved address is validated so the action
 * cannot be pointed at an internal service.
 */

const OutputSchema = z.object({
  channel: z.string(),
  delivered: z.boolean(),
  status: z.number().optional(),
});

export class NotificationExecutor implements ActionExecutor {
  readonly type = 'notification';
  readonly configSchema = NotificationConfigSchema;
  readonly outputSchema = OutputSchema;
  // Posting a message is a side effect that cannot be undone.
  readonly safeToRepeat = false;
  readonly redactionKeys = ['webhookUrl', 'credential'];

  validateConfig(config: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
    const parsed = NotificationConfigSchema.safeParse(config ?? {});
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join('; ') };
    }
    if (!parsed.data.webhookUrl && !parsed.data.credentialId) {
      return {
        ok: false,
        message: 'a webhook URL or a credential with the destination URL is required',
      };
    }
    if (parsed.data.webhookUrl) {
      const destination = validateHttpDestination(parsed.data.webhookUrl, {
        allowedHosts: allowedPrivateHosts(),
      });
      if (!destination.ok) return { ok: false, message: destination.reason ?? 'the destination is not allowed' };
    }
    return { ok: true, value: parsed.data };
  }

  async execute(context: ActionContext): Promise<ActionResult> {
    const config = NotificationConfigSchema.parse(context.input);
    const destination = config.webhookUrl ?? context.credential?.secret;

    if (!destination) {
      throw S9Error.validation('the notification action has no destination URL');
    }

    if (context.simulate) {
      return { output: { channel: config.channel, delivered: true, status: 200 } };
    }

    const validation = validateHttpDestination(destination, { allowedHosts: allowedPrivateHosts() });
    if (!validation.ok) {
      throw S9Error.validation(validation.reason ?? 'the destination is not allowed');
    }

    const resolved = await resolvePublicAddress(destination);
    if (!resolved) {
      throw S9Error.validation('the destination resolves only to blocked addresses');
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.idempotencyHeader) headers[config.idempotencyHeader] = context.idempotencyKey;

    let response: Response;
    try {
      response = await fetch(destination, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: config.message, channel: config.channel }),
        redirect: 'manual',
        signal: context.signal,
      });
    } catch (error) {
      const err = error as { name?: string; message?: string };
      if (err.name === 'AbortError') {
        throw S9Error.timeout('the notification request timed out', false);
      }
      throw new S9Error('transient_provider', sanitizeErrorSummary(err.message ?? 'the request failed'), {
        safeToRepeat: false,
      });
    }

    if (!response.ok) {
      const errorClass = classifyHttpStatus(response.status);
      const detail = sanitizeErrorSummary(await response.text().catch(() => ''), 300);
      if (errorClass === 'rate_limited') {
        throw S9Error.rateLimited('the notification destination replied with 429', undefined, { detail });
      }
      if (errorClass === 'transient_provider') {
        throw new S9Error('transient_provider', `the destination replied with ${response.status}`, {
          safeToRepeat: false,
          status: response.status,
          details: { detail },
        });
      }
      throw new S9Error('permanent_provider', `the destination replied with ${response.status}`, {
        safeToRepeat: false,
        status: response.status,
        details: { detail },
      });
    }

    return { output: { channel: config.channel, delivered: true, status: response.status }, status: response.status };
  }

  classifyError(error: unknown): ClassifiedError {
    if (error instanceof S9Error) return error.toClassified();
    return {
      class: 'transient_provider',
      message: sanitizeErrorSummary((error as Error)?.message ?? 'the notification failed'),
      safeToRepeat: false,
    };
  }
}

export function createNotificationExecutor(): ActionExecutor {
  return new NotificationExecutor();
}

/** Resolves the destination and rejects private addresses. */
async function resolvePublicAddress(url: string): Promise<string | null> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    const allowed = addresses.filter((entry) =>
      validateResolvedAddress(entry.address, {
        allowedHosts: allowedPrivateHosts(),
        hostname,
      }).ok,
    );
    return allowed[0]?.address ?? null;
  } catch {
    return null;
  }
}

export { LIMITS };
