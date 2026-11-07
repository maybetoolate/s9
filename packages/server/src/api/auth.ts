import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
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

const config = env();
const serviceScopes = config.AUTH_CLIENT_SCOPES.split(' ').filter(Boolean);

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
});

export const auth = betterAuth({
  database: pool,
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
  // The JWT plugin's `/token` endpoint mints a token from a browser session.
  // Only the OAuth provider should issue access tokens, so it is disabled.
  disabledPaths: ['/token'],
  plugins: [
    jwt(),
    oauthProvider({
      loginPage: '/login',
      consentPage: '/consent',
      scopes: serviceScopes,
      resources: [
        {
          identifier: config.AUTH_API_RESOURCE,
          name: 'FlowForge API',
          allowedScopes: serviceScopes,
        },
      ],
      grantTypes: ['client_credentials'],
      m2mAccessTokenExpiresIn: config.AUTH_SERVICE_TOKEN_TTL,
      storeClientSecret: 'hashed',
    }),
  ],
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
      secure: config.WEB_PUBLIC_URL.startsWith('https://'),
    },
  },
  logger: {
    disabled: false,
    level: config.NODE_ENV === 'development' ? 'debug' : 'error',
  },
});

export type Auth = typeof auth;
export { pool as authPool, logger };
