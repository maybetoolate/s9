import { cookies } from 'next/headers';
import { ApiRequestError, type RequestOptions } from './api';
import { serverApiUrl } from './api-url';

/**
 * The server-side API client.
 *
 * A server component has no cookie jar, so the session cookie of the request
 * is forwarded to the API explicitly. The call goes straight to the API
 * (the internal address), not through the browser proxy. Authorization is
 * applied at the API boundary: the web app never decides what a user may see.
 */

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;

  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set('content-type', 'application/json');

  const cookieStore = await cookies();
  const cookie = cookieStore.get('s9.session_token')?.value;
  if (cookie) requestHeaders.set('cookie', `s9.session_token=${cookie}`);

  const response = await fetch(`${serverApiUrl()}${path}`, {
    ...rest,
    headers: requestHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    credentials: 'omit',
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

export { ApiRequestError };
export type { RequestOptions } from './api';
