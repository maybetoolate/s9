'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * Sign out.
 *
 * The auth module only accepts JSON requests, so this cannot be a plain HTML
 * form (a browser form sends `application/x-www-form-urlencoded`). The session
 * cookie is HttpOnly, so the request itself is all the browser has to do; the
 * navigation then shows the signed-out shell.
 */
export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: '{}',
      });
    } finally {
      router.push('/login');
      router.refresh();
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50"
    >
      {pending ? <Loader2 className="size-3 animate-spin" /> : null}
      Sign out
    </button>
  );
}
