import { createHash } from 'node:crypto';
import { auth } from '../api/auth.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Bootstraps the OAuth client the API uses for service-to-service calls.
 *
 * The OAuth provider stores clients in its own tables, but creating one
 * through the HTTP API requires a user session. The service client has no
 * owner, so it is written through the Better-Auth adapter instead.
 *
 * The environment stays the source of truth: every start hashes the configured
 * secret and writes it back, so rotating `AUTH_CLIENT_SECRET` and restarting
 * the auth service rotates the credential. Scopes and the resource link are
 * reconciled the same way.
 */

const CLIENT_NAME = 's9 API';

/** Matches the OAuth provider's default client-secret storage format. */
function hashClientSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url');
}

export async function ensureServiceClient(): Promise<void> {
  const config = env();
  const context = await auth.$context;
  const scopes = config.AUTH_CLIENT_SCOPES.split(' ').filter(Boolean);
  const now = new Date();

  // The plugin seeds configured resources lazily. Create the row first so the
  // client link below always has a target.
  const resource = await context.adapter.findOne({
    model: 'oauthResource',
    where: [{ field: 'identifier', value: config.AUTH_API_RESOURCE }],
  });
  if (!resource) {
    await context.adapter.create({
      model: 'oauthResource',
      data: {
        identifier: config.AUTH_API_RESOURCE,
        name: CLIENT_NAME,
        allowedScopes: scopes,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  const client = await context.adapter.findOne({
    model: 'oauthClient',
    where: [{ field: 'clientId', value: config.AUTH_CLIENT_ID }],
  });

  const clientValues = {
    clientSecret: hashClientSecret(config.AUTH_CLIENT_SECRET),
    name: CLIENT_NAME,
    redirectUris: [],
    grantTypes: ['client_credentials'],
    clientCredentialsScopes: scopes,
    tokenEndpointAuthMethod: 'client_secret_basic',
    skipConsent: true,
    disabled: false,
    updatedAt: now,
  };

  if (client) {
    await context.adapter.update({
      model: 'oauthClient',
      where: [{ field: 'clientId', value: config.AUTH_CLIENT_ID }],
      update: clientValues,
    });
  } else {
    await context.adapter.create({
      model: 'oauthClient',
      data: {
        clientId: config.AUTH_CLIENT_ID,
        ...clientValues,
        createdAt: now,
      },
    });
  }

  const link = await context.adapter.findOne({
    model: 'oauthClientResource',
    where: [
      { field: 'clientId', value: config.AUTH_CLIENT_ID },
      { field: 'resourceId', value: config.AUTH_API_RESOURCE },
    ],
  });
  if (!link) {
    await context.adapter.create({
      model: 'oauthClientResource',
      data: {
        clientId: config.AUTH_CLIENT_ID,
        resourceId: config.AUTH_API_RESOURCE,
        createdAt: now,
      },
    });
  }

  logger.info(
    { clientId: config.AUTH_CLIENT_ID, resource: config.AUTH_API_RESOURCE, scopes },
    'the OAuth service client is ready',
  );
}
