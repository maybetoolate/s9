/**
 * The address of the s9 API.
 *
 * `API_INTERNAL_URL` is the server-to-server address (the service name inside
 * a container network). `API_PUBLIC_URL` is the address a browser or a webhook
 * sender uses. Both are read at runtime, never at build time.
 */

export function API_INTERNAL_URL(): string | undefined {
  return process.env.API_INTERNAL_URL?.trim() || undefined;
}

export function API_PUBLIC_URL(): string | undefined {
  return process.env.API_PUBLIC_URL?.trim() || undefined;
}

/** The address the server components use. */
export function serverApiUrl(): string {
  return API_INTERNAL_URL() ?? API_PUBLIC_URL() ?? 'http://localhost:4100';
}
