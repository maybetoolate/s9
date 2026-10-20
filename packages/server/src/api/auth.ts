import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Authentication.
 *
 * The session and password protocol comes from a maintained authentication
 * library; FlowForge does not implement its own. Authorization is applied at
 * the server boundary: hiding a control in the UI is not authorization.
 */

const pool = new Pool({
  connectionString: env().DATABASE_URL,
  max: 10,
});

export const auth = betterAuth({
  database: pool,
  secret: env().SESSION_SECRET,
  baseURL: env().WEB_PUBLIC_URL,
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
    cookiePrefix: 'flowforge',
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      // The cookie is only marked `Secure` when the deployment is actually
      // served over HTTPS. Deriving it from NODE_ENV would break a plain HTTP
      // deployment (a browser silently drops a `Secure` cookie), and deriving
      // it from the public URL keeps a container behind a TLS terminator
      // correct.
      secure: env().WEB_PUBLIC_URL.startsWith('https://'),
    },
  },
  logger: {
    disabled: false,
    level: env().NODE_ENV === 'development' ? 'debug' : 'error',
  },
});

export type Auth = typeof auth;
export { pool as authPool, logger };
