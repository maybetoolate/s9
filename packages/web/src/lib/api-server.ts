import { cookies } from 'next/headers';
import { apiFetch as baseFetch, type RequestOptions } from './api';

/**
 * The server-side API client.
 *
 * A server component has no cookie jar, so the session cookie of the request
 * is forwarded to the API explicitly. Authorization is applied at the API
 * boundary: the web app never decides what a user may see.
 */

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;

  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set('content-type', 'application/json');

  const cookieStore = await cookies();
  const cookie = cookieStore.get('flowforge.session_token')?.value;
  if (cookie) requestHeaders.set('cookie', `flowforge.session_token=${cookie}`);

  return baseFetch<T>(path, { ...rest, headers: requestHeaders, credentials: 'omit' });
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

export { ApiRequestError } from './api';
export type { RequestOptions } from './api';
