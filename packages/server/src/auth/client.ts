import { env } from '../config/env.js';
import { ApiError } from '../api/http.js';

/**
 * The API's client for the auth service.
 *
 * Two calls are exposed:
 *  - `validateSession` resolves the caller of an incoming request. It forwards
 *    the user's cookie; the auth service owns the session tables.
 *  - `getUserProfile` reads the display profile for `/api/me`.
 *
 * Both use an OAuth2 client-credentials access token issued by the auth
 * service's OAuth provider. The token is cached in memory until shortly before
 * it expires and is refreshed with single-flight so a burst of requests does
 * not stampede the token endpoint.
 */

const TOKEN_SKEW_MS = 30_000;
const REQUEST_TIMEOUT_MS = 2_000;
const PROFILE_TTL_MS = 30_000;
const PROFILE_CACHE_LIMIT = 1_000;

export interface SessionInfo {
  userId: string;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let tokenInflight: Promise<CachedToken> | null = null;

const profileCache = new Map<string, { value: UserProfile; expiresAt: number }>();

/** Drops the cached token after the auth service rejected it. */
export function invalidateServiceToken(): void {
  cachedToken = null;
}

async function requestToken(): Promise<CachedToken> {
  const config = env();
  const credentials = Buffer.from(
    `${config.AUTH_CLIENT_ID}:${config.AUTH_CLIENT_SECRET}`,
  ).toString('base64');

  let response: Response;
  try {
    response = await fetch(new URL('/api/auth/oauth2/token', config.AUTH_INTERNAL_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: config.AUTH_CLIENT_SCOPES,
        resource: config.AUTH_API_RESOURCE,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ApiError(
      503,
      'auth_unavailable',
      `the auth service could not be reached: ${(error as Error).message}`,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      503,
      'auth_unavailable',
      `the auth service rejected the service credentials with ${response.status}`,
    );
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token || !body.expires_in) {
    throw new ApiError(503, 'auth_unavailable', 'the auth service returned an invalid token response');
  }

  return {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1_000,
  };
}

async function serviceToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_SKEW_MS > Date.now()) {
    return cachedToken.token;
  }
  if (tokenInflight) {
    return (await tokenInflight).token;
  }

  tokenInflight = requestToken()
    .then((issued) => {
      cachedToken = issued;
      return issued;
    })
    .finally(() => {
      tokenInflight = null;
    });

  return (await tokenInflight).token;
}

/**
 * Calls an internal endpoint with the service token.
 *
 * A 401 means the token was rotated or revoked: drop the cache, fetch a new
 * token and retry exactly once. Anything else is surfaced to the caller.
 */
async function requestInternal(path: string, init: RequestInit = {}): Promise<Response> {
  const config = env();

  const attempt = async (): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await serviceToken()}`);

    try {
      return await fetch(new URL(path, config.AUTH_INTERNAL_URL), {
        ...init,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ApiError(
        503,
        'auth_unavailable',
        `the auth service could not be reached: ${(error as Error).message}`,
      );
    }
  };

  const response = await attempt();
  if (response.status !== 401) return response;

  invalidateServiceToken();
  return attempt();
}

/** Resolves the user behind a request, or null when the cookie is not valid. */
export async function validateSession(cookie: string | undefined): Promise<SessionInfo | null> {
  if (!cookie) return null;

  const response = await requestInternal('/internal/sessions/validate', {
    method: 'POST',
    headers: { cookie },
  });

  if (response.status === 401) {
    throw new ApiError(503, 'auth_unavailable', 'the auth service rejected the service token');
  }
  if (!response.ok) {
    throw new ApiError(
      503,
      'auth_unavailable',
      `the auth service could not validate the session (${response.status})`,
    );
  }

  const body = (await response.json()) as { session: { userId: string } | null };
  return body.session ? { userId: body.session.userId } : null;
}

/** Reads a user profile from the auth service, with a short-lived cache. */
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const cached = profileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const response = await requestInternal(`/internal/users/${encodeURIComponent(userId)}`);

  if (response.status === 404) return null;
  if (response.status === 401) {
    throw new ApiError(503, 'auth_unavailable', 'the auth service rejected the service token');
  }
  if (!response.ok) {
    throw new ApiError(
      503,
      'auth_unavailable',
      `the auth service could not read the profile (${response.status})`,
    );
  }

  const profile = (await response.json()) as UserProfile;
  if (profileCache.size >= PROFILE_CACHE_LIMIT) {
    const oldest = profileCache.keys().next().value;
    if (oldest !== undefined) profileCache.delete(oldest);
  }
  profileCache.set(userId, { value: profile, expiresAt: Date.now() + PROFILE_TTL_MS });
  return profile;
}

/** Test helper: clears both caches. */
export function resetAuthClientCache(): void {
  cachedToken = null;
  tokenInflight = null;
  profileCache.clear();
}
