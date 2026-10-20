import type { CredentialDto } from '@flowforge/core';
import { api } from '@/lib/api-server';
import { requireSession } from '@/lib/session';
import { CredentialsManager } from './credentials-manager';

export const dynamic = 'force-dynamic';

export default async function CredentialsPage() {
  await requireSession();
  const result = await api.get<{ data: CredentialDto[] }>('/api/credentials');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Credentials</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Provider secrets are stored separately from the workflow definition, encrypted at rest, and never returned by
          the API.
        </p>
      </div>

      <CredentialsManager credentials={result.data} />
    </div>
  );
}
