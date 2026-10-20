import { z } from 'zod';
import {
  EmailConfigSchema,
  FlowForgeError,
  sanitizeErrorSummary,
  stripControlCharacters,
  type ActionContext,
  type ActionExecutor,
  type ActionResult,
  type ClassifiedError,
} from '@flowforge/core';
import { env } from '../config/env.js';

/**
 * The email action.
 *
 * Two providers are supported: the real one (Resend) and a local mail catcher
 * for tests. Provider credentials come from a credential record; they never
 * live in the workflow definition.
 *
 * CR/LF is stripped from the mapped recipient and subject so a mapped value
 * cannot inject additional headers.
 */

const OutputSchema = z.object({
  messageId: z.string(),
  provider: z.string(),
  accepted: z.boolean(),
  simulated: z.boolean().optional(),
});

export function createEmailExecutor(): ActionExecutor {
  return {
    type: 'send_email',
    configSchema: EmailConfigSchema,
    outputSchema: OutputSchema,
    // Sending an email is a side effect that cannot be undone.
    safeToRepeat: false,
    redactionKeys: ['credential', 'apiKey', 'body'],

    validateConfig(config: unknown) {
      const parsed = EmailConfigSchema.safeParse(config ?? {});
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join('; ') };
      }
      return { ok: true, value: parsed.data };
    },

    async execute(context: ActionContext): Promise<ActionResult> {
      const config = EmailConfigSchema.parse(context.input);
      const to = stripControlCharacters(config.to);
      const subject = stripControlCharacters(config.subject);
      const from = stripControlCharacters(config.from);

      if (context.simulate) {
        return {
          output: {
            messageId: `simulated-${context.executionId}-${context.stepKey}`,
            provider: config.provider,
            accepted: true,
            simulated: true,
          },
        };
      }

      const provider = config.provider;
      if (provider === 'resend') {
        return sendWithResend(context, config, { to, subject, from });
      }
      return sendWithLocalCatcher(context, config, { to, subject, from });
    },

    classifyError(error: unknown): ClassifiedError {
      if (error instanceof FlowForgeError) return error.toClassified();
      return {
        class: 'transient_provider',
        message: sanitizeErrorSummary((error as Error)?.message ?? 'the email could not be sent'),
        safeToRepeat: false,
      };
    },
  };
}

interface NormalisedMessage {
  to: string;
  subject: string;
  from: string;
}

async function sendWithResend(
  context: ActionContext,
  config: z.infer<typeof EmailConfigSchema>,
  message: NormalisedMessage,
): Promise<ActionResult> {
  const apiKey = context.credential?.secret;
  if (!apiKey) {
    throw FlowForgeError.validation('the send_email action needs a Resend API key in a credential');
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  };
  const idempotencyHeader = config.idempotencyHeader ?? 'Idempotency-Key';
  headers[idempotencyHeader] = context.idempotencyKey;

  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        text: config.body,
      }),
      signal: context.signal,
    });
  } catch (error) {
    throw wrapNetworkError(error, 'the email provider could not be reached');
  }

  if (!response.ok) {
    const detail = sanitizeErrorSummary(await response.text().catch(() => ''), 300);
    if (response.status === 429) {
      throw FlowForgeError.rateLimited(`the email provider replied with 429`, undefined, { detail });
    }
    if (response.status >= 500) {
      throw new FlowForgeError('transient_provider', `the email provider replied with ${response.status}`, {
        safeToRepeat: false,
        status: response.status,
        details: { detail },
      });
    }
    throw new FlowForgeError('permanent_provider', `the email provider replied with ${response.status}`, {
      safeToRepeat: false,
      status: response.status,
      details: { detail },
    });
  }

  const body = (await response.json().catch(() => ({}))) as { id?: string };
  return {
    output: {
      messageId: body.id ?? context.idempotencyKey,
      provider: 'resend',
      accepted: true,
    },
    status: response.status,
  };
}

async function sendWithLocalCatcher(
  context: ActionContext,
  config: z.infer<typeof EmailConfigSchema>,
  message: NormalisedMessage,
): Promise<ActionResult> {
  const baseUrl = env().MAILPIT_URL.replace(/\/$/, '');
  const from = splitAddress(message.from);
  const recipient = splitAddress(message.to);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v1/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        From: { Name: from.name, Email: from.email },
        To: [{ Name: recipient.name, Email: recipient.email }],
        Subject: message.subject,
        Text: config.body,
      }),
      signal: context.signal,
    });
  } catch (error) {
    throw wrapNetworkError(error, 'the local mail catcher could not be reached');
  }

  if (!response.ok) {
    const detail = sanitizeErrorSummary(await response.text().catch(() => ''), 300);
    throw new FlowForgeError('transient_provider', `the local mail catcher replied with ${response.status}`, {
      safeToRepeat: false,
      status: response.status,
      details: { detail },
    });
  }

  const body = (await response.json().catch(() => ({}))) as { ID?: string };
  return {
    output: {
      messageId: body.ID ?? `local-${context.executionId}-${context.stepKey}`,
      provider: 'mailpit',
      accepted: true,
    },
    status: response.status,
  };
}

/** Splits `Name <address@example.com>` into its parts. */
function splitAddress(value: string): { name: string; email: string } {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match?.[1] && match[2]) return { name: match[1], email: match[2] };
  return { name: '', email: value.trim() };
}

function wrapNetworkError(error: unknown, message: string): Error {
  const err = error as { name?: string; code?: string; message?: string };
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
    // The provider may still have accepted the message.
    return FlowForgeError.timeout(`${message} (timeout)`, false);
  }
  return new FlowForgeError('transient_provider', sanitizeErrorSummary(err.message ?? message), {
    safeToRepeat: false,
  });
}
