import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { LIMITS, redactString } from '@s9/core';
import type { AppContext } from './context.js';

/**
 * The API error envelope.
 *
 * Every error response has the same shape so the UI (and a support engineer)
 * can always find the request id, the machine readable code and a sanitized
 * message.
 */

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, code = 'bad_request', details?: unknown): ApiError {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(message = 'authentication required'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }
  static forbidden(message = 'you do not have access to this resource'): ApiError {
    return new ApiError(403, 'forbidden', message);
  }
  static notFound(message = 'not found'): ApiError {
    return new ApiError(404, 'not_found', message);
  }
  static conflict(message: string, code = 'conflict'): ApiError {
    return new ApiError(409, code, message);
  }
  static tooManyRequests(message: string, code = 'rate_limited'): ApiError {
    return new ApiError(429, code, message);
  }
  static payloadTooLarge(message: string): ApiError {
    return new ApiError(413, 'payload_too_large', message);
  }
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export function sendError(c: Context, error: unknown, requestId?: string): Response {
  const statusCode = error instanceof ApiError ? error.statusCode : 500;
  const code = error instanceof ApiError ? error.code : 'internal_error';
  const message =
    error instanceof ApiError ? error.message : redactString((error as Error)?.message ?? 'an unexpected error occurred');

  const body: ErrorBody = {
    error: {
      code,
      message,
      ...(error instanceof ApiError && error.details !== undefined ? { details: error.details } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };

  return c.json(body, statusCode as ContentfulStatusCode);
}

/**
 * Reads the JSON request body.
 *
 * An empty body is treated as an empty object, matching the old parser, and
 * invalid JSON is reported through the normal error envelope.
 */
export async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_json', 'the request body is not valid JSON');
  }
}

/** Wraps a handler so a plain object (or a DTO) is serialized as JSON. */
export function jsonRoute(
  handler: (c: AppContext) => Promise<unknown> | unknown,
): (c: AppContext) => Promise<Response> {
  return async (c) => {
    const result = await handler(c);
    if (result instanceof Response) return result;
    return c.json(result as never);
  };
}

/**
 * Copies an upstream response into a Hono response, keeping `set-cookie`
 * headers separate instead of flattening them.
 */
export async function relayResponse(upstream: Response): Promise<Response> {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie' || key.toLowerCase() === 'content-length') return;
    headers.set(key, value);
  });

  for (const cookie of upstream.headers.getSetCookie?.() ?? []) {
    headers.append('set-cookie', cookie);
  }

  return new Response(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers,
  });
}

export interface Pagination {
  page: number;
  pageSize: number;
}

export function parsePagination(query: Record<string, unknown>): Pagination {
  const page = Number.parseInt(String(query.page ?? '1'), 10);
  const pageSize = Number.parseInt(String(query.pageSize ?? String(LIMITS.defaultPageSize)), 10);
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, LIMITS.maxPageSize) : LIMITS.defaultPageSize,
  };
}

export function paginated<T>(data: T[], total: number, pagination: Pagination) {
  return {
    data,
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pagination.pageSize)),
    },
  };
}

/** Parses an optional ISO date from a query parameter. */
export function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
