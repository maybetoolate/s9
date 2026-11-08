import { lookup, type LookupAllOptions } from 'node:dns';
import { Agent, request } from 'undici';
import { z } from 'zod';
import {
  classifyHttpStatus,
  S9Error,
  HttpRequestConfigSchema,
  LIMITS,
  redactValue,
  sanitizeErrorSummary,
  validateHttpDestination,
  validateResolvedAddress,
  type ActionContext,
  type ActionExecutor,
  type ActionResult,
  type ClassifiedError,
} from '@s9/core';
import { allowedPrivateHosts } from '../lib/allowed-hosts.js';

/**
 * The HTTP request action.
 *
 * Safeguards (blueprint section 11 and 13):
 *  - private and internal destinations are blocked unless explicitly allowed;
 *  - the resolved address is re-checked for every connection (DNS rebinding);
 *  - redirects are not followed by default;
 *  - the response body is size limited;
 *  - the request has a deadline;
 *  - headers are redacted before they are logged or stored.
 */

const OutputSchema = z.object({
  status: z.number().int(),
  body: z.unknown().optional(),
  truncated: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'x-auth-token', 'proxy-authorization']);

/**
 * A `lookup` implementation that only ever hands back addresses that passed
 * the SSRF validation, so a hostname that resolves to a private address can
 * not be reached even if it changed between validation and connection.
 */
function createSafeLookup(allowPrivateNetwork: boolean) {
  const allowed = allowedPrivateHosts();
  return (
    hostname: string,
    options: LookupAllOptions,
    callback: (err: NodeJS.ErrnoException | null, addresses?: unknown[], family?: number) => void,
  ): void => {
    lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      const permitted = addresses.filter((entry) =>
        validateResolvedAddress(entry.address, {
          allowPrivateNetwork,
          allowedHosts: allowed,
          hostname,
        }).ok,
      );
      if (permitted.length === 0) {
        callback(
          Object.assign(new Error(`the host "${hostname}" resolves only to blocked addresses`), {
            code: 'EHOSTUNREACH',
          }),
        );
        return;
      }
      const first = permitted[0];
      if (!first) {
        callback(new Error('the host could not be resolved'));
        return;
      }
      callback(null, [first], first.family);
    });
  };
}

export class HttpRequestExecutor implements ActionExecutor {
  readonly type = 'http_request';
  readonly configSchema = HttpRequestConfigSchema;
  readonly outputSchema = OutputSchema;
  // An HTTP request may have a side effect, so repeating it is unsafe
  // unless the caller opted into an idempotency header.
  readonly safeToRepeat = false;
  readonly redactionKeys = ['headers', 'body', 'authorization'];

  validateConfig(config: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
    const parsed = HttpRequestConfigSchema.safeParse(config ?? {});
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join('; ') };
    }
    const destination = validateHttpDestination(parsed.data.url, {
      allowPrivateNetwork: parsed.data.allowPrivateNetwork,
      allowedHosts: allowedPrivateHosts(),
    });
    if (!destination.ok) {
      return { ok: false, message: destination.reason ?? 'the destination is not allowed' };
    }
    return { ok: true, value: parsed.data };
  }

  async execute(context: ActionContext): Promise<ActionResult> {
    const config = HttpRequestConfigSchema.parse(context.input);
    const allowPrivateNetwork = config.allowPrivateNetwork === true;

    const destination = validateHttpDestination(config.url, {
      allowPrivateNetwork,
      allowedHosts: allowedPrivateHosts(),
    });
    if (!destination.ok) {
      throw S9Error.validation(destination.reason ?? 'the destination is not allowed');
    }

    if (context.simulate) {
      return {
        output: {
          status: 200,
          body: { simulated: true, url: config.url, method: config.method },
          truncated: false,
        },
        status: 200,
      };
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      headers[key] = value;
    }
    if (context.credential?.secret) {
      headers.authorization ??= context.credential.secret;
    }
    if (config.idempotencyHeader) {
      headers[config.idempotencyHeader] = context.idempotencyKey;
    }

    let body: string | undefined;
    if (config.body !== undefined && config.method !== 'GET') {
      body = config.bodyType === 'json' ? config.body : config.body;
      if (config.bodyType === 'json' && !headers['content-type']) headers['content-type'] = 'application/json';
    }

    const agent = new Agent({
      connect: {
        lookup: createSafeLookup(allowPrivateNetwork) as never,
      },
    });

    try {
      const response = await request(config.url, {
        method: config.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        dispatcher: agent,
        // undici does not follow redirects unless the redirect interceptor
        // is enabled, so a 3xx is returned to the action as-is.
        headersTimeout: config.timeoutMs,
        bodyTimeout: config.timeoutMs,
        signal: context.signal,
      });

      const { text, truncated } = await readLimited(response.body, LIMITS.maxHttpResponseBytes);
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === 'string' && !SENSITIVE_HEADERS.has(key.toLowerCase())) {
          responseHeaders[key.toLowerCase()] = value;
        }
      }

      if (response.statusCode >= 400) {
        const errorClass = classifyHttpStatus(response.statusCode);
        const retryAfter = parseRetryAfter(response.headers['retry-after']);
        const message = `the endpoint responded with ${response.statusCode}`;
        if (errorClass === 'rate_limited') {
          throw S9Error.rateLimited(message, retryAfter, { status: response.statusCode });
        }
        if (errorClass === 'transient_provider') {
          throw new S9Error('transient_provider', message, {
            safeToRepeat: isRepeatSafe(config.method, config.idempotencyHeader),
            status: response.statusCode,
          });
        }
        throw new S9Error('permanent_provider', message, {
          safeToRepeat: false,
          status: response.statusCode,
          details: { body: sanitizeErrorSummary(text, 300) },
        });
      }

      let parsedBody: unknown = text;
      try {
        parsedBody = text ? JSON.parse(text) : null;
      } catch {
        // Keep the raw text when the response is not JSON.
      }

      return {
        output: {
          status: response.statusCode,
          body: parsedBody,
          truncated,
          headers: responseHeaders,
        },
        status: response.statusCode,
      };
    } catch (error) {
      throw wrapTransportError(error, config);
    } finally {
      // Bun ships its own `undici` module whose Agent is a thin fetch wrapper
      // without `close`; Node's undici Agent needs to be closed to release
      // sockets, so close it when the runtime provides the method.
      await (agent.close?.() ?? Promise.resolve()).catch(() => undefined);
    }
  }

  classifyError(error: unknown): ClassifiedError {
    if (error instanceof S9Error) return error.toClassified();
    return {
      class: 'transient_provider',
      message: sanitizeErrorSummary((error as Error)?.message ?? 'the request failed'),
      safeToRepeat: false,
    };
  }
}

export function createHttpRequestExecutor(): ActionExecutor {
  return new HttpRequestExecutor();
}

function isRepeatSafe(method: string, idempotencyHeader: string | undefined): boolean {
  if (idempotencyHeader) return true;
  return method === 'GET' || method === 'HEAD';
}

function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function wrapTransportError(error: unknown, config: z.infer<typeof HttpRequestConfigSchema>): Error {
  if (error instanceof S9Error) return error;

  const err = error as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  const code = err.code ?? err.cause?.code;

  if (err.name === 'AbortError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED') {
    // A timeout does not prove the remote operation failed. Repeating a
    // non-idempotent request could duplicate the side effect.
    return S9Error.timeout(
      `the request did not complete within ${config.timeoutMs}ms`,
      isRepeatSafe(config.method, config.idempotencyHeader),
    );
  }
  if (code === 'EHOSTUNREACH' || code === 'ENOTFOUND' || code === 'ECONNREFUSED') {
    return new S9Error('transient_provider', `the endpoint could not be reached (${code})`, {
      safeToRepeat: isRepeatSafe(config.method, config.idempotencyHeader),
    });
  }
  if (code === 'UND_ERR_RESPONSE_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return S9Error.timeout(
      `the request timed out (${code})`,
      isRepeatSafe(config.method, config.idempotencyHeader),
    );
  }
  return new S9Error('transient_provider', sanitizeErrorSummary(err.message ?? 'the request failed'), {
    safeToRepeat: isRepeatSafe(config.method, config.idempotencyHeader),
  });
}

/** Reads at most `limit` bytes from a stream. */
async function readLimited(
  body: AsyncIterable<Buffer | Uint8Array>,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;

  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      chunks.push(buffer.subarray(0, Math.max(0, limit - (size - buffer.length))));
      truncated = true;
      break;
    }
    chunks.push(buffer);
  }

  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** Redacts the request headers before they are stored in the step input. */
export function redactRequestHeaders(headers: Record<string, string>): Record<string, string> {
  return redactValue(headers);
}
