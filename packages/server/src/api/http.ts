import type { FastifyReply } from 'fastify';
import { LIMITS, redactString } from '@flowforge/core';

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

export function sendError(reply: FastifyReply, error: unknown, requestId?: string): FastifyReply {
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

  return reply.status(statusCode).send(body);
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
