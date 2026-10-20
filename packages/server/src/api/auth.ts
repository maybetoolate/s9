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
      secure: env().NODE_ENV === 'production',
    },
  },
  logger: {
    disabled: false,
    level: env().NODE_ENV === 'development' ? 'debug' : 'error',
  },
});

export type Auth = typeof auth;
export { pool as authPool, logger };
