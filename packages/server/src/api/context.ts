import type { Context, Hono } from 'hono';
import { getUserProfile, validateSession, type SessionInfo } from '../auth/index.js';
import { addMembership, createWorkspace, findMembership, listWorkspacesForUser } from '../db/repo.js';
import { getDb, withAdvisoryLock } from '../db/client.js';
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
 * Returns the user's workspace, provisioning one on first use.
 *
 * The MVP has one workspace per user, but an account created through sign-up
 * has no membership yet. Provisioning here (rather than only at sign-up)
 * repairs accounts that predate the rule and keeps every entry point
 * consistent. The advisory lock serializes concurrent first requests so a new
 * account never gets two workspaces.
 */
async function ensureWorkspace(userId: string) {
  const db = getDb();
  const existing = await listWorkspacesForUser(db, userId);
  if (existing[0]) return existing[0];

  const profile = await getUserProfile(userId);
  const name = profile?.name ? `${profile.name}'s workspace` : 'My workspace';

  return withAdvisoryLock(`workspace-provision:${userId}`, async (tx) => {
    const rechecked = await listWorkspacesForUser(tx, userId);
    if (rechecked[0]) return rechecked[0];

    const workspace = await createWorkspace(tx, name);
    await addMembership(tx, workspace.id, userId, 'owner');
    return { ...workspace, role: 'owner' };
  });
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

  const db = getDb();
  const workspace = await ensureWorkspace(session.userId);

  const membership = await findMembership(db, workspace.id, session.userId);
  const role = (membership?.role ?? 'viewer') as Role;

  for (const capability of options.capabilities ?? []) {
    if (!can(role, capability)) {
      throw ApiError.forbidden(`the ${role} role may not ${capability.replace('_', ' ')}`);
    }
  }

  const context: RequestContext = {
    userId: session.userId,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
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
