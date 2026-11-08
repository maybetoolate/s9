import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { env } from '../config/env.js';
import { getDb } from '../db/client.js';
import { schema } from '../db/schema.js';

/**
 * The Better-Auth instance.
 *
 * This file is private to the auth module: the rest of the application talks
 * to `src/auth/index.ts`, which exposes session resolution and the HTTP
 * surface. That keeps Better-Auth's schema and API from leaking into the
 * workflow code, so the module could be extracted into its own process later
 * without touching its callers.
 *
 * The session and password protocol comes from a maintained authentication
 * library; s9 does not implement its own. Authorization is applied at the
 * server boundary: hiding a control in the UI is not authorization.
 */

const config = env();

export const auth = betterAuth({
  // The auth module shares the application Drizzle client: it runs in the same
  // process, so a second connection pool would only add connections. It still
  // owns its tables (`user`, `session`, `account`, `verification`).
  database: drizzleAdapter(getDb(), { provider: 'pg', schema }),
  secret: config.SESSION_SECRET,
  baseURL: config.WEB_PUBLIC_URL,
  basePath: '/api/auth',
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    cookiePrefix: 's9',
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      // The cookie is only marked `Secure` when the deployment is actually
      // served over HTTPS. Deriving it from NODE_ENV would break a plain HTTP
      // deployment (a browser silently drops a `Secure` cookie), and deriving
      // it from the public URL keeps a container behind a TLS terminator
      // correct.
      secure: config.WEB_PUBLIC_URL.startsWith('https://'),
    },
  },
  logger: {
    disabled: false,
    level: config.NODE_ENV === 'development' ? 'debug' : 'error',
  },
});

export type Auth = typeof auth;
