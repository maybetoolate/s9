'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, KeyRound, LayoutDashboard, ListChecks, Workflow } from 'lucide-react';
import { cn } from '@/lib/utils';

const NAVIGATION = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/workflows', label: 'Workflows', icon: Workflow },
  { href: '/executions', label: 'Executions', icon: ListChecks },
  { href: '/credentials', label: 'Credentials', icon: KeyRound },
];

/** The application shell: a fixed sidebar plus the page content. */
export function AppShell({ children, email }: { children: React.ReactNode; email?: string }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-card)] p-4 md:block">
        <Link href="/dashboard" className="mb-6 flex items-center gap-2 px-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-[var(--color-primary)] text-[var(--color-primary-foreground)]">
            <Activity className="size-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight">FlowForge</span>
        </Link>

        <nav className="flex flex-col gap-1">
          {NAVIGATION.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                    : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]',
                )}
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-card)] px-6">
          <div className="flex items-center gap-2 md:hidden">
            <Activity className="size-5 text-[var(--color-primary)]" />
            <span className="text-sm font-semibold">FlowForge</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {email ? <span className="text-sm text-[var(--color-muted-foreground)]">{email}</span> : null}
            <form action="/api/auth/sign-out" method="post">
              <button
                type="submit"
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-accent)]"
              >
                Sign out
              </button>
            </form>
          </div>
        </header>

        <main className="flex-1 px-6 py-6">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
