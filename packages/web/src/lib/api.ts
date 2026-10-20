import { API_INTERNAL_URL, API_PUBLIC_URL } from '@/lib/api-url';

/**
 * The browser-safe API client.
 *
 * This module must stay free of server-only imports (such as `next/headers`)
 * so client components can use it. The server variant, which forwards the
 * session cookie, lives in `api-server.ts`.
 *
 * The browser talks to the web app, which proxies the call to the API. The
 * address of the API is therefore never part of the browser bundle.
 */

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Kept for symmetry with the server client. */
  browser?: boolean;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, browser: _browser, headers, ...rest } = options;

  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set('content-type', 'application/json');

  const response = await fetch(path, {
    ...rest,
    headers: requestHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    credentials: 'include',
  });

  const text = await response.text();
  const payload = text ? safeJson(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? `the request failed with ${response.status}`,
      error?.details,
    );
  }

  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string, options: RequestOptions = {}) => apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
    apiFetch<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
    apiFetch<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options: RequestOptions = {}) => apiFetch<T>(path, { ...options, method: 'DELETE' }),
};

/** Escapes a path segment. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

export { API_INTERNAL_URL, API_PUBLIC_URL };
