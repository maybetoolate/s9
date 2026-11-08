import { env } from '../config/env.js';
import { relayResponse } from '../api/http.js';
import { auth } from './instance.js';

/**
 * The auth HTTP surface.
 *
 * The API mounts this at `/api/auth/*`; it is not a separate server. The
 * request is rewritten to the public origin because Better-Auth builds URLs
 * and cookie scopes from its configured base URL, which is the web app's
 * origin even when the API is reached on a different host or port.
 */
export async function handleAuthRequest(request: Request): Promise<Response> {
  const config = env();
  const incoming = new URL(request.url);
  const url = new URL(incoming.pathname + incoming.search, config.WEB_PUBLIC_URL);

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    // Hop-by-hop headers are owned by the new request.
    if (key === 'host' || key === 'connection' || key === 'content-length') continue;
    headers.append(key, value);
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : undefined;

  const response = await auth.handler(
    new Request(url.toString(), {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    }),
  );

  return relayResponse(response);
}
