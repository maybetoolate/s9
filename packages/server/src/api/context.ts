import type { FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from './auth.js';
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
  email: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    context?: RequestContext;
    rawBody?: Buffer;
  }
}

/** Role capabilities. */
export const ROLE_CAPABILITIES: Record<Role, string[]> = {
  owner: ['read', 'write', 'publish', 'retry', 'manage_credentials', 'rotate_credentials', 'manage_workspace'],
  editor: ['read', 'write', 'publish', 'retry'],
  viewer: ['read'],
};

export function can(role: Role, capability: string): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export async function getSession(request: FastifyRequest) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  return session;
}

/**
 * Resolves the session, the workspace and the role of the caller.
 *
 * The MVP exposes one workspace per user, but every query still carries the
 * workspace id.
 */
export async function requireContext(
  request: FastifyRequest,
  _reply: FastifyReply,
  options: { capabilities?: string[] } = {},
): Promise<RequestContext> {
  const session = await getSession(request);
  if (!session?.user) throw ApiError.unauthorized();

  const db = getPool();
  const workspaces = await listWorkspacesForUser(db, session.user.id);
  const first = workspaces[0];
  if (!first) {
    throw ApiError.forbidden('the account is not a member of any workspace');
  }

  const membership = await findMembership(db, first.id, session.user.id);
  const role = (membership?.role ?? 'viewer') as Role;

  for (const capability of options.capabilities ?? []) {
    if (!can(role, capability)) {
      throw ApiError.forbidden(`the ${role} role may not ${capability.replace('_', ' ')}`);
    }
  }

  const context: RequestContext = {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    workspaceId: first.id,
    workspaceName: first.name,
    role,
  };
  request.context = context;
  return context;
}

/** Reads the context that a pre-handler already resolved. */
export function context(request: FastifyRequest): RequestContext {
  if (!request.context) throw ApiError.unauthorized();
  return request.context;
}
