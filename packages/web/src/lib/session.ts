import { redirect } from 'next/navigation';
import { api } from '@/lib/api-server';

/**
 * The session.
 *
 * The web app reads the session through the API, which owns authentication.
 */
export interface Session {
  user: { id: string; email: string; name: string };
  workspace: { id: string; name: string };
  role: 'owner' | 'editor' | 'viewer';
}

export async function getSession(): Promise<Session | null> {
  try {
    return await api.get<Session>('/api/me');
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}
