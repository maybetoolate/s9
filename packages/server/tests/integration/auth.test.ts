import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { App } from '../../src/api/context.js';
import { workspaceMemberships, workspaces } from '../../src/db/schema.js';
import { buildServer, createSession, getDb, inject, resetData } from './helpers.js';

/**
 * The auth module.
 *
 * Authentication is embedded in the API but isolated in `src/auth`. The API
 * only ever sees an opaque session cookie; it does not read the Better-Auth
 * tables and there is no internal service-to-service surface anymore.
 */
describe('auth module', () => {
  let app: App;

  beforeAll(async () => {
    app = await buildServer();
  });

  beforeEach(async () => {
    await resetData();
  });

  it('returns the profile on /api/me', async () => {
    const context = await createSession(
      app,
      `profile-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    );

    const response = await inject(app, {
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

  it('provisions one owner workspace for a new account on first use', async () => {
    const email = `provision-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    const signUp = await inject(app, {
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password: 'integration-test-password', name: 'Provisioned User' },
    });
    expect(signUp.statusCode).toBe(200);

    const userId = (signUp.json() as { user: { id: string } }).user.id;
    const setCookie = signUp.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';

    // Sign-up creates the account only. The first authorized requests must
    // provision exactly one workspace, even when they race each other.
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        inject(app, { method: 'GET', url: '/api/me', headers: { cookie } }),
      ),
    );

    const workspaceIds = new Set<string>();
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        workspace: { id: string; name: string };
        role: string;
      };
      expect(body.role).toBe('owner');
      expect(body.workspace.name).toBe("Provisioned User's workspace");
      workspaceIds.add(body.workspace.id);
    }
    expect(workspaceIds.size).toBe(1);

    const db = getDb();
    const memberships = await db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.user_id, userId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.role).toBe('owner');
    expect(memberships[0]!.workspace_id).toBe([...workspaceIds][0]!);
    expect(await db.select().from(workspaces)).toHaveLength(1);
  });

  it('rejects /api/me without a session', async () => {
    const response = await inject(app, { method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a session cookie that the auth module does not know', async () => {
    const response = await inject(app, {
      method: 'GET',
      url: '/api/me',
      headers: { cookie: 's9.session_token=not-a-real-session' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('sets an HttpOnly, opaque session cookie on sign-up', async () => {
    const response = await inject(app, {
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        email: `cookie-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
        password: 'integration-test-password',
        name: 'Cookie Test',
      },
    });

    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookie).toContain('s9.session_token=');
    expect(cookie?.toLowerCase()).toContain('httponly');

    // The session token is opaque, not a self-contained JWT.
    const value = cookie?.split(';')[0]?.split('=')[1] ?? '';
    expect(value.length).toBeGreaterThan(0);
    expect(value.split('.')).not.toHaveLength(3);
  });

  it('signs in with email and password after sign-up', async () => {
    const context = await createSession(
      app,
      `signin-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    );

    const login = await inject(app, {
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: context.email, password: 'integration-test-password' },
    });

    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toBeTruthy();
  });

  it('revokes the session on sign-out', async () => {
    const context = await createSession(
      app,
      `signout-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    );

    const signOut = await inject(app, {
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: context.cookie },
      payload: {},
    });
    expect(signOut.statusCode).toBe(200);

    const me = await inject(app, {
      method: 'GET',
      url: '/api/me',
      headers: { cookie: context.cookie },
    });
    expect(me.statusCode).toBe(401);
  });

  it('does not expose the removed internal service endpoints', async () => {
    const calls = [
      { method: 'POST', url: '/internal/service-token' },
      { method: 'POST', url: '/internal/sessions/validate' },
      { method: 'GET', url: '/internal/users/some-user' },
    ] as const;

    for (const call of calls) {
      const response = await inject(app, call);
      expect(response.statusCode).toBe(404);
    }
  });
});
