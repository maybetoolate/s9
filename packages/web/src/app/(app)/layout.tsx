import { requireSession } from '@/lib/session';
import { AppShell } from '@/components/app-shell';

/**
 * The signed-in shell.
 *
 * Every page below this layout requires a session; the API owns authentication
 * and the workspace scoping.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return <AppShell email={session.user.email}>{children}</AppShell>;
}
