import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer, closePool, createSession, resetData } from './helpers.js';

/**
 * The service boundary.
 *
 * The API validates the session and reads the profile through the auth
 * service; it must never answer these requests from the Better-Auth tables
 * itself. These tests drive the real API and the real auth service (started by
 * the test setup on an ephemeral port).
 */
describe('auth service boundary', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  beforeEach(async () => {
    await resetData();
  });

  it('returns the profile from the auth service on /api/me', async () => {
    const context = await createSession(
      app,
      `profile-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: context.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { user: { id: string; email: string; name: string } };
    expect(body.user.id).toBe(context.userId);
    expect(body.user.email).toBe(context.email);
    expect(body.user.name).toBe('Integration Test');
  });

  it('rejects /api/me without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a session cookie that the auth service does not know', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: 'flowforge.session_token=not-a-real-session' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects an internal call without a service token', async () => {
    const response = await fetch(`${process.env.AUTH_INTERNAL_URL}/internal/sessions/validate`, {
      method: 'POST',
    });

    expect(response.status).toBe(401);
  });

  it('rejects an internal call with an invalid service token', async () => {
    const response = await fetch(`${process.env.AUTH_INTERNAL_URL}/internal/sessions/validate`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-real-access-token' },
    });

    expect(response.status).toBe(401);
  });

  it('rejects a service token that does not grant the required scope', async () => {
    const credentials = Buffer.from(
      `${process.env.AUTH_CLIENT_ID}:${process.env.AUTH_CLIENT_SECRET}`,
    ).toString('base64');

    const tokenResponse = await fetch(`${process.env.AUTH_INTERNAL_URL}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'users:read',
        resource: process.env.AUTH_API_RESOURCE ?? 'urn:flowforge:api',
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const { access_token: token } = (await tokenResponse.json()) as { access_token: string };

    // The token is valid, but it grants `users:read`, not `sessions:validate`.
    const response = await fetch(`${process.env.AUTH_INTERNAL_URL}/internal/sessions/validate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('insufficient_scope');
  });
});
