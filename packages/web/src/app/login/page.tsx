'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Alert } from '@/components/ui/feedback';

/**
 * The sign-in screen.
 *
 * The session protocol comes from the authentication service; this form only
 * posts credentials and lets the browser cookie do the rest.
 */
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('operator@flowforge.local');
  const [password, setPassword] = useState('flowforge-demo-password');
  const [name, setName] = useState('Demo Operator');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const path = mode === 'sign-in' ? '/api/auth/sign-in/email' : '/api/auth/sign-up/email';
    const payload =
      mode === 'sign-in' ? { email, password } : { email, password, name };

    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string; error?: { message?: string } };
        setError(body?.error?.message ?? body?.message ?? 'the sign in failed');
        return;
      }

      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('the server could not be reached');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-10 items-center justify-center rounded-lg bg-[var(--color-primary)] text-[var(--color-primary-foreground)]">
            <Activity className="size-5" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight">FlowForge</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Configure the process once, run it repeatedly, and understand every run.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-6">
          <div className="flex gap-1 rounded-lg bg-[var(--color-muted)] p-1 text-sm">
            <button
              type="button"
              onClick={() => setMode('sign-in')}
              className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
                mode === 'sign-in' ? 'bg-[var(--color-card)] shadow-sm' : 'text-[var(--color-muted-foreground)]'
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => setMode('sign-up')}
              className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
                mode === 'sign-up' ? 'bg-[var(--color-card)] shadow-sm' : 'text-[var(--color-muted-foreground)]'
              }`}
            >
              Create account
            </button>
          </div>

          {mode === 'sign-up' ? (
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(event) => setName(event.target.value)} required />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>

          {error ? <Alert variant="error">{error}</Alert> : null}

          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            {mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </Button>

          <p className="text-center text-xs text-[var(--color-muted-foreground)]">
            The demo workspace uses <span className="font-mono">operator@flowforge.local</span> /{' '}
            <span className="font-mono">flowforge-demo-password</span>.
          </p>
        </form>
      </div>
    </div>
  );
}
