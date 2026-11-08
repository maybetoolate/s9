import type { Context, Hono } from 'hono';
import { validateSession, type SessionInfo } from '../auth/client.js';
import { findMembership, listWorkspacesForUser } from '../db/repo.js';
import { getPool } from '../db/pool.js';
import { ApiError } from './http.js';

/**
 * Request context.
 *
 * Authorization is applied at the server boundary: every workflow, execution,
 * schedule and credential query is scoped to the user's workspace, and the
 * role decides what the user may do.
 */

export type Role = 'owner' | 'editor' | 'viewer';

export interface RequestContext {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  role: Role;
}

/** Per-request values shared through the Hono context. */
export interface AppEnv {
  Variables: {
    requestId: string;
    context?: RequestContext;
  };
}

export type App = Hono<AppEnv>;
export type AppContext = Context<AppEnv>;

/** Role capabilities. */
export const ROLE_CAPABILITIES: Record<Role, string[]> = {
  owner: ['read', 'write', 'publish', 'retry', 'manage_credentials', 'rotate_credentials', 'manage_workspace'],
  editor: ['read', 'write', 'publish', 'retry'],
  viewer: ['read'],
};

export function can(role: Role, capability: string): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export async function getSession(c: AppContext): Promise<SessionInfo | null> {
  return validateSession(c.req.header('cookie'));
}

/**
 * Resolves the session, the workspace and the role of the caller.
 *
 * The MVP exposes one workspace per user, but every query still carries the
 * workspace id.
 */
export async function requireContext(
  c: AppContext,
  options: { capabilities?: string[] } = {},
): Promise<RequestContext> {
  const session = await getSession(c);
  if (!session) throw ApiError.unauthorized();

  const db = getPool();
  const workspaces = await listWorkspacesForUser(db, session.userId);
  const first = workspaces[0];
  if (!first) {
    throw ApiError.forbidden('the account is not a member of any workspace');
  }

  const membership = await findMembership(db, first.id, session.userId);
  const role = (membership?.role ?? 'viewer') as Role;

  for (const capability of options.capabilities ?? []) {
    if (!can(role, capability)) {
      throw ApiError.forbidden(`the ${role} role may not ${capability.replace('_', ' ')}`);
    }
  }

  const context: RequestContext = {
    userId: session.userId,
    workspaceId: first.id,
    workspaceName: first.name,
    role,
  };
  c.set('context', context);
  return context;
}

/** Reads the context that a pre-handler already resolved. */
export function context(c: AppContext): RequestContext {
  const resolved = c.get('context');
  if (!resolved) throw ApiError.unauthorized();
  return resolved;
}
