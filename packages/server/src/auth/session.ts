import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { user } from '../db/schema.js';
import { auth } from './instance.js';

/**
 * The session-facing API of the auth module.
 *
 * Everything here runs in-process. The API hands over the opaque session
 * cookie; Better-Auth resolves it against the session table. No user JWT is
 * issued, so revocation is a row deletion rather than a token blacklist.
 */

export interface SessionInfo {
  userId: string;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

/** Resolves the user behind a request, or null when the cookie is not valid. */
export async function validateSession(cookie: string | undefined): Promise<SessionInfo | null> {
  if (!cookie) return null;

  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!session?.user) return null;

  return { userId: session.user.id };
}

/** Reads the display profile for `/api/me`. */
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const [row] = await getDb()
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? null;
}
